/**
 * Buddy's ears — Whisper running on this machine.
 *
 * This is what makes "Hey Buddy" work without a key or an account. The orb
 * listens for a loud-enough stretch of sound, sends the clip here, and this
 * turns it into words; the same path serves the microphone button.
 *
 * Two sizes are offered — see MODELS below for why the smaller one is the
 * default and when it is the wrong choice.
 *
 * Audio arrives as 16 kHz mono float samples, already decoded — the renderer
 * captures at that rate through an AudioWorklet, which keeps a compressed-audio
 * decoder out of this process entirely.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const hf = require('./hf.js');

/**
 * Two sizes, because which is right depends on the microphone.
 *
 * tiny.en is the default: half the download and roughly twice the speed.
 *
 * base.en is offered because it is generally the better model on poor audio, and
 * because being able to try something is worth a lot when the wake word is
 * mishearing you. An honest caveat: a synthetic test here — clean speech pushed
 * through 8 kHz and back, imitating a hands-free headset — scored them the same,
 * 3 of 4, with base.en simply slower. So it is offered as something to try, not
 * as a promise.
 */
const MODELS = {
  'tiny.en': {
    id: 'onnx-community/whisper-tiny.en',
    label: 'Faster — 39 MB, the default',
    weights: [
      { file: 'encoder_model_quantized.onnx', minBytes: 8 * 1024 * 1024 },
      { file: 'decoder_model_merged_quantized.onnx', minBytes: 24 * 1024 * 1024 },
    ],
  },
  'base.en': {
    id: 'onnx-community/whisper-base.en',
    label: 'Larger — 73 MB, slower, worth trying if it mishears you',
    weights: [
      { file: 'encoder_model_quantized.onnx', minBytes: 18 * 1024 * 1024 },
      { file: 'decoder_model_merged_quantized.onnx', minBytes: 40 * 1024 * 1024 },
    ],
  },
};

const DEFAULT_MODEL = 'tiny.en';
const MODEL_ID = MODELS[DEFAULT_MODEL].id;
const SAMPLE_RATE = 16000;

function resolveModel(name) {
  return MODELS[name] ? name : DEFAULT_MODEL;
}

const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const MIN_SAMPLES = SAMPLE_RATE * 0.3; // shorter than this is a click, not a word
const MAX_SECONDS = 30; // Whisper's own window

let loadPromise = null;
let transcriber = null;
/** Which size is currently resident, so a change of setting reloads. */
let loadedModel = null;
let queue = Promise.resolve();
let idleTimer = null;

// ── readiness ─────────────────────────────────────────────────────────────

function isReady(configDir, name) {
  const model = MODELS[resolveModel(name)];
  const dir = path.join(hf.cacheDir(configDir), ...model.id.split('/'), 'onnx');
  return model.weights.every((entry) => {
    try {
      return fs.statSync(path.join(dir, entry.file)).size >= entry.minBytes;
    } catch {
      return false;
    }
  });
}

// ── loading ───────────────────────────────────────────────────────────────

function scheduleIdleUnload() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => unload(), IDLE_UNLOAD_MS);
}

function load(configDir, name) {
  const wanted = resolveModel(name);
  // Switching size means the loaded one is the wrong one.
  if (loadedModel && loadedModel !== wanted) {
    loadPromise = null;
    const stale = transcriber;
    transcriber = null;
    loadedModel = null;
    if (stale) stale.dispose().catch(() => {});
  }
  if (loadPromise) return loadPromise;

  const model = MODELS[wanted];

  loadPromise = (async () => {
    const alreadyOnDisk = isReady(configDir, wanted);
    const transformers = await hf.getTransformers(configDir);
    if (!alreadyOnDisk) hf.setStatus('hearing', 'downloading');

    const startedAt = Date.now();
    try {
      const pipe = await transformers.pipeline('automatic-speech-recognition', model.id, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: hf.progressCallback('hearing'),
      });
      hf.setStatus('hearing', 'ready');
      transcriber = pipe;
      loadedModel = wanted;
      console.log(`[buddy] hearing ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (Whisper ${wanted})`);
      return pipe;
    } catch (error) {
      hf.setStatus('hearing', 'error', error.message);
      throw error;
    }
  })();

  loadPromise.catch(() => {
    loadPromise = null;
  });
  return loadPromise;
}

