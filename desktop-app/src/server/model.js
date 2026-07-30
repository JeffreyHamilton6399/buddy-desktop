/**
 * Buddy's brains, on disk.
 *
 * The app ships without a model — a 770 MB GGUF inside an installer would be a
 * miserable download for anyone who never opens it — so the first launch fetches
 * one and keeps it in <userData>/models forever. No key, no account, and after
 * this one download Buddy never needs the network again.
 *
 * More than one is on offer, because "which model" is the one choice where the
 * right answer depends on the machine: the 1 GB default is the only one that is
 * comfortable on a laptop with 8 GB of memory, while a desktop can run something
 * several times better. Every entry is a plain GGUF that llama.cpp loads through
 * builtin.js, so adding one is a matter of listing its URL, size and digest.
 *
 * Downloads resume if interrupted and are verified by SHA-256 before being
 * accepted, because a truncated multi-gigabyte file would otherwise surface as a
 * baffling crash inside llama.cpp rather than an honest "download failed".
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Sizes and digests come from HuggingFace's /paths-info API, where `lfs.oid` is
 * the file's real SHA-256. Do NOT use the HTTP etag: on Xet-backed repos that is
 * the xetHash, a different content-addressing scheme, which will fail every
 * check while looking exactly like a plausible digest.
 */
const CATALOG = [
  {
    id: 'llama-3.2-1b-instruct-q4_k_m',
    label: 'Llama 3.2 1B',
    blurb: 'Quick and light. Runs comfortably on any laptop, including without a GPU.',
    parameters: '1B',
    file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    url:
      'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/' +
      'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    bytes: 807694464,
    sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    memoryHint: 'about 1.5 GB of memory',
    isDefault: true,
  },
  {
    id: 'llama-3.2-3b-instruct-q4_k_m',
    label: 'Llama 3.2 3B',
    blurb: 'Noticeably better at following a thread and at longer answers.',
    parameters: '3B',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    url:
      'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/' +
      'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    bytes: 2019377696,
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    memoryHint: 'about 3 GB of memory',
  },
  {
    id: 'qwen2.5-3b-instruct-q4_k_m',
    label: 'Qwen 2.5 3B',
    blurb: 'Similar size to Llama 3B but stronger on code and step-by-step reasoning.',
    parameters: '3B',
    file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    url:
      'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/' +
      'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    bytes: 1929903264,
    sha256: '9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94',
    memoryHint: 'about 3 GB of memory',
  },
  {
    id: 'qwen2.5-7b-instruct-q4_k_m',
    label: 'Qwen 2.5 7B',
    blurb: 'The best answers on offer here, if the machine has the memory to spare.',
    parameters: '7B',
    file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    url:
      'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/' +
      'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    bytes: 4683074240,
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    memoryHint: 'about 6 GB of memory',
  },
];

const DEFAULT_ID = (CATALOG.find((entry) => entry.isDefault) || CATALOG[0]).id;

/** Kept for the many places that only ever cared about the default. */
const MODEL = CATALOG.find((entry) => entry.id === DEFAULT_ID);

const PROGRESS_THROTTLE_MS = 250;

/** @type {Map<string, {status:string, receivedBytes:number, bytesPerSecond:number, error:string|null}>} */
const states = new Map();
/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();
const listeners = new Set();

/** A model id that is definitely in the catalog. */
function resolveId(id) {
  return CATALOG.some((entry) => entry.id === id) ? id : DEFAULT_ID;
}

function get(id) {
  return CATALOG.find((entry) => entry.id === resolveId(id));
}

function stateOf(id) {
  if (!states.has(id)) {
    states.set(id, { status: 'idle', receivedBytes: 0, bytesPerSecond: 0, error: null });
  }
  return states.get(id);
}

function modelDir(configDir) {
  return path.join(configDir, 'models');
}

function modelPath(configDir, id) {
  return path.join(modelDir(configDir), get(id).file);
}

function partPath(configDir, id) {
  return `${modelPath(configDir, id)}.part`;
}

/** A model is only "ready" at exactly the expected size — a short file is not. */
function isReady(configDir, id) {
  try {
    return fs.statSync(modelPath(configDir, id)).size === get(id).bytes;
  } catch {
    return false;
  }
}

function snapshot(configDir, id) {
  const entry = get(id);
  const state = stateOf(entry.id);
  const ready = isReady(configDir, entry.id);
  const totalBytes = entry.bytes;
  const percent = totalBytes ? Math.min(100, (state.receivedBytes / totalBytes) * 100) : 0;
  const remaining = Math.max(0, totalBytes - state.receivedBytes);
  const busy = state.status === 'downloading' || state.status === 'verifying';

  return {
    model: {
      id: entry.id,
      label: entry.label,
      blurb: entry.blurb,
      parameters: entry.parameters,
      bytes: entry.bytes,
      memoryHint: entry.memoryHint,
    },
    status: ready && !busy ? 'ready' : state.status,
    ready,
    receivedBytes: ready && !busy ? totalBytes : state.receivedBytes,
    totalBytes,
    percent: ready && !busy ? 100 : Number(percent.toFixed(1)),
    bytesPerSecond: Math.round(state.bytesPerSecond),
    etaSeconds: state.bytesPerSecond > 0 ? Math.round(remaining / state.bytesPerSecond) : null,
    error: state.error,
  };
}

