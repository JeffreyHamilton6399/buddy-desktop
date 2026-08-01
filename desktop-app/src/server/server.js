/**
 * Buddy's local server.
 *
 * Plain Node http, bound to 127.0.0.1 on an OS-assigned port. It is the only
 * place the z-ai key is ever read, and the only thing that touches the chat
 * history on disk. The renderer sees neither.
 *
 * Endpoints
 *   GET    /health              is Buddy usable, and where does each capability run
 *   GET    /settings            current provider choices (never any secret)
 *   POST   /settings            change provider choices
 *   GET    /providers/status    probe the local stack: is Ollama up, which models
 *   GET    /model               how far the active chat model's download has got
 *   POST   /model               start or resume that download
 *   GET    /models              the whole catalog, plus any models Ollama offers
 *   POST   /models/:id          download one catalogue model
 *   DELETE /models/:id          give its disk space back
 *   GET    /speech              how far the voice and hearing downloads have got
 *   POST   /speech              start or resume those downloads
 *   GET    /voices              the voices Buddy can speak with
 *   POST   /setup               store the z-ai baseUrl + key
 *   GET    /keys                which API keys are saved, masked, and for whom
 *   POST   /keys                paste a key — Buddy works out whose it is
 *   GET    /keys/:id/models     what that key can reach
 *   DELETE /keys/:id            forget that key
 *   POST   /chat                send a message, get a reply
 *   POST   /tts/plan            split a reply into speakable chunks
 *   POST   /tts                 speak text (audio bytes, or a hand-off to the OS voice)
 *   POST   /asr                 transcribe a clip of 16 kHz float samples
 *   GET    /chats               list saved conversations
 *   GET    /chats/:id           read one conversation
 *   PATCH  /chats/:id           rename one conversation
 *   DELETE /chats/:id           delete one conversation
 *   DELETE /chats               delete every conversation
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const providers = require('./providers.js');
const actions = require('./actions.js');
const filesStore = require('./files.js');
const builtin = require('./builtin.js');
const keyStore = require('./keys.js');
const cloud = require('./cloud.js');
const modelStore = require('./model.js');
const voice = require('./voice.js');
const hearing = require('./hearing.js');
const audio = require('./audio.js');
const { History } = require('./history.js');

// ── SDK facts, verified against z-ai-web-dev-sdk@0.0.18 ────────────────────
// The published spec guessed at these; the real package differs, so:
//  * `ZAI.create()` takes NO arguments. It finds its own config by reading
//    `.z-ai-config` from, in order: process.cwd(), os.homedir(), /etc.
//    That is why getZai() below briefly chdir's into our config dir.
//  * TTS body key is `input` (not `text`), and the call resolves to the raw
//    `Response` object — we have to pull the bytes off it ourselves.
//  * ASR body key is `file_base64` (not `audio`), and it resolves to parsed
//    JSON with the transcript on `.text`.
//  * `thinking` already defaults to { type: 'disabled' } inside the SDK.
// ───────────────────────────────────────────────────────────────────────────

const CONFIG_FILENAME = '.z-ai-config';
const SETTINGS_FILENAME = 'buddy-settings.json';

/**
 * Who Buddy thinks it is.
 *
 * The name is a setting, so this is a function of it rather than a constant: a
 * model told it is called Buddy while the window above it says "Ada" will
 * cheerfully correct the user about their own assistant's name.
 */
const systemPrompt = (name) =>
  `You are ${name}, a friendly, warm, concise local AI assistant that lives on ` +
  "the user's desktop. Keep replies short, natural, and friendly — like a " +
  `helpful companion. Avoid long lists unless asked. Your name is ${name}; use ` +
  'it if you are asked what you are called.';

/**
 * Spoken answers are a different medium. Every extra sentence is another second
 * of synthesis before the user hears anything and another few they have to sit
 * through, and markdown is meaningless out loud.
 */
const systemPromptVoice = (name) =>
  `You are ${name}, a friendly local AI assistant. You are being spoken aloud, so ` +
  'answer in one or two short sentences of plain conversational English. No ' +
  'lists, no markdown, no code blocks. If the answer is genuinely long, give the ' +
  'short version and offer to say more.';

const VOICE_REPLY_TOKENS = 120;
const CLOUD_REPLY_TOKENS = 800;

/**
 * A model has no clock.
 *
 * Asked the time, it will either refuse or — worse, and much more commonly —
 * confidently invent one from whenever its training data stopped. Neither is
 * acceptable for something sitting on a desktop being asked "what time is it".
 * The machine knows, so tell it, on every single turn.
 *
 * This goes at the very top of the system prompt because a small model reads
 * the beginning far more reliably than the middle.
 */
function clockLine() {
  const now = new Date();
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* some minimal ICU builds have no zone; the date alone is still useful */
  }

  const stamp = now.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    `Right now it is ${stamp}${zone ? ` (${zone})` : ''} where the user is. ` +
    'That is the real current date and time, read from their computer. Use it ' +
    'directly whenever you are asked the time, the date, the day of the week, ' +
    "someone's age, or how long until something — never say you have no way to " +
    'know, and never guess a different date.'
  );
}

const MAX_TTS_CHARS = 1024;
const CONTEXT_MESSAGES = 20; // how much of a conversation the model is shown
const MAX_BODY_BYTES = 12 * 1024 * 1024; // audio clips arrive as base64

/** Where config, settings and chats live. Electron passes userData. */
function configDir() {
  return process.env.BUDDY_CONFIG_DIR || process.cwd();
}

const history = new History(configDir);

// ── z-ai credentials ──────────────────────────────────────────────────────

function configPath() {
  return path.join(configDir(), CONFIG_FILENAME);
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (parsed && parsed.baseUrl && parsed.apiKey) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function writeConfig({ apiKey, baseUrl }) {
  await fsp.mkdir(configDir(), { recursive: true });
  const body = JSON.stringify({ baseUrl, apiKey }, null, 2);
  // 0600: owner-only. Best effort — a no-op on some Windows filesystems.
  await fsp.writeFile(configPath(), body, { mode: 0o600 });
  try {
    await fsp.chmod(configPath(), 0o600);
  } catch {
    /* not fatal */
  }
}

// ── provider settings ─────────────────────────────────────────────────────

function settingsPath() {
  return path.join(configDir(), SETTINGS_FILENAME);
}

let settingsCache = null;

function readSettings() {
  if (settingsCache) return settingsCache;
  try {
    /**
     * The byte-order mark is stripped for the same reason buddy-state.json
     * strips it in main.js, and the stakes here are higher. JSON.parse throws on
     * a leading BOM, this catch then quietly hands back stock defaults, and the
     * user's model, voice, folders and API provider all appear to have reset
     * themselves — with the real settings still sitting intact on disk. Nothing
     * Buddy writes has one; anything else that has ever touched the file might.
     */
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^﻿/, ''));
    settingsCache = providers.normaliseSettings(providers.migrateSettings(onDisk));
  } catch {
    settingsCache = providers.normaliseSettings(null);
  }
  return settingsCache;
}

/** Which catalogue model the built-in brain should be using. */
function activeModelId(settings) {
  return modelStore.resolveId((settings || readSettings()).chat.builtinModel);
}

function settingsFileExists() {
  return fs.existsSync(settingsPath());
}

async function writeSettings(patch) {
  const merged = providers.normaliseSettings({
    ...readSettings(),
    ...patch,
    chat: { ...readSettings().chat, ...(patch.chat || {}) },
    tts: { ...readSettings().tts, ...(patch.tts || {}) },
    asr: { ...readSettings().asr, ...(patch.asr || {}) },
    look: { ...readSettings().look, ...(patch.look || {}) },
    identity: { ...readSettings().identity, ...(patch.identity || {}) },
  });
  await fsp.mkdir(configDir(), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(merged, null, 2));
  settingsCache = merged;
  return merged;
}

/**
 * Can Buddy actually work right now? A missing settings file means first run.
 * Any capability still pointing at z-ai needs the key to be present.
 */
function isConfigured() {
  const settings = readSettings();
  // The built-in model is the default, so a brand new install is "configured"
  // exactly when its model has finished downloading. The voice and the ears are
  // deliberately not part of this: Buddy is usable by typing while they arrive.
  if (providers.usesBuiltinModel(settings) && !modelStore.isReady(configDir(), activeModelId(settings))) return false;
  // A pasted key answers for chat; the older z-ai path answers for any of the
  // three, and still reads its credentials from .z-ai-config.
  if (settings.chat.provider === 'cloud' && !keyStore.has(configDir(), settings.chat.cloudProvider)) return false;
  const needsZai =
    settings.chat.provider === 'z-ai' || settings.tts.provider === 'z-ai' || settings.asr.provider === 'z-ai';
  if (!needsZai) return true;
  return Boolean(readConfig());
}

// ── z-ai client (lazy, memoised, invalidated by /setup) ────────────────────

let zaiPromise = null;

function resetZai() {
  zaiPromise = null;
}

