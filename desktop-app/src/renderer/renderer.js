/**
 * Buddy — renderer. One file serves three window modes (orb / panel / setup);
 * the mode arrives as a query parameter from main.js.
 */
'use strict';

const params = new URLSearchParams(location.search);
const MODE = ['orb', 'panel', 'setup'].includes(params.get('mode')) ? params.get('mode') : 'panel';

/** @type {{ port: number|null, token: string|null, wakeEnabled: boolean, panelVisible: boolean }} */
let boot = { port: null, token: null, wakeEnabled: true, panelVisible: false };

const $ = (id) => document.getElementById(id);

// ── server access ─────────────────────────────────────────────────────────

function serverUrl(route) {
  return `http://127.0.0.1:${boot.port}${route}`;
}

async function api(route, body, { raw = false } = {}) {
  const response = await fetch(serverUrl(route), {
    method: body === undefined ? 'GET' : 'POST',
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
    micButton.disabled = value;
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
    equalizer.hidden = true;
  }

  async function speak(text) {
    if (!speakerOn || !text.trim()) return;
    stopSpeaking();
    try {
      const response = await api('/tts', { text }, { raw: true });
      const url = URL.createObjectURL(await response.blob());

      audioElement = new Audio(url);
      equalizer.hidden = false;
      setStatus('speaking', 'busy');

      const done = () => {
        equalizer.hidden = true;
        if (!busy) setStatus('online');
        URL.revokeObjectURL(url);
        if (audioElement && audioElement.src === url) audioElement = null;
      };
      audioElement.addEventListener('ended', done, { once: true });
      audioElement.addEventListener('error', done, { once: true });

      await audioElement.play();
    } catch (error) {
      equalizer.hidden = true;
      if (!busy) setStatus('online');
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

  async function startRecording() {
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
        const { text } = await api('/asr', { audio: await blobToBase64(blob) });
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
  setStatus('online');
  addMessage('buddy', "Hey! I'm Buddy. Ask me anything, or say **“Hey Buddy”** any time.", { markdown: true });
  input.focus();
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
    if (wakeEnabled) startListening();
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
  const baseUrlInput = $('setup-baseurl');
  const keyInput = $('setup-key');
  const saveButton = $('setup-save');
  const errorBox = $('setup-error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  // Closing setup without a key ends the run — Buddy can't do anything without one.
  $('setup-close').addEventListener('click', () => window.close());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const baseUrl = baseUrlInput.value.trim();
    const apiKey = keyInput.value.trim();
    if (!baseUrl || !apiKey) return showError('Both the base URL and the API key are required.');

    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await api('/setup', { baseUrl, apiKey });
      saveButton.textContent = 'All set!';
      window.buddy.setupComplete();
    } catch (error) {
      showError(error.message);
      saveButton.disabled = false;
      saveButton.textContent = 'Save and start Buddy';
    }
  });

  keyInput.focus();
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

  if (MODE === 'orb') initOrb();
  else if (MODE === 'setup') initSetup();
  else initPanel();
}

main().catch((error) => {
  console.error('[buddy] renderer failed to start:', error);
});
