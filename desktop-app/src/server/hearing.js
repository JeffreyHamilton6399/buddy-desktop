/**
 * Buddy's ears — Whisper tiny.en running on this machine.
 *
 * This is what makes "Hey Buddy" work without a key or an account. The orb
 * listens for a loud-enough stretch of sound, sends the clip here, and this
 * turns it into words; the same path serves the microphone button.
 *
 * tiny.en over base.en deliberately: measured here it is 39 MB against 73 MB,
 * transcribes a four-second clip in about half a second rather than nearly one,
 * and got the same words right on every phrase tried. Wake-word checks happen
 * constantly, so the fast one is also the kind one.
 *
 * Audio arrives as 16 kHz mono float samples, already decoded — the renderer
 * captures at that rate through an AudioWorklet, which keeps a compressed-audio
 * decoder out of this process entirely.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const hf = require('./hf.js');

const MODEL_ID = 'onnx-community/whisper-tiny.en';
const SAMPLE_RATE = 16000;
const WEIGHTS = [
  { file: 'encoder_model_quantized.onnx', minBytes: 8 * 1024 * 1024 },
  { file: 'decoder_model_merged_quantized.onnx', minBytes: 24 * 1024 * 1024 },
];

const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const MIN_SAMPLES = SAMPLE_RATE * 0.3; // shorter than this is a click, not a word
const MAX_SECONDS = 30; // Whisper's own window

let loadPromise = null;
let transcriber = null;
let queue = Promise.resolve();
let idleTimer = null;

// ── readiness ─────────────────────────────────────────────────────────────

function isReady(configDir) {
  const dir = path.join(hf.cacheDir(configDir), ...MODEL_ID.split('/'), 'onnx');
  return WEIGHTS.every((entry) => {
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

function load(configDir) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const alreadyOnDisk = isReady(configDir);
    const transformers = await hf.getTransformers(configDir);
    if (!alreadyOnDisk) hf.setStatus('hearing', 'downloading');

    const startedAt = Date.now();
    try {
      const pipe = await transformers.pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: hf.progressCallback('hearing'),
      });
      hf.setStatus('hearing', 'ready');
      transcriber = pipe;
      console.log(`[buddy] hearing ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (Whisper tiny.en)`);
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

async function warmUp(configDir) {
  await load(configDir);
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
function transcribe({ configDir, samples }) {
  if (!(samples instanceof Float32Array)) throw new Error('samples must be a Float32Array of 16 kHz audio');
  if (samples.length < MIN_SAMPLES) return Promise.resolve('');

  const clip = samples.length > SAMPLE_RATE * MAX_SECONDS ? samples.subarray(0, SAMPLE_RATE * MAX_SECONDS) : samples;

  const run = queue.then(async () => {
    const pipe = await load(configDir);
    const result = await pipe(clip);
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