async function getZai() {
  if (zaiPromise) return zaiPromise;
  zaiPromise = (async () => {
    if (!readConfig()) {
      throw Object.assign(new Error("That cloud provider needs an API key. Buddy's built-in model needs none — see buddy-settings.json"), { code: 'NO_CONFIG' });
    }
    // The SDK is ESM-only; we are CJS, so dynamic import is required.
    const mod = await import('z-ai-web-dev-sdk');
    const ZAI = mod.default || mod.ZAI;
    if (!ZAI || typeof ZAI.create !== 'function') {
      throw new Error('z-ai-web-dev-sdk did not export a ZAI class with .create()');
    }
    // ZAI.create() reads `.z-ai-config` relative to cwd, so point cwd at our
    // config dir just for the duration of the call, then put it back.
    const previousCwd = process.cwd();
    const target = configDir();
    let moved = false;
    try {
      if (path.resolve(previousCwd) !== path.resolve(target)) {
        process.chdir(target);
        moved = true;
      }
      return await ZAI.create();
    } finally {
      if (moved) {
        try {
          process.chdir(previousCwd);
        } catch {
          /* ignore */
        }
      }
    }
  })();
  // Don't cache a rejection — the user may be about to run setup.
  zaiPromise.catch(() => {
    zaiPromise = null;
  });
  return zaiPromise;
}

// ── response shape helpers (providers vary; be forgiving) ─────────────────

/**
 * Reasoning models think out loud, in tags.
 *
 * Qwen 3, DeepSeek R1 and GPT-OSS all wrap their working in `<think>` before
 * giving an answer. That is not something to show the user and it is certainly
 * not something to read aloud — a spoken reply would become thirty seconds of
 * the model talking itself through the problem. Take the answer and drop the
 * working.
 *
 * An unclosed tag means the reply hit its token limit mid-thought; everything
 * from the tag on is then working with no answer attached, so it goes too.
 */
function stripThinking(text) {
  let out = String(text || '');
  out = out.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '');
  // Some builds emit only the closing tag, with the working ahead of it.
  out = out.replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, '');
  return out.trim();
}

function extractReply(completion) {
  if (!completion) return '';
  if (typeof completion === 'string') return completion;
  const choice = completion.choices && completion.choices[0];
  const text =
    // Ollama's native shape comes first, then the OpenAI one.
    (completion.message && completion.message.content) ||
    (choice && choice.message && choice.message.content) ||
    (choice && choice.delta && choice.delta.content) ||
    (choice && choice.text) ||
    completion.response ||
    completion.reply ||
    completion.content ||
    '';
  return typeof text === 'string' ? text.trim() : '';
}

function extractTranscript(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  const direct =
    result.text ||
    result.transcript ||
    (typeof result.result === 'string' ? result.result : null) ||
    (result.result && (result.result.text || result.result.transcript)) ||
    (result.data && (result.data.text || result.data.transcript)) ||
    extractReply(result);
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (Array.isArray(result.segments)) {
    return result.segments
      .map((s) => (s && (s.text || s.transcript)) || '')
      .join(' ')
      .trim();
  }
  return '';
}

/** Find base64 audio in a JSON TTS response, for providers that don't send bytes. */
function extractAudioBase64(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  const candidates = [
    payload.audio,
    payload.data,
    payload.audio_base64,
    payload.audioContent,
    payload.choices && payload.choices[0] && payload.choices[0].delta && payload.choices[0].delta.content,
    payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 64) return value;
    if (Array.isArray(value) && value.length) {
      const first = value[0];
      if (typeof first === 'string' && first.length > 64) return first;
      if (first && typeof first.base64 === 'string') return first.base64;
      if (first && typeof first.audio === 'string') return first.audio;
    }
  }
  return null;
}

// ── http plumbing ─────────────────────────────────────────────────────────

/**
 * A loopback bind keeps other machines out, but any web page in any browser can
 * still POST to 127.0.0.1. A per-launch token (handed to the renderer by the
 * main process) is what actually keeps Buddy's endpoints ours.
 */
const AUTH_TOKEN = process.env.BUDDY_TOKEN || crypto.randomBytes(24).toString('hex');
const OPEN_ROUTES = new Set(['/health']);

function isAllowedOrigin(origin) {
  // The renderer is served over our own privileged `buddy://` scheme so that
  // the CSP can be generated per-launch (see main.js). curl and file:// send
  // no Origin at all.
  if (!origin || origin === 'null') return true;
  return origin.startsWith('buddy://') || origin.startsWith('file://');
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', isAllowedOrigin(origin) ? origin || 'null' : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Buddy-Token');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

/**
 * How much of a part-written reply is safe to show.
 *
 * A streamed reply arrives a few characters at a time, and some of those
 * characters are machinery the user must never see: an action marker is
 * stripped out of the final text, so streaming it raw would flash
 * `[[open_url: https://…]]` on screen and then take it away again. The same
 * goes for a model that thinks out loud in <think> tags.
 *
 * So everything from an unfinished marker or an unclosed think block onwards is
 * withheld until it closes, at which point it either disappears (it was
 * machinery) or is released in one go. A lone trailing `[` is held back too,
 * since the next character may be the one that makes it a marker.
 */
/**
 * Which brains can stream. Ollama and the bundled z-ai SDK answer in one piece
 * here, so asking them to stream would be a promise this cannot keep — the
 * caller falls back to waiting for the whole reply, which is what it did
 * before.
 */
/**
 * How much of an action's output the model is shown.
 *
 * A read of a file can be a megabyte, and the whole point of the context window
 * is that it is not. Enough for a document worth discussing, and the model is
 * told when it has been cut so it does not claim to have seen the end.
 */
const ACTION_RESULT_LIMIT = 4000;

/**
 * Turn what an action did into something a model can use.
 *
 * Written as prose rather than as a data structure, and addressed to the model
 * in the second person, because this arrives as an ordinary user turn — that is
 * the one shape every provider and every size of model already understands, and
 * inventing a `tool` role would mean teaching it to llama.cpp, both cloud
 * dialects and Ollama separately for no gain the user would ever see.
 *
 * The instruction at the end matters more than it looks. Without it a small
 * model reads the result, decides the job is not finished, and emits the same
 * marker again — which is a loop that reads the same file forever.
 */
function describeActionResult(result) {
  const what = String(result.description || result.name || 'that').slice(0, 120);

  if (result.ok === false) {
    return (
      `[Buddy tried to ${what} and it failed: ${String(result.error || 'unknown error').slice(0, 300)}]\n\n` +
      'Tell the user plainly that it did not work and why. Do not try the same thing again.'
    );
  }

  const detail = String(result.detail || '').trim();
  if (!detail) {
    return `[Buddy did ${what}, and it worked.]\n\nSay so briefly. Do not write another marker.`;
  }

  const clipped = detail.length > ACTION_RESULT_LIMIT;
  const shown = clipped ? detail.slice(0, ACTION_RESULT_LIMIT) : detail;
  return (
    `[Result of ${what}:]\n\n${shown}\n\n` +
    (clipped ? '[…truncated — this is only the beginning of it.]\n\n' : '') +
    'That is the real result. Answer the user using it. Do not write another marker unless something ' +
    'genuinely still needs doing.'
  );
}

/**
 * Keep a note of what has fallen out of the window.
 *
 * The model is only ever shown the last CONTEXT_MESSAGES turns, so a long
 * conversation forgets its own beginning — you can tell Buddy your sister's
 * name and have it gone twenty messages later, which is exactly the sort of
 * thing that makes an assistant feel stupid.
 *
 * So the turns that drop off the back are boiled down to a few lines and
 * carried in the system prompt instead. It costs one extra generation, which is
 * why it runs *after* the reply has been sent and nobody is waiting on it, and
 * why it is skipped entirely for a conversation short enough not to need one.
 *
 * Failure here is silent on purpose. A missing summary is a conversation that
 * remembers slightly less; an error shown to the user would be about machinery
 * they never asked for.
 */
/**
 * Summarise as soon as anything has fallen out of the window, not later.
 *
 * A generous trigger leaves a gap where the earliest turns are already out of
 * sight and not yet written down — the conversation forgets, and only starts
 * remembering again several messages afterwards. The first turn to drop off is
 * the moment the note is needed.
 */
const SUMMARY_TRIGGER = CONTEXT_MESSAGES + 2;
/** How many further messages before it is worth rewriting the note. */
const SUMMARY_REFRESH_EVERY = 4;
const SUMMARY_MAX_CHARS = 700;

/**
 * Ask whichever brain is configured a plain question, with none of the
 * machinery a real turn carries — no actions, no streaming, no history. For the
 * jobs Buddy does for itself rather than for the user.
 */
async function runModel(settings, messages, { maxTokens } = {}) {
  if (settings.chat.provider === 'builtin') {
    const modelId = activeModelId(settings);
    if (!modelStore.isReady(configDir(), modelId)) throw new Error('the model is not downloaded');
    return builtin.chat({ modelPath: modelStore.modelPath(configDir(), modelId), messages, maxTokens });
  }
  if (settings.chat.provider === 'ollama') {
    return providers.ollamaChat({ baseUrl: settings.chat.baseUrl, model: settings.chat.model, messages });
  }
  if (settings.chat.provider === 'cloud') {
    const credential = keyStore.get(configDir(), settings.chat.cloudProvider);
    if (!credential) throw new Error('no API key saved');
    return cloud.chat({ credential, model: settings.chat.cloudModel, messages, maxTokens });
  }
  const zai = await getZai();
  return zai.chat.completions.create({ messages, thinking: { type: 'disabled' } });
}

