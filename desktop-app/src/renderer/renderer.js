/**
 * Buddy — renderer. One file serves three window modes (orb / panel / setup);
 * the mode arrives as a query parameter from main.js.
 */
'use strict';

const params = new URLSearchParams(location.search);
const MODE = ['orb', 'panel', 'setup'].includes(params.get('mode')) ? params.get('mode') : 'panel';

/** @type {{ port: number|null, token: string|null, wakeEnabled: boolean, panelVisible: boolean }} */
let boot = { port: null, token: null, wakeEnabled: true, panelVisible: false };

/**
 * Where each capability runs, straight from the server. Shapes what the UI
 * offers: no local transcription means no mic and no wake word, and a system
 * voice is spoken here in the renderer rather than streamed as audio.
 */
let runtime = {
  providers: { chat: 'z-ai', tts: 'z-ai', asr: 'z-ai' },
  cloud: ['chat', 'tts', 'asr'],
  fullyLocal: false,
  saveHistory: true,
};

async function refreshRuntime() {
  try {
    const response = await fetch(serverUrl('/health'));
    if (response.ok) runtime = { ...runtime, ...(await response.json()) };
  } catch {
    /* keep the defaults; the panel will surface the failure on first use */
  }
  return runtime;
}

const voiceInputAvailable = () => runtime.providers.asr !== 'off';

const $ = (id) => document.getElementById(id);

// ── server access ─────────────────────────────────────────────────────────

function serverUrl(route) {
  return `http://127.0.0.1:${boot.port}${route}`;
}

