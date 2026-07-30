/**
 * "Here is my API key" — and Buddy works out the rest.
 *
 * Setup used to ask for a key *and* a base URL, and only ever meant z-ai. That
 * is two questions too many: an API key already says who issued it. `sk-ant-`
 * is Anthropic, `gsk_` is Groq, `AIza` is Google, and so on — so the key alone
 * is enough to fill in the endpoint, the auth header shape, and a sensible
 * default model. Paste it and Buddy tells you whose it is.
 *
 * Anything unrecognised is still usable: it is treated as an OpenAI-compatible
 * endpoint and the user supplies the base URL themselves. That covers Together,
 * Fireworks, LM Studio, vLLM, and everything else that speaks the same shape.
 *
 * Keys live in buddy-keys.json, owner-readable only, and are never sent to the
 * renderer — only ever a masked form of them.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const KEYS_FILENAME = 'buddy-keys.json';

/**
 * Who issues which keys.
 *
 * Order matters: `match` is tried top to bottom, and several providers issue
 * keys beginning `sk-`. Anthropic (`sk-ant-`) and OpenRouter (`sk-or-`) have to
 * be tested before the bare `sk-` that means OpenAI, or every key would come
 * back as OpenAI.
 *
 * `style` is how the request is made, not who made the key: 'openai' is the
 * /chat/completions shape that most of the industry copied, 'anthropic' is the
 * /messages shape, and 'z-ai' goes through the bundled SDK.
 */
const CATALOG = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    match: /^sk-ant-/,
    style: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5',
    hint: 'Claude',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    match: /^sk-or-/,
    style: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    hint: 'hundreds of models behind one key',
  },
  {
    id: 'groq',
    label: 'Groq',
    match: /^gsk_/,
    style: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    hint: 'very fast open models',
    // Whisper on Groq is unusually quick, which is exactly what dictation wants.
    asrModel: 'whisper-large-v3-turbo',
    ttsModel: 'playai-tts',
    ttsVoices: ['Fritz-PlayAI', 'Celeste-PlayAI', 'Briggs-PlayAI', 'Quinn-PlayAI', 'Arista-PlayAI'],
  },
  {
    id: 'xai',
    label: 'xAI',
    match: /^xai-/,
    style: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    hint: 'Grok',
  },
  {
    id: 'google',
    label: 'Google',
    // Deliberately just the prefix. The old pattern also pinned the length and
    // the alphabet, which is the sort of thing that quietly stops matching the
    // day a provider changes its key format — and then the key looks like
    // nobody's rather than Google's.
    match: /^AIza/,
    style: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    hint: 'Gemini',
  },
  {
    // z-ai keys are an id and a secret joined by a dot, which nothing else here
    // looks like — so this can sit above the catch-all `sk-` rule safely.
    id: 'z-ai',
    label: 'z.ai',
    match: /^[0-9a-f]{16,40}\.[A-Za-z0-9]{8,}$/i,
    style: 'z-ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    hint: 'GLM',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    match: /^sk-[A-Za-z0-9_-]{16,}$/,
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    hint: 'GPT',
    asrModel: 'whisper-1',
    ttsModel: 'gpt-4o-mini-tts',
    ttsVoices: ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
  },
];

/**
 * Not every provider does everything. Anthropic has no speech at all, Google's
 * is a different API rather than an OpenAI-compatible route, and OpenRouter is
 * text only. Offering a provider for a job it cannot do produces a 404 on the
 * first attempt and looks like Buddy is broken, so the pickers ask this first.
 */
function supports(id, job) {
  const known = describe(id);
  if (!known) return false;
  if (job === 'chat') return true;
  if (job === 'tts') return Boolean(known.ttsModel);
  if (job === 'asr') return Boolean(known.asrModel);
  return false;
}

/** Which saved keys can do a given job, for a picker. */
function providersFor(configDir, job) {
  return list(configDir).filter((entry) => supports(entry.id, job));
}

