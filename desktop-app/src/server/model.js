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
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Sizes and digests come from HuggingFace's /paths-info API, where `lfs.oid` is
 * the file's real SHA-256. Do NOT use the HTTP etag: on Xet-backed repos that is
 * the xetHash, a different content-addressing scheme, which will fail every
 * check while looking exactly like a plausible digest.
 */
/**
 * Every model is a Q4_K_M GGUF from bartowski, which keeps one quantisation and
 * one packager across the whole list — so "bigger is smarter and slower" is the
 * only axis a user has to reason about.
 *
 * `bytes` and `sha256` come from HuggingFace's paths-info API, where `lfs.oid`
 * is the file's real SHA-256. To add an entry, fetch them rather than typing
 * them: a wrong digest fails every download with a checksum error, and a wrong
 * size makes an already-downloaded model read as permanently unfinished.
 *
 * `needsBytes` is roughly the resident memory the model wants: the weights plus
 * the KV cache and overhead. It is what decides whether the library shows a
 * model as comfortable on this machine, so it errs generous.
 */
const GB = 1024 * 1024 * 1024;
const hf = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}`;

const CATALOG = [
  {
    id: 'minicpm5-1b-q4_k_m',
    label: 'MiniCPM5 1B',
    blurb: 'Tiny and surprisingly articulate. The one to try on an old laptop.',
    parameters: '1B',
    tags: ['small', 'fast', 'chat'],
    file: 'MiniCPM5-1B-Q4_K_M.gguf',
    url: hf('openbmb/MiniCPM5-1B-GGUF', 'MiniCPM5-1B-Q4_K_M.gguf'),
    bytes: 688065920,
    sha256: '81b64d05a23b17b34c475f42b3e72fbde62d4b92cc34541f7a8031d0752deafa',
    memoryHint: 'about 1.2 GB of memory',
    needsBytes: 1.2 * GB,
  },
  {
    id: 'lfm2.5-1.2b-instruct-q4_k_m',
    label: 'LFM2.5 1.2B',
    blurb: "Liquid AI's small model, built for running on the device rather than a server.",
    parameters: '1.2B',
    tags: ['small', 'fast', 'chat'],
    file: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    url: hf('LiquidAI/LFM2.5-1.2B-Instruct-GGUF', 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf'),
    bytes: 730895168,
    sha256: 'b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5',
    memoryHint: 'about 1.3 GB of memory',
    needsBytes: 1.3 * GB,
  },
  {
    id: 'llama-3.2-1b-instruct-q4_k_m',
    label: 'Llama 3.2 1B',
    blurb: 'Older, but dependable and undemanding. A safe fallback on weak hardware.',
    parameters: '1B',
    tags: ['small', 'fast'],
    file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    url: hf('bartowski/Llama-3.2-1B-Instruct-GGUF', 'Llama-3.2-1B-Instruct-Q4_K_M.gguf'),
    bytes: 807694464,
    sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    memoryHint: 'about 1.5 GB of memory',
    needsBytes: 1.5 * GB,
  },
  {
    id: 'granite-4.1-3b-q4_k_m',
    label: 'Granite 4.1 3B',
    blurb: "IBM's small model. Steady and literal, and good at sticking to instructions.",
    parameters: '3B',
    tags: ['chat', 'instructions'],
    file: 'granite-4.1-3b-Q4_K_M.gguf',
    url: hf('ibm-granite/granite-4.1-3b-GGUF', 'granite-4.1-3b-Q4_K_M.gguf'),
    bytes: 2099501664,
    sha256: '662b0626cd58f443baea23559b469df6576a81d349649c59413b36a9fb32eb29',
    memoryHint: 'about 3 GB of memory',
    needsBytes: 3 * GB,
  },
  {
    id: 'gemma-3-4b-it-q4_k_m',
    label: 'Gemma 3 4B',
    blurb: "Google's small model. Writes the most naturally of anything this size.",
    parameters: '4B',
    tags: ['chat', 'writing'],
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    url: hf('unsloth/gemma-3-4b-it-GGUF', 'gemma-3-4b-it-Q4_K_M.gguf'),
    bytes: 2489894016,
    sha256: '04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19',
    memoryHint: 'about 3.5 GB of memory',
    needsBytes: 3.5 * GB,
  },
  {
    id: 'qwen3-4b-instruct-2507-q4_k_m',
    label: 'Qwen 3 4B',
    blurb: 'The best all-round choice for most machines. Quick, current, and rarely wrong.',
    parameters: '4B',
    tags: ['chat', 'general', 'recommended'],
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: hf('unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
    bytes: 2497281120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    memoryHint: 'about 3.5 GB of memory',
    needsBytes: 3.5 * GB,
    isDefault: true,
  },
  {
    id: 'qwen2.5-coder-7b-instruct-q4_k_m',
    label: 'Qwen 2.5 Coder 7B',
    blurb: 'Tuned for code and shell commands. Weaker at ordinary conversation.',
    parameters: '7B',
    tags: ['code', 'programming'],
    file: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    url: hf('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', 'qwen2.5-coder-7b-instruct-q4_k_m.gguf'),
    bytes: 4683073536,
    sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
    memoryHint: 'about 6 GB of memory',
    needsBytes: 6 * GB,
  },
  {
    id: 'qwen2.5-7b-instruct-q4_k_m',
    label: 'Qwen 2.5 7B',
    blurb: 'The previous generation. Still perfectly good, and already proven.',
    parameters: '7B',
    tags: ['chat', 'general'],
    file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    url: hf('bartowski/Qwen2.5-7B-Instruct-GGUF', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'),
    bytes: 4683074240,
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    memoryHint: 'about 6 GB of memory',
    needsBytes: 6 * GB,
  },
  {
    id: 'qwen3-8b-q4_k_m',
    label: 'Qwen 3 8B',
    blurb: 'A clear step up from the 4B if the memory is there. Thinks before it answers.',
    parameters: '8B',
    tags: ['chat', 'general', 'reasoning'],
    file: 'Qwen3-8B-Q4_K_M.gguf',
    url: hf('unsloth/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf'),
    bytes: 5027784512,
    sha256: '120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4',
    memoryHint: 'about 6.5 GB of memory',
    needsBytes: 6.5 * GB,
  },
  {
    id: 'deepseek-r1-0528-qwen3-8b-q4_k_m',
    label: 'DeepSeek R1 8B',
    blurb: 'Reasons its way through problems step by step. Slower, and better at hard questions.',
    parameters: '8B',
    tags: ['reasoning', 'maths', 'thinking'],
    file: 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf',
    url: hf('lmstudio-community/DeepSeek-R1-0528-Qwen3-8B-GGUF', 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf'),
    bytes: 5027782720,
    sha256: '713d3a7a93f306763a6de2b5e9f9350e3aeee3bbfe8c3ee0066b61939feaa332',
    memoryHint: 'about 6.5 GB of memory',
    needsBytes: 6.5 * GB,
  },
  {
    id: 'gemma-3-12b-it-q4_k_m',
    label: 'Gemma 3 12B',
    blurb: "Google's larger model. Excellent prose, and a big appetite for memory.",
    parameters: '12B',
    tags: ['chat', 'writing'],
    file: 'gemma-3-12b-it-Q4_K_M.gguf',
    url: hf('unsloth/gemma-3-12b-it-GGUF', 'gemma-3-12b-it-Q4_K_M.gguf'),
    bytes: 7300778336,
    sha256: '15b8fd9d8672cd4240c178c217ca781409291f34e353d2e913b29c7602ceb3ff',
    memoryHint: 'about 9 GB of memory',
    needsBytes: 9 * GB,
  },
  {
    id: 'qwen3-14b-q4_k_m',
    label: 'Qwen 3 14B',
    blurb: 'Close to what a cloud model gives you, if the machine can hold it.',
    parameters: '14B',
    tags: ['chat', 'general', 'reasoning'],
    file: 'Qwen3-14B-Q4_K_M.gguf',
    url: hf('Qwen/Qwen3-14B-GGUF', 'Qwen3-14B-Q4_K_M.gguf'),
    bytes: 9001752960,
    sha256: '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
    memoryHint: 'about 11 GB of memory',
    needsBytes: 11 * GB,
  },
  {
    id: 'gpt-oss-20b-q4_k_m',
    label: 'GPT-OSS 20B',
    blurb: "OpenAI's open model. The most capable here, and the largest download by far.",
    parameters: '20B',
    tags: ['chat', 'general', 'reasoning', 'openai'],
    file: 'gpt-oss-20b-Q4_K_M.gguf',
    url: hf('unsloth/gpt-oss-20b-GGUF', 'gpt-oss-20b-Q4_K_M.gguf'),
    bytes: 11624759488,
    sha256: 'c27536640e410032865dc68781d80a08b98f8db5e93575919af8ccc0568aeb4f',
    memoryHint: 'about 14 GB of memory',
    needsBytes: 14 * GB,
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
      // What the search box matches on, beyond the name and description.
      tags: entry.tags || [],
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

/**
 * Every model, for the picker: what is downloaded, what is arriving, how big.
 *
 * `fits` is the useful part of a long list. Offering a dozen models is only an
 * improvement if the user can tell which of them their machine can actually
 * run, so each is measured against total RAM with a margin left for the rest of
 * the system — downloading nine gigabytes to discover it swaps is a bad
 * afternoon.
 */
function catalogSnapshot(configDir, activeId) {
  const active = resolveId(activeId);
  const usable = os.totalmem() * 0.7;
  return {
    activeId: active,
    totalMemoryBytes: os.totalmem(),
    models: CATALOG.map((entry) => ({
      ...snapshot(configDir, entry.id),
      active: entry.id === active,
      isDefault: entry.id === DEFAULT_ID,
      downloading: inFlight.has(entry.id),
      fits: !entry.needsBytes || entry.needsBytes <= usable,
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