async function updateSummary(conversation, settings) {
  const total = conversation.messages.length;
  if (total < SUMMARY_TRIGGER) return;
  // Only redo it every few messages, rather than on every single turn.
  if (conversation.summarisedAt && total - conversation.summarisedAt < SUMMARY_REFRESH_EVERY) return;

  // Everything the next request will not be shown, plus what was already known.
  const dropped = conversation.messages.slice(0, Math.max(0, total - CONTEXT_MESSAGES));
  if (!dropped.length) return;

  const transcript = dropped
    .filter((message) => !message.kind)
    .map((message) => `${message.role === 'assistant' ? 'You' : 'They'}: ${String(message.content || '').slice(0, 400)}`)
    .join('\n')
    .slice(-6000);
  if (!transcript.trim()) return;

  const ask = [
    {
      role: 'system',
      content:
        'You compress a conversation into notes for your own later reference. ' +
        'Keep names, facts, decisions, preferences and anything the person asked you to remember. ' +
        'Drop pleasantries. Write plain sentences, no more than 120 words, no preamble.',
    },
    {
      role: 'user',
      content:
        (conversation.summary ? `Notes so far:\n${conversation.summary}\n\n` : '') +
        `Conversation to fold in:\n${transcript}`,
    },
  ];

  const note = await runModel(settings, ask, { maxTokens: 220 });
  const text = stripThinking(extractReply(note)).trim();
  if (!text) return;

  conversation.summary = text.slice(0, SUMMARY_MAX_CHARS);
  conversation.summarisedAt = total;
  if (settings.saveHistory) await history.persist(conversation);
}

function streamableProvider(settings) {
  return settings.chat.provider === 'builtin' || settings.chat.provider === 'cloud';
}

/** Everything that means "what follows is machinery, not speech". */
const MACHINERY = ['[[', '<think>', '<thinking>', '<reasoning>', '</think>', '</thinking>', '</reasoning>'];

/**
 * How many characters at the end might be the beginning of machinery.
 *
 * A stream arrives a character at a time, so `<think>` is preceded by `<`,
 * `<t`, `<th` and so on — none of which match anything, all of which would be
 * printed and then snatched back the moment the tag completed. Anything that
 * could still turn into a marker is held for one more character.
 */
function trailingPartial(text) {
  const longest = Math.max(...MACHINERY.map((token) => token.length)) - 1;
  for (let length = Math.min(longest, text.length); length > 0; length--) {
    const tail = text.slice(-length).toLowerCase();
    if (MACHINERY.some((token) => token.startsWith(tail))) return length;
  }
  return 0;
}

function visibleSoFar(raw) {
  let text = String(raw || '');
  // Complete machinery, wherever it sits.
  text = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/\[\[[\s\S]*?\]\]/g, '');
  // Machinery that has started and not finished. Only the earliest matters —
  // everything after it is inside the unclosed block.
  const openers = [text.search(/<(think|thinking|reasoning)>/i), text.indexOf('[[')].filter((at) => at !== -1);
  if (openers.length) text = text.slice(0, Math.min(...openers));
  // And machinery that has not finished starting.
  const partial = trailingPartial(text);
  return partial ? text.slice(0, -partial) : text;
}

/** One newline-delimited JSON event on an open response. */
function sendEvent(res, event) {
  res.write(JSON.stringify(event) + '\n');
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body must be valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Never let a key, or a provider error echoing one, reach a client or a log. */
function scrub(message) {
  const text = String(message || 'Unexpected error');
  let safe = text;

  const config = readConfig();
  if (config && config.apiKey) safe = safe.split(config.apiKey).join('«key»');
  // Every pasted key too — providers are fond of quoting the offending key back.
  for (const entry of keyStore.list(configDir())) {
    const stored = keyStore.get(configDir(), entry.id);
    if (stored && stored.apiKey) safe = safe.split(stored.apiKey).join('«key»');
  }

  return safe
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1«key»')
    .replace(/\bsk-[A-Za-z0-9._-]{12,}/g, '«key»')
    .slice(0, 500);
}

// ── route handlers ────────────────────────────────────────────────────────

function describeRuntime() {
  const settings = readSettings();
  const modelId = activeModelId(settings);
  const voiceReady = voice.isReady(configDir());
  const localWhisper = hearing.resolveModel(settings.asr.localModel);
  const hearingReady = hearing.isReady(configDir(), localWhisper);
  const savedKeys = keyStore.list(configDir());
  const cloudKey = settings.chat.provider === 'cloud' ? keyStore.get(configDir(), settings.chat.cloudProvider) : null;

  /** What to call whatever is currently answering, in one phrase. */
  const describeChatModel = () => {
    if (settings.chat.provider === 'builtin') return modelStore.get(modelId).label;
    if (settings.chat.provider === 'ollama') return settings.chat.model || providers.OLLAMA_DEFAULT_MODEL;
    if (settings.chat.provider === 'cloud') {
      const known = keyStore.describe(settings.chat.cloudProvider);
      const name = settings.chat.cloudModel || (cloudKey && cloudKey.model) || 'no model chosen';
      return `${name}${known ? ` · ${known.label}` : ''}`;
    }
    return settings.chat.model || 'GLM · z.ai';
  };

  return {
    ok: true,
    configured: isConfigured(),
    firstRun: !settingsFileExists() && !readConfig(),
    hasKey: Boolean(readConfig()) || savedKeys.length > 0,
    providers: {
      chat: settings.chat.provider,
      tts: settings.tts.provider,
      asr: settings.asr.provider,
    },
    // Which pasted keys are stored, masked, and which of them is answering.
    keys: savedKeys,
    cloudProvider: settings.chat.cloudProvider,
    cloudModel: settings.chat.cloudModel,
    needsKey: settings.chat.provider === 'cloud' && !cloudKey,
    chatModel: describeChatModel(),
    model: modelStore.snapshot(configDir(), modelId),
    needsModel: providers.usesBuiltinModel(settings) && !modelStore.isReady(configDir(), modelId),
    ttsVoice: settings.tts.voice || voice.DEFAULT_VOICE,
    ttsSpeed: settings.tts.speed,
    asrBaseUrl: settings.asr.baseUrl,
    asrLocalModel: localWhisper,
    asrLocalModels: Object.entries(hearing.MODELS).map(([id, entry]) => ({ id, label: entry.label })),
    // Whether each capability can actually run right now, which is what decides
    // if the UI offers a microphone and whether the orb may listen at all.
    // A cloud engine is only "ready" if there is a key to reach it with —
    // otherwise the UI offers a microphone that fails on first use.
    voiceReady:
      settings.tts.provider === 'kokoro'
        ? voiceReady
        : settings.tts.provider === 'cloud'
          ? keyStore.has(configDir(), settings.tts.cloudProvider)
          : true,
    hearingReady:
      settings.asr.provider === 'local'
        ? hearingReady
        : settings.asr.provider === 'cloud'
          ? keyStore.has(configDir(), settings.asr.cloudProvider)
          : settings.asr.provider !== 'off',
    // Which saved keys can do speech, so the pickers only offer what works.
    ttsProviders: keyStore.providersFor(configDir(), 'tts'),
    asrProviders: keyStore.providersFor(configDir(), 'asr'),
    ttsCloudProvider: settings.tts.cloudProvider,
    asrCloudProvider: settings.asr.cloudProvider,
    speech: { voice: voice.snapshot(), hearing: hearing.snapshot() },
    needsSpeech:
      (providers.usesLocalVoice(settings) && !voiceReady) || (providers.usesLocalHearing(settings) && !hearingReady),
    cloud: providers.cloudCapabilities(settings),
    fullyLocal: providers.isFullyLocal(settings),
    // Whether the composer should offer a paperclip at all.
    canSee: providers.canSeeImages(settings),
    // What Buddy is called and what it looks like. Every window reads these —
    // the orb paints itself from them and the panel titles itself from them —
    // so they ride along with the rest of the runtime rather than needing a
    // route of their own.
    look: settings.look,
    identity: settings.identity,
    about: settings.about,
    orbSizes: providers.ORB_SIZES,
    saveHistory: settings.saveHistory,
    speakReplies: settings.speakReplies,
    allowSystem: settings.allowSystem,
    fileRoots: settings.fileRoots,
    fileScope: settings.fileScope,
    // Where writing actually lands when no folder has been named, so the
    // settings pane can name it rather than saying "somewhere sensible".
    writeRoots: filesStore.scopedRoots(settings).write,
    // What "everywhere" actually means on this machine, so the settings pane can
    // show it rather than promising something vague.
    machineRoots: filesStore.machineRoots(),
  };
}

async function handleSetup(req, res) {
  const body = await readBody(req);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!apiKey) return sendJson(res, 400, { ok: false, error: 'apiKey is required' });
  if (!baseUrl) {
    return sendJson(res, 400, {
      ok: false,
      error: 'baseUrl is required (the SDK needs it, e.g. https://api.z.ai/api/paas/v4)',
    });
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return sendJson(res, 400, { ok: false, error: 'baseUrl must start with http:// or https://' });
  }
  await writeConfig({ apiKey, baseUrl: baseUrl.replace(/\/+$/, '') });
  resetZai();
  console.log('[buddy] z-ai credentials saved to', configPath());
  return sendJson(res, 200, { ok: true });
}