/** What an unrecognised key becomes: usable, but it has to be told where to go. */
const CUSTOM = {
  id: 'custom',
  label: 'Custom',
  style: 'openai',
  baseUrl: '',
  defaultModel: '',
  hint: 'any OpenAI-compatible server',
};

const PROBE_TIMEOUT_MS = 8000;

/** Which provider issued this key, or the custom fallback. */
function detect(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  return CATALOG.find((entry) => entry.match.test(key)) || CUSTOM;
}

function describe(id) {
  return CATALOG.find((entry) => entry.id === id) || (id === 'custom' ? CUSTOM : null);
}

/**
 * Enough of the key to recognise it, and not enough to use it. This is the only
 * form a key ever takes outside this file.
 */
function mask(apiKey) {
  const key = String(apiKey || '');
  if (key.length <= 12) return '••••';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

// ── the store ─────────────────────────────────────────────────────────────

function keysPath(configDir) {
  return path.join(configDir, KEYS_FILENAME);
}

function readAll(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysPath(configDir), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      return parsed.providers;
    }
    return {};
  } catch {
    return {};
  }
}

/** The stored credential for one provider, or null. */
function get(configDir, id) {
  const entry = readAll(configDir)[id];
  if (!entry || typeof entry.apiKey !== 'string' || !entry.apiKey) return null;
  const known = describe(id);
  return {
    id,
    apiKey: entry.apiKey,
    baseUrl: (entry.baseUrl || (known && known.baseUrl) || '').replace(/\/+$/, ''),
    model: entry.model || (known && known.defaultModel) || '',
    style: (known && known.style) || 'openai',
  };
}

async function writeAll(configDir, providers) {
  await fsp.mkdir(configDir, { recursive: true });
  const body = JSON.stringify({ providers }, null, 2);
  // 0600: owner only. Best effort — a no-op on some Windows filesystems.
  await fsp.writeFile(keysPath(configDir), body, { mode: 0o600 });
  try {
    await fsp.chmod(keysPath(configDir), 0o600);
  } catch {
    /* not fatal */
  }
}

async function save(configDir, { id, apiKey, baseUrl, model }) {
  const providers = readAll(configDir);
  const known = describe(id);
  providers[id] = {
    apiKey,
    baseUrl: (baseUrl || (known && known.baseUrl) || '').replace(/\/+$/, ''),
    model: model || (providers[id] && providers[id].model) || (known && known.defaultModel) || '',
  };
  await writeAll(configDir, providers);
  return get(configDir, id);
}

async function remove(configDir, id) {
  const providers = readAll(configDir);
  if (!providers[id]) return false;
  delete providers[id];
  await writeAll(configDir, providers);
  return true;
}

/** Every stored key, masked, for the settings list. */
function list(configDir) {
  const providers = readAll(configDir);
  return Object.keys(providers)
    .map((id) => {
      const stored = get(configDir, id);
      if (!stored) return null;
      const known = describe(id);
      return {
        id,
        label: (known && known.label) || id,
        hint: (known && known.hint) || '',
        style: stored.style,
        baseUrl: stored.baseUrl,
        model: stored.model,
        maskedKey: mask(stored.apiKey),
      };
    })
    .filter(Boolean);
}

function has(configDir, id) {
  return Boolean(get(configDir, id));
}

