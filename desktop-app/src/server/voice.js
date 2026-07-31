/**
 * Buddy's voice — Kokoro-82M running on this machine.
 *
 * The OS voices (SAPI on Windows, `say` on macOS) are what Buddy used to speak
 * with, and they sound like a 2005 satnav. Kokoro is a small neural TTS model
 * that runs on the CPU through onnxruntime and sounds like a person, so it is
 * now the default and nothing about speaking needs the network.
 *
 * Weights are fp16, not the smaller q8: measured on this machine q8 synthesizes
 * at 0.9x realtime — slower than the speech plays, so Buddy would fall further
 * behind the longer it talked — while fp16 manages 2.4x for half the disk of
 * fp32. See VERIFICATION.md for the numbers.
 *
 * The model costs ~300 MB of memory, so it is loaded on first use and dropped
 * again when Buddy goes quiet for a while.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const hf = require('./hf.js');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'fp16';
const WEIGHTS_FILE = 'model_fp16.onnx';
const MIN_WEIGHTS_BYTES = 100 * 1024 * 1024; // a truncated download must not read as ready

const DEFAULT_VOICE = 'af_heart';
const IDLE_UNLOAD_MS = 10 * 60 * 1000;
/** Short lines like the wake-word greeting are said over and over — keep them. */
const CACHE_LIMIT = 24;
const CACHEABLE_CHARS = 90;

let loadPromise = null;
let tts = null;
let queue = Promise.resolve();
let idleTimer = null;
const rendered = new Map();

// ── readiness ─────────────────────────────────────────────────────────────

function weightsPath(configDir) {
  return path.join(hf.cacheDir(configDir), ...MODEL_ID.split('/'), 'onnx', WEIGHTS_FILE);
}

/** Are the weights on disk, so Buddy can speak with no network? */
function isReady(configDir) {
  try {
    return fs.statSync(weightsPath(configDir)).size >= MIN_WEIGHTS_BYTES;
  } catch {
    return false;
  }
}

// ── loading ───────────────────────────────────────────────────────────────

const isLoaded = () => Boolean(tts);

function scheduleIdleUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => unload(), IDLE_UNLOAD_MS);
}

function load(configDir) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const alreadyOnDisk = isReady(configDir);
    // Configure transformers.js before kokoro-js imports it, or it caches to the
    // user's home directory instead of Buddy's own models folder.
    await hf.getTransformers(configDir);
    if (!alreadyOnDisk) hf.setStatus('voice', 'downloading');

    const startedAt = Date.now();
    try {
      const { KokoroTTS } = await import('kokoro-js');
      const engine = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: DTYPE,
        device: 'cpu',
        progress_callback: hf.progressCallback('voice'),
      });
      hf.setStatus('voice', 'ready');
      tts = engine;
      console.log(`[buddy] voice ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (Kokoro ${DTYPE})`);
      return engine;
    } catch (error) {
      hf.setStatus('voice', 'error', error.message);
      throw error;
    }
  })();

  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

function unload() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!tts) return;
  tts = null;
  loadPromise = null;
  rendered.clear();
  console.log('[buddy] voice unloaded after being idle');
}

/**
 * Pull the model into memory ahead of time, and run one throwaway line through
 * it. Loading the weights is not the whole cost: the very first generation pays
 * an extra ~0.8s setting the ONNX session up, and that is worth spending while
 * nobody is waiting rather than on the first thing Buddy is asked.
 *
 * The line is deliberately not anything Buddy says, so it does not sit in the
 * render cache taking up a slot that a real repeated phrase could use.
 */
/**
 * See builtin.warmUp — `maintain` means "keep it warm", never "load it".
 *
 * The dummy line matters here in a way it does not for the other two: Kokoro's
 * first synthesis is far slower than the rest, so one throwaway phrase at load
 * time is what stops the first thing Buddy actually says from being late. It is
 * a real inference though, so it belongs to loading and must not be repeated on
 * every keep-warm ping — which, at one ping every five minutes for as long as
 * the wake word is on, is exactly what it used to be.
 */
async function warmUp(configDir, options = {}) {
  const { maintain = false } = options;
  if (maintain && !isLoaded()) return;
  if (isLoaded()) return;

  await load(configDir);
  await speak({ configDir, text: 'Ready.', voice: options.voice }).catch(() => {
    /* a failed warm-up just means the first real line is a second slower */
  });
  scheduleIdleUnload();
}

