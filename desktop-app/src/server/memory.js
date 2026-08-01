/**
 * What Buddy remembers about you between conversations.
 *
 *   <userData>/memory.json
 *
 * A chat remembers itself and nothing beyond itself, so every new conversation
 * met the user as a stranger. The `about` note in settings was the cheapest fix
 * for that — a few lines you write once — and its objection to going further was
 * a good one: a note about yourself that you cannot see and did not write is a
 * worse thing to have than no note at all.
 *
 * That objection is about *visibility*, not about memory, so this is built to
 * answer it rather than to ignore it:
 *
 *   * Every fact is one short sentence in plain English, not an opaque vector.
 *     If Buddy knows it, you can read it.
 *   * Every fact records which conversation it came out of and when, so "why
 *     does it think that?" always has an answer.
 *   * Every fact can be edited, pinned or deleted one at a time, and the whole
 *     store is one readable file you own.
 *
 * One file rather than one per fact, unlike chats. The entire store is read on
 * every turn to decide what is worth recalling, it is a few hundred short
 * strings, and a single atomic rewrite is simpler than reconciling a directory.
 * Writes go through a temp file and a rename, the same as history, so a crash
 * mid-save cannot leave half a memory behind.
 *
 * Nothing here talks to a model. Deciding *what* is worth remembering is the
 * caller's job; this module is the store, the deduplicator and the librarian.
 */
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const FILENAME = 'memory.json';

/**
 * How many facts are kept before the least useful start being dropped. Two
 * hundred short sentences is far more than a person will accumulate in a year
 * of ordinary use, and still only a few tens of kilobytes.
 */
const DEFAULT_MAX_FACTS = 200;

/** One fact is one sentence. Anything longer is a paragraph that got in by mistake. */
const MAX_FACT_CHARS = 200;

/**
 * How much of the prompt recalled facts may occupy, and how many may appear.
 *
 * Both caps matter and they are not the same cap. The character budget is what
 * protects a small model's context window; the count is what stops six barely
 * relevant one-word facts crowding out the conversation itself. Whichever runs
 * out first wins.
 */
const RECALL_MAX_FACTS = 6;
const RECALL_MAX_CHARS = 400;

/**
 * Below this a fact is not worth putting in front of the model for this message.
 * Everything scores something against something, so without a floor the six
 * least irrelevant facts are recalled every single turn regardless of topic.
 */
const WORTH_RECALLING = 0.2;

/**
 * Words that say nothing about what a fact is *about*.
 *
 * Kept deliberately short. This exists to stop "their", "is" and "the" from
 * making every fact look like every other fact; it is not an attempt at
 * linguistics, and a word wrongly left in costs far less than a word wrongly
 * taken out.
 */
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'called', 'can', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'hers', 'him', 'his', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'that', 'the', 'their',
  'theirs', 'them', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who',
  'will', 'with', 'would', 'you', 'your', 'yours',
]);

// ── comparing two pieces of text ──────────────────────────────────────────

/**
 * The words of a piece of text, lowercased, stripped of punctuation and of the
 * words that carry no subject matter.
 *
 * Plural and possessive endings are trimmed so "sister", "sisters" and
 * "sister's" all meet. This is a crude stem on purpose — a real stemmer is a
 * dependency and a surprise, and the whole scheme here is a placeholder for
 * embeddings anyway (see `similarity`).
 */
function terms(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const kept = new Set();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const stem = word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
    kept.add(stem);
  }
  return kept;
}

function shared(a, b) {
  let count = 0;
  for (const term of a) if (b.has(term)) count += 1;
  return count;
}

/**
 * How much a fact has to do with what was just said, 0 to 1.
 *
 * The share of the fact's words that appear in the message, and deliberately
 * not a symmetric measure like Jaccard. A message is usually far longer than a
 * fact, and a measure that divides by the size of both punishes that difference
 * so hard that a perfectly relevant fact scores near zero. The question being
 * asked is not "are these two texts alike" but "does this short fact turn up in
 * this long message", so the message's length should not enter into it at all.
 */
function relevance(fact, message) {
  const left = fact instanceof Set ? fact : terms(fact);
  const right = message instanceof Set ? message : terms(message);
  if (!left.size || !right.size) return 0;
  return shared(left, right) / left.size;
}