// ── pasted API keys ───────────────────────────────────────────────────────

/** Every saved key, masked, plus the catalogue so the UI can name providers. */
async function handleListKeys(_req, res) {
  return sendJson(res, 200, {
    keys: keyStore.list(configDir()),
    catalog: keyStore.CATALOG.map(({ id, label, hint, baseUrl, defaultModel }) => ({
      id,
      label,
      hint,
      baseUrl,
      defaultModel,
    })),
    active: readSettings().chat.cloudProvider,
  });
}

/**
 * Take a pasted key, work out whose it is, check it, and save it.
 *
 * The whole point is that this needs one field. A base URL is only ever asked
 * for when the key belongs to nobody recognisable, and then the error says so
 * rather than making the user guess what is missing.
 */
async function handleAddKey(req, res) {
  const body = await readBody(req);
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const chosen = typeof body.provider === 'string' ? body.provider.trim() : '';

  let found;
  try {
    found = await keyStore.inspect({ apiKey, baseUrl, provider: chosen });
  } catch (error) {
    return sendJson(res, error.status || 502, {
      error: scrub(error.message),
      needsProvider: Boolean(error.needsProvider),
      needsBaseUrl: Boolean(error.needsBaseUrl),
      provider: error.provider || null,
    });
  }

  const { provider, models } = found;
  // Prefer a model the provider actually listed — a default that has been
  // retired since this was written would otherwise 404 on the first message —
  // but never something that cannot hold a conversation. Groq lists its Whisper
  // builds here too, and picking blindly off the top of the list chose one.
  const model = keyStore.pickChatModel(models, provider.defaultModel);

  const saved = await keyStore.save(configDir(), {
    id: provider.id,
    apiKey,
    baseUrl: provider.baseUrl,
    model,
  });

  // The old z-ai path reads its own file, so keep that in step when the pasted
  // key turns out to be a z-ai one.
  if (provider.style === 'z-ai') {
    await writeConfig({ apiKey, baseUrl: provider.baseUrl });
    resetZai();
  }

  console.log(`[buddy] saved a ${provider.label} key (${keyStore.mask(apiKey)})`);
  return sendJson(res, 200, {
    ok: true,
    provider: { id: provider.id, label: provider.label, hint: provider.hint, baseUrl: provider.baseUrl },
    models,
    model: saved.model,
  });
}

/** The models one saved key can reach, for the picker. */
async function handleKeyModels(_req, res, [id]) {
  const credential = keyStore.get(configDir(), id);
  if (!credential) return sendJson(res, 404, { error: 'No key saved for that provider.' });
  if (credential.style === 'z-ai') return sendJson(res, 200, { models: [], selected: credential.model });

  try {
    const models = await keyStore.listModels(credential);
    // The picker is for choosing what answers, so transcription and image
    // models have no business being in it.
    return sendJson(res, 200, { models: keyStore.chatModels(models), selected: credential.model });
  } catch (error) {
    return sendJson(res, 502, { error: scrub(error.message) });
  }
}

async function handleRemoveKey(_req, res, [id]) {
  const removed = await keyStore.remove(configDir(), id);
  if (!removed) return sendJson(res, 404, { error: 'No key saved for that provider.' });

  // Deleting the key that is currently answering would leave Buddy mute with no
  // explanation, so hand the conversation back to the model on this machine.
  const settings = readSettings();
  if (settings.chat.provider === 'cloud' && settings.chat.cloudProvider === id) {
    await writeSettings({ chat: { provider: 'builtin', cloudProvider: '', cloudModel: '' } });
  }
  if (id === 'z-ai') resetZai();

  console.log(`[buddy] removed the ${id} key`);
  return sendJson(res, 200, { ok: true, keys: keyStore.list(configDir()), runtime: describeRuntime() });
}

async function handleGetSettings(_req, res) {
  return sendJson(res, 200, { settings: readSettings(), runtime: describeRuntime() });
}

async function handlePostSettings(req, res) {
  const before = readSettings();
  const beforeModelId = activeModelId(before);

  const body = await readBody(req);
  const settings = await writeSettings(body && typeof body === 'object' ? body : {});

  // A different brain means the loaded one is now the wrong one. Dropping it here
  // rather than on the next message keeps the memory honest and makes the switch
  // visible: the following reply is slow because it is loading what you chose.
  if (activeModelId(settings) !== beforeModelId || settings.chat.provider !== before.chat.provider) {
    await builtin.unload().catch(() => {});
  }
  if (before.tts.provider === 'kokoro' && settings.tts.provider !== 'kokoro') voice.unload();
  if (before.asr.provider === 'local' && settings.asr.provider !== 'local') await hearing.unload();

  console.log(
    `[buddy] providers → chat:${settings.chat.provider} tts:${settings.tts.provider} asr:${settings.asr.provider}`
  );
  return sendJson(res, 200, { ok: true, settings, runtime: describeRuntime() });
}

/** Where the active model's download has got to. Polled by the ready screen. */
async function handleModelState(_req, res) {
  return sendJson(res, 200, modelStore.snapshot(configDir(), activeModelId()));
}

/**
 * Start (or resume) the download. Returns immediately with the current state —
 * the caller polls GET /model rather than holding a request open for 770 MB.
 */
async function handleModelDownload(_req, res) {
  const id = activeModelId();
  if (modelStore.isReady(configDir(), id)) return sendJson(res, 200, modelStore.snapshot(configDir(), id));
  if (!modelStore.isDownloading(id)) {
    modelStore.ensureModel(configDir(), id).catch(() => {
      /* the error is already on the snapshot the client polls */
    });
  }
  return sendJson(res, 202, modelStore.snapshot(configDir(), id));
}

/**
 * The whole picker in one response: every model Buddy can download itself, plus
 * whatever an Ollama on this machine is offering. Ollama is probed rather than
 * assumed, so the picker can say "not running" instead of listing nothing.
 */
/**
 * The last answer from Ollama, and when it arrived.
 *
 * The settings pane polls /models several times a second while it is open so
 * downloads animate, and each call used to reach out to Ollama's port. Where
 * nothing is listening that costs a refused connection every time; where the
 * port is filtered rather than refused it costs the full probe timeout, which is
 * longer than the poll interval — so the probes pile up on top of each other.
 * Which models Ollama has does not change on that timescale.
 */
const OLLAMA_CACHE_MS = 10 * 1000;
let ollamaCache = { at: 0, baseUrl: '', models: null };

async function ollamaModels(baseUrl) {
  const fresh = Date.now() - ollamaCache.at < OLLAMA_CACHE_MS && ollamaCache.baseUrl === baseUrl;
  if (fresh) return ollamaCache.models;

  const models = await providers.listOllamaModels(baseUrl);
  ollamaCache = { at: Date.now(), baseUrl, models };
  return models;
}

async function handleListModels(_req, res) {
  const settings = readSettings();
  const catalog = modelStore.catalogSnapshot(configDir(), activeModelId(settings));
  const installed = await ollamaModels(settings.chat.baseUrl);

  return sendJson(res, 200, {
    ...catalog,
    provider: settings.chat.provider,
    ollama: {
      baseUrl: settings.chat.baseUrl,
      reachable: installed !== null,
      models: installed || [],
      active: settings.chat.provider === 'ollama' ? settings.chat.model || providers.OLLAMA_DEFAULT_MODEL : null,
    },
  });
}

async function handleDownloadModel(_req, res, [id]) {
  const resolved = modelStore.resolveId(id);
  if (resolved !== id) return sendJson(res, 404, { error: `No model called ${id}` });

  if (modelStore.isReady(configDir(), id)) return sendJson(res, 200, modelStore.snapshot(configDir(), id));
  if (!modelStore.isDownloading(id)) {
    modelStore.ensureModel(configDir(), id).catch(() => {
      /* the error is already on the snapshot the client polls */
    });
  }
  return sendJson(res, 202, modelStore.snapshot(configDir(), id));
}

async function handleRemoveModel(_req, res, [id]) {
  const resolved = modelStore.resolveId(id);
  if (resolved !== id) return sendJson(res, 404, { error: `No model called ${id}` });
  if (modelStore.isDownloading(id)) {
    return sendJson(res, 409, { error: 'That model is still downloading.' });
  }

  const settings = readSettings();
  // Deleting the model that is currently answering would leave Buddy mute with
  // no explanation, so the choice has to move somewhere that still exists.
  if (providers.usesBuiltinModel(settings) && activeModelId(settings) === id) {
    const fallback = modelStore.CATALOG.find(
      (entry) => entry.id !== id && modelStore.isReady(configDir(), entry.id)
    );
    if (!fallback) {
      return sendJson(res, 409, {
        error: 'That is the only model Buddy has to think with. Download another one first.',
      });
    }
    await writeSettings({ chat: { builtinModel: fallback.id } });
    await builtin.unload();
  }

  await modelStore.removeModel(configDir(), id);
  console.log(`[buddy] removed model ${id}`);
  return sendJson(res, 200, { ok: true, ...modelStore.catalogSnapshot(configDir(), activeModelId()) });
}