async function unload() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const current = transcriber;
  transcriber = null;
  loadPromise = null;
  if (!current) return;
  try {
    await current.dispose();
    console.log('[buddy] hearing unloaded after being idle');
  } catch {
    /* going away regardless */
  }
}

async function warmUp(configDir, name) {
  await load(configDir, name);
  scheduleIdleUnload();
}

// ── what counts as having heard something ─────────────────────────────────

/**
 * Given silence or noise, Whisper does not return nothing — it invents something,
 * because that is what its training transcripts did. Two flavours of invention:
 * a bracketed sound effect like "(wind blowing)" or "[BLANK_AUDIO]", and a stock
 * phrase from the end of a YouTube video. Measured here, two seconds of digital
 * silence reliably transcribes as "you".
 *
 * An always-listening orb feeds this near-silence all day, so both have to count
 * as "no words" — otherwise Buddy would answer a question nobody asked. Only a
 * transcript that is *entirely* one of these is dropped, so someone genuinely
 * saying "thank you" mid-sentence still gets through.
 */
const NON_SPEECH = new Set([
  'you',
  'thank you',
  'thanks',
  'thank you very much',
  'thanks for watching',
  'thanks for watching!',
  'please subscribe',
  'bye',
  'goodbye',
  'okay',
  'ok',
  'oh',
  'uh',
  'um',
  'hmm',
  'mm',
  'yeah',
  'so',
  'the',
  'a',
]);

function meaningfulText(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';

  // Strip bracketed sound descriptions wherever they appear.
  text = text
    .replace(/[([*][^)\]*]{0,60}[)\]*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Whatever survived has to contain an actual word.
  if (!/[a-z]/i.test(text)) return '';

  const bare = text
    .toLowerCase()
    .replace(/[^a-z\s!]/g, '')
    .trim();
  if (NON_SPEECH.has(bare)) return '';

  return text;
}

// ── transcription ─────────────────────────────────────────────────────────

/**
 * @param {{ configDir: string, samples: Float32Array }} options
 * @returns {Promise<string>} what was said, or '' when there were no words
 */
function transcribe({ configDir, samples, model }) {
  if (!(samples instanceof Float32Array)) throw new Error('samples must be a Float32Array of 16 kHz audio');
  if (samples.length < MIN_SAMPLES) return Promise.resolve('');

  const clip = samples.length > SAMPLE_RATE * MAX_SECONDS ? samples.subarray(0, SAMPLE_RATE * MAX_SECONDS) : samples;

  const run = queue.then(async () => {
    const pipe = await load(configDir, model);
    const result = await pipe(clip, {
      /**
       * Whisper can fall into a repetition loop on poor audio and emit the same
       * token until something stops it. Measured here on a narrowband clip it
       * produced several hundred exclamation marks and took thirteen seconds —
       * thirteen seconds during which nothing else could be transcribed, because
       * this queue is serial. A spoken sentence is nowhere near this many tokens,
       * so the cap costs nothing and bounds the damage.
       */
      max_new_tokens: 96,
      // Stops the loop forming in the first place rather than just truncating it.
      no_repeat_ngram_size: 6,
    });
    scheduleIdleUnload();
    return meaningfulText(result && result.text);
  });

  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

module.exports = {
  MODEL_ID,
  MODELS,
  DEFAULT_MODEL,
  resolveModel,
  SAMPLE_RATE,
  isReady,
  load,
  warmUp,
  unload,
  transcribe,
  meaningfulText,
  snapshot: () => hf.snapshot('hearing'),
  isLoaded: () => Boolean(transcriber),
};
