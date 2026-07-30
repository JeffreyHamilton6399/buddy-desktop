/**
 * Buddy's providers.
 *
 * Each capability — chat, speech synthesis, speech recognition — can be served
 * either by the z-ai cloud API or by something running on this machine:
 *
 *   chat  builtin │ ollama  │ z-ai      builtin = llama.cpp inside the app
 *   tts   kokoro  │ system  │ z-ai      kokoro  = neural TTS inside the app
 *   asr   local   │ whisper │ z-ai │ off  local = Whisper inside the app
 *
 * The defaults are the first of each, so out of the box Buddy thinks, speaks and
 * listens entirely on this machine: no key, no account, and nothing leaves the
 * device. `system` (the OS's own robotic voices) and `whisper` (a separate
 * transcription server you run) stay as alternatives, and `off` is still a real
 * choice for anyone who would rather Buddy could not hear at all. Mix and match
 * freely — local chat with cloud speech works, and so does the reverse.
 */
'use strict';

const path = require('path');

// 'builtin' is llama.cpp inside the app — the default, so Buddy works with no
// key and no account the moment its model has downloaded.
const CHAT_PROVIDERS = ['builtin', 'z-ai', 'ollama'];
// 'kokoro' is neural TTS inside the app; 'system' is the OS's own voices, spoken
// in the renderer by speechSynthesis.
const TTS_PROVIDERS = ['kokoro', 'system', 'z-ai'];
// 'local' is Whisper inside the app. 'off' is still a real choice, not a failure:
// typing works exactly the same, and the mic and wake word simply stay dark.
const ASR_PROVIDERS = ['local', 'whisper', 'z-ai', 'off'];

// Everything defaults to this machine: Buddy's own model, its own voice, and its
// own ears. Nothing to configure and nothing leaves the device.
const DEFAULTS = {
  chat: { provider: 'builtin', model: '', builtinModel: '', baseUrl: 'http://127.0.0.1:11434' },
  tts: { provider: 'kokoro', voice: '', speed: 1 },
  asr: { provider: 'local', baseUrl: 'http://127.0.0.1:8000/v1', model: 'Systran/faster-whisper-small' },
  saveHistory: true,
  // Buddy reaching outside its own window is opt-in, always.
  allowActions: false,
};

/** Bumped whenever defaults change in a way an existing install should inherit. */
const SETTINGS_VERSION = 2;

const OLLAMA_DEFAULT_MODEL = 'llama3.2';
const REQUEST_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 2500;

/**
 * Bring an older settings file forward.
 *
 * Buddy shipped before it had a voice or ears of its own, so those installs are
 * sitting on `tts: system` and `asr: off` — which were the best available then
 * and are now merely the fallbacks. Anyone who never chose those explicitly
 * should get the good ones on upgrade; anyone who did keep a deliberate choice
 * (the cloud, or a Whisper server of their own) is left exactly as they are.
 */
function migrateSettings(raw) {
  const input = raw && typeof raw === 'object' ? { ...raw } : {};
  if (Number(input.version) >= SETTINGS_VERSION) return input;

  const tts = { ...(input.tts || {}) };
  const asr = { ...(input.asr || {}) };

  if (!tts.provider || tts.provider === 'system') tts.provider = DEFAULTS.tts.provider;
  if (!asr.provider || asr.provider === 'off') asr.provider = DEFAULTS.asr.provider;
  // 'system' voices are named per OS ("Microsoft Zira Desktop"); a Kokoro voice
  // id looks nothing like that, so a carried-over name would never match.
  if (tts.provider === 'kokoro' && tts.voice && !/^[a-z]{2}_[a-z]+$/.test(tts.voice)) tts.voice = '';

  return { ...input, tts, asr, version: SETTINGS_VERSION };
}

/** Coerce whatever is on disk into a complete, valid settings object. */
function normaliseSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (value, allowed, fallback) =>
    typeof value === 'string' && allowed.includes(value) ? value : fallback;
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const number = (value, fallback, low, high) =>
    Number.isFinite(Number(value)) && Number(value) >= low && Number(value) <= high ? Number(value) : fallback;

  const chat = input.chat || {};
  const tts = input.tts || {};
  const asr = input.asr || {};

  return {
    version: SETTINGS_VERSION,
    chat: {
      provider: pick(chat.provider, CHAT_PROVIDERS, DEFAULTS.chat.provider),
      model: text(chat.model, DEFAULTS.chat.model),
      builtinModel: text(chat.builtinModel, DEFAULTS.chat.builtinModel),
      baseUrl: text(chat.baseUrl, DEFAULTS.chat.baseUrl).replace(/\/+$/, ''),
    },
    tts: {
      provider: pick(tts.provider, TTS_PROVIDERS, DEFAULTS.tts.provider),
      voice: text(tts.voice, DEFAULTS.tts.voice),
      speed: number(tts.speed, DEFAULTS.tts.speed, 0.6, 1.6),
    },
    asr: {
      provider: pick(asr.provider, ASR_PROVIDERS, DEFAULTS.asr.provider),
      baseUrl: text(asr.baseUrl, DEFAULTS.asr.baseUrl).replace(/\/+$/, ''),
      model: text(asr.model, DEFAULTS.asr.model),
    },
    saveHistory: input.saveHistory !== false,
    // Defaults to false rather than true: this one has to be asked for.
    allowActions: input.allowActions === true,
  };
}

