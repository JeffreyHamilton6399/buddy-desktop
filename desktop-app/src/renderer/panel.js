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
  refreshRuntime,
  renderMarkdown,
  voiceInputAvailable,
} from './core.js';
import { openMicrophone, createVoiceDetector, samplesToBase64 } from './capture.js';
import { createSpeaker } from './speech.js';
import { createSettings } from './settings.js';

export function initPanel() {
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

  function speak(text) {
    if (!speakerOn || !String(text || '').trim()) return;
    speaker.speak(text);
  }

  async function send(text) {
    const content = String(text || '').trim();
    if (!content || busy) return;

    speaker.stop();
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

  // ── settings ────────────────────────────────────────────────────────────

  const settings = createSettings({
    onChanged: () => {
      applyVoiceInputAvailability();
      // The orb cares about hearing and about the voice being ready.
      window.buddy.notifyRuntimeChanged();
    },
    getWakeEnabled: () => wakeEnabled,
    onRequestMicTest: () => micTest(),
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
        ? 'Buddy is set not to listen — turn hearing on in settings'
        : "Buddy's ears are still downloading";
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
      addMessage('error', "I can't reach the microphone. Check your system's mic permissions for Buddy.");
      return;
    }

    microphone.beginClip(0);
    recording = true;
    micButton.classList.add('recording');
    setStatus('listening', 'busy');
  }

  /**
   * Settings' "test the microphone": listen until they stop talking, then report
   * back the words. Ends early on a finished sentence rather than always making
   * the user sit through the whole timeout.
   */
  async function micTest() {
    if (!voiceInputAvailable()) throw new Error('Buddy has no way to listen right now.');

    const LISTEN_MS = 7000;
    let spoke = false;
    /** Replaced below by the resolver, once there is a promise to settle. */
    let finished = () => {};

    const detector = createVoiceDetector({
      onSpeechStart: () => {
        spoke = true;
      },
      onSpeechEnd: () => finished(),
    });
    detector.restart();

    const mic = await openMicrophone({ onFrame: (_frame, rms) => detector.push(rms) });
    mic.beginClip(0);

    try {
      await new Promise((resolve) => {
        // Whichever comes first: they finish a sentence, or the clock runs out.
        const timer = setTimeout(resolve, LISTEN_MS);
        finished = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      const clip = mic.endClip();
      if (!spoke || clip.length < mic.sampleRate * 0.3) return 'Heard nothing at all.';

      const { text } = await api('/asr', { pcm: samplesToBase64(clip), sampleRate: mic.sampleRate });
      return text && text.trim() ? `Heard: “${text.trim()}”` : 'Heard sound, but no words in it.';
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

  speakerButton.addEventListener('click', () => {
    speakerOn = !speakerOn;
    localStorage.setItem('buddy:speaker', speakerOn ? 'on' : 'off');
    updateSpeakerButton();
    if (!speakerOn) speaker.stop();
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
    sessionId = null;
    closeDrawer();
    settings.close();
    greet();
    setStatus('online');
    input.focus();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
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
    if (visible) setTimeout(() => input.focus(), 40);
    else {
      speaker.stop();
      stopRecording({ send: false });
    }
  });

  window.buddy.onWakeToggled((enabled) => {
    wakeEnabled = Boolean(enabled);
    settings.syncWake(wakeEnabled);
  });

  // "Hey Buddy, what time is it" — the orb already heard the question.
  window.buddy.onWakeQuestion((text) => {
    closeDrawer();
    settings.close();
    send(text);
  });

  window.buddy.onRuntimeChanged(async () => {
    await refreshRuntime();
    applyVoiceInputAvailability();
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
