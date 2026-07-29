/**
 * Buddy's providers.
 *
 * Each capability — chat, speech synthesis, speech recognition — can be served
 * either by the z-ai cloud API or by something running on this machine:
 *
 *   chat  builtin │ ollama  │ z-ai   builtin = llama.cpp inside the app
 *   tts   system  │ z-ai            system  = the OS's own voices, in the renderer
 *   asr   off     │ whisper │ z-ai   whisper = a local /audio/transcriptions server
 *
 * The defaults are the first of each: Buddy answers with its own model, speaks
 * with the voices already on the machine, and keeps the microphone shut. Nothing
 * to configure, no key, and nothing leaves the device. Mix and match freely —
 * local chat with cloud speech works, and so does the reverse.
 */
'use strict';

const path = require('path');

// 'builtin' is llama.cpp inside the app — the default, so Buddy works with no
// key and no account the moment its model has downloaded.
const CHAT_PROVIDERS = ['builtin', 'z-ai', 'ollama'];
const TTS_PROVIDERS = ['z-ai', 'system'];
// 'off' is a real choice, not a failure: local mode without a Whisper server
// still works fine by typing, and the mic and wake word simply stay dark.
const ASR_PROVIDERS = ['z-ai', 'whisper', 'off'];

// Everything defaults to this machine: a bundled-in model, the OS's own voices,
// and the microphone closed. Nothing to configure and nothing leaves the device.
const DEFAULTS = {
  chat: { provider: 'builtin', model: '', baseUrl: 'http://127.0.0.1:11434' },
  tts: { provider: 'system', voice: '' },
  asr: { provider: 'off', baseUrl: 'http://127.0.0.1:8000/v1', model: 'Systran/faster-whisper-small' },
  saveHistory: true,
};

const OLLAMA_DEFAULT_MODEL = 'llama3.2';
const REQUEST_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 2500;

/** Coerce whatever is on disk into a complete, valid settings object. */
function normaliseSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (value, allowed, fallback) =>
    typeof value === 'string' && allowed.includes(value) ? value : fallback;
  const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

  const chat = input.chat || {};
  const tts = input.tts || {};
  const asr = input.asr || {};

  return {
    chat: {
      provider: pick(chat.provider, CHAT_PROVIDERS, DEFAULTS.chat.provider),
      model: text(chat.model, DEFAULTS.chat.model),
      baseUrl: text(chat.baseUrl, DEFAULTS.chat.baseUrl).replace(/\/+$/, ''),
    },
    tts: {
      provider: pick(tts.provider, TTS_PROVIDERS, DEFAULTS.tts.provider),
      voice: text(tts.voice, DEFAULTS.tts.voice),
    },
    asr: {
      provider: pick(asr.provider, ASR_PROVIDERS, DEFAULTS.asr.provider),
      baseUrl: text(asr.baseUrl, DEFAULTS.asr.baseUrl).replace(/\/+$/, ''),
      model: text(asr.model, DEFAULTS.asr.model),
    },
    saveHistory: input.saveHistory !== false,
  };
}

/** True when no capability touches the network. */
function isFullyLocal(settings) {
  return settings.chat.provider !== 'z-ai' && settings.tts.provider !== 'z-ai' && settings.asr.provider !== 'z-ai';
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
  CHAT_PROVIDERS,
  TTS_PROVIDERS,
  ASR_PROVIDERS,
  DEFAULTS,
  OLLAMA_DEFAULT_MODEL,
  normaliseSettings,
  isFullyLocal,
  cloudCapabilities,
  ollamaChat,
  listOllamaModels,
  whisperTranscribe,
  probeWhisper,
  probeProviders,
};