// ── voice and hearing assets ──────────────────────────────────────────────

async function handleSpeechState(_req, res) {
  return sendJson(res, 200, {
    voice: { ...voice.snapshot(), ready: voice.isReady(configDir()), loaded: voice.isLoaded() },
    hearing: { ...hearing.snapshot(), ready: hearing.isReady(configDir(), readSettings().asr.localModel), loaded: hearing.isLoaded() },
  });
}

/**
 * Pull down the voice and the ears. Both are loaded rather than merely fetched,
 * because transformers.js has no separate "download" step — asking for the model
 * is what downloads it, and having it warm is what we wanted anyway.
 */
async function handleSpeechDownload(req, res) {
  const body = await readBody(req);
  const want = typeof body.what === 'string' ? body.what : 'both';
  const settings = readSettings();

  if (want === 'voice' || want === 'both') {
    voice.warmUp(configDir(), { voice: settings.tts.voice || undefined }).catch(() => {
      /* the error is already on the snapshot the client polls */
    });
  }
  if (want === 'hearing' || want === 'both') {
    hearing.warmUp(configDir(), settings.asr.localModel).catch(() => {
      /* as above */
    });
  }
  return sendJson(res, 202, {
    voice: { ...voice.snapshot(), ready: voice.isReady(configDir()) },
    hearing: { ...hearing.snapshot(), ready: hearing.isReady(configDir(), settings.asr.localModel) },
  });
}

/**
 * Load whatever is needed into memory before it is asked for.
 *
 * Measured on this machine: a reply takes 0.1s once the model is resident and
 * 11.9s when it is not, so almost everything that reads as "the AI is slow" is
 * the one-off load. The orb calls this the instant it hears its name, which
 * overlaps the load with the moment the user spends asking their question.
 */
/**
 * @param {{ maintain?: boolean, ears?: boolean, brain?: boolean }} options
 *   `maintain` is a periodic keep-warm ping: it holds on to whatever is already
 *   loaded and loads nothing new. See builtin.warmUp for why the difference
 *   matters so much. `ears` exempts the transcriber from that, because it is
 *   the one engine the wake word cannot wait for — see hearing.warmUp.
 *
 *   `brain: false` says "everything except the language model". That is the
 *   startup case, and it is the difference between Buddy sitting idle costing
 *   a few hundred megabytes and costing several gigabytes of memory and over
 *   half a typical graphics card. The model is by far the largest thing here
 *   and the only one nothing needs until Buddy is actually spoken to.
 */
async function warmEverything({ maintain = false, ears = false, brain = true } = {}) {
  const settings = readSettings();
  const jobs = [];

  if (providers.usesBuiltinModel(settings)) {
    const id = activeModelId(settings);
    if (modelStore.isReady(configDir(), id)) {
      // Not wanting the brain is the same instruction as a maintenance ping:
      // keep it if somebody already loaded it, never load it from cold.
      jobs.push(builtin.warmUp(modelStore.modelPath(configDir(), id), { maintain: maintain || !brain }));
    }
  }
  if (providers.usesLocalVoice(settings) && voice.isReady(configDir())) {
    jobs.push(voice.warmUp(configDir(), { voice: settings.tts.voice || undefined, maintain }));
  }
  if (providers.usesLocalHearing(settings) && hearing.isReady(configDir(), settings.asr.localModel)) {
    jobs.push(hearing.warmUp(configDir(), settings.asr.localModel, { maintain, hold: ears }));
  }

  // Never let a warm-up failure surface as a request error; the real call will
  // report it properly if something is actually broken.
  await Promise.allSettled(jobs);
}

async function handleWarm(req, res) {
  const body = await readBody(req).catch(() => ({}));
  warmEverything({
    maintain: body && body.maintain === true,
    ears: body && body.ears === true,
    // Present and false is the only way to decline the brain; a bare /warm,
    // which is what the orb sends the instant it hears its name, still wants it.
    brain: !(body && body.brain === false),
  }).catch(() => {});
  return sendJson(res, 202, {
    warming: {
      chat: builtin.isLoaded(),
      voice: voice.isLoaded(),
      hearing: hearing.isLoaded(),
    },
  });
}

/** The voice picker's options. Needs the model on disk, so it may take a moment. */
async function handleListVoices(_req, res) {
  const settings = readSettings();

  // Whatever voices the chosen provider publishes. These are fixed lists rather
  // than a live call: neither OpenAI nor Groq has an endpoint that enumerates
  // them, and a free-text box just produces 404s on a typo.
  if (settings.tts.provider === 'cloud') {
    const known = keyStore.describe(settings.tts.cloudProvider);
    const voices = ((known && known.ttsVoices) || []).map((id) => ({ id, name: id }));
    return sendJson(res, 200, { provider: 'cloud', voices, selected: settings.tts.voice || (voices[0] || {}).id });
  }

  if (settings.tts.provider !== 'kokoro') {
    // The OS voices are only enumerable in the renderer, and z-ai's are fixed.
    return sendJson(res, 200, { provider: settings.tts.provider, voices: [], selected: settings.tts.voice });
  }
  if (!voice.isReady(configDir())) {
    return sendJson(res, 200, { provider: 'kokoro', voices: [], selected: settings.tts.voice, needsDownload: true });
  }
  return sendJson(res, 200, {
    provider: 'kokoro',
    voices: await voice.listVoices(configDir()),
    selected: settings.tts.voice || voice.DEFAULT_VOICE,
  });
}

async function handleProviderStatus(_req, res) {
  const status = await providers.probeProviders(readSettings());
  return sendJson(res, 200, status);
}

/**
 * Should the action instructions go on every turn, or only when the message
 * looks like a request?
 *
 * The keyword gate exists for one reason: handed the instructions on every
 * turn, a 1B model forgets its actual job — asked "what is 2+2?" it opens
 * Google. Anything of a reasonable size holds both at once, and for those the
 * gate is pure downside. "I need the weather forecast for tomorrow" contains no
 * word on the list, so a capable model never gets told it *could* search, and
 * invents a forecast instead. That is worse than the problem the gate solves.
 *
 * So: a cloud model, an Ollama model, or a local model of 4B or more always
 * gets the instructions. Only the genuinely small ones keep the keyword gate.
 */
function alwaysOffersActions(settings) {
  if (settings.chat.provider !== 'builtin') return true;
  const parameters = Number.parseFloat(modelStore.get(activeModelId(settings)).parameters);
  return Number.isFinite(parameters) && parameters >= 4;
}

/** Formats every vision API in use accepts, and that a browser can produce. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * Whatever the renderer sent, reduced to pictures worth forwarding.
 *
 * The base64 is checked for shape rather than merely trusted: it is about to be
 * interpolated into a `data:` URL and posted to somebody else's API, and a
 * malformed one comes back as an opaque 400 from the provider that looks like a
 * key problem. The size cap is what stops a phone photo from becoming a
 * multi-megabyte line in a chat file that is read on every launch.
 */
