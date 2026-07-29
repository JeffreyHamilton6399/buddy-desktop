/**
 * Buddy's local server.
 *
 * Plain Node http, bound to 127.0.0.1 on an OS-assigned port. It is the only
 * place the z-ai key is ever read or used — the renderer never sees it.
 *
 * Endpoints: GET /health, POST /setup, POST /chat, POST /tts, POST /asr
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

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
const SYSTEM_PROMPT =
  'You are Buddy, a friendly, warm, concise local AI assistant that lives on ' +
  "the user's desktop. Keep replies short, natural, and friendly — like a " +
  'helpful companion. Avoid long lists unless asked.';

const DEFAULT_VOICE = 'tongtong';
const MAX_TTS_CHARS = 1024;
const MAX_HISTORY = 20;
const MAX_BODY_BYTES = 12 * 1024 * 1024; // audio clips arrive as base64
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Where `.z-ai-config` lives. Electron passes userData; standalone uses cwd. */
function configDir() {
  return process.env.BUDDY_CONFIG_DIR || process.cwd();
}

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

// ── z-ai client (lazy, memoised, invalidated by /setup) ────────────────────

let zaiPromise = null;

function resetZai() {
  zaiPromise = null;
}

async function getZai() {
  if (zaiPromise) return zaiPromise;
  zaiPromise = (async () => {
    if (!readConfig()) {
      throw Object.assign(new Error('Run setup to add your API key'), { code: 'NO_CONFIG' });
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

// ── conversation memory ───────────────────────────────────────────────────

/** sessionId -> { messages: ChatMessage[], touched: number } */
const sessions = new Map();

function getSession(sessionId) {
  const id = sessionId && typeof sessionId === 'string' ? sessionId : crypto.randomUUID();
  let session = sessions.get(id);
  if (!session) {
    session = { messages: [], touched: Date.now() };
    sessions.set(id, session);
  }
  session.touched = Date.now();
  return { id, session };
}

function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.touched < cutoff) sessions.delete(id);
  }
}

// ── response shape helpers (providers vary; be forgiving) ─────────────────

function extractReply(completion) {
  if (!completion) return '';
  if (typeof completion === 'string') return completion;
  const choice = completion.choices && completion.choices[0];
  const text =
    (choice && choice.message && choice.message.content) ||
    (choice && choice.delta && choice.delta.content) ||
    (choice && choice.text) ||
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  console.log('[buddy] config saved to', configPath());
  return sendJson(res, 200, { ok: true });
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const incoming = Array.isArray(body.messages) ? body.messages : null;
  if (!incoming || !incoming.length) {
    return sendJson(res, 400, { error: 'messages must be a non-empty array' });
  }

  const { id, session } = getSession(body.sessionId);
  for (const message of incoming) {
    if (!message || typeof message.content !== 'string' || !message.content.trim()) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    session.messages.push({ role, content: message.content.slice(0, 8000) });
  }
  if (session.messages.length > MAX_HISTORY) {
    session.messages.splice(0, session.messages.length - MAX_HISTORY);
  }

  const zai = await getZai();
  const completion = await zai.chat.completions.create({
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...session.messages],
    thinking: { type: 'disabled' },
  });

  const reply = extractReply(completion);
  if (!reply) throw new Error('The AI provider returned an empty reply');

  session.messages.push({ role: 'assistant', content: reply });
  if (session.messages.length > MAX_HISTORY) {
    session.messages.splice(0, session.messages.length - MAX_HISTORY);
  }
  pruneSessions();
  return sendJson(res, 200, { reply, sessionId: id });
}

async function handleTts(req, res) {
  const body = await readBody(req);
  const raw = typeof body.text === 'string' ? body.text.trim() : '';
  if (!raw) return sendJson(res, 400, { error: 'text is required' });
  const input = raw.slice(0, MAX_TTS_CHARS);
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : DEFAULT_VOICE;

  const zai = await getZai();
  // Verified: the key is `input`, and this resolves to a raw Response.
  const response = await zai.audio.tts.create({
    input,
    voice,
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

async function handleAsr(req, res) {
  const body = await readBody(req);
  const supplied = typeof body.audio === 'string' ? body.audio : '';
  // Accept a bare base64 payload or a full `data:audio/webm;base64,...` URI.
  const base64 = supplied.includes(',') ? supplied.slice(supplied.indexOf(',') + 1) : supplied;
  if (!base64.trim()) return sendJson(res, 400, { error: 'audio (base64) is required' });

  const zai = await getZai();
  // Verified: the key is `file_base64`, and the transcript comes back on .text.
  const result = await zai.audio.asr.create({ file_base64: base64.trim() });
  return sendJson(res, 200, { text: extractTranscript(result) });
}

const ROUTES = {
  'POST /setup': handleSetup,
  'POST /chat': handleChat,
  'POST /tts': handleTts,
  'POST /asr': handleAsr,
};

async function router(req, res) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    return sendJson(res, 403, { error: 'Origin not allowed' });
  }

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, configured: Boolean(readConfig()) });
  }

  if (!OPEN_ROUTES.has(pathname)) {
    const supplied = req.headers['x-buddy-token'];
    const expected = Buffer.from(AUTH_TOKEN);
    const given = Buffer.from(typeof supplied === 'string' ? supplied : '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return sendJson(res, 401, { error: 'Missing or invalid X-Buddy-Token' });
    }
  }

  const handler = ROUTES[`${req.method} ${pathname}`];
  if (!handler) return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });

  try {
    await handler(req, res);
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    const isMissingConfig = error && error.code === 'NO_CONFIG';
    const message = isMissingConfig ? 'Run setup to add your API key' : scrub(error && error.message);
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

    server.listen(requested, '127.0.0.1', () => {
      const { port } = server.address();
      const configured = Boolean(readConfig());
      console.log('');
      console.log('  ✦ Buddy local server');
      console.log(`    http://127.0.0.1:${port}`);
      console.log(`    config   ${configPath()}${configured ? '' : '  (not set up yet)'}`);
      console.log(`    routes   GET /health · POST /setup /chat /tts /asr`);
      if (!process.env.BUDDY_TOKEN) console.log(`    token    ${AUTH_TOKEN}`);
      console.log('');
      resolve({ port, token: AUTH_TOKEN, server });
    });
  });
}

module.exports = { start, readConfig, configPath, AUTH_TOKEN };

// Standalone: `npm run server`.
if (require.main === module) {
  start().catch((error) => {
    console.error('[buddy] failed to start:', error.message);
    process.exit(1);
  });
}