async function api(route, body, { raw = false, method } = {}) {
  const response = await fetch(serverUrl(route), {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      'X-Buddy-Token': boot.token || '',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }

  return raw ? response : response.json();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the recording'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

// ── tiny markdown (no dependencies) ───────────────────────────────────────

function escapeHtml(text) {
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
function renderMarkdown(source) {
  const stash = [];
  // A bare ' 12 ' placeholder would collide with prose ('about 12 of them'),
  // so delimit with a character that cannot survive in the input.
  const MARK = '\u0000';
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
      const solo = block.trim().match(/^\u0000(\d+)\u0000$/);
      if (solo && String(stash[Number(solo[1])]).startsWith('<pre')) return block.trim();

      return `<p>${lines.join('<br />')}</p>`;
    })
    .join('');

  return html.replace(/\u0000(\d+)\u0000/g, (_m, index) => stash[Number(index)]);
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL
// ═══════════════════════════════════════════════════════════════════════════

function initPanel() {
  const messages = $('messages');
  const input = $('input');
  const composer = $('composer');
  const sendButton = $('send');
  const micButton = $('mic');
  const speakerButton = $('speaker');
  const statusLabel = $('status');
  const equalizer = $('equalizer');

  let sessionId = null;
  let busy = false;
  let speakerOn = localStorage.getItem('buddy:speaker') !== 'off';
  let audioElement = null;
  let recorder = null;
  let recordingChunks = [];

  function setStatus(text, tone) {
    statusLabel.textContent = text;
    statusLabel.className = 'panel-status' + (tone ? ` ${tone}` : '');
  }

  function scrollToEnd() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(role, content, { markdown = false } = {}) {
    const row = document.createElement('div');
    row.className = `msg ${role}`;

    if (role !== 'user') {
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      row.appendChild(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (markdown) bubble.innerHTML = renderMarkdown(content);
    else bubble.textContent = content;

    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToEnd();
    return bubble;
  }

  function addTyping() {
    const bubble = addMessage('buddy', '');
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    return bubble.parentElement;
  }

  function setBusy(value) {
    busy = value;
    sendButton.disabled = value;
    micButton.disabled = value || !voiceInputAvailable();
  }

  function updateSpeakerButton() {
    speakerButton.setAttribute('aria-pressed', String(speakerOn));
    speakerButton.title = `Voice replies: ${speakerOn ? 'on' : 'off'}`;
  }

  function stopSpeaking() {
    if (audioElement) {
      audioElement.pause();
      if (audioElement.src.startsWith('blob:')) URL.revokeObjectURL(audioElement.src);
      audioElement = null;
    }
    if (window.speechSynthesis) speechSynthesis.cancel();
    equalizer.hidden = true;
  }

  function finishSpeaking() {
    equalizer.hidden = true;
    if (!busy) setStatus('online');
  }

  /** The OS voices live here in the renderer, so nothing goes over the network. */
  function speakWithSystemVoice(text, voiceName) {
    if (!window.speechSynthesis) throw new Error('This system has no speech voices available');
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const chosen = voices.find((voice) => voice.name === voiceName);
    if (chosen) utterance.voice = chosen;
    utterance.rate = 1.02;

    equalizer.hidden = false;
    setStatus('speaking', 'busy');
    utterance.addEventListener('end', finishSpeaking, { once: true });
    utterance.addEventListener('error', finishSpeaking, { once: true });
    speechSynthesis.speak(utterance);
  }

  async function speak(text) {
    if (!speakerOn || !text.trim()) return;
    stopSpeaking();
    try {
      const response = await api('/tts', { text }, { raw: true });

      // A JSON body means "say this yourself with an OS voice"; anything else
      // is audio the provider generated for us.
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        const payload = await response.json();
        if (payload && payload.mode === 'system') return speakWithSystemVoice(payload.text, payload.voice);
        throw new Error((payload && payload.error) || 'The voice service returned no audio');
      }

      const url = URL.createObjectURL(await response.blob());
      audioElement = new Audio(url);
      equalizer.hidden = false;
      setStatus('speaking', 'busy');

      const done = () => {
        finishSpeaking();
        URL.revokeObjectURL(url);
        if (audioElement && audioElement.src === url) audioElement = null;
      };
      audioElement.addEventListener('ended', done, { once: true });
      audioElement.addEventListener('error', done, { once: true });

      await audioElement.play();
    } catch (error) {
      finishSpeaking();
      console.warn('[buddy] voice reply failed:', error.message);
    }
  }

  async function send(text) {
    const content = text.trim();
    if (!content || busy) return;

    stopSpeaking();
    addMessage('user', content);
    input.value = '';
    setBusy(true);
    setStatus('thinking', 'busy');

    const typingRow = addTyping();

    try {
      const payload = await api('/chat', { messages: [{ role: 'user', content }], sessionId });
      typingRow.remove();
      sessionId = payload.sessionId || sessionId;
      addMessage('buddy', payload.reply, { markdown: true });
      setBusy(false);
      setStatus('online');
      speak(payload.reply);
    } catch (error) {
      typingRow.remove();
      addMessage('error', error.message);
      setBusy(false);
      setStatus('offline', 'bad');
    }
  }

  // ── saved conversations ─────────────────────────────────────────────────

  const drawer = $('drawer');
  const chatList = $('chat-list');
  const clearButton = $('clear-history');
  const saveToggle = $('save-history');
  let clearArmed = false;

  function greet() {
    messages.replaceChildren();
    addMessage('buddy', "Hey! I'm Buddy. Ask me anything, or say **“Hey Buddy”** any time.", { markdown: true });
  }

  function formatWhen(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const today = new Date();
    const sameDay = then.toDateString() === today.toDateString();
    if (sameDay) return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const thisYear = then.getFullYear() === today.getFullYear();
    return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
  }

  function renderChatList(chats) {
    chatList.replaceChildren();

    if (!chats.length) {
      const empty = document.createElement('p');
      empty.className = 'drawer-empty';
      empty.textContent = runtime.saveHistory
        ? "No saved chats yet. Anything you ask will be kept here on this device so you can come back to it."
        : 'Saving is turned off, so nothing is being kept.';
      chatList.appendChild(empty);
      return;
    }

    for (const chat of chats) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chat-row' + (chat.id === sessionId ? ' is-current' : '');

      const main = document.createElement('span');
      main.className = 'chat-row-main';

      const title = document.createElement('span');
      title.className = 'chat-row-title';
      title.textContent = chat.title;

      const meta = document.createElement('span');
      meta.className = 'chat-row-meta';
      const when = formatWhen(chat.updatedAt);
      meta.textContent = `${when}${when ? ' · ' : ''}${chat.messageCount} message${chat.messageCount === 1 ? '' : 's'}`;

      main.append(title, meta);

      const remove = document.createElement('span');
      remove.className = 'chat-row-del';
      remove.setAttribute('role', 'button');
      remove.setAttribute('tabindex', '0');
      remove.title = 'Delete this chat';
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

      row.append(main, remove);

      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await api(`/chats/${chat.id}`, undefined, { method: 'DELETE' });
          if (chat.id === sessionId) {
            sessionId = null;
            greet();
          }
          await openDrawer();
        } catch (error) {
          console.warn('[buddy] could not delete chat:', error.message);
        }
      });

      row.addEventListener('click', () => loadConversation(chat.id));
      chatList.appendChild(row);
    }
  }

  async function openDrawer() {
    drawer.hidden = false;
    $('drawer-note').textContent = runtime.saveHistory ? 'saved on this device' : 'saving is off';
    saveToggle.checked = Boolean(runtime.saveHistory);
    try {
      const { chats } = await api('/chats');
      renderChatList(chats);
    } catch (error) {
      chatList.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'drawer-empty';
      failed.textContent = `Couldn't read your chats: ${error.message}`;
      chatList.appendChild(failed);
    }
  }

  function closeDrawer() {
    drawer.hidden = true;
    resetClearButton();
  }

  async function loadConversation(id) {
    try {
      const { chat } = await api(`/chats/${id}`);
      stopSpeaking();
      sessionId = chat.id;
      messages.replaceChildren();
      for (const message of chat.messages) {
        if (message.role === 'assistant') addMessage('buddy', message.content, { markdown: true });
        else addMessage('user', message.content);
      }
      closeDrawer();
      setStatus('online');
      input.focus();
    } catch (error) {
      addMessage('error', `Couldn't open that chat: ${error.message}`);
      closeDrawer();
    }
  }

  function resetClearButton() {
    clearArmed = false;
    clearButton.classList.remove('confirming');
    clearButton.textContent = 'Delete all saved chats';
  }

  // ── voice input ─────────────────────────────────────────────────────────

  function applyVoiceInputAvailability() {
    const available = voiceInputAvailable();
    micButton.disabled = !available || busy;
    micButton.title = available
      ? 'Tap to talk, tap again to send'
      : 'Voice input is off — turn it on in your settings file to use the mic';
  }

  async function startRecording() {
    if (!voiceInputAvailable()) {
      addMessage(
        'error',
        'Voice input is turned off, so I have no way to hear you. Typing works exactly the same.'
      );
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      addMessage('error', "I can't reach the microphone. Check your system's mic permissions for Buddy.");
      return;
    }

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
      (type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)
    );

    recordingChunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) recordingChunks.push(event.data);
    });

    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((track) => track.stop());
      micButton.classList.remove('recording');
      recorder = null;

      const blob = new Blob(recordingChunks, { type: mimeType || 'audio/webm' });
      recordingChunks = [];
      if (blob.size < 900) {
        setStatus('online');
        return;
      }

      setBusy(true);
      setStatus('transcribing', 'busy');
      try {
        // The mime type matters to local Whisper servers, which sniff the
        // container from the filename before handing the clip to ffmpeg.
        const { text } = await api('/asr', { audio: await blobToBase64(blob), mimeType: blob.type });
        setBusy(false);
        if (text && text.trim()) {
          input.value = text.trim();
          send(text);
        } else {
          setStatus('online');
          addMessage('error', "I couldn't make out any words in that.");
        }
      } catch (error) {
        setBusy(false);
        setStatus('offline', 'bad');
        addMessage('error', error.message);
      }
    });

    recorder.start();
    micButton.classList.add('recording');
    setStatus('listening', 'busy');
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  // events

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });

  micButton.addEventListener('click', () => {
    if (recorder) stopRecording();
    else startRecording();
  });

  speakerButton.addEventListener('click', () => {
    speakerOn = !speakerOn;
    localStorage.setItem('buddy:speaker', speakerOn ? 'on' : 'off');
    updateSpeakerButton();
    if (!speakerOn) stopSpeaking();
  });

  $('close-panel').addEventListener('click', () => {
    stopSpeaking();
    stopRecording();
    window.buddy.closePanel();
  });

  $('history-btn').addEventListener('click', () => {
    if (drawer.hidden) openDrawer();
    else closeDrawer();
  });

  $('drawer-close').addEventListener('click', closeDrawer);

  $('new-chat').addEventListener('click', () => {
    stopSpeaking();
    stopRecording();
    // The old conversation is already on disk; starting fresh just detaches it.
    sessionId = null;
    closeDrawer();
    greet();
    setStatus('online');
    input.focus();
  });

  saveToggle.addEventListener('change', async () => {
    try {
      const { runtime: updated } = await api('/settings', { saveHistory: saveToggle.checked });
      runtime = { ...runtime, ...updated };
      $('drawer-note').textContent = runtime.saveHistory ? 'saved on this device' : 'saving is off';
    } catch (error) {
      saveToggle.checked = !saveToggle.checked;
      console.warn('[buddy] could not change the save setting:', error.message);
    }
  });

  // Deleting everything is worth a second tap rather than a modal.
  clearButton.addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      clearButton.classList.add('confirming');
      clearButton.textContent = 'Really delete every chat?';
      setTimeout(() => {
        if (clearArmed) resetClearButton();
      }, 4000);
      return;
    }
    try {
      await api('/chats', undefined, { method: 'DELETE' });
      sessionId = null;
      greet();
      resetClearButton();
      await openDrawer();
    } catch (error) {
      console.warn('[buddy] could not clear history:', error.message);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  // Links must open in the real browser, never inside Buddy.
  messages.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-external]');
    if (!link) return;
    event.preventDefault();
    window.buddy.openExternal(link.getAttribute('href'));
  });

  window.buddy.onPanelVisibility((visible) => {
    if (visible) setTimeout(() => input.focus(), 40);
    else {
      stopSpeaking();
      stopRecording();
    }
  });

  updateSpeakerButton();
  applyVoiceInputAvailability();
  setStatus('online');
  greet();
  input.focus();

  // Pick up where the last conversation left off, so reopening Buddy feels
  // continuous rather than amnesiac.
  (async () => {
    try {
      const { chats } = await api('/chats');
      if (chats.length) await loadConversation(chats[0].id);
    } catch {
      /* a fresh install, or history is unreadable — the greeting stands */
    }
  })();
}

