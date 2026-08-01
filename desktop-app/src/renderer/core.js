/**
 * Shared renderer plumbing: which window this is, how to reach the server, and
 * the little markdown renderer. Everything here is free of DOM assumptions so
 * the orb, the panel and the setup window can all import it.
 */
'use strict';

const params = new URLSearchParams(location.search);
export const MODE = ['orb', 'panel', 'setup'].includes(params.get('mode')) ? params.get('mode') : 'panel';
export const FLAT = params.get('flat') === '1';

/** @type {{ port: number|null, token: string|null, wakeEnabled: boolean, panelVisible: boolean, platform?: string, version?: string }} */
export let boot = { port: null, token: null, wakeEnabled: true, panelVisible: false };

/**
 * Where each capability runs, straight from the server. Shapes what the UI
 * offers: no transcription means no mic and no wake word, and a system voice is
 * spoken here in the renderer rather than streamed as audio.
 */
export let runtime = {
  // Matches the server's defaults, so the UI is right even in the moment before
  // /health answers: Buddy's own brain, its own voice, its own ears.
  providers: { chat: 'builtin', tts: 'kokoro', asr: 'local' },
  cloud: [],
  fullyLocal: true,
  saveHistory: true,
  voiceReady: false,
  hearingReady: false,
  // The default brain is the built-in text-only model, so assume no eyes until
  // /health says otherwise — offering a paperclip and taking it away again is
  // worse than showing it a moment late.
  canSee: false,
  ttsVoice: 'af_heart',
  ttsSpeed: 1,
  // Saved API keys, masked. Empty until /health answers.
  keys: [],
  // Matches the server's defaults for the same reason as the providers above:
  // the windows paint themselves from these in the moment before /health
  // answers, and defaulting to nothing would flash an unnamed, uncoloured orb.
  look: { theme: 'dark', accent: '#f43f5e', orbSize: 'medium' },
  identity: { name: 'Buddy', wakeWord: 'Hey Buddy' },
};

/**
 * What Buddy is called, and what it answers to.
 *
 * Both are settings, so every piece of copy that used to say "Buddy" goes
 * through one of these instead. They fall back rather than returning undefined,
 * because a panel headed "undefined" is worse than one headed with the default.
 */
export const buddyName = () => (runtime.identity && runtime.identity.name) || 'Buddy';
export const wakePhrase = () => (runtime.identity && runtime.identity.wakeWord) || 'Hey Buddy';

/**
 * What this machine calls the place deleted files go. Copy about deleting has to
 * name the thing the user will actually go looking in, and "Recycle Bin" on a
 * Mac reads as a promise Buddy has not kept.
 */
export const binName = () => (boot.platform === 'win32' ? 'Recycle Bin' : 'Trash');

export async function loadBoot() {
  boot = await window.buddy.getBoot();
  return boot;
}

export async function refreshRuntime() {
  try {
    const response = await fetch(serverUrl('/health'));
    if (response.ok) runtime = { ...runtime, ...(await response.json()) };
  } catch {
    /* keep the defaults; the panel will surface the failure on first use */
  }
  return runtime;
}

/** Voice input is possible when something can transcribe and it is ready to. */
export const voiceInputAvailable = () => runtime.providers.asr !== 'off' && runtime.hearingReady !== false;

export const $ = (id) => document.getElementById(id);

// ── server access ─────────────────────────────────────────────────────────

export function serverUrl(route) {
  return `http://127.0.0.1:${boot.port}${route}`;
}

export async function api(route, body, { raw = false, method, signal } = {}) {
  const response = await fetch(serverUrl(route), {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      'X-Buddy-Token': boot.token || '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Dropping the request is how a caller calls off work already under way —
    // the server watches for the socket closing and stops generating.
    signal,
  });

  if (!response.ok) {
    if (raw) return response;
    let message = `Request failed (${response.status})`;
    let payload = null;
    try {
      payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* keep the generic message */
    }
    throw Object.assign(new Error(message), { status: response.status, payload });
  }

  return raw ? response : response.json();
}

