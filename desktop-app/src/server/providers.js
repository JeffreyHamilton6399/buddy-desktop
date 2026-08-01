/**
 * Buddy's providers.
 *
 * Each capability — chat, speech synthesis, speech recognition — can be served
 * either by the z-ai cloud API or by something running on this machine:
 *
 *   chat  builtin │ ollama  │ cloud │ z-ai   builtin = llama.cpp inside the app
 *   tts   kokoro  │ system  │ z-ai           kokoro  = neural TTS inside the app
 *   asr   local   │ whisper │ z-ai  │ off    local = Whisper inside the app
 *
 * 'cloud' is any provider whose key the user has pasted — Anthropic, OpenAI,
 * Groq, and the rest; see keys.js. ('z-ai' predates it and goes through its own
 * bundled SDK, which is why it is still a provider of its own.)
 *
 * The defaults are the first of each, so out of the box Buddy thinks, speaks and
 * listens entirely on this machine: no key, no account, and nothing leaves the
 * device. `system` (the OS's own robotic voices) and `whisper` (a separate
 * transcription server you run) stay as alternatives, and `off` is still a real
 * choice for anyone who would rather Buddy could not hear at all. Mix and match
 * freely — local chat with cloud speech works, and so does the reverse.
 */
'use strict';

const files = require('./files.js');

// 'builtin' is llama.cpp inside the app — the default, so Buddy works with no
// key and no account the moment its model has downloaded.
const CHAT_PROVIDERS = ['builtin', 'z-ai', 'ollama', 'cloud'];
// 'kokoro' is neural TTS inside the app; 'system' is the OS's own voices, spoken
// in the renderer by speechSynthesis.
const TTS_PROVIDERS = ['kokoro', 'system', 'cloud', 'z-ai'];
// 'local' is Whisper inside the app. 'off' is still a real choice, not a failure:
// typing works exactly the same, and the mic and wake word simply stay dark.
const ASR_PROVIDERS = ['local', 'whisper', 'cloud', 'z-ai', 'off'];

/**
 * How big the orb is, in the two numbers that have to agree.
 *
 * `visual` is the circle you see; `window` is the transparent Electron window it
 * is centred in. The window is deliberately twice the circle, because a
 * transparent window cannot paint outside itself and the glow — a blurred disc
 * 1.5× the circle wide, spreading another ~0.17× in each direction as it blurs —
 * would otherwise be clipped into a square. See main.js and the orb rules in
 * styles.css, both of which derive their sizes from these.
 */
const ORB_SIZES = {
  small: { visual: 48, window: 96, label: 'Small' },
  medium: { visual: 64, window: 128, label: 'Medium' },
  large: { visual: 88, window: 176, label: 'Large' },
};

const THEMES = ['dark', 'light', 'system'];

/** The rose in the middle of the original amber → rose → fuchsia orb. */
const DEFAULT_ACCENT = '#f43f5e';
const DEFAULT_NAME = 'Buddy';
const DEFAULT_WAKE_WORD = 'Hey Buddy';