function normaliseImages(list) {
  if (!Array.isArray(list)) return [];

  const images = [];
  for (const entry of list.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (!entry || typeof entry !== 'object') continue;

    const mime = String(entry.mime || '').toLowerCase().trim();
    if (!IMAGE_TYPES.has(mime)) continue;

    // Accept a full data: URL too — that is what a paste or a drag-drop gives
    // the renderer, and stripping it there and here costs nothing.
    const data = String(entry.data || '').replace(/^data:[^,]*,/, '').trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    if (Buffer.byteLength(data, 'utf8') * 0.75 > MAX_IMAGE_BYTES) continue;

    images.push({ mime, data, ...(entry.name ? { name: String(entry.name).slice(0, 120) } : {}) });
  }
  return images;
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  /**
   * What came back from an action Buddy just performed.
   *
   * This is the second half of a turn rather than a new one: the model asked
   * for something, the main process did it, and this is the answer coming back
   * so the model can use it. So a request carrying one needs no user message —
   * nobody has said anything new.
   */
  const actionResult = body.actionResult && typeof body.actionResult === 'object' ? body.actionResult : null;

  if (!incoming.length && !actionResult) {
    return sendJson(res, 400, { error: 'messages must be a non-empty array' });
  }

  const settings = readSettings();
  await history.load();
  const conversation = history.resolve(body.sessionId);

  let added = 0;
  let sentImages = 0;

  if (actionResult) {
    history.append(conversation, 'user', describeActionResult(actionResult), null, 'action');
    added += 1;
  }

  for (const message of incoming) {
    const images = normaliseImages(message && message.images);
    const text = message && typeof message.content === 'string' ? message.content : '';
    // A picture on its own is a perfectly good message — "what is this?" is
    // implied — so blankness is only disqualifying when nothing came with it.
    if (!text.trim() && !images.length) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    history.append(conversation, role, text.slice(0, 8000), images);
    added += 1;
    sentImages += images.length;
  }

  // Every message was blank. This is what a transcription of silence looks like
  // by the time it reaches here, and it is a bad request rather than a failure
  // of the model — which would otherwise throw with nothing to reply to.
  if (!added) {
    return sendJson(res, 400, { error: 'There was nothing to reply to.', empty: true });
  }

  // Refuse before spending anything. The alternative is sending a picture to a
  // text-only model, which answers plausibly about an image it never received —
  // the single most confusing way this could fail.
  if (sentImages && !providers.canSeeImages(settings)) {
    /**
     * Name the actual reason. "The built-in model reads text only" was the only
     * explanation this ever gave, and once a text-only *cloud* model could
     * reach here too it was simply untrue — leaving somebody to go looking in
     * settings for a switch that was already set the way it said.
     */
    const model = providers.activeChatModel(settings);
    return sendJson(res, 400, {
      error: model
        ? `${model} reads text only, so it cannot look at pictures. Choose a model that can see — ` +
          'Llama 4, GPT-4o, Claude, Gemini or an Ollama vision model — under Brain.'
        : `${settings.identity.name}'s built-in model reads text only, so it cannot look at pictures. ` +
          'Switch Brain to a cloud provider, or to an Ollama vision model, and it will see them.',
      cannotSee: true,
    });
  }

  // Asked by voice, this answer is going to be read out — keep it to a sentence
  // or two rather than making the user listen to a wall of text.
  const spoken = body.voice === true;

  /**
   * The model only ever sees the tail of the conversation, however long it gets.
   *
   * Pictures ride along on the turn they arrived with, but only for providers
   * that can use them — carrying them to a text-only provider would put a stray
   * `images` key on a payload that has no idea what to do with it.
   */
  const seeing = providers.canSeeImages(settings);
  const context = conversation.messages.slice(-CONTEXT_MESSAGES).map(({ role, content, images }) => {
    // Pictures whose data has been aged out (see forgetOldPictures) keep their
    // place in the transcript but have nothing left to send.
    const usable = seeing && Array.isArray(images) ? images.filter((image) => image.data) : [];
    return { role, content, ...(usable.length ? { images: usable } : {}) };
  });
  const name = settings.identity.name;
  const basePrompt = spoken ? systemPromptVoice(name) : systemPrompt(name);

  /**
   * The two things that stop a conversation starting from nothing.
   *
   * `about` is what the user wrote about themselves and rides on every request
   * in every chat. The summary is this conversation's own past — the turns that
   * have fallen out of the window above — so a long exchange stops quietly
   * forgetting how it began while still only sending twenty messages.
   */
  const remembered = [];
  const about = String(settings.about || '').trim();
  if (about) remembered.push(`About the person you are talking to:\n${about}`);
  if (conversation.summary) {
    remembered.push(`Earlier in this conversation:\n${conversation.summary}`);
  }

  // Only hand over the action instructions when the last thing said looks like a
  // request to do something — see looksLikeRequest for why carrying them on every
  // turn makes a small model markedly worse at ordinary conversation.
  const lastSaid = [...conversation.messages].reverse().find((message) => message.role === 'user');
  const roots = filesStore.scopedRoots(settings);
  const permissions = {
    allowSystem: settings.allowSystem,
    fileRoots: settings.fileRoots,
    fileScope: settings.fileScope,
    readRoots: roots.read,
    writeRoots: roots.write,
  };
  const wantsAction =
    settings.allowSystem &&
    (alwaysOffersActions(settings) || actions.looksLikeRequest(lastSaid && lastSaid.content, permissions));
  const withClock = `${clockLine()}\n\n${basePrompt}`;
  const withMemory = remembered.length ? `${withClock}\n\n${remembered.join('\n\n')}` : withClock;
  const prompt = wantsAction ? `${withMemory}\n\n${actions.instructionsFor(permissions)}` : withMemory;
  const messages = [{ role: 'system', content: prompt }, ...context];

  let completion;
  /**
   * Streaming, when the caller asked and the provider can.
   *
   * The response becomes newline-delimited JSON rather than one object: any
   * number of `delta` events, then exactly one `done` carrying precisely what
   * the non-streaming reply would have carried. A client that does not ask for
   * it sees no change at all.
   *
   * Only the text is streamed. The action, the session and the saved history
   * are all decided after the last token, because a marker cannot be parsed
   * until it is complete and half of one is not an instruction.
   */
  const wantsStream = body.stream === true && streamableProvider(settings);

  /**
   * Stop generating when whoever asked has gone.
   *
   * Talking over Buddy used to silence the voice and nothing else: the model
   * carried on to the last token, holding several gigabytes of graphics card to
   * finish a sentence that was never going to be heard. The renderer now drops
   * the request when it is interrupted, and this is the other half — the socket
   * closing before the reply is finished means nobody is waiting, so the
   * generation is called off rather than run to completion for nobody.
   */
  const abandoned = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abandoned.abort();
  });

  /**
   * The header is written on the first thing actually sent, not here.
   *
   * Several checks below still answer with a plain status — the model is not
   * downloaded, the provider has no key — and those come after this point.
   * Committing to 200 up front would make every one of them a crash instead of
   * an error message.
   */
  let streamOpen = false;
  const beginStream = () => {
    if (streamOpen) return;
    streamOpen = true;
    /**
     * Nagle's algorithm has to go, or streaming is slower than not streaming.
     *
     * Each delta is a small write, and Nagle holds a small write back waiting
     * for more to coalesce with while the far end's delayed ACK waits for data
     * — so the two sit waiting for each other and every token costs about
     * 150ms. Measured here before this line: a reply the model generated in
     * 2.7s took 15s to deliver. The generation was never the problem.
     */
    if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Nothing between here and the renderer should be holding this back.
      'X-Accel-Buffering': 'no',
    });
  };

  let shown = '';
  const emit = (raw) => {
    if (!wantsStream) return;
    const visible = visibleSoFar(raw);
    if (visible.length <= shown.length) return;
    beginStream();
    sendEvent(res, { type: 'delta', text: visible.slice(shown.length) });
    shown = visible;
  };

  /** Accumulates the raw reply so each delta can be measured against the whole. */
  let streamed = '';
  const onDelta = wantsStream
    ? (piece) => {
        streamed += piece;
        emit(streamed);
      }
    : undefined;

  if (settings.chat.provider === 'builtin') {
    const modelId = activeModelId(settings);
    if (!modelStore.isReady(configDir(), modelId)) {
      return sendJson(res, 503, {
        error: "Buddy's model is still downloading.",
        needsModel: true,
        model: modelStore.snapshot(configDir(), modelId),
      });
    }
    completion = await builtin.chat({
      modelPath: modelStore.modelPath(configDir(), modelId),
      messages,
      maxTokens: spoken ? VOICE_REPLY_TOKENS : undefined,
      onDelta,
      signal: abandoned.signal,
    });
  } else if (settings.chat.provider === 'ollama') {
    completion = await providers.ollamaChat({
      baseUrl: settings.chat.baseUrl,
      model: settings.chat.model,
      messages,
    });
  } else if (settings.chat.provider === 'cloud') {
    const credential = keyStore.get(configDir(), settings.chat.cloudProvider);
    if (!credential) {
      return sendJson(res, 503, {
        error: 'That cloud provider has no API key saved. Add one under Brain in settings.',
        needsKey: true,
      });
    }
    completion = await cloud.chat({
      credential,
      model: settings.chat.cloudModel,
      messages,
      maxTokens: spoken ? VOICE_REPLY_TOKENS : CLOUD_REPLY_TOKENS,
      onDelta,
      signal: abandoned.signal,
    });
  } else {
    const zai = await getZai();
    completion = await zai.chat.completions.create({ messages, thinking: { type: 'disabled' } });
  }

  /**
   * Interrupted. The socket is gone, so there is nowhere to send this and
   * nobody to send it to — and a half-finished answer nobody heard is not worth
   * keeping in the transcript either. The question stays; the abandoned reply
   * to it does not.
   */
  if (abandoned.signal.aborted) return;

  const raw = stripThinking(extractReply(completion));
  if (!raw) throw new Error('The model returned an empty reply');

  // Only look for an action when the user has allowed them; otherwise the
  // syntax is just text, and text is all it stays.
  const parsed = wantsAction
    ? actions.extractAction(raw, permissions)
    : { reply: raw, action: null, refused: null };

  // What goes in the history is what was said, not the machinery. A model that
  // writes nothing but the marker — which the small one usually does, having been
  // shown examples — would otherwise leave the raw `[[open_url: …]]` as its reply.
  let reply = parsed.reply;
  if (!reply) reply = parsed.action ? `Okay — I'll ${parsed.action.description}.` : raw;
  history.append(conversation, 'assistant', reply);
  if (settings.saveHistory) await history.persist(conversation);

  if (parsed.action) console.log(`[buddy] action requested: ${parsed.action.name} → ${parsed.action.value}`);
  if (parsed.refused) console.warn(`[buddy] ${parsed.refused}`);

  const answer = {
    reply,
    sessionId: conversation.id,
    title: conversation.title,
    saved: settings.saveHistory,
    action: parsed.action,
    actionRefused: parsed.refused,
  };

  /**
   * Fold the fallen-off turns into the conversation's notes — after the answer
   * has gone, never before it. This costs a second generation, and the user
   * should not wait through it for a reply that is already written.
   */
  const remember = () =>
    updateSummary(conversation, settings).catch((error) =>
      console.warn('[buddy] could not update the conversation summary:', error.message)
    );

  if (wantsStream) {
    // The reply is sent in full rather than as a last delta. Streaming shows a
    // near-enough version — machinery withheld, markers removed — and this is
    // the authoritative text, so the client replaces rather than appends and
    // any difference between the two resolves in favour of this one.
    beginStream();
    sendEvent(res, { type: 'done', ...answer });
    res.end();
    remember();
    return;
  }

  sendJson(res, 200, answer);
  remember();
}

