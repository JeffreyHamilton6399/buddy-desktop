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

  append(conversation, role, content) {
    conversation.messages.push({ role, content, at: new Date().toISOString() });
    if (conversation.messages.length > MAX_STORED_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_STORED_MESSAGES);
    }
    conversation.updatedAt = new Date().toISOString();

    if (conversation.title === 'New chat' && role === 'user') {
      conversation.title = History.titleFrom(content);
    }
  }

  /** Newest first, with just enough to render a list row. */
  list() {
    return [...this.cache.values()]
      .map((conversation) => {
        const lastMessage = conversation.messages[conversation.messages.length - 1];
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
