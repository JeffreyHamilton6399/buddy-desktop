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
const builtin = require('./builtin.js');
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

const SYSTEM_PROMPT =
  'You are Buddy, a friendly, warm, concise local AI assistant that lives on ' +
  "the user's desktop. Keep replies short, natural, and friendly — like a " +
  'helpful companion. Avoid long lists unless asked.';

/**
 * Spoken answers are a different medium. Every extra sentence is another second
 * of synthesis before the user hears anything and another few they have to sit
 * through, and markdown is meaningless out loud.
 */
const SYSTEM_PROMPT_VOICE =
  'You are Buddy, a friendly local AI assistant. You are being spoken aloud, so ' +
  'answer in one or two short sentences of plain conversational English. No ' +
  'lists, no markdown, no code blocks. If the answer is genuinely long, give the ' +
  'short version and offer to say more.';

const VOICE_REPLY_TOKENS = 120;

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
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
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
  if (providers.cloudCapabilities(settings).length === 0) return true;
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
  const config = readConfig();
  let safe = text;
  if (config && config.apiKey) safe = safe.split(config.apiKey).join('«key»');
  return safe.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1«key»').slice(0, 500);
}

// ── route handlers ────────────────────────────────────────────────────────

function describeRuntime() {
  const settings = readSettings();
  const modelId = activeModelId(settings);
  const voiceReady = voice.isReady(configDir());
  const hearingReady = hearing.isReady(configDir());

  return {
    ok: true,
    configured: isConfigured(),
    firstRun: !settingsFileExists() && !readConfig(),
    hasKey: Boolean(readConfig()),
    providers: {
      chat: settings.chat.provider,
      tts: settings.tts.provider,
      asr: settings.asr.provider,
    },
    chatModel:
      settings.chat.provider === 'builtin'
        ? modelStore.get(modelId).label
        : settings.chat.model || providers.OLLAMA_DEFAULT_MODEL,
    model: modelStore.snapshot(configDir(), modelId),
    needsModel: providers.usesBuiltinModel(settings) && !modelStore.isReady(configDir(), modelId),
    ttsVoice: settings.tts.voice || voice.DEFAULT_VOICE,
    ttsSpeed: settings.tts.speed,
    asrBaseUrl: settings.asr.baseUrl,
    greeting: voice.GREETING,
    // Whether each capability can actually run right now, which is what decides
    // if the UI offers a microphone and whether the orb may listen at all.
    voiceReady: settings.tts.provider === 'kokoro' ? voiceReady : true,
    hearingReady: settings.asr.provider === 'local' ? hearingReady : settings.asr.provider !== 'off',
    speech: { voice: voice.snapshot(), hearing: hearing.snapshot() },
    needsSpeech:
      (providers.usesLocalVoice(settings) && !voiceReady) || (providers.usesLocalHearing(settings) && !hearingReady),
    cloud: providers.cloudCapabilities(settings),
    fullyLocal: providers.isFullyLocal(settings),
    saveHistory: settings.saveHistory,
    allowActions: settings.allowActions,
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
async function handleListModels(_req, res) {
  const settings = readSettings();
  const catalog = modelStore.catalogSnapshot(configDir(), activeModelId(settings));
  const installed = await providers.listOllamaModels(settings.chat.baseUrl);

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
    hearing: { ...hearing.snapshot(), ready: hearing.isReady(configDir()), loaded: hearing.isLoaded() },
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
    voice.warmUp(configDir(), { greetingVoice: settings.tts.voice || undefined }).catch(() => {
      /* the error is already on the snapshot the client polls */
    });
  }
  if (want === 'hearing' || want === 'both') {
    hearing.warmUp(configDir()).catch(() => {
      /* as above */
    });
  }
  return sendJson(res, 202, {
    voice: { ...voice.snapshot(), ready: voice.isReady(configDir()) },
    hearing: { ...hearing.snapshot(), ready: hearing.isReady(configDir()) },
  });
}

/**
 * Load whatever is needed into memory before it is asked for.
 *
 * Measured on this machine: a reply takes 0.1s once the model is resident and
 * 11.9s when it is not, so almost everything that reads as "the AI is slow" is
 * the one-off load. The orb calls this the instant it hears its name, which
 * overlaps the load with the second or so of greeting it speaks back.
 */
async function warmEverything() {
  const settings = readSettings();
  const jobs = [];

  if (providers.usesBuiltinModel(settings)) {
    const id = activeModelId(settings);
    if (modelStore.isReady(configDir(), id)) jobs.push(builtin.warmUp(modelStore.modelPath(configDir(), id)));
  }
  if (providers.usesLocalVoice(settings) && voice.isReady(configDir())) {
    jobs.push(voice.warmUp(configDir(), { greetingVoice: settings.tts.voice || undefined }));
  }
  if (providers.usesLocalHearing(settings) && hearing.isReady(configDir())) {
    jobs.push(hearing.warmUp(configDir()));
  }

  // Never let a warm-up failure surface as a request error; the real call will
  // report it properly if something is actually broken.
  await Promise.allSettled(jobs);
}

async function handleWarm(_req, res) {
  warmEverything().catch(() => {});
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

async function handleChat(req, res) {
  const body = await readBody(req);
  const incoming = Array.isArray(body.messages) ? body.messages : null;
  if (!incoming || !incoming.length) {
    return sendJson(res, 400, { error: 'messages must be a non-empty array' });
  }

  const settings = readSettings();
  await history.load();
  const conversation = history.resolve(body.sessionId);

  let added = 0;
  for (const message of incoming) {
    if (!message || typeof message.content !== 'string' || !message.content.trim()) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    history.append(conversation, role, message.content.slice(0, 8000));
    added += 1;
  }

  // Every message was blank. This is what a transcription of silence looks like
  // by the time it reaches here, and it is a bad request rather than a failure
  // of the model — which would otherwise throw with nothing to reply to.
  if (!added) {
    return sendJson(res, 400, { error: 'There was nothing to reply to.', empty: true });
  }

  // Asked by voice, this answer is going to be read out — keep it to a sentence
  // or two rather than making the user listen to a wall of text.
  const spoken = body.voice === true;

  // The model only ever sees the tail of the conversation, however long it gets.
  const context = conversation.messages.slice(-CONTEXT_MESSAGES).map(({ role, content }) => ({ role, content }));
  const basePrompt = spoken ? SYSTEM_PROMPT_VOICE : SYSTEM_PROMPT;

  // Only hand over the action instructions when the last thing said looks like a
  // request to do something — see looksLikeRequest for why carrying them on every
  // turn makes a small model markedly worse at ordinary conversation.
  const lastSaid = [...conversation.messages].reverse().find((message) => message.role === 'user');
  const wantsAction = settings.allowActions && actions.looksLikeRequest(lastSaid && lastSaid.content);
  const prompt = wantsAction ? `${basePrompt}\n\n${actions.ACTION_INSTRUCTIONS}` : basePrompt;
  const messages = [{ role: 'system', content: prompt }, ...context];

  let completion;
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
    });
  } else if (settings.chat.provider === 'ollama') {
    completion = await providers.ollamaChat({
      baseUrl: settings.chat.baseUrl,
      model: settings.chat.model,
      messages,
    });
  } else {
    const zai = await getZai();
    completion = await zai.chat.completions.create({ messages, thinking: { type: 'disabled' } });
  }

  const raw = extractReply(completion);
  if (!raw) throw new Error('The model returned an empty reply');

  // Only look for an action when the user has allowed them; otherwise the
  // syntax is just text, and text is all it stays.
  const parsed = wantsAction ? actions.extractAction(raw) : { reply: raw, action: null, refused: null };

  // What goes in the history is what was said, not the machinery. A model that
  // writes nothing but the marker — which the small one usually does, having been
  // shown examples — would otherwise leave the raw `[[open_url: …]]` as its reply.
  let reply = parsed.reply;
  if (!reply) reply = parsed.action ? `Okay — I'll ${parsed.action.description}.` : raw;
  history.append(conversation, 'assistant', reply);
  if (settings.saveHistory) await history.persist(conversation);

  if (parsed.action) console.log(`[buddy] action requested: ${parsed.action.name} → ${parsed.action.value}`);
  if (parsed.refused) console.warn(`[buddy] ${parsed.refused}`);

  return sendJson(res, 200, {
    reply,
    sessionId: conversation.id,
    title: conversation.title,
    saved: settings.saveHistory,
    action: parsed.action,
    actionRefused: parsed.refused,
  });
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
    if (!hearing.isReady(configDir())) {
      return sendJson(res, 503, {
        error: "Buddy's hearing is still downloading.",
        needsSpeech: true,
        speech: hearing.snapshot(),
      });
    }
    const text = await hearing.transcribe({
      configDir: configDir(),
      samples: audio.resample(samples, sampleRate, hearing.SAMPLE_RATE),
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

      const where = (provider) => (provider === 'z-ai' ? 'cloud' : 'local');
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
            ? ` · ${hearing.isReady(configDir()) ? 'ready' : 'NOT downloaded yet'}`
            : '')
      );
      console.log(
        `    history  ${settings.saveHistory ? 'saved on this device' : 'not saved'} · ` +
          `${history.list().length} conversation(s)`
      );
      if (providers.isFullyLocal(settings)) console.log('    ✓ fully local — nothing leaves this machine');
      if (!process.env.BUDDY_TOKEN) console.log(`    token    ${AUTH_TOKEN}`);
      console.log('');

      // Start loading the models now rather than on the first message. Buddy sits
      // open all day waiting to be spoken to, so paying twelve seconds at launch
      // — while nobody is waiting — beats paying it the first time somebody is.
      if (options.warm !== false) {
        const warmStarted = Date.now();
        warmEverything()
          .then(() => console.log(`[buddy] warm and ready in ${((Date.now() - warmStarted) / 1000).toFixed(1)}s`))
          .catch(() => {});
      }

      resolve({ port, token: AUTH_TOKEN, server });
    });
  });
}

module.exports = { start, readConfig, readSettings, isConfigured, activeModelId, configPath, AUTH_TOKEN };

// Standalone: `npm run server`.
if (require.main === module) {
  start().catch((error) => {
    console.error('[buddy] failed to start:', error.message);
    process.exit(1);
  });
}