// ═══════════════════════════════════════════════════════════════════════════
// ORB  (click / drag / wake word)
// ═══════════════════════════════════════════════════════════════════════════

const WAKE_TARGETS = [
  'hey buddy',
  'hi buddy',
  'hey body',
  'a buddy',
  'hey butty',
  'hey buddie',
  'hey bud',
  'ok buddy',
  'yo buddy',
  'hey buddha',
];

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Fuzzy match so common mishearings of "hey buddy" still wake Buddy up. */
function isWakePhrase(transcript) {
  const normalised = String(transcript || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalised) return false;

  for (const target of WAKE_TARGETS) {
    if (normalised.includes(target)) return true;
  }

  const words = normalised.split(' ');
  for (let size = 1; size <= 3; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      const phrase = words.slice(start, start + size).join(' ');
      if (phrase.length < 4 || phrase.length > 16) continue;
      for (const target of WAKE_TARGETS) {
        const budget = target.length <= 8 ? 1 : 2;
        if (levenshtein(phrase, target) <= budget) return true;
      }
    }
  }
  return false;
}

function initOrb() {
  const stage = document.querySelector('.orb-stage');
  const orb = $('orb');
  const tooltip = $('orb-tooltip');
  const toast = $('orb-toast');

  // ── wake-word tuning ────────────────────────────────────────────────────
  const CALIBRATION_MS = 2000; // measure the room before trusting any threshold
  const SPEECH_SUSTAIN_MS = 250; // loud for this long => probably speech
  const SILENCE_HANG_MS = 700; // quiet for this long => the phrase ended
  const MAX_CLIP_MS = 4000;
  const ASR_MIN_GAP_MS = 1500; // a noisy room must not spam the provider
  const WAKE_COOLDOWN_MS = 2500;
  const FLOOR_FACTOR = 2.2; // threshold = floor * factor …
  const FLOOR_MARGIN = 0.012; // … but at least this far above it
  const MIN_THRESHOLD = 0.02;

  let wakeEnabled = true;
  let panelVisible = false;
  let running = false;

  let stream = null;
  let audioContext = null;
  let analyser = null;
  let frame = null;
  let sampleBuffer = null;

  let recorder = null;
  let chunks = [];
  let recordingStartedAt = 0;

  let calibrationEndsAt = 0;
  let floorSamples = [];
  let noiseFloor = 0.01;
  let loudSince = 0;
  let quietSince = 0;
  let lastAsrAt = 0;
  let cooldownUntil = 0;
  let toastTimer = null;

  function showToast(message, bad) {
    toast.textContent = message;
    toast.classList.toggle('bad', Boolean(bad));
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function flash(className, duration) {
    stage.classList.add(className);
    setTimeout(() => stage.classList.remove(className), duration);
  }

  function refreshHotState() {
    const hot = running && wakeEnabled && !panelVisible;
    stage.classList.toggle('hot', hot);
    tooltip.textContent = hot ? "Listening for 'Hey Buddy'" : 'Ask Buddy';
    if (!voiceInputAvailable()) tooltip.textContent = 'Ask Buddy (voice input off)';
  }

  // ── click vs. drag ──────────────────────────────────────────────────────

  let pressedAt = 0;
  let pressOrigin = null;
  let dragging = false;

  orb.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pressedAt = Date.now();
    pressOrigin = { x: event.screenX, y: event.screenY };
    dragging = true;
    stage.classList.add('dragging');
    window.buddy.startOrbDrag();
  });

  function endPress(event) {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('dragging');
    window.buddy.endOrbDrag();

    const travelled = pressOrigin
      ? Math.hypot(event.screenX - pressOrigin.x, event.screenY - pressOrigin.y)
      : Infinity;
    // A short press that barely moved was a click, not a drag.
    if (travelled < 5 && Date.now() - pressedAt < 450) window.buddy.requestOpenPanel();
    pressOrigin = null;
  }

  window.addEventListener('mouseup', endPress);
  window.addEventListener('blur', () => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('dragging');
    window.buddy.endOrbDrag();
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('dragstart', (event) => event.preventDefault());

  // ── the listening pipeline ──────────────────────────────────────────────

  function computeRms() {
    analyser.getByteTimeDomainData(sampleBuffer);
    let sum = 0;
    for (let i = 0; i < sampleBuffer.length; i++) {
      const deviation = (sampleBuffer[i] - 128) / 128;
      sum += deviation * deviation;
    }
    return Math.sqrt(sum / sampleBuffer.length);
  }

  function threshold() {
    return Math.max(noiseFloor * FLOOR_FACTOR, noiseFloor + FLOOR_MARGIN, MIN_THRESHOLD);
  }

  function startClip() {
    if (recorder || !stream) return;
    chunks = [];
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
      (type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)
    );
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      console.warn('[buddy] cannot record wake clips:', error.message);
      return;
    }
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder && recorder.mimeType ? recorder.mimeType : 'audio/webm' });
      chunks = [];
      recorder = null;
      checkClip(blob);
    });
    recorder.start();
    recordingStartedAt = Date.now();
  }

  function stopClip() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function checkClip(blob) {
    if (blob.size < 1200) return;
    if (Date.now() - lastAsrAt < ASR_MIN_GAP_MS) return; // rate limit
    if (!wakeEnabled || panelVisible || Date.now() < cooldownUntil) return;
    lastAsrAt = Date.now();

    try {
      const { text } = await api('/asr', { audio: await blobToBase64(blob) });
      if (!text || !isWakePhrase(text)) return;

      cooldownUntil = Date.now() + WAKE_COOLDOWN_MS;
      flash('fired', 700);
      showToast('Hey!');
      window.buddy.requestOpenPanel();
      acknowledge();
    } catch (error) {
      // A failing wake check is not worth shouting about on every clip.
      console.warn('[buddy] wake check failed:', error.message);
    }
  }

  async function acknowledge() {
    try {
      const response = await api('/tts', { text: 'Yeah?' }, { raw: true });
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch (error) {
      console.warn('[buddy] ack failed:', error.message);
    }
  }

  function tick() {
    frame = requestAnimationFrame(tick);
    if (!analyser) return;

    const now = Date.now();
    const rms = computeRms();

    // Calibrate against the actual room before gating on anything.
    if (now < calibrationEndsAt) {
      floorSamples.push(rms);
      return;
    }
    if (floorSamples.length) {
      floorSamples.sort((a, b) => a - b);
      noiseFloor = floorSamples[Math.floor(floorSamples.length * 0.5)] || 0.01;
      floorSamples = [];
      showToast('Listening');
    }

    if (!wakeEnabled || panelVisible || now < cooldownUntil) {
      if (recorder) stopClip();
      return;
    }

    const limit = threshold();

    if (rms >= limit) {
      quietSince = 0;
      if (!loudSince) loudSince = now;
      if (!recorder && now - loudSince >= SPEECH_SUSTAIN_MS) startClip();
    } else {
      loudSince = 0;
      // Drift the floor toward sustained quiet so the room can change.
      noiseFloor = noiseFloor * 0.995 + rms * 0.005;
      if (recorder) {
        if (!quietSince) quietSince = now;
        if (now - quietSince >= SILENCE_HANG_MS) stopClip();
      }
    }

    if (recorder && now - recordingStartedAt >= MAX_CLIP_MS) stopClip();
  }

  async function startListening() {
    if (running) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      flash('errored', 800);
      showToast('Mic blocked', true);
      wakeEnabled = false;
      localStorage.setItem('buddy:wake', 'off');
      window.buddy.setWakeEnabled(false); // keep the tray checkbox honest
      refreshHotState();
      return;
    }

    audioContext = new AudioContext();
    if (audioContext.state === 'suspended') await audioContext.resume();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.4;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    sampleBuffer = new Uint8Array(analyser.fftSize);

    calibrationEndsAt = Date.now() + CALIBRATION_MS;
    floorSamples = [];
    loudSince = 0;
    quietSince = 0;
    running = true;
    refreshHotState();
    tick();
  }

  function stopListening() {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    stopClip();
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
    refreshHotState();
  }

  function applyWakePreference(enabled) {
    wakeEnabled = Boolean(enabled);
    localStorage.setItem('buddy:wake', wakeEnabled ? 'on' : 'off');
    // With no way to transcribe, opening the microphone would be pointless —
    // and worse, dishonest about what Buddy is doing with it.
    if (wakeEnabled && voiceInputAvailable()) startListening();
    else stopListening();
    refreshHotState();
  }

  window.buddy.onWakeToggled((enabled) => applyWakePreference(enabled));

  window.buddy.onPanelVisibility((visible) => {
    panelVisible = Boolean(visible);
    // Buddy should not listen for its own name while you already have it open.
    if (panelVisible) stopClip();
    refreshHotState();
  });

  panelVisible = boot.panelVisible;
  // main.js owns the persisted setting; localStorage mirrors it per the spec.
  const stored = localStorage.getItem('buddy:wake');
  applyWakePreference(boot.wakeEnabled !== undefined ? boot.wakeEnabled : stored !== 'off');
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════