/**
 * Split a reply into the pieces Buddy will say one at a time. The renderer plays
 * each chunk while the next is still being synthesized, so speech starts about
 * half a second after a reply lands instead of after the whole thing is made.
 */
async function handleTtsPlan(req, res) {
  const body = await readBody(req);
  const raw = typeof body.text === 'string' ? body.text : '';
  if (!raw.trim()) return sendJson(res, 400, { error: 'text is required' });

  const settings = readSettings();
  // Only the local voice is generated a chunk at a time; the others are one call.
  if (settings.tts.provider !== 'kokoro') {
    const spoken = voice.speakableText(raw).slice(0, MAX_TTS_CHARS);
    return sendJson(res, 200, { chunks: spoken ? [spoken] : [] });
  }
  return sendJson(res, 200, { chunks: voice.chunkForSpeech(raw) });
}

async function handleTts(req, res) {
  const body = await readBody(req);
  const raw = typeof body.text === 'string' ? body.text.trim() : '';
  if (!raw) return sendJson(res, 400, { error: 'text is required' });

  const settings = readSettings();
  const input = raw.slice(0, MAX_TTS_CHARS);
  const chosenVoice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : settings.tts.voice;

  // Buddy's own voice: a neural model in this process. Nothing leaves the machine.
  if (settings.tts.provider === 'kokoro') {
    if (!voice.isReady(configDir())) {
      return sendJson(res, 503, {
        error: "Buddy's voice is still downloading.",
        needsSpeech: true,
        speech: voice.snapshot(),
      });
    }
    const spoken = await voice.speak({
      configDir: configDir(),
      text: input,
      voice: chosenVoice,
      speed: settings.tts.speed,
    });
    res.writeHead(200, {
      'Content-Type': spoken.contentType,
      'Content-Length': spoken.audio.length,
      'Cache-Control': 'no-store',
    });
    return res.end(spoken.audio);
  }

  // The OS voices live in the renderer process, so hand the text back and let
  // speechSynthesis say it. Nothing leaves the machine on this path either.
  if (settings.tts.provider === 'system') {
    return sendJson(res, 200, { mode: 'system', text: voice.speakableText(input), voice: chosenVoice });
  }

  // A voice from whichever key the user pasted.
  if (settings.tts.provider === 'cloud') {
    const credential = keyStore.get(configDir(), settings.tts.cloudProvider);
    if (!credential) {
      return sendJson(res, 503, {
        error: 'That cloud voice has no API key saved. Add one under Brain in settings.',
        needsKey: true,
      });
    }
    const known = keyStore.describe(settings.tts.cloudProvider);
    const spoken = await cloud.speak({
      credential,
      model: settings.tts.cloudModel || (known && known.ttsModel),
      voice: chosenVoice || (known && known.ttsVoices && known.ttsVoices[0]),
      input: voice.speakableText(input),
      speed: settings.tts.speed,
    });
    res.writeHead(200, {
      'Content-Type': spoken.contentType,
      'Content-Length': spoken.audio.length,
      'Cache-Control': 'no-store',
    });
    return res.end(spoken.audio);
  }

  const zai = await getZai();
  // Verified: the key is `input`, and this resolves to a raw Response.
  const response = await zai.audio.tts.create({
    input: voice.speakableText(input),
    voice: chosenVoice,
    response_format: 'wav',
    stream: false,
  });

  let audio = null;
  let contentType = 'audio/wav';

  if (response && typeof response.arrayBuffer === 'function') {
    const headerType = (response.headers && response.headers.get('content-type')) || '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (headerType.includes('application/json')) {
      const base64 = extractAudioBase64(JSON.parse(bytes.toString('utf8')));
      if (base64) audio = Buffer.from(base64, 'base64');
    } else {
      audio = bytes;
      if (headerType.startsWith('audio/')) contentType = headerType;
    }
  } else {
    const base64 = extractAudioBase64(response);
    if (base64) audio = Buffer.from(base64, 'base64');
  }

  if (!audio || !audio.length) throw new Error('The AI provider returned no audio');

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': audio.length,
    'Cache-Control': 'no-store',
  });
  return res.end(audio);
}

/**
 * The renderer always sends raw 16 kHz float samples, whichever provider is in
 * use — that is what the in-app Whisper wants, and giving the wav header to the
 * others here means the microphone code never has to know who is listening.
 * The older `{ audio, mimeType }` form still works for anything scripting this.
 */
async function handleAsr(req, res) {
  const body = await readBody(req);
  const settings = readSettings();

  if (settings.asr.provider === 'off') {
    return sendJson(res, 400, {
      error: 'Buddy is set not to listen. Turn hearing back on in settings to use the microphone.',
      asrOff: true,
    });
  }

  const sampleRate = Number(body.sampleRate) > 0 ? Number(body.sampleRate) : hearing.SAMPLE_RATE;
  const samples = typeof body.pcm === 'string' ? audio.float32FromBase64(body.pcm) : null;

  const supplied = typeof body.audio === 'string' ? body.audio : '';
  const encoded = supplied.includes(',') ? supplied.slice(supplied.indexOf(',') + 1) : supplied;

  if ((!samples || !samples.length) && !encoded.trim()) {
    return sendJson(res, 400, { error: 'pcm (base64 float32) or audio (base64) is required' });
  }

  if (settings.asr.provider === 'local') {
    if (!samples || !samples.length) {
      return sendJson(res, 400, {
        error: "Buddy's own ears need raw samples — send pcm rather than an encoded clip.",
      });
    }
    if (!hearing.isReady(configDir(), settings.asr.localModel)) {
      return sendJson(res, 503, {
        error: "Buddy's hearing is still downloading.",
        needsSpeech: true,
        speech: hearing.snapshot(),
      });
    }
    const text = await hearing.transcribe({
      configDir: configDir(),
      samples: audio.resample(samples, sampleRate, hearing.SAMPLE_RATE),
      model: settings.asr.localModel,
    });
    return sendJson(res, 200, { text });
  }

  // Everything else wants a file, so give the samples a wav header.
  const clip =
    samples && samples.length
      ? { bytes: audio.wavFromFloat32(samples, sampleRate), mimeType: 'audio/wav' }
      : {
          bytes: Buffer.from(encoded.trim(), 'base64'),
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'audio/webm',
        };

  if (settings.asr.provider === 'cloud') {
    const credential = keyStore.get(configDir(), settings.asr.cloudProvider);
    if (!credential) {
      return sendJson(res, 503, {
        error: 'That cloud transcription has no API key saved. Add one under Brain in settings.',
        needsKey: true,
      });
    }
    const known = keyStore.describe(settings.asr.cloudProvider);
    const text = await cloud.transcribe({
      credential,
      model: settings.asr.cloudModel || (known && known.asrModel),
      audio: clip.bytes,
      mimeType: clip.mimeType,
    });
    return sendJson(res, 200, { text: hearing.meaningfulText(text) });
  }

  if (settings.asr.provider === 'whisper') {
    const result = await providers.whisperTranscribe({
      baseUrl: settings.asr.baseUrl,
      model: settings.asr.model,
      audio: clip.bytes,
      mimeType: clip.mimeType,
    });
    return sendJson(res, 200, { text: hearing.meaningfulText(extractTranscript(result)) });
  }

  const zai = await getZai();
  // Verified: the key is `file_base64`, and the transcript comes back on .text.
  const result = await zai.audio.asr.create({ file_base64: clip.bytes.toString('base64') });
  return sendJson(res, 200, { text: hearing.meaningfulText(extractTranscript(result)) });
}

// ── chat history ──────────────────────────────────────────────────────────

async function handleListChats(_req, res) {
  await history.load();
  return sendJson(res, 200, { chats: history.list(), saveHistory: readSettings().saveHistory });
}

async function handleGetChat(_req, res, [id]) {
  await history.load();
  const conversation = history.get(id);
  if (!conversation) return sendJson(res, 404, { error: 'No such conversation' });
  return sendJson(res, 200, { chat: conversation });
}

async function handleRenameChat(req, res, [id]) {
  const body = await readBody(req);
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return sendJson(res, 400, { error: 'title is required' });
  }
  await history.load();
  const conversation = await history.rename(id, body.title);
  if (!conversation) return sendJson(res, 404, { error: 'No such conversation' });
  return sendJson(res, 200, { ok: true, title: conversation.title });
}

