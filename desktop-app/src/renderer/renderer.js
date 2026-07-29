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
  // Matches the server's defaults, so the UI is right even in the moment before
  // /health answers: own model, OS voices, microphone shut.
  providers: { chat: 'builtin', tts: 'system', asr: 'off' },
  cloud: [],
  fullyLocal: true,
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

/**
 * First run. There is nothing to configure and nothing to decide: Buddy fetches
 * its model once, shows how far along it is, and starts. The cloud form exists
 * only for people who go looking for it.
 */
function initSetup() {
  const ready = $('ready');
  const form = $('setup-form');
  const barFill = $('bar-fill');
  const line = $('ready-line');
  const sub = $('ready-sub');
  const title = $('ready-title');
  const lede = $('ready-lede');
  const retry = $('ready-retry');
  const saveButton = $('setup-save');
  const errorBox = $('setup-error');

  let polling = null;
  let finished = false;

  const MB = 1048576;
  const asSize = (bytes) =>
    bytes >= 1024 * MB ? (bytes / (1024 * MB)).toFixed(1) + ' GB' : Math.round(bytes / MB) + ' MB';

  function asDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return null;
    if (seconds < 60) return 'less than a minute left';
    const minutes = Math.round(seconds / 60);
    return 'about ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + ' left';
  }

  function stopPolling() {
    clearInterval(polling);
    polling = null;
  }

  // Closing setup without finishing ends the run — Buddy has nothing to run on.
  $('setup-close').addEventListener('click', () => window.close());

  // ── the download ────────────────────────────────────────────────────────

  function render(state) {
    if (state.status === 'error') {
      ready.classList.add('failed');
      barFill.classList.remove('indeterminate');
      // Show how far it got: the copy below promises the progress was kept, so an
      // empty bar would contradict it.
      barFill.style.width = `${state.percent || 0}%`;
      title.textContent = "That didn't work.";
      lede.textContent = 'I could not finish downloading my model.';
      line.textContent = state.error || 'The download failed.';
      sub.textContent =
        'Your progress was kept, so trying again picks up where it stopped. A different network often helps.';
      retry.hidden = false;
      return;
    }

    ready.classList.remove('failed');
    retry.hidden = true;

    if (state.status === 'verifying') {
      barFill.classList.remove('indeterminate');
      barFill.style.width = '100%';
      line.textContent = 'Checking the download…';
      sub.textContent = 'Making sure every byte arrived intact before I use it.';
      return;
    }

    if (state.ready) {
      barFill.classList.remove('indeterminate');
      barFill.style.width = '100%';
      title.textContent = "All set. I'm Buddy.";
      lede.textContent = 'Starting up…';
      line.textContent = 'Ready';
      return;
    }

    // Downloading, or still waiting for the first byte.
    const started = state.receivedBytes > 0;
    barFill.classList.toggle('indeterminate', !started);
    if (started) barFill.style.width = state.percent + '%';

    const bits = [];
    if (started) bits.push(asSize(state.receivedBytes) + ' of ' + asSize(state.totalBytes));
    if (state.bytesPerSecond > 0) bits.push((state.bytesPerSecond / MB).toFixed(1) + ' MB/s');
    const eta = asDuration(state.etaSeconds);
    if (eta) bits.push(eta);
    line.textContent = started ? bits.join('  ·  ') : 'Starting the download…';
  }

  async function finish() {
    if (finished) return;
    finished = true;
    stopPolling();
    // The defaults are already fully local, so nothing needs choosing — writing
    // the settings file is what marks this install as past its first run.
    try {
      await api('/settings', { chat: { provider: 'builtin' } });
    } catch (error) {
      console.warn('[buddy] could not persist settings:', error.message);
    }
    setTimeout(() => window.buddy.setupComplete(), 450);
  }

  async function poll() {
    try {
      const state = await api('/model');
      render(state);
      if (state.ready) await finish();
    } catch (error) {
      render({ status: 'error', error: error.message, receivedBytes: 0, totalBytes: 1, percent: 0 });
    }
  }

  async function beginDownload() {
    ready.classList.remove('failed');
    retry.hidden = true;
    render({ status: 'downloading', receivedBytes: 0, totalBytes: 1, percent: 0, bytesPerSecond: 0 });
    try {
      const state = await api('/model', {});
      render(state);
      if (state.ready) return finish();
    } catch (error) {
      return render({ status: 'error', error: error.message, receivedBytes: 0, totalBytes: 1, percent: 0 });
    }
    stopPolling();
    polling = setInterval(poll, 500);
  }

  retry.addEventListener('click', beginDownload);

  // ── the cloud escape hatch ──────────────────────────────────────────────

  $('show-advanced').addEventListener('click', () => {
    stopPolling();
    ready.hidden = true;
    form.hidden = false;
    title.textContent = 'Use a cloud API';
    lede.textContent = 'Only if you want to. The built-in model needs none of this.';
    $('setup-key').focus();
  });

  $('hide-advanced').addEventListener('click', () => {
    form.hidden = true;
    ready.hidden = false;
    errorBox.hidden = true;
    title.textContent = "Hey, I'm Buddy.";
    lede.textContent = 'Getting my brain ready — this happens once.';
    beginDownload();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const baseUrl = $('setup-baseurl').value.trim();
    const apiKey = $('setup-key').value.trim();
    if (!baseUrl || !apiKey) {
      errorBox.textContent = 'Both the base URL and the API key are required.';
      errorBox.hidden = false;
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await api('/setup', { baseUrl, apiKey });
      await api('/settings', {
        chat: { provider: 'z-ai' },
        tts: { provider: 'z-ai', voice: 'tongtong' },
        asr: { provider: 'z-ai' },
      });
      finished = true;
      stopPolling();
      window.buddy.setupComplete();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      saveButton.disabled = false;
      saveButton.textContent = 'Use this cloud API';
    }
  });

  beginDownload();
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