// Everything defaults to this machine: Buddy's own model, its own voice, and its
// own ears. Nothing to configure and nothing leaves the device.
const DEFAULTS = {
  chat: {
    provider: 'builtin',
    model: '',
    builtinModel: '',
    baseUrl: 'http://127.0.0.1:11434',
    // Which pasted key answers when provider is 'cloud', and with which model.
    cloudProvider: '',
    cloudModel: '',
  },
  tts: { provider: 'kokoro', voice: '', speed: 1, cloudProvider: '', cloudModel: '' },
  asr: {
    provider: 'local',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'Systran/faster-whisper-small',
    localModel: 'tiny.en',
    cloudProvider: '',
    cloudModel: '',
  },
  /**
   * What Buddy looks like. The accent is a single colour the user picks; the
   * three-stop gradient of the orb is derived from it in the renderer rather
   * than being three separate settings nobody would want to tune by hand.
   */
  look: { theme: 'dark', accent: DEFAULT_ACCENT, orbSize: 'medium' },
  /**
   * What Buddy is called, and what it answers to. Two settings rather than one:
   * calling it "Ada" while still saying "Hey Buddy" out loud is a perfectly
   * reasonable thing to want, and a wake phrase has to survive being transcribed
   * by Whisper, which not every good name does.
   */
  identity: { name: DEFAULT_NAME, wakeWord: DEFAULT_WAKE_WORD },
  /**
   * What Buddy should know about the person it is talking to, carried into
   * every conversation.
   *
   * A chat remembers itself and nothing beyond itself, so Buddy met everybody
   * as a stranger every time a new one was started — which for something that
   * lives on your desktop all day is the wrong shape entirely. This is the
   * cheapest possible fix for that: a few lines the user writes once, added to
   * the system prompt. Deliberately not learned or inferred, because a note
   * about yourself that you cannot see and did not write is a worse thing to
   * have than no note at all.
   */
  about: '',
  saveHistory: true,
  /**
   * Whether typed replies are read out loud in the panel. A real setting rather
   * than a per-window preference, so it is the same in both windows and is
   * where someone would look for it. The orb ignores it: talking is the whole
   * point of the orb, and silencing it would just leave a mute circle.
   */
  speakReplies: true,
  /**
   * Buddy reaching outside its own window is opt-in, always — but it is now one
   * decision rather than two.
   *
   * There used to be a switch for opening things and a second for files, and
   * nobody reading them could say what the difference bought them. This is the
   * whole of it: on, Buddy can open pages, run searches, look at the screen, and
   * read, write and delete files. Off, it can do none of them.
   *
   * Writing and deleting no longer require a folder to be named first. That was
   * a deliberate second lock and it is gone by request — see fileRoots for what
   * happens instead, and note that the guards which do not depend on it still
   * hold: programs and keys are refused by extension, deletes go to the recycle
   * bin, and every action is written into the transcript as it happens.
   */
  allowSystem: false,
  /**
   * Folders Buddy may write to and delete in.
   *
   * Empty now means the home folder rather than nowhere. Naming folders here
   * narrows it back down, which is the only way left to confine writing, so it
   * is worth doing if you ever want that.
   */
  fileRoots: [],
  /**
   * How far Buddy may look.
   *
   * 'folders'    — only the folders named in fileRoots, which is the old
   *                behaviour and stays the default.
   * 'everywhere' — read and list anything on this machine. Writing is *not*
   *                widened by this; it stays inside fileRoots either way. See
   *                scopedRoots in files.js for why those are separate.
   */
  fileScope: 'folders',
};

const FILE_SCOPES = ['folders', 'everywhere'];

/** Bumped whenever defaults change in a way an existing install should inherit. */
const SETTINGS_VERSION = 3;

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

  /**
   * The two permission switches became one, and the one grants more than either
   * did — writing and deleting no longer wait for a folder to be named.
   *
   * So it is only inherited by installs that had *both* halves on already.
   * Anyone who had opened things but never allowed files would otherwise wake
   * up after an update able to delete inside their home folder, having agreed
   * to no such thing. Those installs get the switch off and one flip to make,
   * which is the version of this that cannot surprise anybody.
   */
  const permissions = {};
  if (input.allowSystem === undefined) {
    permissions.allowSystem = input.allowActions === true && input.allowFiles === true;
  }

  return { ...input, tts, asr, ...permissions, version: SETTINGS_VERSION };
}

/**
 * A colour Buddy is willing to paint with: #rgb or #rrggbb, in any case, with
 * or without the hash. Everything else falls back rather than throwing, because
 * this value ends up interpolated straight into CSS.
 */
function normaliseHex(value, fallback) {
  const text = String(value == null ? '' : value).trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) {
    const [, r, g, b] = short;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const long = /^#?([0-9a-f]{6})$/i.exec(text);
  return long ? `#${long[1].toLowerCase()}` : fallback;
}