/**
 * Is the second fact already covered by the first — a restatement of it, or the
 * same thing said at more length?
 *
 * This started as a threshold on `similarity` and that was wrong, in a way
 * worth writing down because it will be tempting again. Scoring "their daughter
 * goes to Ashfield Primary" against "their son goes to Ashfield Primary" gives
 * 0.67 — high, because five words out of six agree — and any threshold loose
 * enough to catch real duplicates was also loose enough to let one of those
 * silently overwrite the other. Two facts that differ in exactly the word that
 * matters look almost identical to a bag of words.
 *
 * So the rule is containment rather than resemblance: a fact is a duplicate
 * only when it says *nothing the other does not already say*. "They are
 * learning Portuguese" is subsumed by "they are learning Portuguese at the
 * moment"; "son" is not subsumed by "daughter", because it contributes a word
 * of its own. That is a narrow test, and narrow is the right direction — a
 * duplicate that slips through is a tidiness problem, while a wrong merge is a
 * thing Buddy believes about someone that nobody ever told it.
 *
 * The single-word guard is the other half of it. Without it a bare
 * "Vegetarian." is contained in "their brother is vegetarian", the longer
 * wording wins, and a fact about the user has quietly become a fact about their
 * brother. A one-word fact only ever merges with the identical one-word fact.
 *
 * This is the seam for embeddings — but note that a sentence encoder does not
 * solve the hard case either. "They live in Bristol" and "They live in Leeds"
 * are semantically adjacent and *should* merge, while "daughter" and "son" are
 * equally adjacent and must not. Telling those apart needs to know which part
 * of the sentence is the value, which is a job for the extraction pass saying
 * outright that a fact replaces another, not for any distance measure.
 */
function duplicates(a, b) {
  const left = a instanceof Set ? a : terms(a);
  const right = b instanceof Set ? b : terms(b);
  if (!left.size || !right.size) return false;

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  // Anything in the shorter fact that the longer one lacks makes it its own fact.
  if (shared(smaller, larger) < smaller.size) return false;
  // The same words in both: the same fact, however it was worded.
  if (smaller.size === larger.size) return true;
  return smaller.size >= 2;
}

// ── reading what a model wrote ────────────────────────────────────────────

/**
 * Turn an extraction pass's output into facts, throwing away anything that does
 * not look like one.
 *
 * Lines rather than JSON, for the same reason the action protocol uses markers:
 * the smallest model Buddy ships cannot be relied on to close a brace, and a
 * malformed response here must degrade to remembering less rather than to an
 * error nobody asked about.
 *
 * The filtering is severe because the cost is lopsided. A fact wrongly dropped
 * is remembered again next time it comes up in conversation; a fact wrongly
 * kept is a thing Buddy believes about someone that is not true, and it will
 * keep believing it until they find it and delete it.
 */
function parseExtraction(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const text = line
      .trim()
      .replace(/^[-*•]\s*/, '') // the bullet it was asked for
      .replace(/^\d+[.)]\s*/, '') // the numbering it sometimes uses instead
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();

    if (!text) continue;
    // "none", "nothing worth remembering", "no new facts" — the empty answer,
    // which a model will phrase a dozen ways and must never become a memory.
    if (/^(none|nothing|no\b)/i.test(text)) continue;
    if (text.length > MAX_FACT_CHARS) continue;
    // A sentence about the user is at least a few words. One or two is a
    // fragment, a heading, or the model restating the instruction.
    if (text.split(/\s+/).length < 3) continue;
    // First person is Buddy talking about itself. The instruction asks for
    // third-person statements precisely so this test can exist.
    if (/^i\b|^i'/i.test(text)) continue;

    out.push(text);
    if (out.length >= 5) break; // one pass should not be able to flood the store
  }
  return out;
}

// ── the store ─────────────────────────────────────────────────────────────

/** A fact, as it goes to the renderer and as it sits on disk. */
function makeFact(text, source) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    text,
    at: now,
    source: source && source.chatId ? { chatId: source.chatId, title: source.title || '' } : null,
    pinned: false,
    uses: 0,
    lastUsedAt: null,
  };
}

class Memory {
  /** @param {() => string} resolveDir returns the directory to store memory in */
  constructor(resolveDir) {
    this.resolveDir = resolveDir;
    /** @type {object[]} oldest first, which is the order they were learned in */
    this.facts = [];
    this.loaded = false;
    this.writing = Promise.resolve();
  }

