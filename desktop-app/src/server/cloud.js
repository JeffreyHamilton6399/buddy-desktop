/**
 * Talking to a cloud model with a key the user pasted.
 *
 * Two request shapes cover nearly everything: the OpenAI /chat/completions
 * shape, which most providers copied, and Anthropic's /messages shape, which
 * differs enough to need its own path — the system prompt is a separate field
 * rather than a message, and the reply is a list of content blocks.
 *
 * Everything here answers in the Ollama shape so extractReply() in server.js
 * needs no special case for any of it.
 */
'use strict';

const keys = require('./keys.js');

const REQUEST_TIMEOUT_MS = 120000;
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Claude counts thinking against max_tokens, and on the current models thinking
 * is on by default — so a tight cap can spend the whole budget reasoning and
 * return a truncated sentence. The cap is therefore generous and brevity is
 * left to the system prompt, which is where it belongs anyway.
 */
const ANTHROPIC_MAX_TOKENS = 4096;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Turn a provider's error body into one line worth showing someone. */
function readError(status, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = (parsed.error && (parsed.error.message || parsed.error.type)) || parsed.message || '';
  } catch {
    detail = String(body || '').slice(0, 200);
  }
  if (status === 401 || status === 403) {
    return `That API key was refused${detail ? ` — ${detail}` : ''}. Check it in settings.`;
  }
  if (status === 404) {
    return `That model does not exist on this provider${detail ? ` — ${detail}` : ''}. Pick another in settings.`;
  }
  if (status === 429) {
    return 'The provider is rate-limiting this key. Wait a moment and try again.';
  }
  return `The provider returned ${status}${detail ? `: ${detail}` : ''}`;
}

async function post(url, { headers, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(readError(response.status, await response.text().catch(() => '')));
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The provider did not respond in time.');
    throw error;
  } finally {
    done();
  }
}

// ── the OpenAI /chat/completions shape ────────────────────────────────────

async function openAiChat({ baseUrl, apiKey, model, messages, maxTokens }) {
  const payload = await post(`${baseUrl}/chat/completions`, {
    headers: keys.authHeaders('openai', apiKey),
    body: {
      model,
      messages,
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
    },
  });

  // Normalised to the same shape the Anthropic path returns. extractReply()
  // understands both, but two shapes out of one function is a trap for whoever
  // calls this next.
  const choice = payload && payload.choices && payload.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';
  return { message: { role: 'assistant', content: String(text).trim() } };
}

// ── Anthropic's /messages shape ───────────────────────────────────────────

/**
 * Anthropic takes the system prompt out of the message list entirely, and only
 * accepts user and assistant turns in it. Note that no sampling parameters are
 * sent: the current Claude models reject `temperature` outright, so passing one
 * would turn every request into a 400.
 */
async function anthropicChat({ baseUrl, apiKey, model, messages }) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const turns = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: String(message.content) }));

  if (!turns.length) throw new Error('There was no message to send.');

  const payload = await post(`${baseUrl}/messages`, {
    headers: keys.authHeaders('anthropic', apiKey),
    body: {
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: turns,
    },
  });

  // A safety classifier declining is a normal 200 with an empty reply, so it
  // has to be checked before the content is read or it looks like a blank answer.
  if (payload && payload.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer that one.');
  }

  const text = Array.isArray(payload && payload.content)
    ? payload.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
    : '';

  return { message: { role: 'assistant', content: text.trim() } };
}

/**
 * Send a conversation to whichever cloud provider is selected.
 *
 * @param {{ credential: {style: string, baseUrl: string, apiKey: string, model: string},
 *           model?: string,
 *           messages: Array<{role: string, content: string}>,
 *           maxTokens?: number }} options
 * @returns {Promise<object>} a reply extractReply() understands
 */
async function chat({ credential, model, messages, maxTokens }) {
  if (!credential || !credential.apiKey) {
    throw Object.assign(new Error('That provider has no API key saved. Add one in settings.'), {
      code: 'NO_KEY',
    });
  }

  const baseUrl = String(credential.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('That provider has no server address saved. Set one in settings.');

  const chosen = model || credential.model;
  if (!chosen) throw new Error('No model is chosen for that provider. Pick one in settings.');

  if (credential.style === 'anthropic') {
    return anthropicChat({ baseUrl, apiKey: credential.apiKey, model: chosen, messages });
  }
  return openAiChat({ baseUrl, apiKey: credential.apiKey, model: chosen, messages, maxTokens });
}

// ── speech, over the same OpenAI-compatible routes ────────────────────────

/**
 * Say something using a provider's voice.
 *
 * `/audio/speech` is the OpenAI shape, which Groq copied — so one request works
 * for both. It answers with audio bytes rather than JSON, hence the hand-rolled
 * fetch instead of post().
 */
async function speak({ credential, model, voice, input, speed }) {
  const baseUrl = String(credential.baseUrl || '').replace(/\/+$/, '');
  const { signal, done } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...keys.authHeaders('openai', credential.apiKey) },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: 'wav',
        ...(Number.isFinite(speed) && speed > 0 ? { speed } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(readError(response.status, await response.text().catch(() => '')));
    }
    const contentType = response.headers.get('content-type') || 'audio/wav';
    return { audio: Buffer.from(await response.arrayBuffer()), contentType };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The voice provider did not respond in time.');
    throw error;
  } finally {
    done();
  }
}

/** Transcribe a clip through `/audio/transcriptions`, the same shape again. */
async function transcribe({ credential, model, audio, mimeType }) {
  const baseUrl = String(credential.baseUrl || '').replace(/\/+$/, '');
  const extension = String(mimeType || '').includes('wav') ? 'wav' : 'webm';

  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType || 'audio/wav' }), `clip.${extension}`);
  form.append('model', model);
  form.append('response_format', 'json');

  const { signal, done } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      // No Content-Type: fetch has to set the multipart boundary itself.
      headers: keys.authHeaders('openai', credential.apiKey),
      body: form,
      signal,
    });
    if (!response.ok) {
      throw new Error(readError(response.status, await response.text().catch(() => '')));
    }
    const payload = await response.json();
    return String((payload && payload.text) || '').trim();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The transcription provider did not respond in time.');
    throw error;
  } finally {
    done();
  }
}

module.exports = { chat, speak, transcribe };
