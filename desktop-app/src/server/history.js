/**
 * Buddy's chat history — plain JSON files on this machine, one per conversation.
 *
 *   <userData>/chats/<id>.json
 *
 * Nothing is uploaded and nothing is encrypted; they are readable files the user
 * owns and can delete, either from the drawer in the app or with a file manager.
 * Writes go through a temp file and a rename so a crash mid-save cannot leave a
 * half-written conversation behind.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MAX_STORED_MESSAGES = 400; // per conversation, oldest trimmed first

/**
 * How many bytes of pictures one conversation may carry.
 *
 * Text messages are small enough that four hundred of them cost nothing, which
 * is why they are simply counted. Pictures are not: four megabytes each, four to
 * a message, and every conversation is held in memory for the life of the
 * process once load() has read it. A few weeks of screenshots would therefore
 * sit in RAM permanently and make every launch slower, which is the opposite of
 * what a local-first app should do to a machine.
 *
 * So the pictures are a sliding window. The most recent ones stay — those are
 * the ones a follow-up question is about, and the ones you see when you scroll
 * back — and older ones lose their data while keeping the message they belonged
 * to. Twelve megabytes is roughly the last half-dozen screenshots.
 */
const MAX_IMAGE_BYTES_PER_CHAT = 12 * 1024 * 1024;

/**
 * Drop the picture data from the oldest image-bearing messages until the
 * conversation is back under budget. The message itself, and the fact that it
 * had a picture, are both kept.
 */
function forgetOldPictures(conversation) {
  const withImages = conversation.messages.filter((message) => Array.isArray(message.images) && message.images.length);
  if (!withImages.length) return;

  const weigh = (message) =>
    message.images.reduce((total, image) => total + (image.data ? image.data.length : 0), 0);

  let total = withImages.reduce((sum, message) => sum + weigh(message), 0);
  // Oldest first: `messages` is in order, and filter preserves it.
  for (const message of withImages) {
    if (total <= MAX_IMAGE_BYTES_PER_CHAT) break;
    total -= weigh(message);
    message.images = message.images.map(({ mime, name }) => ({ mime, name, forgotten: true }));
  }
}
const TITLE_LENGTH = 52;

class History {
  /** @param {() => string} resolveDir returns the directory to store chats in */
  constructor(resolveDir) {
    this.resolveDir = resolveDir;
    /** @type {Map<string, object>} id -> conversation */
    this.cache = new Map();
    this.loaded = false;
    this.writes = new Map();
  }

  dir() {
    return path.join(this.resolveDir(), 'chats');
  }

  fileFor(id) {
    return path.join(this.dir(), `${id}.json`);
  }

  /** Only ids we generated are ever accepted, so a request cannot walk the disk. */
  static isValidId(id) {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  static titleFrom(text) {
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return 'New chat';
    return clean.length > TITLE_LENGTH ? `${clean.slice(0, TITLE_LENGTH - 1)}…` : clean;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let names = [];
    try {
      names = await fsp.readdir(this.dir());
    } catch {
      return; // no history yet
    }

    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!History.isValidId(id)) continue;
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(this.dir(), name), 'utf8'));
        if (parsed && parsed.id === id && Array.isArray(parsed.messages)) this.cache.set(id, parsed);
      } catch {
        // A corrupt file should not stop the rest of the history from loading.
        console.error(`[buddy] skipping unreadable conversation ${name}`);
      }
    }
  }

  /** Serialise writes per conversation so two saves cannot interleave. */
  async persist(conversation) {
    const previous = this.writes.get(conversation.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(this.dir(), { recursive: true });
        const target = this.fileFor(conversation.id);
        const temp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temp, JSON.stringify(conversation, null, 2));
        await fsp.rename(temp, target);
      });
    this.writes.set(conversation.id, next);
    return next;
  }

  create() {
    const now = new Date().toISOString();
    const conversation = {
      id: crypto.randomUUID(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.cache.set(conversation.id, conversation);
    return conversation;
  }

  get(id) {
    return History.isValidId(id) ? this.cache.get(id) || null : null;
  }

  /** Returns an existing conversation, or a fresh one when the id is unknown. */
  resolve(id) {
    return this.get(id) || this.create();
  }

  /**
   * `images` is optional and only ever set on a user turn. It is stored with the
   * message so reopening a conversation shows the picture that was asked about,
   * and so a follow-up question ("what about the top left?") still has it in
   * context. They are capped per message in server.js before they get this far.
   */
  /**
   * `kind` marks a turn that is not something a person said. The only one so
   * far is 'action' — what came back from a file being read or a folder listed,
   * which the model has to see to be able to use, but which was never typed by
   * anybody and must not be drawn as though it were.
   */
  append(conversation, role, content, images, kind) {
    conversation.messages.push({
      role,
      content,
      ...(Array.isArray(images) && images.length ? { images } : {}),
      ...(kind ? { kind } : {}),
      at: new Date().toISOString(),
    });
    if (conversation.messages.length > MAX_STORED_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_STORED_MESSAGES);
    }
    forgetOldPictures(conversation);
    conversation.updatedAt = new Date().toISOString();

    // A chat is named after what was asked, never after what an action returned
    // — otherwise a conversation that opened by listing a folder is filed under
    // the first filename in it.
    if (conversation.title === 'New chat' && role === 'user' && !kind) {
      conversation.title = History.titleFrom(content);
    }
  }

  /** Newest first, with just enough to render a list row. */
  list() {
    return [...this.cache.values()]
      .map((conversation) => {
        // The preview is what was last *said*, so an action's output is skipped
        // — a chat whose newest turn is a folder listing should not be
        // previewed with a filename out of the middle of it.
        const lastMessage = [...conversation.messages].reverse().find((message) => !message.kind);
        return {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messages.length,
          preview: lastMessage ? History.titleFrom(lastMessage.content) : '',
        };
      })
      .filter((entry) => entry.messageCount > 0)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async rename(id, title) {
    const conversation = this.get(id);
    if (!conversation) return null;
    conversation.title = History.titleFrom(title);
    await this.persist(conversation);
    return conversation;
  }

  async remove(id) {
    if (!this.get(id)) return false;
    this.cache.delete(id);
    try {
      await fsp.unlink(this.fileFor(id));
    } catch {
      /* already gone */
    }
    return true;
  }

  async clear() {
    const ids = [...this.cache.keys()];
    this.cache.clear();
    await Promise.all(
      ids.map((id) =>
        fsp.unlink(this.fileFor(id)).catch(() => {
          /* already gone */
        })
      )
    );
    return ids.length;
  }

  /** Forget everything in memory, e.g. after the storage directory changes. */
  reset() {
    this.cache.clear();
    this.loaded = false;
  }
}

module.exports = { History, MAX_STORED_MESSAGES };