async function handleDeleteChat(_req, res, [id]) {
  await history.load();
  const removed = await history.remove(id);
  if (!removed) return sendJson(res, 404, { error: 'No such conversation' });
  return sendJson(res, 200, { ok: true });
}

async function handleClearChats(_req, res) {
  await history.load();
  const count = await history.clear();
  console.log(`[buddy] cleared ${count} conversation(s) from disk`);
  return sendJson(res, 200, { ok: true, deleted: count });
}

// ── routing ───────────────────────────────────────────────────────────────

const UUID = '([0-9a-fA-F-]{36})';
const MODEL_ID = '([a-z0-9][a-z0-9._-]{0,63})';
const PROVIDER_ID = '([a-z0-9][a-z0-9-]{0,31})';

const ROUTES = [
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, describeRuntime())],
  ['GET', /^\/settings$/, handleGetSettings],
  ['POST', /^\/settings$/, handlePostSettings],
  ['GET', /^\/providers\/status$/, handleProviderStatus],
  ['GET', /^\/model$/, handleModelState],
  ['POST', /^\/model$/, handleModelDownload],
  ['GET', /^\/models$/, handleListModels],
  ['POST', new RegExp(`^/models/${MODEL_ID}$`), handleDownloadModel],
  ['DELETE', new RegExp(`^/models/${MODEL_ID}$`), handleRemoveModel],
  ['GET', /^\/speech$/, handleSpeechState],
  ['POST', /^\/speech$/, handleSpeechDownload],
  ['POST', /^\/warm$/, handleWarm],
  ['GET', /^\/voices$/, handleListVoices],
  ['POST', /^\/setup$/, handleSetup],
  ['GET', /^\/keys$/, handleListKeys],
  ['POST', /^\/keys$/, handleAddKey],
  ['GET', new RegExp(`^/keys/${PROVIDER_ID}/models$`), handleKeyModels],
  ['DELETE', new RegExp(`^/keys/${PROVIDER_ID}$`), handleRemoveKey],
  ['POST', /^\/chat$/, handleChat],
  ['POST', /^\/tts\/plan$/, handleTtsPlan],
  ['POST', /^\/tts$/, handleTts],
  ['POST', /^\/asr$/, handleAsr],
  ['GET', /^\/chats$/, handleListChats],
  ['DELETE', /^\/chats$/, handleClearChats],
  ['GET', new RegExp(`^/chats/${UUID}$`), handleGetChat],
  ['PATCH', new RegExp(`^/chats/${UUID}$`), handleRenameChat],
  ['DELETE', new RegExp(`^/chats/${UUID}$`), handleDeleteChat],
];

function matchRoute(method, pathname) {
  let pathExists = false;
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    pathExists = true;
    if (routeMethod === method) return { handler, params: match.slice(1) };
  }
  return { handler: null, params: [], pathExists };
}

async function router(req, res) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/(.)\/+$/, '$1') || '/';

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    return sendJson(res, 403, { error: 'Origin not allowed' });
  }

  if (!OPEN_ROUTES.has(pathname)) {
    const supplied = req.headers['x-buddy-token'];
    const expected = Buffer.from(AUTH_TOKEN);
    const given = Buffer.from(typeof supplied === 'string' ? supplied : '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return sendJson(res, 401, { error: 'Missing or invalid X-Buddy-Token' });
    }
  }

  const { handler, params, pathExists } = matchRoute(req.method, pathname);
  if (!handler) {
    return sendJson(res, pathExists ? 405 : 404, {
      error: pathExists ? `${req.method} not allowed on ${pathname}` : `No route for ${req.method} ${pathname}`,
    });
  }

  try {
    await handler(req, res, params);
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    const isMissingConfig = error && error.code === 'NO_CONFIG';
    const message = isMissingConfig ? "That cloud provider needs an API key. Buddy's built-in model needs none — see buddy-settings.json" : scrub(error && error.message);
    console.error('[buddy]', req.method, pathname, '->', message);
    if (!res.headersSent) {
      sendJson(res, isMissingConfig ? 500 : status, { error: message, needsSetup: Boolean(isMissingConfig) });
    } else {
      // A stream that has already started cannot become a status code, so the
      // failure is delivered as its last event. Without this the connection
      // simply ends and the client is left holding half an answer with no way
      // to tell a finished reply from a broken one.
      try {
        res.write(JSON.stringify({ type: 'error', error: message }) + '\n');
      } catch {
        /* the socket has gone; nothing left to say */
      }
      res.end();
    }
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ port: number, token: string, server: http.Server }>}
 */
function start(options = {}) {
  const requested = Number.isInteger(options.port)
    ? options.port
    : Number.parseInt(process.env.BUDDY_PORT || '', 10) || 0;

  const server = http.createServer((req, res) => {
    router(req, res).catch((error) => {
      console.error('[buddy] unhandled:', scrub(error && error.message));
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  });

  return new Promise((resolve, reject) => {
    let triedFallback = false;

    server.on('error', (error) => {
      // A taken port is never a reason to refuse to start — grab a free one.
      if (error.code === 'EADDRINUSE' && !triedFallback && requested !== 0) {
        triedFallback = true;
        console.warn(`[buddy] port ${requested} is busy, asking the OS for a free one`);
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(error);
    });

    server.listen(requested, '127.0.0.1', async () => {
      const { port } = server.address();
      const settings = readSettings();
      await history.load().catch(() => {});

      const where = (provider) => (provider === 'z-ai' || provider === 'cloud' ? 'cloud' : 'local');
      console.log('');
      console.log('  ✦ Buddy local server');
      console.log(`    http://127.0.0.1:${port}`);
      console.log(`    config   ${configDir()}${isConfigured() ? '' : '  (not set up yet)'}`);
      const modelId = activeModelId(settings);
      const modelState = modelStore.snapshot(configDir(), modelId);
      console.log(
        `    chat     ${settings.chat.provider} (${where(settings.chat.provider)})` +
          (settings.chat.provider === 'ollama'
            ? ` · ${settings.chat.model || providers.OLLAMA_DEFAULT_MODEL} · ${settings.chat.baseUrl}`
            : '') +
          (settings.chat.provider === 'builtin'
            ? ` · ${modelStore.get(modelId).label} · ${modelState.ready ? 'model ready' : 'model NOT downloaded yet'}`
            : '') +
          (settings.chat.provider === 'cloud'
            ? ` · ${settings.chat.cloudProvider || 'no provider'} · ${settings.chat.cloudModel || 'no model'} · ${
                keyStore.has(configDir(), settings.chat.cloudProvider) ? 'key saved' : 'NO KEY SAVED'
              }`
            : '')
      );
      console.log(
        `    voice    ${settings.tts.provider} (${where(settings.tts.provider)})` +
          (settings.tts.provider === 'kokoro'
            ? ` · ${settings.tts.voice || voice.DEFAULT_VOICE} · ${
                voice.isReady(configDir()) ? 'ready' : 'NOT downloaded yet'
              }`
            : '')
      );
      console.log(
        `    hearing  ${settings.asr.provider} (${where(settings.asr.provider)})` +
          (settings.asr.provider === 'whisper' ? ` · ${settings.asr.baseUrl}` : '') +
          (settings.asr.provider === 'local'
            ? ` · ${settings.asr.localModel} · ${
                hearing.isReady(configDir(), settings.asr.localModel) ? 'ready' : 'NOT downloaded yet'
              }`
            : '')
      );
      console.log(
        `    history  ${settings.saveHistory ? 'saved on this device' : 'not saved'} · ` +
          `${history.list().length} conversation(s)`
      );
      if (providers.isFullyLocal(settings)) console.log('    ✓ fully local — nothing leaves this machine');
      if (!process.env.BUDDY_TOKEN) console.log(`    token    ${AUTH_TOKEN}`);
      console.log('');

      /**
       * Get the small engines ready now — but not the language model.
       *
       * Buddy sits open all day waiting to be spoken to, and the ears and voice
       * are tens of megabytes, so having those ready costs nothing worth
       * counting. The model is different: several gigabytes of weights and, on
       * a machine that offloads to the GPU, over half a typical card. Loading
       * it at launch meant merely having Buddy running made everything else on
       * the machine slower, whether or not anyone ever spoke to it.
       *
       * Nothing is lost by waiting. The orb calls /warm the instant it hears
       * its name, which overlaps the load with the seconds the user spends
       * asking their question — the case this was really for all along.
       */
      if (options.warm !== false) {
        const warmStarted = Date.now();
        warmEverything({ ears: true, brain: false })
          .then(() => console.log(`[buddy] warm and ready in ${((Date.now() - warmStarted) / 1000).toFixed(1)}s`))
          .catch(() => {});
      }

      resolve({ port, token: AUTH_TOKEN, server });
    });
  });
}

module.exports = {
  start,
  readConfig,
  readSettings,
  isConfigured,
  activeModelId,
  configPath,
  // Exported so the picture validation can be exercised on its own; it is the
  // gate between whatever the renderer sent and somebody else's API.
  normaliseImages,
  AUTH_TOKEN,
};

// Standalone: `npm run server`.
if (require.main === module) {
  start().catch((error) => {
    console.error('[buddy] failed to start:', error.message);
    process.exit(1);
  });
}
