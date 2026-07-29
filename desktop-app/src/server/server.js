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
 *   GET    /model               how far the built-in model download has got
 *   POST   /model               start or resume that download
 *   POST   /setup               store the z-ai baseUrl + key
 *   POST   /chat                send a message, get a reply
 *   POST   /tts                 speak text (audio bytes, or a hand-off to the OS voice)
 *   POST   /asr                 transcribe an audio clip
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
const builtin = require('./builtin.js');
const modelStore = require('./model.js');
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
    settingsCache = providers.normaliseSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    settingsCache = providers.normaliseSettings(null);
  }
  return settingsCache;
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
  // exactly when its model has finished downloading.
  if (providers.usesBuiltinModel(settings) && !modelStore.isReady(configDir())) return false;
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
        ? modelStore.MODEL.label
        : settings.chat.model || providers.OLLAMA_DEFAULT_MODEL,
    model: modelStore.snapshot(configDir()),
    needsModel: providers.usesBuiltinModel(settings) && !modelStore.isReady(configDir()),
    ttsVoice: settings.tts.voice,
    cloud: providers.cloudCapabilities(settings),
    fullyLocal: providers.isFullyLocal(settings),
    saveHistory: settings.saveHistory,
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
  const body = await readBody(req);
  const settings = await writeSettings(body && typeof body === 'object' ? body : {});
  console.log(
    `[buddy] providers → chat:${settings.chat.provider} tts:${settings.tts.provider} asr:${settings.asr.provider}`
  );
  return sendJson(res, 200, { ok: true, settings, runtime: describeRuntime() });
}

/** Where the built-in model download has got to. Polled by the ready screen. */
async function handleModelState(_req, res) {
  return sendJson(res, 200, modelStore.snapshot(configDir()));
}

/**
 * Start (or resume) the download. Returns immediately with the current state —
 * the caller polls GET /model rather than holding a request open for 770 MB.
 */
async function handleModelDownload(_req, res) {
  if (modelStore.isReady(configDir())) return sendJson(res, 200, modelStore.snapshot(configDir()));
  if (!modelStore.isDownloading()) {
    modelStore.ensureModel(configDir()).catch(() => {
      /* the error is already on the snapshot the client polls */
    });
  }
  return sendJson(res, 202, modelStore.snapshot(configDir()));
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

  for (const message of incoming) {
    if (!message || typeof message.content !== 'string' || !message.content.trim()) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    history.append(conversation, role, message.content.slice(0, 8000));
  }

  // The model only ever sees the tail of the conversation, however long it gets.
  const context = conversation.messages.slice(-CONTEXT_MESSAGES).map(({ role, content }) => ({ role, content }));
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...context];

  let completion;
  if (settings.chat.provider === 'builtin') {
    if (!modelStore.isReady(configDir())) {
      return sendJson(res, 503, {
        error: "Buddy's model is still downloading.",
        needsModel: true,
        model: modelStore.snapshot(configDir()),
      });
    }
    completion = await builtin.chat({
      modelPath: modelStore.modelPath(configDir()),
      messages,
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

  const reply = extractReply(completion);
  if (!reply) throw new Error('The model returned an empty reply');

  history.append(conversation, 'assistant', reply);
  if (settings.saveHistory) await history.persist(conversation);

  return sendJson(res, 200, {
    reply,
    sessionId: conversation.id,
    title: conversation.title,
    saved: settings.saveHistory,
  });
}

async function handleTts(req, res) {
  const body = await readBody(req);
  const raw = typeof body.text === 'string' ? body.text.trim() : '';
  if (!raw) return sendJson(res, 400, { error: 'text is required' });

  const settings = readSettings();
  const input = raw.slice(0, MAX_TTS_CHARS);
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : settings.tts.voice;

  // The OS voices live in the renderer process, so hand the text back and let
  // speechSynthesis say it. Nothing leaves the machine on this path.
  if (settings.tts.provider === 'system') {
    return sendJson(res, 200, { mode: 'system', text: input, voice });
  }

  const zai = await getZai();
  // Verified: the key is `input`, and this resolves to a raw Response.
  const response = await zai.audio.tts.create({ input, voice, response_format: 'wav', stream: false });

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

async function handleAsr(req, res) {
  const body = await readBody(req);
  const supplied = typeof body.audio === 'string' ? body.audio : '';
  // Accept a bare base64 payload or a full `data:audio/webm;base64,...` URI.
  const base64 = supplied.includes(',') ? supplied.slice(supplied.indexOf(',') + 1) : supplied;
  if (!base64.trim()) return sendJson(res, 400, { error: 'audio (base64) is required' });

  const settings = readSettings();

  if (settings.asr.provider === 'off') {
    return sendJson(res, 400, {
      error: 'Voice input is turned off. Add a local Whisper server, or switch hearing to z-ai.',
      asrOff: true,
    });
  }

  if (settings.asr.provider === 'whisper') {
    const result = await providers.whisperTranscribe({
      baseUrl: settings.asr.baseUrl,
      model: settings.asr.model,
      audio: Buffer.from(base64.trim(), 'base64'),
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'audio/webm',
    });
    return sendJson(res, 200, { text: extractTranscript(result) });
  }

  const zai = await getZai();
  // Verified: the key is `file_base64`, and the transcript comes back on .text.
  const result = await zai.audio.asr.create({ file_base64: base64.trim() });
  return sendJson(res, 200, { text: extractTranscript(result) });
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

const ROUTES = [
  ['GET', /^\/health$/, (req, res) => sendJson(res, 200, describeRuntime())],
  ['GET', /^\/settings$/, handleGetSettings],
  ['POST', /^\/settings$/, handlePostSettings],
  ['GET', /^\/providers\/status$/, handleProviderStatus],
  ['GET', /^\/model$/, handleModelState],
  ['POST', /^\/model$/, handleModelDownload],
  ['POST', /^\/setup$/, handleSetup],
  ['POST', /^\/chat$/, handleChat],
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
      const modelState = modelStore.snapshot(configDir());
      console.log(
        `    chat     ${settings.chat.provider} (${where(settings.chat.provider)})` +
          (settings.chat.provider === 'ollama'
            ? ` · ${settings.chat.model || providers.OLLAMA_DEFAULT_MODEL} · ${settings.chat.baseUrl}`
            : '') +
          (settings.chat.provider === 'builtin'
            ? ` · ${modelStore.MODEL.label} · ${modelState.ready ? 'model ready' : 'model NOT downloaded yet'}`
            : '')
      );
      console.log(`    voice    ${settings.tts.provider} (${where(settings.tts.provider)})`);
      console.log(
        `    hearing  ${settings.asr.provider} (${where(settings.asr.provider)})` +
          (settings.asr.provider === 'whisper' ? ` · ${settings.asr.baseUrl}` : '')
      );
      console.log(
        `    history  ${settings.saveHistory ? 'saved on this device' : 'not saved'} · ` +
          `${history.list().length} conversation(s)`
      );
      if (providers.isFullyLocal(settings)) console.log('    ✓ fully local — nothing leaves this machine');
      if (!process.env.BUDDY_TOKEN) console.log(`    token    ${AUTH_TOKEN}`);
      console.log('');
      resolve({ port, token: AUTH_TOKEN, server });
    });
  });
}

module.exports = { start, readConfig, readSettings, isConfigured, configPath, AUTH_TOKEN };

// Standalone: `npm run server`.
if (require.main === module) {
  start().catch((error) => {
    console.error('[buddy] failed to start:', error.message);
    process.exit(1);
  });
}