// ── what a voice should actually say ──────────────────────────────────────

/**
 * Markdown is for reading, not for saying: unprocessed, Buddy pronounces every
 * asterisk and reads whole code blocks aloud. Strip the syntax, drop the parts
 * that cannot be spoken, and leave the words.
 */
function speakableText(source) {
  let text = String(source || '');

  text = text.replace(/```[\s\S]*?```/g, ' (code) ');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  // Emoji and other pictographs have no pronunciation and derail the phonemizer.
  // They go before the list handling below, which would otherwise treat a
  // trailing emoji as the end of the sentence and punctuate after it.
  text = text.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, ' ');
  // A leading bullet or number reads as a list item without being announced —
  // but an item with no full stop runs straight into the next one ("the ocean is
  // large it is salty"), so give it one to breathe on.
  text = text.replace(/^\s*[-*•]\s+(.*?)\s*$/gm, (_m, item) => (/[.!?,;:]$/.test(item) ? item : `${item}.`));
  text = text.replace(/^\s*(\d+)[.)]\s+(.*?)\s*$/gm, (_m, number, item) =>
    /[.!?,;:]$/.test(item) ? `${number}. ${item}` : `${number}. ${item}.`
  );
  text = text.replace(/https?:\/\/\S+/g, ' a link ');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
  // Removing a word can leave a gap in front of its punctuation ("large .").
  text = text.replace(/\s+([.!?,;:])/g, '$1');

  return text.trim();
}

/**
 * Split into chunks of roughly a sentence. The renderer asks for these one at a
 * time and plays each while the next is still being made, so Buddy starts talking
 * about half a second after a reply lands instead of after the whole thing has
 * been synthesized.
 *
 * The limits are deliberately short, and the first one shorter still: the
 * opening chunk is the only one the user actually waits through, because every
 * later one is made while the previous is still playing.
 *
 * Measured here (fp16, Vulkan-less CPU path): ~0.032s of synthesis per
 * character, against ~0.065s of speech per character — so roughly 2x realtime.
 * That gives the two numbers below:
 *
 *   firstLimit 42  the wait before Buddy starts talking, ~1.3s rather than the
 *                  ~2.2s that 70 characters cost
 *   limit     120  a later chunk must synthesize faster than the one before it
 *                  plays, or the pipeline falls behind and Buddy pauses
 *                  mid-sentence. At 2x realtime that means no chunk may be more
 *                  than about twice its predecessor; 120 against a 42-character
 *                  opener keeps a margin.
 *
 * Only genuinely short fragments are merged, so pauses still land on sentence ends.
 */