/** Every model, for the picker: what is downloaded, what is arriving, how big. */
function catalogSnapshot(configDir, activeId) {
  const active = resolveId(activeId);
  return {
    activeId: active,
    models: CATALOG.map((entry) => ({
      ...snapshot(configDir, entry.id),
      active: entry.id === active,
      isDefault: entry.id === DEFAULT_ID,
      downloading: inFlight.has(entry.id),
    })),
  };
}

function onProgress(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(configDir, id) {
  const payload = snapshot(configDir, id);
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      /* a broken listener must not stop a download */
    }
  }
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Fetch a model, resuming a partial file if one is lying around.
 * Safe to call repeatedly — concurrent callers share the one download.
 */
function ensureModel(configDir, id) {
  const entry = get(id);
  const key = entry.id;

  if (isReady(configDir, key)) {
    states.set(key, { status: 'ready', receivedBytes: entry.bytes, bytesPerSecond: 0, error: null });
    return Promise.resolve(snapshot(configDir, key));
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const run = (async () => {
    const target = modelPath(configDir, key);
    const partial = partPath(configDir, key);
    await fsp.mkdir(modelDir(configDir), { recursive: true });

    let alreadyHave = 0;
    try {
      alreadyHave = (await fsp.stat(partial)).size;
      if (alreadyHave > entry.bytes) {
        await fsp.unlink(partial); // nonsense on disk; start over
        alreadyHave = 0;
      }
    } catch {
      alreadyHave = 0;
    }

    const state = { status: 'downloading', receivedBytes: alreadyHave, bytesPerSecond: 0, error: null };
    states.set(key, state);
    emit(configDir, key);

    try {
      if (alreadyHave < entry.bytes) {
        const headers = alreadyHave > 0 ? { Range: `bytes=${alreadyHave}-` } : {};
        const response = await fetch(entry.url, { headers, redirect: 'follow' });

        if (!response.ok) throw new Error(`The model server returned ${response.status}`);
        // If we asked to resume and got a fresh 200, the server ignored us.
        const resuming = alreadyHave > 0 && response.status === 206;
        if (alreadyHave > 0 && !resuming) {
          await fsp.rm(partial, { force: true });
          alreadyHave = 0;
          state.receivedBytes = 0;
        }

        const sink = fs.createWriteStream(partial, { flags: resuming ? 'a' : 'w' });
        let received = alreadyHave;
        let windowBytes = 0;
        let windowStart = Date.now();
        let lastEmit = 0;

        try {
          for await (const chunk of response.body) {
            if (!sink.write(chunk)) {
              await new Promise((resolve) => sink.once('drain', resolve));
            }
            received += chunk.length;
            windowBytes += chunk.length;

            const now = Date.now();
            const elapsed = now - windowStart;
            if (elapsed >= 1000) {
              state.bytesPerSecond = (windowBytes / elapsed) * 1000;
              windowBytes = 0;
              windowStart = now;
            }
            state.receivedBytes = received;
            if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
              lastEmit = now;
              emit(configDir, key);
            }
          }
        } finally {
          await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())));
        }

        const finalSize = (await fsp.stat(partial)).size;
        if (finalSize !== entry.bytes) {
          throw new Error(`Download ended early — got ${finalSize} of ${entry.bytes} bytes`);
        }
      }

      state.status = 'verifying';
      state.bytesPerSecond = 0;
      emit(configDir, key);

      const digest = await sha256Of(partial);
      if (digest !== entry.sha256) {
        // Keep the bytes under a dead name rather than silently deleting gigabytes:
        // if this ever fires it is far more likely to be a stale expected hash
        // than a corrupt download, and the file is the evidence.
        await fsp.rename(partial, `${partial}.badhash`).catch(() => fsp.rm(partial, { force: true }));
        console.error(`[buddy] integrity check failed — expected ${entry.sha256}, got ${digest}`);
        throw new Error('The downloaded model did not match its expected checksum, so it was not used');
      }

      await fsp.rename(partial, target);
      states.set(key, { status: 'ready', receivedBytes: entry.bytes, bytesPerSecond: 0, error: null });
      emit(configDir, key);
      console.log(`[buddy] model ready: ${target}`);
      return snapshot(configDir, key);
    } catch (error) {
      // Leave the .part file alone unless it is corrupt — the next attempt resumes.
      state.status = 'error';
      state.bytesPerSecond = 0;
      state.error = error.message;
      emit(configDir, key);
      console.error('[buddy] model download failed:', error.message);
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

/** Free the disk again. */
async function removeModel(configDir, id) {
  const key = get(id).id;
  await fsp.rm(modelPath(configDir, key), { force: true });
  await fsp.rm(partPath(configDir, key), { force: true });
  states.set(key, { status: 'idle', receivedBytes: 0, bytesPerSecond: 0, error: null });
}

module.exports = {
  CATALOG,
  MODEL,
  DEFAULT_ID,
  resolveId,
  get,
  modelDir,
  modelPath,
  isReady,
  snapshot,
  catalogSnapshot,
  onProgress,
  ensureModel,
  removeModel,
  isDownloading: (id) => (id === undefined ? inFlight.size > 0 : inFlight.has(resolveId(id))),
};