// ── checking a key actually works ─────────────────────────────────────────

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function authHeaders(style, apiKey) {
  if (style === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Ask the provider what models it has. Doubles as proof the key is real: a
 * wrong key comes back 401 here rather than on the first thing you say, which
 * is a much better moment to find out.
 *
 * @returns {Promise<string[]>} model ids, newest-looking first where the
 *   provider bothers to sort them. Empty when the provider has no /models.
 */
async function listModels({ style, baseUrl, apiKey }) {
  const { signal, done } = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: authHeaders(style, apiKey),
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('That key was refused. Check it was copied in full.'), { status: 401 });
    }
    // Not every OpenAI-compatible server implements /models. A key that gets
    // as far as "no such route" is still plausibly a working key.
    if (response.status === 404 || response.status === 405) return [];
    if (!response.ok) {
      throw new Error(`The provider returned ${response.status} when asked for its models.`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    return rows.map((row) => (row && (row.id || row.name)) || '').filter(Boolean);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The provider did not respond in time.');
    throw error;
  } finally {
    done();
  }
}

/**
 * A provider's /models list is everything they host, not everything that can
 * hold a conversation: Groq lists half a dozen Whisper builds and a text-to-
 * speech model alongside its chat models, OpenAI lists embeddings and image
 * models. Picking the first entry off that list is how Buddy ended up trying to
 * chat with a speech-recognition model.
 */
const NOT_A_CHAT_MODEL =
  /whisper|transcrib|\btts\b|text-to-speech|speech|audio|embed|rerank|moder|guard|safety|image|vision-encoder|dall|sdxl|stable-diffusion|realtime|search-preview/i;

/** Something from this provider that can actually hold a conversation. */
function pickChatModel(models, preferred) {
  if (preferred && models.includes(preferred)) return preferred;
  const usable = models.filter((id) => !NOT_A_CHAT_MODEL.test(id));
  if (!usable.length) return preferred || models[0] || '';
  // Among what is left, prefer something that names itself as a chat model
  // rather than whatever happens to sort first.
  const familiar = usable.find((id) =>
    /instruct|chat|versatile|gpt|claude|gemini|llama|qwen|mistral|grok|glm|deepseek/i.test(id)
  );
  return familiar || usable[0];
}

/** The subset of a provider's models worth offering as a chat model. */
function chatModels(models) {
  const usable = models.filter((id) => !NOT_A_CHAT_MODEL.test(id));
  return usable.length ? usable : models;
}

/**
 * Take a pasted key and work out everything else about it.
 *
 * `provider` overrides the guess. That matters because prefix-matching is only
 * ever a guess: a provider can change its key format, and then a perfectly good
 * key looks like it belongs to nobody. When that happens the useful question is
 * "who issued this?" — which the user knows — and not "what is the base URL of
 * their OpenAI-compatible endpoint?", which they should never have to know.
 * Asking by name also means the key is never sent to a provider that did not
 * issue it, which probing around to find the owner would have done.
 *
 * @returns {Promise<{provider: object, models: string[], verified: boolean}>}
 */
async function inspect({ apiKey, baseUrl, provider: chosen }) {
  const key = String(apiKey || '').trim();
  if (!key) throw Object.assign(new Error('Paste an API key first.'), { status: 400 });

  const provider = (chosen && describe(chosen)) || detect(key);
  const endpoint = (baseUrl || provider.baseUrl || '').trim().replace(/\/+$/, '');

  if (!endpoint) {
    throw Object.assign(new Error("Buddy doesn't recognise that key — who issued it?"), {
      status: 400,
      needsProvider: true,
      // Only a genuinely custom endpoint needs the address typed out.
      needsBaseUrl: chosen === 'custom',
      provider: provider.id,
    });
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    throw Object.assign(new Error('The server address must start with http:// or https://'), { status: 400 });
  }

  // z-ai goes through its own SDK, which has no model listing to check against.
  if (provider.style === 'z-ai') {
    return { provider: { ...provider, baseUrl: endpoint }, models: [], verified: false };
  }

  const models = await listModels({ style: provider.style, baseUrl: endpoint, apiKey: key });
  return { provider: { ...provider, baseUrl: endpoint }, models, verified: true };
}

module.exports = {
  CATALOG,
  CUSTOM,
  detect,
  describe,
  mask,
  get,
  save,
  remove,
  list,
  has,
  listModels,
  pickChatModel,
  chatModels,
  supports,
  providersFor,
  inspect,
  authHeaders,
};