  file() {
    return path.join(this.resolveDir(), FILENAME);
  }

  /** Only ids we generated are ever accepted, the same as conversations. */
  static isValidId(id) {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  /**
   * Trim a piece of text into something storable, or return '' if it is not.
   * Permissive on purpose: the strict filtering belongs in `parseExtraction`,
   * where the text came from a model. Somebody typing "Vegetarian." by hand
   * into the settings pane means it, and is owed no opinion about its length.
   */
  static clean(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_FACT_CHARS);
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file(), 'utf8'));
      if (!parsed || !Array.isArray(parsed.facts)) return;
      this.facts = parsed.facts
        .filter((fact) => fact && typeof fact.text === 'string' && Memory.isValidId(fact.id))
        .map((fact) => ({
          id: fact.id,
          text: Memory.clean(fact.text),
          at: fact.at || new Date().toISOString(),
          source: fact.source && fact.source.chatId ? fact.source : null,
          pinned: fact.pinned === true,
          uses: Number.isFinite(fact.uses) ? fact.uses : 0,
          lastUsedAt: fact.lastUsedAt || null,
        }))
        .filter((fact) => fact.text);
    } catch {
      // No file yet is the ordinary case on first run. A corrupt one is not, but
      // the response is the same: start empty rather than refuse to start. The
      // file is overwritten on the next write, and losing what Buddy remembered
      // is a smaller failure than an assistant that will not open.
    }
  }

  /** Serialise writes so two saves cannot interleave. */
  async persist() {
    const next = this.writing
      .catch(() => {})
      .then(async () => {
        const target = this.file();
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temp, JSON.stringify({ version: 1, facts: this.facts }, null, 2));
        await fsp.rename(temp, target);
      });
    this.writing = next;
    return next;
  }

  /** Newest first, which is the order the settings pane shows them in. */
  all() {
    return [...this.facts].reverse();
  }

  get size() {
    return this.facts.length;
  }

  /**
   * Learn one thing, or discover it was already known.
   *
   * A fact already covered by an existing one folds into it — keeping the
   * original's id, source and usage — rather than sitting beside it. Without
   * this the store fills with restatements, because a model asked twice about
   * the same conversation words the answer differently each time.
   *
   * What this deliberately does *not* do is notice that a fact has changed
   * value. "They live in Bristol" and "They live in Leeds" are stored as two
   * facts, and the model will see both. See `duplicates` for why that is the
   * safe direction to be wrong in, and what would actually fix it.
   *
   * Returns what happened, so a caller can tell the user "remembered" or
   * "updated" rather than guessing.
   */
  remember(text, source, { max = DEFAULT_MAX_FACTS } = {}) {
    const clean = Memory.clean(text);
    if (!clean) return { ok: false, reason: 'empty' };

    const incoming = terms(clean);
    const known = this.facts.find((fact) => duplicates(incoming, fact.text));

    if (known) {
      // Keep the longer wording: it is the one carrying the detail, and a model
      // restating a known fact usually does so more tersely than it first
      // learned it.
      if (clean.length > known.text.length) known.text = clean;
      known.at = new Date().toISOString();
      if (source && source.chatId) known.source = { chatId: source.chatId, title: source.title || '' };
      return { ok: true, updated: true, fact: known };
    }

    const fact = makeFact(clean, source);
    this.facts.push(fact);
    this.evict(max, fact.id);
    return { ok: true, updated: false, fact };
  }

  /** Learn several things at once — one extraction pass's worth. */
  rememberAll(texts, source, options) {
    const learned = [];
    for (const text of Array.isArray(texts) ? texts : []) {
      const result = this.remember(text, source, options);
      if (result.ok) learned.push(result);
    }
    return learned;
  }

  /**
   * Drop the least useful facts until the store is back under its cap.
   *
   * Least useful means least recently *useful* — a fact that has never once
   * been worth recalling in fifty conversations is not one worth keeping, which
   * is a better measure than age. Facts the user pinned are never dropped; that
   * is what pinning is for, and it is why the cap is generous enough that
   * nobody should reach it by accident.
   *
   * Two things are therefore untouchable, and the cap yields to both rather
   * than the other way round. Pins are the user saying keep this. And the fact
   * that has just been learned is spared by `protectedId`, because without it a
   * store holding more pins than the cap allows would evict every new fact the
   * instant it arrived — Buddy would go on appearing to learn and quietly
   * remember nothing, which is the worst of the available failures. Going one
   * over is the better answer: the cap exists to stop unattended extraction
   * growing without bound, not to override somebody's own choices.
   */
  evict(max = DEFAULT_MAX_FACTS, protectedId = null) {
    const limit = Math.max(1, max);
    if (this.facts.length <= limit) return 0;

    const droppable = this.facts
      .filter((fact) => !fact.pinned && fact.id !== protectedId)
      .sort((a, b) => String(a.lastUsedAt || a.at).localeCompare(String(b.lastUsedAt || b.at)));

    const dropping = new Set();
    for (const fact of droppable) {
      if (this.facts.length - dropping.size <= limit) break;
      dropping.add(fact.id);
    }
    if (!dropping.size) return 0;

    this.facts = this.facts.filter((fact) => !dropping.has(fact.id));
    return dropping.size;
  }

  edit(id, changes) {
    const fact = this.facts.find((entry) => entry.id === id);
    if (!fact) return null;
    if (typeof changes.text === 'string') {
      const clean = Memory.clean(changes.text);
      if (!clean) return null;
      fact.text = clean;
      // Edited by hand, so it is the user's sentence now rather than the
      // model's, and the conversation it came from no longer explains it.
      fact.source = null;
    }
    if (typeof changes.pinned === 'boolean') fact.pinned = changes.pinned;
    return fact;
  }

  forget(id) {
    const before = this.facts.length;
    this.facts = this.facts.filter((fact) => fact.id !== id);
    return this.facts.length < before;
  }

  clear() {
    const count = this.facts.length;
    this.facts = [];
    return count;
  }

  /** Forget everything held in memory, e.g. after the storage directory changes. */
  reset() {
    this.facts = [];
    this.loaded = false;
  }

  /**
   * The facts worth putting in front of the model for this message.
   *
   * Not all of them. A small model's context is small, and an irrelevant fact
   * is worse than a missing one — it invites the model to drag the user's job
   * title into a question about the weather.
   *
   * Pinned facts come first and unconditionally: somebody who pinned "they are
   * allergic to peanuts" meant it to apply to everything, not to messages that
   * happen to mention peanuts. Everything else has to earn its place against
   * what was actually said, with a small nudge for facts learned recently,
   * since a thing that came up this week is likelier to be live than one from
   * six months ago.
   *
   * Recalling a fact counts as using it, which is what `evict` reads later.
   * That makes this a read that writes; the alternative was a `touch()` the
   * caller has to remember to make, and a forgotten one silently poisons
   * eviction months later.
   */
  recall(message, { limit = RECALL_MAX_FACTS, budget = RECALL_MAX_CHARS } = {}) {
    if (!this.facts.length) return [];

    const asked = terms(message);
    const now = Date.now();
    const MONTH = 30 * 24 * 60 * 60 * 1000;

    const scored = [];
    for (const fact of this.facts) {
      if (fact.pinned) {
        scored.push({ fact, score: Infinity });
        continue;
      }
      const score = relevance(fact.text, asked);
      if (score < WORTH_RECALLING) continue;
      const age = now - Date.parse(fact.at || '');
      const freshness = Number.isFinite(age) ? Math.max(0, 1 - age / (6 * MONTH)) : 0;
      scored.push({ fact, score: score + freshness * 0.1 });
    }

    scored.sort((a, b) => b.score - a.score);

    const chosen = [];
    let used = 0;
    for (const { fact } of scored) {
      if (chosen.length >= limit) break;
      if (used + fact.text.length > budget && chosen.length) break;
      chosen.push(fact);
      used += fact.text.length + 1;
    }

    if (chosen.length) {
      const stamp = new Date().toISOString();
      for (const fact of chosen) {
        fact.uses += 1;
        fact.lastUsedAt = stamp;
      }
      // Usage is bookkeeping. It must survive a restart for eviction to mean
      // anything, but nobody is waiting on it and a failed write here should
      // never surface as a failed reply.
      this.persist().catch(() => {});
    }

    return chosen;
  }
}

module.exports = {
  Memory,
  parseExtraction,
  duplicates,
  relevance,
  terms,
  DEFAULT_MAX_FACTS,
  MAX_FACT_CHARS,
  RECALL_MAX_FACTS,
  RECALL_MAX_CHARS,
};