/**
 * Ask for a reply and watch it being written.
 *
 * Resolves to exactly what a plain POST to /chat resolves to — the reply, the
 * session, the action — with `onDelta` called along the way as the text
 * arrives. The final reply is authoritative and may differ slightly from the
 * sum of the deltas, since the server withholds anything that might turn out to
 * be an action marker; callers should replace what they have shown rather than
 * append to it.
 *
 * Falls back on its own. Ollama and the bundled z-ai SDK answer in one piece,
 * and the server says so by replying with ordinary JSON, which is handled here
 * rather than by every caller.
 */
export async function streamChat(body, { onDelta, signal } = {}) {
  const response = await fetch(serverUrl('/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Buddy-Token': boot.token || '' },
    body: JSON.stringify({ ...body, stream: true }),
    // Dropping this request is what tells the server to stop generating; see
    // the abort handling in handleChat.
    signal,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let payload = null;
    try {
      payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* keep the generic message */
    }
    throw Object.assign(new Error(message), { status: response.status, payload });
  }

  if (!(response.headers.get('content-type') || '').includes('ndjson')) return response.json();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a partial line cannot happen here, but never die on one
      }
      if (event.type === 'delta') {
        if (onDelta) onDelta(event.text || '');
      } else if (event.type === 'done') {
        finished = event;
      } else if (event.type === 'error') {
        throw new Error(event.error || 'The reply failed.');
      }
    }
  }

  // The connection closing before `done` means the reply was cut off partway,
  // which is a failure however much text arrived first.
  if (!finished) throw new Error('The reply ended before it was finished.');
  return finished;
}

// ── formatting ────────────────────────────────────────────────────────────

const MB = 1048576;

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
}

/** "1.4 GB of 2.0 GB · 8.1 MB/s · about 3 minutes left" */
export function describeProgress(state) {
  const bits = [];
  if (state.receivedBytes > 0) bits.push(`${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)}`);
  if (state.bytesPerSecond > 0) bits.push(`${(state.bytesPerSecond / MB).toFixed(1)} MB/s`);
  const eta = formatDuration(state.etaSeconds);
  if (eta) bits.push(eta);
  return bits.join('  ·  ');
}

// ── tiny markdown (no dependencies) ───────────────────────────────────────

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Supports fenced and inline code, bold, italics, links, and both list styles.
 * Everything is escaped before any tag is introduced, and code spans are
 * stashed behind placeholders so their contents are never re-formatted.
 */
export function renderMarkdown(source) {
  const stash = [];
  // A bare ' 12 ' placeholder would collide with prose ('about 12 of them'),
  // so delimit with a character that cannot survive in the input.
  const MARK = ' ';
  const keep = (html) => `${MARK}${stash.push(html) - 1}${MARK}`;

  let text = escapeHtml(String(source).replace(/\r\n/g, '\n').split(MARK).join('').trim());

  text = text.replace(/```([a-z0-9+#.-]*)\n?([\s\S]*?)```/gi, (_m, _lang, code) =>
    keep(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`)
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => keep(`<code>${code}</code>`));

  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => {
    const safe = href.replace(/"/g, '%22');
    return keep(`<a href="${safe}" data-external="1">${label}</a>`);
  });
  text = text.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_m, lead, url) => {
    const safe = url.replace(/"/g, '%22');
    return `${lead}${keep(`<a href="${safe}" data-external="1">${url}</a>`)}`;
  });

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');

  const html = text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');

      if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
        const items = lines.map((line) => `<li>${line.replace(/^\s*[-*•]\s+/, '')}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
        const items = lines.map((line) => `<li>${line.replace(/^\s*\d+[.)]\s+/, '')}</li>`).join('');
        return `<ol>${items}</ol>`;
      }
      // A block that is only a stashed <pre> should not be wrapped in <p>.
      const solo = block.trim().match(/^ (\d+) $/);
      if (solo && String(stash[Number(solo[1])]).startsWith('<pre')) return block.trim();

      return `<p>${lines.join('<br />')}</p>`;
    })
    .join('');

  return html.replace(/ (\d+) /g, (_m, index) => stash[Number(index)]);
}
