/**
 * Buddy's brain, on disk.
 *
 * The app ships without a model — a 770 MB GGUF inside an installer would be a
 * miserable download for anyone who never opens it — so the first launch fetches
 * one and keeps it in <userData>/models forever. No key, no account, and after
 * this one download Buddy never needs the network again.
 *
 * The download resumes if it is interrupted and is verified by SHA-256 before
 * being accepted, because a truncated 770 MB file would otherwise surface as a
 * baffling crash inside llama.cpp rather than an honest "download failed".
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Llama 3.2 1B Instruct, 4-bit. Small enough to download once without
 * resentment and to run on a laptop with no GPU, big enough to hold a persona —
 * the 0.5B alternative forgets it is Buddy within a sentence.
 */
const MODEL = {
  id: 'llama-3.2-1b-instruct-q4_k_m',
  label: 'Llama 3.2 1B Instruct',
  file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
  url:
    'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/' +
    'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
  bytes: 807694464,
  // The file's real SHA-256, taken from the LFS oid in HuggingFace's
  // /paths-info API. Do NOT use the HTTP etag for this: on Xet-backed repos the
  // etag is the xetHash (a different content-addressing scheme), which will fail
  // every check while looking exactly like a plausible digest.
  sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
};

const PROGRESS_THROTTLE_MS = 250;

/** @type {{ status: 'idle'|'downloading'|'verifying'|'ready'|'error', receivedBytes: number, totalBytes: number, error: string|null }} */
let state = {
  status: 'idle',
  receivedBytes: 0,
  totalBytes: MODEL.bytes,
  bytesPerSecond: 0,
  error: null,
};

let inFlight = null;
const listeners = new Set();

function modelDir(configDir) {
  return path.join(configDir, 'models');
}

function modelPath(configDir) {
  return path.join(modelDir(configDir), MODEL.file);
}

function partPath(configDir) {
  return `${modelPath(configDir)}.part`;
}

/** A model is only "ready" at exactly the expected size — a short file is not. */
function isReady(configDir) {
  try {
    return fs.statSync(modelPath(configDir)).size === MODEL.bytes;
  } catch {
    return false;
  }
}

function snapshot(configDir) {
  const ready = isReady(configDir);
  const percent = state.totalBytes ? Math.min(100, (state.receivedBytes / state.totalBytes) * 100) : 0;
  const remaining = Math.max(0, state.totalBytes - state.receivedBytes);
  return {
    model: { id: MODEL.id, label: MODEL.label, bytes: MODEL.bytes },
    status: ready && state.status !== 'downloading' && state.status !== 'verifying' ? 'ready' : state.status,
    ready,
    receivedBytes: state.receivedBytes,
    totalBytes: state.totalBytes,
    percent: Number(percent.toFixed(1)),
    bytesPerSecond: Math.round(state.bytesPerSecond),
    etaSeconds: state.bytesPerSecond > 0 ? Math.round(remaining / state.bytesPerSecond) : null,
    error: state.error,
  };
}

function onProgress(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(configDir) {
  const payload = snapshot(configDir);
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      /* a broken listener must not stop a download */
    }
  }
}

async function sha256Of(file, onChunk) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
    if (onChunk) onChunk(chunk.length);
  }
  return hash.digest('hex');
}

/**
 * Fetch the model, resuming a partial file if one is lying around.
 * Safe to call repeatedly — concurrent callers share the one download.
 */
function ensureModel(configDir) {
  if (isReady(configDir)) {
    state = { ...state, status: 'ready', receivedBytes: MODEL.bytes, error: null };
    return Promise.resolve(snapshot(configDir));
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const target = modelPath(configDir);
    const partial = partPath(configDir);
    await fsp.mkdir(modelDir(configDir), { recursive: true });

    let alreadyHave = 0;
    try {
      alreadyHave = (await fsp.stat(partial)).size;
      if (alreadyHave > MODEL.bytes) {
        await fsp.unlink(partial); // nonsense on disk; start over
        alreadyHave = 0;
      }
    } catch {
      alreadyHave = 0;
    }

    state = {
      status: 'downloading',
      receivedBytes: alreadyHave,
      totalBytes: MODEL.bytes,
      bytesPerSecond: 0,
      error: null,
    };
    emit(configDir);

    try {
      if (alreadyHave < MODEL.bytes) {
        const headers = alreadyHave > 0 ? { Range: `bytes=${alreadyHave}-` } : {};
        const response = await fetch(MODEL.url, { headers, redirect: 'follow' });

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
              emit(configDir);
            }
          }
        } finally {
          await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())));
        }

        const finalSize = (await fsp.stat(partial)).size;
        if (finalSize !== MODEL.bytes) {
          throw new Error(`Download ended early — got ${finalSize} of ${MODEL.bytes} bytes`);
        }
      }

      state.status = 'verifying';
      state.bytesPerSecond = 0;
      emit(configDir);

      const digest = await sha256Of(partial);
      if (digest !== MODEL.sha256) {
        // Keep the bytes under a dead name rather than silently deleting 770 MB:
        // if this ever fires it is far more likely to be a stale expected hash
        // than a corrupt download, and the file is the evidence.
        await fsp.rename(partial, `${partial}.badhash`).catch(() => fsp.rm(partial, { force: true }));
        console.error(`[buddy] integrity check failed — expected ${MODEL.sha256}, got ${digest}`);
        throw new Error('The downloaded model did not match its expected checksum, so it was not used');
      }

      await fsp.rename(partial, target);
      state = { status: 'ready', receivedBytes: MODEL.bytes, totalBytes: MODEL.bytes, bytesPerSecond: 0, error: null };
      emit(configDir);
      console.log(`[buddy] model ready: ${target}`);
      return snapshot(configDir);
    } catch (error) {
      // Leave the .part file alone unless it is corrupt — the next attempt resumes.
      state.status = 'error';
      state.bytesPerSecond = 0;
      state.error = error.message;
      emit(configDir);
      console.error('[buddy] model download failed:', error.message);
      throw error;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Free the disk again. */
async function removeModel(configDir) {
  await fsp.rm(modelPath(configDir), { force: true });
  await fsp.rm(partPath(configDir), { force: true });
  state = { status: 'idle', receivedBytes: 0, totalBytes: MODEL.bytes, bytesPerSecond: 0, error: null };
}

module.exports = {
  MODEL,
  modelDir,
  modelPath,
  isReady,
  snapshot,
  onProgress,
  ensureModel,
  removeModel,
  isDownloading: () => Boolean(inFlight),
};