/**
 * Buddy's name is drawn into the panel header, handed to the model as part of
 * its system prompt, and used in a dozen bits of copy, so it is stripped back to
 * printable characters on a single line and capped at a length the header can
 * actually fit.
 */
function normaliseName(value, fallback) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return text || fallback;
}

/**
 * The wake phrase is only ever compared against a Whisper transcript, and that
 * transcript has already had its punctuation stripped and its case flattened by
 * the time the comparison happens. So anything that cannot survive that trip —
 * emoji, punctuation, symbols — is dropped here rather than quietly never
 * matching. Letters, digits, spaces, apostrophes and hyphens are what is left.
 */
function normaliseWakeWord(value, fallback) {
  const text = String(value == null ? '' : value)
    .replace(/[^\p{L}\p{N}' -]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return text || fallback;
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
  const look = input.look || {};
  const identity = input.identity || {};

  return {
    version: SETTINGS_VERSION,
    chat: {
      provider: pick(chat.provider, CHAT_PROVIDERS, DEFAULTS.chat.provider),
      model: text(chat.model, DEFAULTS.chat.model),
      builtinModel: text(chat.builtinModel, DEFAULTS.chat.builtinModel),
      baseUrl: text(chat.baseUrl, DEFAULTS.chat.baseUrl).replace(/\/+$/, ''),
      cloudProvider: text(chat.cloudProvider, DEFAULTS.chat.cloudProvider),
      cloudModel: text(chat.cloudModel, DEFAULTS.chat.cloudModel),
    },
    tts: {
      provider: pick(tts.provider, TTS_PROVIDERS, DEFAULTS.tts.provider),
      voice: text(tts.voice, DEFAULTS.tts.voice),
      speed: number(tts.speed, DEFAULTS.tts.speed, 0.6, 1.6),
      cloudProvider: text(tts.cloudProvider, DEFAULTS.tts.cloudProvider),
      cloudModel: text(tts.cloudModel, DEFAULTS.tts.cloudModel),
    },
    asr: {
      provider: pick(asr.provider, ASR_PROVIDERS, DEFAULTS.asr.provider),
      baseUrl: text(asr.baseUrl, DEFAULTS.asr.baseUrl).replace(/\/+$/, ''),
      model: text(asr.model, DEFAULTS.asr.model),
      // Which size of the in-app Whisper to use; validated by hearing.js.
      localModel: text(asr.localModel, DEFAULTS.asr.localModel),
      cloudProvider: text(asr.cloudProvider, DEFAULTS.asr.cloudProvider),
      cloudModel: text(asr.cloudModel, DEFAULTS.asr.cloudModel),
    },
    look: {
      theme: pick(look.theme, THEMES, DEFAULTS.look.theme),
      accent: normaliseHex(look.accent, DEFAULTS.look.accent),
      orbSize: pick(look.orbSize, Object.keys(ORB_SIZES), DEFAULTS.look.orbSize),
    },
    identity: {
      name: normaliseName(identity.name, DEFAULTS.identity.name),
      wakeWord: normaliseWakeWord(identity.wakeWord, DEFAULTS.identity.wakeWord),
    },
    saveHistory: input.saveHistory !== false,
    speakReplies: input.speakReplies !== false,
    // Capped because it rides on every single request: a page of prose here
    // would cost tokens on every turn of every conversation forever.
    about: text(input.about, DEFAULTS.about).slice(0, 600),
    // Default to false rather than true: this has to be asked for.
    allowSystem: input.allowSystem === true,
    fileRoots: files.normaliseRoots(input.fileRoots),
    fileScope: pick(input.fileScope, FILE_SCOPES, DEFAULTS.fileScope),
  };
}

/** True when a capability is answered by somebody else's server. */
function isCloud(provider) {
  return provider === 'cloud' || provider === 'z-ai';
}

function usesCloudChat(settings) {
  return isCloud(settings.chat.provider);
}

/** True when no capability touches the network. */
function isFullyLocal(settings) {
  return !isCloud(settings.chat.provider) && !isCloud(settings.tts.provider) && !isCloud(settings.asr.provider);
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

/**
 * Model names that can look at a picture.
 *
 * This list was resisted for a while on the grounds that it would be wrong
 * within a month, and that is true. It turned out to be the smaller problem.
 * Without it "cloud" alone meant eyes, so pointing Brain at Groq's
 * llama-3.3-70b — a text-only model — put a paperclip on the composer and then
 * answered a picture with `messages[20].content must be a string`, which is a
 * raw API error about a request the user never knew was being shaped for them.
 *
 * Being out of date fails the other way and fails quietly: a new vision model
 * is not recognised, so the paperclip stays away until a line is added here.
 * That is a feature briefly missing rather than a feature that visibly breaks,
 * which is the right way round.
 */
const VISION_MODELS = [
  // OpenAI
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4-(turbo|vision)/i,
  /gpt-5/i,
  // Anthropic — every Claude 3 and later reads images.
  /claude-3/i,
  /claude-(opus|sonnet|haiku)-\d/i,
  // Google
  /gemini/i,
  // Meta, on Groq and elsewhere. Llama 4 is multimodal throughout; of Llama 3
  // only the models with "vision" in the name are.
  /llama-?4/i,
  /llama-3\.2-\d+b-vision/i,
  /scout|maverick/i,
  // Mistral, xAI, and the open vision models people run through Ollama.
  /pixtral/i,
  /grok-\d*-?vision/i,
  /grok-[4-9]/i,
  /qwen.*vl/i,
  /llava/i,
  /moondream/i,
  /minicpm-?v/i,
  /internvl/i,
  // Ollama drops the hyphen — "gemma3:4b" where the cloud APIs say "gemma-3".
  /gemma-?3/i,
];

/** Whichever model id is actually in play for the current chat provider. */
function activeChatModel(settings) {
  const chat = settings.chat || {};
  if (chat.provider === 'cloud') return chat.cloudModel || '';
  if (chat.provider === 'ollama') return chat.model || '';
  return '';
}

/**
 * Can whatever is answering right now look at a picture?
 *
 * Two gates. The provider has to have an image path at all — which rules out
 * the built-in llama.cpp engine, running text-only GGUFs with no image encoder,
 * and the bundled z-ai SDK, which only ever sends text. Then the chosen model
 * has to be one that reads them, because "supports images" is a property of the
 * model and not of the company hosting it.
 *
 * An unrecognised model counts as no. Offering a paperclip that fails on use is
 * the failure worth avoiding, and a missing button is a question somebody asks
 * rather than a request that dies at the provider.
 */
function canSeeImages(settings) {
  const provider = (settings.chat || {}).provider;
  if (provider !== 'cloud' && provider !== 'ollama') return false;

  const model = activeChatModel(settings);
  if (!model) return false;
  return VISION_MODELS.some((pattern) => pattern.test(model));
}

/** Which capabilities still reach the cloud — used for honest in-app copy. */
function cloudCapabilities(settings) {
  const cloud = [];
  if (isCloud(settings.chat.provider)) cloud.push('chat');
  if (isCloud(settings.tts.provider)) cloud.push('tts');
  if (isCloud(settings.asr.provider)) cloud.push('asr');
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
    // Ollama takes pictures as bare base64 strings alongside the text, which is
    // its own shape again — see cloud.js for the other two.
    messages: messages.map((message) => ({
      role: message.role,
      content: String(message.content || ''),
      ...(Array.isArray(message.images) && message.images.length
        ? { images: message.images.map((image) => image.data) }
        : {}),
    })),
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
  canSeeImages,
  activeChatModel,
  usesCloudChat,
  isCloud,
  usesLocalVoice,
  usesLocalHearing,
  CHAT_PROVIDERS,
  TTS_PROVIDERS,
  ASR_PROVIDERS,
  ORB_SIZES,
  THEMES,
  FILE_SCOPES,
  DEFAULTS,
  SETTINGS_VERSION,
  normaliseHex,
  normaliseName,
  normaliseWakeWord,
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
