/**
 * The chat panel: messages, the composer, the saved-chat drawer, and the way in
 * to settings. Speaking is delegated to speech.js and the microphone to capture.js,
 * so what is left here is the conversation itself.
 */
'use strict';

import {
  $,
  api,
  boot,
  runtime,
  buddyName,
  wakePhrase,
  refreshRuntime,
  renderMarkdown,
  streamChat,
  voiceInputAvailable,
} from './core.js';
import { openMicrophone, createVoiceDetector, samplesToBase64 } from './capture.js';
import { createSpeaker } from './speech.js';
import { createSettings } from './settings.js';
import { applyLookFromRuntime } from './theme.js';
import { isWakePhrase } from './orb.js';

export function initPanel() {
  const messages = $('messages');
  const input = $('input');
  const composer = $('composer');
  const sendButton = $('send');
  const micButton = $('mic');
  const statusLabel = $('status');
  const equalizer = $('equalizer');

  let sessionId = null;
  let busy = false;
  /** The reply being generated right now, so interrupting can call it off. */
  let inFlight = null;

  /**
   * Put whatever Buddy is currently called into the chrome that names it. The
   * header is the obvious one; the placeholder matters just as much, because
   * "Ask Buddy anything…" under a panel headed "Ada" reads as a bug.
   */
  function applyIdentity() {
    const name = buddyName();
    $('panel-name').textContent = name;
    input.placeholder = `Ask ${name} anything…`;
    $('open-settings').setAttribute('aria-label', `Open settings for ${name}`);
    $('close-panel').setAttribute('aria-label', `Close ${name}`);
  }

  /**
   * Keep the orb pointed at the same conversation. Both windows talk to the
   * server independently, so without this the spoken half and the typed half of
   * the same conversation end up in two different files.
   */
  function setSession(id) {
    if (id === sessionId) return;
    sessionId = id || null;
    window.buddy.setActiveChat(sessionId);
  }
  let microphone = null;
  let recording = false;

  const speaker = createSpeaker({
    onStart: () => {
      equalizer.hidden = false;
      setStatus('speaking', 'busy');
    },
    onEnd: () => {
      equalizer.hidden = true;
      if (!busy) setStatus('online');
    },
    onError: (error) => console.warn('[buddy] voice reply failed:', error.message),
  });

  function setStatus(text, tone) {
    statusLabel.textContent = text;
    statusLabel.className = 'panel-status' + (tone ? ` ${tone}` : '');
  }

  function scrollToEnd() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(role, content, { markdown = false, images = [] } = {}) {
    const row = document.createElement('div');
    row.className = `msg ${role}`;

    if (role !== 'user') {
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      row.appendChild(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    // Pictures go above the text they were sent with, which is the order they
    // were meant in: here is a thing, and here is my question about it.
    for (const image of images) {
      // Old pictures are aged out of saved chats to keep them from growing
      // without bound; the message still says one was there.
      if (!image.data) {
        const gone = document.createElement('span');
        gone.className = 'bubble-image-gone';
        gone.textContent = `🖼 ${image.name || 'picture'} — no longer kept`;
        bubble.appendChild(gone);
        continue;
      }
      const thumb = document.createElement('img');
      thumb.className = 'bubble-image';
      thumb.src = `data:${image.mime};base64,${image.data}`;
      thumb.alt = image.name || 'An attached picture';
      bubble.appendChild(thumb);
    }

    if (markdown) bubble.insertAdjacentHTML('beforeend', renderMarkdown(content));
    else if (content) bubble.appendChild(document.createTextNode(content));

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

  function speak(text) {
    // A real setting now, shared with the orb's window and the settings pane,
    // rather than a per-window preference behind an unlabelled icon.
    if (runtime.speakReplies === false || !String(text || '').trim()) return;
    speaker.speak(text);
  }

  // ── pictures ────────────────────────────────────────────────────────────

  /**
   * Buddy only has eyes when something with eyes is answering. The paperclip is
   * hidden rather than disabled when it does not — a control that is visible but
   * refuses is a worse answer to "can it look at this?" than no control at all,
   * and the tooltip on the greyed-out version is not where anyone would look.
   */
  const attachButton = $('attach');
  const picker = $('image-picker');
  const tray = $('attachments');

  /** @type {Array<{ mime: string, data: string, name: string }>} */
  let pending = [];

  const MAX_PENDING = 4;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

  const screenButton = $('see-screen');

  /**
   * The paperclip and the screen button, which exist only when the brain has
   * eyes.
   *
   * Gone rather than greyed out. Unlike the microphone below — which is off
   * because of a setting you can turn back on, so a disabled button is a
   * pointer to it — a brain with no vision cannot be talked round. Leaving two
   * permanently dead controls in the composer would be clutter that never
   * resolves, so the row simply carries what Buddy can currently do.
   *
   * Both are restored the moment a model that can see is selected, since this
   * runs again on every runtime change.
   */
  function applyVisionAvailability() {
    const blind = runtime.canSee === false;

    attachButton.hidden = blind;
    screenButton.hidden = blind;
    // Cleared explicitly: a button that was disabled while hidden would come
    // back visible and dead.
    attachButton.disabled = false;
    screenButton.disabled = false;
    attachButton.title = 'Add a picture';
    screenButton.title = `Show ${buddyName()} your screen`;

    if (blind && pending.length) {
      pending = [];
      renderAttachments();
    }
  }

  /**
   * Take a picture of the screen and queue it like any other attachment.
   *
   * It lands in the tray rather than sending immediately, so the shot can be
   * looked at — and thrown away — before it goes anywhere. That matters more
   * than usual here: a screenshot catches whatever else was on screen, and if
   * the brain is a cloud provider it is about to leave the machine.
   */
  screenButton.addEventListener('click', async () => {
    if (pending.length >= MAX_PENDING) {
      addMessage('note', `Only ${MAX_PENDING} pictures at a time.`);
      return;
    }
    screenButton.disabled = true;
    try {
      const shot = await window.buddy.captureScreen();
      if (!shot || !shot.ok) {
        addMessage('error', `Couldn't capture the screen: ${(shot && shot.error) || 'unknown error'}`);
        return;
      }
      pending.push({ mime: shot.mime, data: shot.data, name: shot.name });
      renderAttachments();
      if (!input.value.trim()) input.value = 'What do you see here?';
      input.focus();
    } finally {
      screenButton.disabled = false;
    }
  });

  function renderAttachments() {
    tray.replaceChildren();
    tray.hidden = pending.length === 0;

    pending.forEach((image, index) => {
      const cell = document.createElement('div');
      cell.className = 'attachment';

      const thumb = document.createElement('img');
      thumb.src = `data:${image.mime};base64,${image.data}`;
      thumb.alt = image.name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = `Remove ${image.name}`;
      remove.setAttribute('aria-label', `Remove ${image.name}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';
      remove.addEventListener('click', () => {
        pending.splice(index, 1);
        renderAttachments();
      });

      cell.append(thumb, remove);
      tray.appendChild(cell);
    });
  }

  /** Read one file into the base64 the server and every provider want. */
  function readImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        if (comma < 0) return resolve(null);
        resolve({ mime: file.type, data: result.slice(comma + 1), name: file.name || 'picture' });
      };
      reader.readAsDataURL(file);
    });
  }

  async function attachFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file && file.type.startsWith('image/'));
    if (!files.length) return;

    if (runtime.canSee === false) {
      addMessage('note', `${buddyName()} cannot look at pictures with its current brain — see Settings ▸ Brain.`);
      return;
    }

    for (const file of files) {
      if (pending.length >= MAX_PENDING) {
        addMessage('note', `Only ${MAX_PENDING} pictures at a time.`);
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        addMessage('note', `${file.name} is too big — 4 MB is the limit.`);
        continue;
      }
      const image = await readImage(file);
      if (image) pending.push(image);
    }
    renderAttachments();
    input.focus();
  }

  attachButton.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    await attachFiles(picker.files);
    // Reset, or picking the same file twice in a row fires nothing the second time.
    picker.value = '';
  });

  // Paste a screenshot straight in — the fastest path there is, and the one
  // people try first after hitting PrtScn.
  input.addEventListener('paste', (event) => {
    const items = [...((event.clipboardData && event.clipboardData.files) || [])];
    if (items.some((file) => file.type.startsWith('image/'))) {
      event.preventDefault();
      attachFiles(items);
    }
  });

  const panelRoot = document.querySelector('#root-panel .panel');
  let dragDepth = 0;

  // dragenter/dragleave fire for every child element crossed, so a plain
  // toggle flickers the whole time the pointer is moving over the panel.
  panelRoot.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    panelRoot.classList.add('dropping');
  });
  panelRoot.addEventListener('dragover', (event) => event.preventDefault());
  panelRoot.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) panelRoot.classList.remove('dropping');
  });
  panelRoot.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    panelRoot.classList.remove('dropping');
    attachFiles(event.dataTransfer && event.dataTransfer.files);
  });

  async function send(text) {
    const content = String(text || '').trim();
    const images = pending;
    // A picture on its own is a question — "what is this?" — so an empty box
    // with something attached is still worth sending.
    if ((!content && !images.length) || busy) return;

    speaker.stop();
    addMessage('user', content, { images });
    input.value = '';
    pending = [];
    renderAttachments();
    setBusy(true);
    setStatus('thinking', 'busy');

    const typingRow = addTyping();

    /**
     * The typing dots become the reply.
     *
     * Reusing the bubble rather than removing it and adding another means the
     * first words appear exactly where the dots were, with nothing jumping.
     * Rendering is coalesced onto a frame because deltas can arrive a few
     * characters at a time and re-parsing the markdown for each one is work
     * nobody sees.
     */
    const liveBubble = typingRow.querySelector('.bubble');
    let live = '';
    let painting = false;

    const paint = () => {
      painting = false;
      liveBubble.innerHTML = renderMarkdown(live);
      scrollToEnd();
    };

    const onDelta = (piece) => {
      if (!piece) return;
      live += piece;
      if (painting) return;
      painting = true;
      requestAnimationFrame(paint);
    };

    inFlight = new AbortController();
    try {
      const payload = await streamChat(
        { messages: [{ role: 'user', content, images }], sessionId },
        { onDelta, signal: inFlight.signal }
      );
      inFlight = null;
      typingRow.remove();
      setSession(payload.sessionId || sessionId);
      addMessage('buddy', payload.reply, { markdown: true });
      setBusy(false);
      setStatus('online');
      speak(payload.reply);
      await performAction(payload);
    } catch (error) {
      inFlight = null;
      typingRow.remove();
      // Being called off is not a failure worth an error bubble — the user did
      // it on purpose, and whatever had arrived is left where it was.
      if (error.name === 'AbortError') {
        if (live.trim()) addMessage('buddy', live, { markdown: true });
        setBusy(false);
        setStatus('online');
        return;
      }
      addMessage('error', error.message);
      setBusy(false);
      setStatus('offline', 'bad');
    }
  }

  /**
   * Do the thing the model asked for, and say so in the transcript.
   *
   * Nothing happens silently. Opening a tab you did not ask for is only mildly
   * annoying, but not knowing which of your programs opened it is worse — so the
   * action is always written down, whether it worked or was refused.
   */
  /**
   * How many actions one question may set off.
   *
   * Each result goes back to the model, which may ask for another thing, so
   * without a ceiling a model that misreads its own output can read the same
   * file until somebody closes the window. Three is enough for the chains that
   * are actually useful — list a folder, read the interesting file, answer —
   * and short enough that a loop is over before it is annoying.
   */
  const MAX_CHAINED_ACTIONS = 3;

  /**
   * Do the thing, then tell the model what happened.
   *
   * The second half is the point. The result used to go only to the transcript,
   * so Buddy could read a file and still not know what was in it — "read my
   * shopping list and tell me what's missing" read the list and then answered
   * from nothing. Handing the result back and letting it take another turn is
   * what makes an action worth having.
   *
   * @returns {Promise<object|null>} what came back, for the caller to feed on
   */
  async function runOneAction(action) {
    const note = addMessage('note', `About to ${action.description}…`);
    try {
      const result = await window.buddy.runAction(action);
      if (!result || !result.ok) {
        const error = (result && result.error) || 'unknown';
        note.textContent = `Couldn't do that: ${error}`;
        return { ok: false, error, name: action.name, description: action.description };
      }
      note.textContent = `${action.done}.`;
      // Reading a file or listing a folder produces something to look at, and
      // a write says where the old version went. Shown as its own block rather
      // than crammed into the note, because it can be a whole file.
      if (result.detail) addMessage('note', result.detail);
      return { ok: true, detail: result.detail || '', name: action.name, description: action.description };
    } catch (error) {
      note.textContent = `Couldn't do that: ${error.message}`;
      return { ok: false, error: error.message, name: action.name, description: action.description };
    }
  }

  /**
   * Carry out whatever the reply asked for, feed the answer back, and keep
   * going while the model still wants something — up to the ceiling above.
   */
  async function performAction(payload) {
    if (payload.actionRefused) addMessage('note', payload.actionRefused);

    let current = payload;
    for (let step = 0; step < MAX_CHAINED_ACTIONS; step++) {
      if (!current.action) return;

      const result = await runOneAction(current.action);
      if (!result) return;

      // The follow-up is a whole turn of its own: the model sees the result and
      // writes a real answer, which streams into the panel like any other.
      const typingRow = addTyping();
      const liveBubble = typingRow.querySelector('.bubble');
      let live = '';
      let painting = false;
      const paint = () => {
        painting = false;
        liveBubble.innerHTML = renderMarkdown(live);
        scrollToEnd();
      };

      try {
        current = await streamChat(
          { messages: [], sessionId, actionResult: result },
          {
            onDelta: (piece) => {
              if (!piece) return;
              live += piece;
              if (painting) return;
              painting = true;
              requestAnimationFrame(paint);
            },
          }
        );
        typingRow.remove();
        setSession(current.sessionId || sessionId);
        if (current.reply) addMessage('buddy', current.reply, { markdown: true });
        if (current.actionRefused) addMessage('note', current.actionRefused);
        speak(current.reply);
      } catch (error) {
        typingRow.remove();
        addMessage('error', error.message);
        return;
      }
    }

    // Still asking after the ceiling. Say so rather than silently dropping it —
    // "it stopped halfway through" with no explanation is the worse failure.
    if (current.action) {
      addMessage('note', `Stopping after ${MAX_CHAINED_ACTIONS} steps — ask again if there is more to do.`);
    }
  }

  // ── saved conversations ─────────────────────────────────────────────────

  const drawer = $('drawer');
  const chatList = $('chat-list');

  function greet() {
    messages.replaceChildren();
    addMessage('buddy', `Hey! I'm ${buddyName()}. Ask me anything, or say **“${wakePhrase()}”** any time.`, {
      markdown: true,
    });
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
        ? 'No saved chats yet. Anything you ask will be kept here on this device so you can come back to it.'
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
            setSession(null);
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
    settings.close();
    drawer.hidden = false;
    $('drawer-note').textContent = runtime.saveHistory ? 'saved on this device' : 'saving is off';
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
  }

  async function loadConversation(id) {
    try {
      const { chat } = await api(`/chats/${id}`);
      speaker.stop();
      setSession(chat.id);
      messages.replaceChildren();
      for (const message of chat.messages) {
        // An action's result is a turn the model needed, not one anybody said.
        // Drawing it would put the raw framing — instructions and all — in the
        // transcript as though the user had typed it; the reply that follows
        // already carries whatever came of it.
        if (message.kind === 'action') continue;
        if (message.role === 'assistant') addMessage('buddy', message.content, { markdown: true });
        else addMessage('user', message.content, { images: message.images || [] });
      }
      closeDrawer();
      setStatus('online');
      input.focus();
    } catch (error) {
      addMessage('error', `Couldn't open that chat: ${error.message}`);
      closeDrawer();
    }
  }

  // ── settings ────────────────────────────────────────────────────────────

  const settings = createSettings({
    onChanged: () => {
      applyVoiceInputAvailability();
      // The orb cares about hearing and about the voice being ready.
      window.buddy.notifyRuntimeChanged();
    },
    getWakeEnabled: () => wakeEnabled,
    onRequestMicTest: (report) => micTest(report),
  });

  let wakeEnabled = boot.wakeEnabled !== false;

  $('open-settings').addEventListener('click', () => {
    if (settings.visible) settings.close();
    else {
      closeDrawer();
      settings.open();
    }
  });
  $('settings-back').addEventListener('click', () => settings.close());

  // ── voice input ─────────────────────────────────────────────────────────

  function applyVoiceInputAvailability() {
    const available = voiceInputAvailable();
    micButton.disabled = !available || busy;
    micButton.title = available
      ? 'Tap to talk, tap again to send'
      : runtime.providers.asr === 'off'
        ? `${buddyName()} is set not to listen — turn hearing on in settings`
        : `${buddyName()}'s ears are still downloading`;
  }

  async function stopRecording({ send: shouldSend = true } = {}) {
    if (!microphone) return null;
    recording = false;
    micButton.classList.remove('recording');

    const clip = microphone.endClip();
    const rate = microphone.sampleRate;
    const current = microphone;
    microphone = null;
    await current.close();

    if (!shouldSend) return null;

    // Under a third of a second is a mis-tap, not a sentence.
    if (clip.length < rate * 0.3) {
      setStatus('online');
      return null;
    }

    setBusy(true);
    setStatus('transcribing', 'busy');
    try {
      const { text } = await api('/asr', { pcm: samplesToBase64(clip), sampleRate: rate });
      setBusy(false);
      if (text && text.trim()) return text.trim();
      setStatus('online');
      addMessage('error', "I couldn't make out any words in that.");
      return null;
    } catch (error) {
      setBusy(false);
      setStatus('offline', 'bad');
      addMessage('error', error.message);
      return null;
    }
  }

  async function startRecording() {
    if (!voiceInputAvailable()) {
      addMessage(
        'error',
        runtime.providers.asr === 'off'
          ? 'Listening is turned off, so I have no way to hear you. Typing works exactly the same.'
          : "My ears are still downloading. You can carry on typing in the meantime."
      );
      return;
    }

    speaker.stop();
    try {
      microphone = await openMicrophone();
    } catch {
      addMessage('error', `I can't reach the microphone. Check your system's mic permissions for ${buddyName()}.`);
      return;
    }

    microphone.beginClip(0);
    recording = true;
    micButton.classList.add('recording');
    setStatus('listening', 'busy');
  }

  /**
   * Walk the whole wake-word chain and report which link is broken.
   *
   * "Hey Buddy doesn't work" can mean the engine never downloaded, the switch is
   * off, the microphone will not open, the room is quieter than the trigger, the
   * words came back wrong, or the phrase matcher rejected them — and from the
   * outside every one of those looks identical: nothing happens. Each step
   * reports separately so the answer is visible rather than guessed at.
   *
   * @param {(step: string, state: 'run'|'ok'|'fail', detail?: string) => void} report
   */
  async function micTest(report) {
    const say = (step, state, detail) => {
      if (report) report(step, state, detail);
    };

    // 1. is there anything to transcribe with?
    say('engine', 'run');
    await refreshRuntime();
    if (runtime.providers.asr === 'off') {
      say('engine', 'fail', 'Listening is set to off in the dropdown above.');
      throw new Error('Listening is turned off.');
    }
    if (runtime.hearingReady === false) {
      say('engine', 'fail', `${buddyName()}'s ears have not finished downloading yet.`);
      throw new Error('The transcription engine is not ready.');
    }
    say('engine', 'ok', runtime.providers.asr === 'local' ? 'Whisper, in the app' : runtime.providers.asr);

    // 2. is the wake word even switched on?
    say('enabled', wakeEnabled ? 'ok' : 'fail', wakeEnabled ? 'on' : 'Switch it on above — the mic test still works.');

    // 3. can the microphone be opened at all?
    say('mic', 'run');
    let mic;
    const detector = createVoiceDetector({
      onSpeechStart: () => say('speech', 'ok', 'yes — keep talking'),
      onSpeechEnd: () => finished(),
    });
    detector.restart();

    let finished = () => {};
    let peak = 0;
    let spoke = false;

    try {
      mic = await openMicrophone({
        onFrame: (_frame, rms) => {
          peak = Math.max(peak, rms);
          if (detector.push(rms)) spoke = true;
          say('level', 'meter', JSON.stringify({ rms, level: detector.level(rms) }));
        },
      });
    } catch (error) {
      say('mic', 'fail', error.message);
      throw new Error(`The microphone would not open: ${error.message}`);
    }
    say('mic', 'ok', `${Math.round(mic.sampleRate / 1000)} kHz`);
    say('level', 'run', `say “${wakePhrase()}” now`);
    say('speech', 'run');

    mic.beginClip(0);

    try {
      // 4 & 5. wait for a stretch of speech, or give up.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        finished = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      const clip = mic.endClip();
      say(
        'level',
        peak > 0.005 ? 'ok' : 'fail',
        peak > 0.005 ? `peak ${peak.toFixed(3)}` : 'silence — is the right microphone selected?'
      );

      if (!spoke) {
        say('speech', 'fail', `nothing crossed the trigger (floor ${detector.noiseFloor.toFixed(3)})`);
        throw new Error('No speech was detected.');
      }
      if (clip.length < mic.sampleRate * 0.3) {
        say('speech', 'fail', 'the clip was too short to send');
        throw new Error('That clip was too short.');
      }
      say('speech', 'ok', `${(clip.length / mic.sampleRate).toFixed(1)}s captured`);

      // 6. did it come back as words?
      say('heard', 'run');
      const { text } = await api('/asr', { pcm: samplesToBase64(clip), sampleRate: mic.sampleRate });
      const heard = (text || '').trim();
      if (!heard) {
        say('heard', 'fail', 'sound, but no words in it');
        throw new Error('No words were recognised.');
      }
      say('heard', 'ok', `“${heard}”`);

      // 7. and would that have woken Buddy?
      const matched = isWakePhrase(heard);
      const name = buddyName();
      const phrase = wakePhrase();
      say(
        'match',
        matched ? 'ok' : 'fail',
        matched ? `yes — this would wake ${name}` : `not close enough to “${phrase}”`
      );
      return matched ? `Working. Heard “${heard}”.` : `Heard “${heard}”, which is not close enough to “${phrase}”.`;
    } finally {
      finished = () => {};
      await mic.close();
    }
  }

  // events

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });

  micButton.addEventListener('click', async () => {
    if (recording) {
      const text = await stopRecording();
      if (text) {
        input.value = text;
        send(text);
      }
    } else {
      startRecording();
    }
  });

  $('close-panel').addEventListener('click', () => {
    speaker.stop();
    stopRecording({ send: false });
    window.buddy.closePanel();
  });

  $('history-btn').addEventListener('click', () => {
    if (drawer.hidden) openDrawer();
    else closeDrawer();
  });

  $('drawer-close').addEventListener('click', closeDrawer);

  $('new-chat').addEventListener('click', () => {
    speaker.stop();
    stopRecording({ send: false });
    // The old conversation is already on disk; starting fresh just detaches it.
    setSession(null);
    closeDrawer();
    settings.close();
    greet();
    setStatus('online');
    input.focus();
  });

  /**
   * Stop talking. The panel has no wake word listening for someone to cut in,
   * so interrupting here is a deliberate act: press Escape, or click the bars
   * that are bouncing along while Buddy speaks.
   */
  /**
   * Stop. Both halves of it.
   *
   * Silencing the voice was only ever half an interruption — the model kept
   * generating to the last token, so the machine stayed busy answering
   * something the user had already dismissed. Dropping the request is what
   * actually stops it; see the abort handling in handleChat.
   */
  function stopSpeaking() {
    const wasSpeaking = speaker.speaking;
    const wasThinking = Boolean(inFlight);

    speaker.stop();
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
    return wasSpeaking || wasThinking;
  }

  equalizer.addEventListener('click', stopSpeaking);
  // It is announced as a button and can be tabbed to, so it has to answer to the
  // keys a button answers to — Escape alone would be a lie to anyone not using a
  // mouse.
  equalizer.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    stopSpeaking();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Escape means "stop that" before it means "close this".
    if (stopSpeaking()) return;
    if (settings.visible) settings.close();
    else if (!drawer.hidden) closeDrawer();
  });

  // Links must open in the real browser, never inside Buddy.
  messages.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-external]');
    if (!link) return;
    event.preventDefault();
    window.buddy.openExternal(link.getAttribute('href'));
  });

  window.buddy.onPanelVisibility((visible) => {
    if (visible) {
      setTimeout(() => input.focus(), 40);
      /**
       * Opening the panel is as good a sign that a question is coming as the
       * orb hearing its name, and it buys the same thing: the model is no
       * longer resident while Buddy sits idle, so somebody has to start it
       * loading before the question arrives rather than after. Costs nothing
       * when it is already warm.
       */
      api('/warm', {}).catch(() => {});
    } else {
      speaker.stop();
      stopRecording({ send: false });
    }
  });

  window.buddy.onWakeToggled((enabled) => {
    wakeEnabled = Boolean(enabled);
    settings.syncWake(wakeEnabled);
  });

  window.buddy.onRuntimeChanged(async () => {
    await refreshRuntime();
    applyLookFromRuntime();
    applyIdentity();
    applyVisionAvailability();
    applyVoiceInputAvailability();
  });

  /**
   * The orb answered something out loud. Show it here too — that exchange is
   * part of the same conversation, and the point of saying it in the chat is
   * that you can scroll back through everything, not just the typed half.
   */
  window.buddy.onChatUpdated(async (id) => {
    if (!id) return;
    // A spoken exchange may have started the conversation the panel is now in.
    if (!sessionId) sessionId = id;
    if (id !== sessionId || busy) return;
    await loadConversation(id);
  });

  window.buddy.onActiveChat((id) => {
    if (id && !sessionId) sessionId = id;
  });

  applyIdentity();
  applyVisionAvailability();
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