function initSetup() {
  const form = $('setup-form');
  const saveButton = $('setup-save');
  const errorBox = $('setup-error');
  const privacyNote = $('setup-privacy');

  const tabs = { local: $('tab-local'), cloud: $('tab-cloud') };
  const panes = { local: $('pane-local'), cloud: $('pane-cloud') };

  const baseUrlInput = $('setup-baseurl');
  const keyInput = $('setup-key');
  const modelSelect = $('setup-model');
  const modelManual = $('setup-model-manual');
  const voiceSelect = $('setup-voice');
  const asrSelect = $('setup-asr');
  const whisperUrl = $('setup-whisper-url');
  const probe = $('probe-ollama');
  const probeText = $('probe-text');

  let mode = 'cloud';
  let ollamaUp = false;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  // Closing setup without finishing ends the run — Buddy has nothing to run on.
  $('setup-close').addEventListener('click', () => window.close());

  // ── honest privacy copy, recomputed from the actual choices ─────────────

  function describePrivacy() {
    if (mode === 'cloud') {
      return (
        'Your key is stored unencrypted in this app’s local data folder and sent only to z-ai. ' +
        'Your messages, voice clips and wake-word audio go to z-ai to be processed. ' +
        'Chats are saved on this device.'
      );
    }
    const asr = asrSelect.value;
    if (asr === 'z-ai') {
      return (
        'Thinking and speaking stay on this machine. Only voice input goes to z-ai — including short ' +
        'wake-word clips whenever a sound looks like speech. Chats are saved on this device.'
      );
    }
    if (asr === 'whisper') {
      return (
        'Nothing leaves this machine: thinking, speaking and listening all run locally, so ambient audio ' +
        'stays on your device. Chats are saved on this device.'
      );
    }
    return (
      'Nothing leaves this machine, and with voice input off Buddy never opens your microphone. ' +
      'Chats are saved on this device.'
    );
  }

  function refreshCopy() {
    privacyNote.textContent = describePrivacy();

    const asr = asrSelect.value;
    whisperUrl.hidden = asr !== 'whisper';
    if (asr === 'whisper') {
      $('asr-hint').textContent =
        'Point this at any OpenAI-compatible transcription server — faster-whisper-server, Speaches or LocalAI.';
    } else if (asr === 'z-ai') {
      $('asr-hint').textContent =
        'Needs a z-ai key. Switch to the z-ai tab to enter one, then come back — or leave voice input off.';
    } else {
      $('asr-hint').textContent =
        'With voice input off, Buddy never opens your microphone. You can turn it on later.';
    }
  }

  function selectMode(next) {
    mode = next;
    for (const key of ['local', 'cloud']) {
      const on = key === next;
      tabs[key].classList.toggle('is-on', on);
      tabs[key].setAttribute('aria-selected', String(on));
      panes[key].hidden = !on;
    }
    refreshCopy();
    if (next === 'cloud') keyInput.focus();
  }

  tabs.local.addEventListener('click', () => selectMode('local'));
  tabs.cloud.addEventListener('click', () => selectMode('cloud'));
  asrSelect.addEventListener('change', refreshCopy);

  // ── what the machine actually has ──────────────────────────────────────

  function loadSystemVoices() {
    const fill = () => {
      const voices = speechSynthesis.getVoices().filter((voice) => voice.localService !== false);
      if (!voices.length) return false;
      voiceSelect.replaceChildren();
      for (const voice of voices) {
        const option = document.createElement('option');
        option.value = voice.name;
        option.textContent = `${voice.name} (${voice.lang})`;
        voiceSelect.appendChild(option);
      }
      const english = voices.findIndex((voice) => voice.lang.startsWith('en'));
      voiceSelect.selectedIndex = english >= 0 ? english : 0;
      $('voice-hint').textContent = `${voices.length} offline voice${voices.length === 1 ? '' : 's'} found on this system.`;
      return true;
    };

    if (fill()) return;
    // Chromium populates the voice list asynchronously on first call.
    speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
    setTimeout(fill, 600);
  }

  async function probeOllama() {
    try {
      const status = await api('/providers/status');
      ollamaUp = status.ollama.reachable;

      if (!ollamaUp) {
        probe.className = 'probe down';
        probeText.innerHTML =
          'No Ollama at <code>' +
          escapeHtml(status.ollama.baseUrl) +
          '</code>. Install it from ollama.com, then run <code>ollama pull llama3.2</code>.';
        modelSelect.hidden = true;
        modelManual.hidden = false;
        return;
      }

      const models = status.ollama.models;
      if (!models.length) {
        probe.className = 'probe down';
        probeText.innerHTML = 'Ollama is running but has no models. Run <code>ollama pull llama3.2</code> first.';
        modelSelect.hidden = true;
        modelManual.hidden = false;
        return;
      }

      probe.className = 'probe up';
      probeText.textContent = `Ollama is running with ${models.length} model${models.length === 1 ? '' : 's'}.`;
      modelSelect.hidden = false;
      modelManual.hidden = true;
      modelSelect.replaceChildren();
      for (const name of models) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        modelSelect.appendChild(option);
      }
    } catch (error) {
      probe.className = 'probe down';
      probeText.textContent = `Couldn't check for Ollama: ${error.message}`;
      modelSelect.hidden = true;
      modelManual.hidden = false;
    }
  }

  // ── save ───────────────────────────────────────────────────────────────

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const finish = async (settings, credentials) => {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      try {
        if (credentials) await api('/setup', credentials);
        await api('/settings', settings);
        saveButton.textContent = 'All set!';
        window.buddy.setupComplete();
      } catch (error) {
        showError(error.message);
        saveButton.disabled = false;
        saveButton.textContent = 'Save and start Buddy';
      }
    };

    if (mode === 'cloud') {
      const baseUrl = baseUrlInput.value.trim();
      const apiKey = keyInput.value.trim();
      if (!baseUrl || !apiKey) return showError('Both the base URL and the API key are required.');
      return finish(
        {
          chat: { provider: 'z-ai' },
          tts: { provider: 'z-ai', voice: 'tongtong' },
          asr: { provider: 'z-ai' },
        },
        { baseUrl, apiKey }
      );
    }

    const model = (modelManual.hidden ? modelSelect.value : modelManual.value).trim();
    if (!model) return showError('Pick a model, or type the name of one you have pulled in Ollama.');

    const asr = asrSelect.value;
    if (asr === 'z-ai') {
      const apiKey = keyInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      if (!apiKey || !baseUrl) {
        return showError('Voice input via z-ai needs a key — add one on the z-ai tab, or set voice input to off.');
      }
      return finish(
        {
          chat: { provider: 'ollama', model },
          tts: { provider: 'system', voice: voiceSelect.value },
          asr: { provider: 'z-ai' },
        },
        { baseUrl, apiKey }
      );
    }

    return finish({
      chat: { provider: 'ollama', model },
      tts: { provider: 'system', voice: voiceSelect.value },
      asr: asr === 'whisper' ? { provider: 'whisper', baseUrl: whisperUrl.value.trim() } : { provider: 'off' },
    });
  });

  loadSystemVoices();
  probeOllama();
  selectMode('cloud');
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  document.body.dataset.mode = MODE;
  if (params.get('flat') === '1') document.body.classList.add('flat');

  const root = $(`root-${MODE}`);
  if (root) root.hidden = false;

  // Nothing may talk to the server before we know the port and the token.
  boot = await window.buddy.getBoot();
  // Where each capability runs decides what the UI can offer.
  await refreshRuntime();

  if (MODE === 'orb') initOrb();
  else if (MODE === 'setup') initSetup();
  else initPanel();
}

main().catch((error) => {
  console.error('[buddy] renderer failed to start:', error);
});