/** True when no capability touches the network. */
function isFullyLocal(settings) {
  return settings.chat.provider !== 'z-ai' && settings.tts.provider !== 'z-ai' && settings.asr.provider !== 'z-ai';
}

/** True when speaking and listening are done by the models inside the app. */
function usesLocalVoice(settings) {
  return settings.tts.provider === 'kokoro';
}

function usesLocalHearing(settings) {
  return settings.asr.provider === 'local';
}

/** True when chat is answered by the model living inside the app. */
function usesBuiltinModel(settings) {
  return settings.chat.provider === 'builtin';
}

/** Which capabilities still reach the cloud — used for honest in-app copy. */
function cloudCapabilities(settings) {
  const cloud = [];
  if (settings.chat.provider === 'z-ai') cloud.push('chat');
  if (settings.tts.provider === 'z-ai') cloud.push('tts');
  if (settings.asr.provider === 'z-ai') cloud.push('asr');
  return cloud;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function postJson(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`${url} returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${url} did not respond in time`);
    throw error;
  } finally {
    done();
  }
}

// ── chat: ollama ──────────────────────────────────────────────────────────

/**
 * Ollama's native chat API. `extractReply` in server.js also understands the
 * OpenAI shape, so pointing this at an OpenAI-compatible local server works too.
 */
async function ollamaChat({ baseUrl, model, messages }) {
  const payload = await postJson(`${baseUrl}/api/chat`, {
    model: model || OLLAMA_DEFAULT_MODEL,
    messages,
    stream: false,
    options: { temperature: 0.7 },
  });
  return payload;
}

async function listOllamaModels(baseUrl) {
  const { signal, done } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.models)) return [];
    return payload.models.map((entry) => entry.name).filter(Boolean);
  } catch {
    return null; // unreachable
  } finally {
    done();
  }
}

// ── asr: local whisper ────────────────────────────────────────────────────

const AUDIO_EXTENSIONS = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
};

/**
 * Posts the clip to an OpenAI-compatible `/audio/transcriptions` route, which is
 * what faster-whisper-server, Speaches, LocalAI and whisper.cpp's server all
 * expose. The filename extension matters — most of them sniff the container
 * from it before handing the file to ffmpeg.
 */
async function whisperTranscribe({ baseUrl, model, audio, mimeType }) {
  const extension = AUDIO_EXTENSIONS[String(mimeType || '').split(';')[0]] || 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType || 'audio/webm' }), `clip.${extension}`);
  if (model) form.append('model', model);
  form.append('response_format', 'json');

  const { signal, done } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, { method: 'POST', body: form, signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Local transcription returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) return await response.json();
    return { text: await response.text() };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The local transcription server did not respond in time');
    throw error;
  } finally {
    done();
  }
}

async function probeWhisper(baseUrl) {
  const { signal, done } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    // /models is the conventional companion route; any answer proves it is up.
    const response = await fetch(`${baseUrl}/models`, { signal });
    return response.ok || response.status === 404 || response.status === 401;
  } catch {
    return false;
  } finally {
    done();
  }
}

/** What setup shows the user about their local stack. */
async function probeProviders(settings) {
  const [ollamaModels, whisperUp] = await Promise.all([
    listOllamaModels(settings.chat.baseUrl),
    probeWhisper(settings.asr.baseUrl),
  ]);

  return {
    ollama: {
      baseUrl: settings.chat.baseUrl,
      reachable: ollamaModels !== null,
      models: ollamaModels || [],
    },
    whisper: {
      baseUrl: settings.asr.baseUrl,
      reachable: whisperUp,
    },
  };
}

module.exports = {
  usesBuiltinModel,
  usesLocalVoice,
  usesLocalHearing,
  CHAT_PROVIDERS,
  TTS_PROVIDERS,
  ASR_PROVIDERS,
  DEFAULTS,
  SETTINGS_VERSION,
  OLLAMA_DEFAULT_MODEL,
  migrateSettings,
  normaliseSettings,
  isFullyLocal,
  cloudCapabilities,
  ollamaChat,
  listOllamaModels,
  whisperTranscribe,
  probeWhisper,
  probeProviders,
};
