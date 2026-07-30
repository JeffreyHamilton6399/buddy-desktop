/**
 * Shared plumbing for the two ONNX-backed engines (voice.js, hearing.js).
 *
 * transformers.js is ESM-only and configures itself through a module-level
 * `env`, so it is imported once, lazily, and pointed at Buddy's own models
 * directory rather than the user's home cache — everything Buddy downloads
 * should be removable by deleting one folder.
 *
 * It also owns the download progress the settings UI polls. transformers.js
 * reports progress per file via `progress_callback`, so each pack keeps a table
 * of files and we sum it, which is the only way to get a total: the repos hold
 * several weights files and we cannot know their sizes before asking.
 */
'use strict';

const path = require('path');

/** Rough sizes, only for showing something honest before the first byte lands. */
const EXPECTED_BYTES = {
  voice: 164 * 1024 * 1024, // Kokoro-82M fp16 + voice embeddings
  hearing: 41 * 1024 * 1024, // whisper-tiny.en q8, encoder + decoder
};

let transformersPromise = null;

function cacheDir(configDir) {
  return path.join(configDir, 'models', 'hf');
}

/**
 * @param {string} configDir
 * @returns {Promise<any>} the transformers.js module, configured
 */
function getTransformers(configDir) {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      const mod = await import('@huggingface/transformers');
      mod.env.cacheDir = cacheDir(configDir);
      // Buddy never runs an image pipeline, and a browser cache does not exist
      // in this process — keep both out of the way.
      mod.env.allowLocalModels = true;
      mod.env.useBrowserCache = false;
      return mod;
    })();
    transformersPromise.catch(() => {
      transformersPromise = null;
    });
  }
  return transformersPromise;
}

// ── download progress, per pack ───────────────────────────────────────────

/**
 * @type {Map<string, { status: 'idle'|'downloading'|'loading'|'ready'|'error',
 *                      files: Map<string, {loaded:number,total:number}>,
 *                      error: string|null, startedAt: number }>}
 */
const packs = new Map();

function pack(id) {
  if (!packs.has(id)) {
    packs.set(id, { status: 'idle', files: new Map(), error: null, startedAt: 0 });
  }
  return packs.get(id);
}

function setStatus(id, status, error) {
  const entry = pack(id);
  entry.status = status;
  entry.error = error || null;
  if (status === 'downloading' && !entry.startedAt) entry.startedAt = Date.now();
  if (status === 'ready' || status === 'error') entry.startedAt = 0;
}

/**
 * Build the `progress_callback` transformers.js expects. Only genuine network
 * reads are recorded: a cache hit reports 'done' for a file we never saw
 * 'progress' for, and counting those would make a warm start look like a
 * 200 MB download that finished instantly.
 */
function progressCallback(id) {
  return (event) => {
    if (!event || !event.file) return;
    const entry = pack(id);
    if (event.status === 'progress' && Number(event.total) > 0) {
      if (entry.status !== 'downloading') setStatus(id, 'downloading');
      entry.files.set(event.file, { loaded: Number(event.loaded) || 0, total: Number(event.total) });
    } else if (event.status === 'done' && entry.files.has(event.file)) {
      const file = entry.files.get(event.file);
      file.loaded = file.total;
    }
  };
}

/** What the settings UI polls: one honest line about a pack's download. */
function snapshot(id) {
  const entry = pack(id);
  let loaded = 0;
  let total = 0;
  for (const file of entry.files.values()) {
    loaded += file.loaded;
    total += file.total;
  }

  // Before any file has announced itself there is no real total, so fall back to
  // the rough figure rather than dividing by zero and showing 0%.
  const knownTotal = total > 0 ? total : EXPECTED_BYTES[id] || 0;
  const elapsed = entry.startedAt ? (Date.now() - entry.startedAt) / 1000 : 0;
  const bytesPerSecond = elapsed > 0.5 ? loaded / elapsed : 0;
  const remaining = Math.max(0, knownTotal - loaded);

  return {
    status: entry.status,
    ready: entry.status === 'ready',
    receivedBytes: loaded,
    totalBytes: knownTotal,
    percent: knownTotal ? Number(Math.min(100, (loaded / knownTotal) * 100).toFixed(1)) : 0,
    bytesPerSecond: Math.round(bytesPerSecond),
    etaSeconds: bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null,
    error: entry.error,
  };
}

/** Forget a pack's progress so a retry starts from a clean slate. */
function reset(id) {
  packs.delete(id);
}

module.exports = { getTransformers, cacheDir, progressCallback, snapshot, setStatus, reset, EXPECTED_BYTES };