function chunkForSpeech(source, limit = 120, firstLimit = 42) {
  const text = speakableText(source);
  if (!text) return [];

  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) || [text];
  const chunks = [];
  let current = '';
  /** Below this a fragment is too short to be worth a pause of its own. */
  const MERGE_UNDER = 45;
  /**
   * A first chunk shorter than this does not buy enough playback time to cover
   * making the second one, so Buddy says "Sure." and then stops dead for a
   * couple of seconds. Below this it gets merged forward instead.
   */
  const MIN_FIRST = 24;

  /**
   * The ceiling grows to match what is already playing.
   *
   * Speech plays at ~0.065s per character and synthesizes at ~0.032s, so the
   * chunk currently playing covers the making of the next one only while the
   * next is no more than about twice its length. That makes the limit a
   * function of the previous chunk rather than a fixed ramp: a short opener
   * ("Sure thing.") earns a short follow-up, and the allowance doubles each
   * time until it reaches the cap. A fixed ramp got this wrong in exactly the
   * case that matters — a brief first chunk followed by a long second one,
   * where Buddy starts talking quickly and then stops dead.
   */
  const ceiling = () => {
    if (chunks.length === 0) return firstLimit;
    const previous = chunks[chunks.length - 1].length;
    return Math.max(firstLimit, Math.min(limit, Math.round(previous * 1.9)));
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > ceiling()) {
      if (current) {
        chunks.push(current);
        current = '';
      }

      /** A sentence barely over the line is better said whole than broken. */
      const OVERSHOOT = 1.15;
      if (sentence.length <= ceiling() * OVERSHOOT) {
        chunks.push(sentence);
        continue;
      }

      /**
       * Genuinely too long, with no sentence end to split on. Break on a comma,
       * then on a word boundary, never mid-word — clipping the audio at
       * "Thursday afternoo" is worse than any wait it saves.
       *
       * The comma search reaches a little past the ceiling on purpose. The
       * natural break in "…on Thursday afternoon, and you have…" is one
       * character too late; taking it costs a few hundredths of a second and
       * saves a pause landing in the middle of a phrase.
       */
      const COMMA_REACH = 1.25;
      let rest = sentence;
      while (rest.length > ceiling() * OVERSHOOT) {
        const at = ceiling();
        const comma = rest.lastIndexOf(',', Math.round(at * COMMA_REACH));
        const space = rest.lastIndexOf(' ', at);
        let split = at;
        if (comma > at * 0.4) split = comma + 1;
        else if (space > at * 0.4) split = space;
        chunks.push(rest.slice(0, split).trim());
        rest = rest.slice(split).trim();
      }
      if (rest) current = rest;
      continue;
    }

    if (!current) {
      current = sentence;
    } else if (current.length < MERGE_UNDER && current.length + sentence.length + 1 <= ceiling()) {
      // The chunk so far is a fragment ("Sure!"); saying it alone would sound clipped.
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) chunks.push(current);

  // A tiny opener ("Sure.", "Yes.") is over before the next chunk is ready, so
  // fold it forward when there is room. Only the first — later chunks always
  // have the whole of the one before them playing as cover.
  // The result still has to be a short opener, or folding forward just moves
  // the wait rather than removing it.
  const MERGED_FIRST_MAX = Math.round(firstLimit * 1.5);
  if (
    chunks.length > 1 &&
    chunks[0].length < MIN_FIRST &&
    chunks[0].length + chunks[1].length + 1 <= MERGED_FIRST_MAX
  ) {
    chunks.splice(0, 2, `${chunks[0]} ${chunks[1]}`);
  }

  return chunks;
}

// ── synthesis ─────────────────────────────────────────────────────────────

function cacheKey(text, voice) {
  return `${voice} ${text}`;
}

/**
 * @param {{ configDir: string, text: string, voice?: string, speed?: number }} options
 * @returns {Promise<{ audio: Buffer, contentType: string, voice: string }>} a wav
 */
function speak({ configDir, text, voice, speed }) {
  const spoken = speakableText(text);
  if (!spoken) throw new Error('There is nothing speakable in that text');
  const chosen = voice || DEFAULT_VOICE;

  const key = cacheKey(spoken, chosen);
  if (spoken.length <= CACHEABLE_CHARS && rendered.has(key)) {
    scheduleIdleUnload();
    return Promise.resolve({ audio: rendered.get(key), contentType: 'audio/wav', voice: chosen });
  }

  // One session, one utterance at a time.
  const run = queue.then(async () => {
    const engine = await load(configDir);
    const known = engine.voices && Object.hasOwn(engine.voices, chosen) ? chosen : DEFAULT_VOICE;
    const result = await engine.generate(spoken, {
      voice: known,
      speed: Number.isFinite(speed) && speed > 0.5 && speed < 2 ? speed : 1,
    });
    const audio = Buffer.from(result.toWav());

    if (spoken.length <= CACHEABLE_CHARS) {
      if (rendered.size >= CACHE_LIMIT) rendered.delete(rendered.keys().next().value);
      rendered.set(cacheKey(spoken, known), audio);
    }

    scheduleIdleUnload();
    return { audio, contentType: 'audio/wav', voice: known };
  });

  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** The voices the picker offers. Only needs the model's metadata, not a run. */
async function listVoices(configDir) {
  const engine = await load(configDir);
  scheduleIdleUnload();
  return Object.entries(engine.voices || {}).map(([id, info]) => ({
    id,
    name: info.name || id,
    language: info.language || '',
    gender: info.gender || '',
    quality: info.traits || info.overallGrade || '',
  }));
}

module.exports = {
  MODEL_ID,
  DEFAULT_VOICE,
  isReady,
  load,
  warmUp,
  unload,
  speak,
  listVoices,
  speakableText,
  chunkForSpeech,
  snapshot: () => hf.snapshot('voice'),
  isLoaded,
};
