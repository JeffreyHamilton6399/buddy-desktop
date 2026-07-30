/**
 * The orb: a draggable glowing circle that listens for its own name.
 *
 * Two things make this window unusual. It is much larger than the visible circle
 * so the glow is not clipped into a square, which means the renderer has to tell
 * the main process when the pointer is genuinely over the orb — otherwise a big
 * invisible box would eat clicks meant for whatever is behind it. And it holds an
 * open microphone whenever the wake word is on, so everything here is written to
 * fail quiet: a refused microphone turns the feature off rather than nagging.
 */
'use strict';

import { $, api, boot, runtime, refreshRuntime, voiceInputAvailable } from './core.js';
import { openMicrophone, createVoiceDetector, samplesToBase64 } from './capture.js';
import { createSpeaker } from './speech.js';

const WAKE_TARGETS = [
  'hey buddy',
  'hi buddy',
  'hey body',
  'a buddy',
  'hey butty',
  'hey buddie',
  'hey bud',
  'ok buddy',
  'okay buddy',
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
export function isWakePhrase(transcript) {
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

/**
 * Whatever followed the wake phrase, if the user ran straight on: "hey buddy what
 * time is it" should not need asking twice. Returns '' when they only said the name.
 */
export function tailAfterWake(transcript) {
  const text = String(transcript || '').trim();
  const match = text.match(/\b(?:hey|hi|ok|okay|yo)\s+bud(?:dy|die|dha)?\b[\s,.!?-]*/i);
  if (!match) return '';
  const tail = text.slice(match.index + match[0].length).trim();
  // Two words is the floor for something worth treating as a question.
  return tail.split(/\s+/).filter(Boolean).length >= 2 ? tail : '';
}

export function initOrb() {
  const stage = document.querySelector('.orb-stage');
  const orb = $('orb');
  const tooltip = $('orb-tooltip');
  const toast = $('orb-toast');
  const level = $('orb-level');

  const WAKE_COOLDOWN_MS = 2500;
  /**
   * A noisy room starts clips constantly, and every clip that gets transcribed
   * pushes this gap forward — so a wake phrase arriving just after one was
   * dropped without ever being looked at. Whisper handles a short clip in about
   * a third of a second, so the gap can be small.
   */
  const ASR_MIN_GAP_MS = 500;
  /**
   * "Hey Buddy" takes about a second. Listening for five before deciding buried
   * the phrase in whatever else the room was doing and delayed every check; two
   * and a half is long enough for the words and short enough to keep up.
   */
  const WAKE_CLIP_MS = 2500;
  const WAKE_HANGOVER_MS = 500;

  /** How long to wait for a question after Buddy has said hello. */
  const QUESTION_WINDOW_MS = 7000;
  /** A spoken question can run longer than a two-word wake phrase. */
  const QUESTION_MAX_MS = 12000;

  let wakeEnabled = true;
  let panelVisible = false;
  let microphone = null;
  let detector = null;
  let starting = false;
  let lastAsrAt = 0;
  let cooldownUntil = 0;
  let toastTimer = null;
  let levelFrame = null;

  /**
   * The whole point of the wake word is to answer without getting in the way, so
   * a spoken exchange happens entirely at the orb and never opens the panel.
   *
   *   wake      listening for its name
   *   question  said hello, now waiting for what you actually want
   *   busy      thinking, or talking back
   *
   * Clicking the orb still opens the panel; that is a separate thing.
   */
  let mode = 'wake';
  let questionTimer = null;
  /**
   * The conversation both windows are working in, so what you say out loud is
   * waiting in the panel when you open it rather than filed somewhere separate.
   */
  let activeChatId = null;

  const speaker = createSpeaker({
    onStart: () => stage.classList.add('answering'),
    onEnd: () => stage.classList.remove('answering'),
  });

  function showToast(message, bad, holdMs) {
    toast.textContent = message;
    toast.classList.toggle('bad', Boolean(bad));
    toast.classList.add('show');
    clearTimeout(toastTimer);
    if (holdMs !== 0) {
      toastTimer = setTimeout(() => toast.classList.remove('show'), holdMs || 2600);
    }
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toast.classList.remove('show');
  }

  function flash(className, duration) {
    stage.classList.add(className);
    setTimeout(() => stage.classList.remove(className), duration);
  }

  function listening() {
    return Boolean(microphone) && wakeEnabled && !panelVisible;
  }

  function refreshHotState() {
    const hot = listening();
    stage.classList.toggle('hot', hot);
    if (!voiceInputAvailable()) tooltip.textContent = 'Ask Buddy (listening is off)';
    else if (mode === 'question') tooltip.textContent = 'Go ahead…';
    else tooltip.textContent = hot ? 'Listening for “Hey Buddy”' : 'Ask Buddy';
    if (!hot) level.style.setProperty('--level', '0');
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

  /** Turn a captured clip into words. Returns '' when there were none. */
  async function transcribe(samples) {
    const { text } = await api('/asr', {
      pcm: samplesToBase64(samples),
      sampleRate: microphone ? microphone.sampleRate : 16000,
    });
    return text || '';
  }

  function setMode(next) {
    mode = next;
    stage.classList.toggle('asking', next === 'question');
    stage.classList.toggle('thinking', next === 'busy');
    refreshHotState();
  }

  function backToWaiting() {
    clearTimeout(questionTimer);
    questionTimer = null;
    setMode('wake');
    if (detector) {
      detector.configure({ hangoverMs: WAKE_HANGOVER_MS, maxClipMs: WAKE_CLIP_MS });
      detector.restart();
    }
    refreshHotState();
  }

  /** Buddy has said hello — now listen for what they actually want. */
  function openQuestionWindow() {
    if (!listening()) return backToWaiting();
    setMode('question');
    showToast('Listening…', false, 0);
    if (detector) {
      // Room to finish a sentence, and to pause in the middle of one.
      detector.configure({ hangoverMs: 950, maxClipMs: QUESTION_MAX_MS });
      detector.restart();
    }

    clearTimeout(questionTimer);
    questionTimer = setTimeout(() => {
      if (mode !== 'question') return;
      hideToast();
      backToWaiting();
    }, QUESTION_WINDOW_MS);
  }

  /**
   * Answer out loud, at the orb. The panel is deliberately left shut: being able
   * to ask a question without a window appearing over your work is the point.
   */
  async function answer(question) {
    clearTimeout(questionTimer);
    questionTimer = null;
    setMode('busy');
    // The window is 128px across, so there is nowhere to print a reply — it is
    // spoken, and the whole exchange is saved to the conversation, which is
    // there to read if the orb is clicked afterwards.
    showToast('Thinking…', false, 0);

    try {
      const payload = await api('/chat', {
        messages: [{ role: 'user', content: question }],
        sessionId: activeChatId,
        voice: true,
      });

      if (payload.sessionId && payload.sessionId !== activeChatId) {
        activeChatId = payload.sessionId;
        window.buddy.setActiveChat(activeChatId);
      }
      // Tell the panel to re-read it, so opening it shows what was just said.
      window.buddy.notifyChatUpdated(activeChatId);

      const reply = String(payload.reply || '').trim();
      if (!reply) return backToWaiting();

      hideToast();
      await speaker.speak(reply);
    } catch (error) {
      showToast(error.message.slice(0, 60), true, 4000);
    } finally {
      backToWaiting();
    }
  }

  async function considerClip(samples) {
    if (!samples.length) return;
    if (!wakeEnabled || panelVisible) return;

    // ── already awake: this clip is the question ──
    if (mode === 'question') {
      let question = '';
      try {
        question = await transcribe(samples);
      } catch (error) {
        console.warn('[buddy] could not transcribe the question:', error.message);
      }
      if (!question) {
        hideToast();
        return backToWaiting();
      }
      return answer(question);
    }

    if (mode !== 'wake') return;
    if (Date.now() - lastAsrAt < ASR_MIN_GAP_MS) return;
    if (Date.now() < cooldownUntil) return;
    lastAsrAt = Date.now();

    let heard = '';
    try {
      heard = await transcribe(samples);
    } catch (error) {
      // A failing wake check is not worth shouting about on every clip.
      console.warn('[buddy] wake check failed:', error.message);
      return;
    }

    if (!heard || !isWakePhrase(heard)) return;

    cooldownUntil = Date.now() + WAKE_COOLDOWN_MS;
    flash('fired', 900);

    // Load whatever is cold while the greeting plays, so the answer does not
    // have to wait for it. Costs nothing when everything is already warm.
    api('/warm', {}).catch(() => {});

    const tail = tailAfterWake(heard);
    if (tail) {
      // They asked in the same breath — skip the pleasantries.
      return answer(tail);
    }

    setMode('busy');
    showToast('Hey!', false, 0);
    await speaker.say(runtime.greeting || 'Yeah?');
    openQuestionWindow();
  }

  function paintLevel() {
    levelFrame = requestAnimationFrame(paintLevel);
    if (!microphone || !detector) return;
    // Only swell to a voice once Buddy is actually waiting for one. Reacting to
    // every noise while idle is what made the orb feel permanently busy.
    const value = mode === 'question' && listening() ? detector.level(microphone.rms) : 0;
    level.style.setProperty('--level', value.toFixed(3));
  }

  async function startListening() {
    if (microphone || starting) return;
    starting = true;

    try {
      microphone = await openMicrophone({
        onFrame: (_frame, rms) => {
          if (!detector) return;
          // Buddy's own voice would otherwise trip its own detector.
          if (speaker.speaking || panelVisible) return;
          detector.push(rms);
        },
      });
    } catch (error) {
      starting = false;
      flash('errored', 800);
      showToast('Mic blocked', true);
      console.warn('[buddy] could not open the microphone:', error.message);
      wakeEnabled = false;
      localStorage.setItem('buddy:wake', 'off');
      window.buddy.setWakeEnabled(false); // keep the tray checkbox honest
      refreshHotState();
      return;
    }

    detector = createVoiceDetector({
      hangoverMs: WAKE_HANGOVER_MS,
      maxClipMs: WAKE_CLIP_MS,
      onSpeechStart: () => {
        if (!microphone) return;
        // Seeded from the ring buffer, so the leading "Hey" is not lost.
        microphone.beginClip(0.4);
        stage.classList.add('hearing');
      },
      onSpeechEnd: () => {
        stage.classList.remove('hearing');
        if (!microphone || !microphone.capturing) return;
        considerClip(microphone.endClip());
      },
    });
    detector.restart();

    starting = false;
    refreshHotState();
    // No announcement: switching the microphone on is not news, and the toast
    // appeared every time the panel closed.
    if (!levelFrame) paintLevel();
  }

  async function stopListening() {
    if (levelFrame) cancelAnimationFrame(levelFrame);
    levelFrame = null;
    detector = null;
    const current = microphone;
    microphone = null;
    stage.classList.remove('hearing');
    if (current) await current.close();
    refreshHotState();
  }

  /**
   * On a new install the ears are still downloading when the orb starts up, so
   * `voiceInputAvailable()` is false and listening never begins. Checking once at
   * startup meant the wake word stayed silently dead until the app was restarted
   * — nothing on screen said so, because from the outside "not listening yet" and
   * "listening and ignoring you" look exactly the same. So keep asking until the
   * answer changes, then start.
   */
  let readinessTimer = null;
  let keepWarmTimer = null;

  /**
   * The models drop out of memory after a stretch of not being used, which is
   * right for an app sitting idle — but not while the wake word is on, because
   * then Buddy is claiming to be ready to answer at any moment and the first
   * question after lunch would take twelve seconds. A periodic touch resets the
   * idle timers and keeps that promise honest. It costs about 1.4 GB of memory,
   * which is why it only happens while listening is switched on.
   */
  function keepWarm(on) {
    clearInterval(keepWarmTimer);
    keepWarmTimer = null;
    if (!on) return;
    api('/warm', {}).catch(() => {});
    keepWarmTimer = setInterval(() => {
      api('/warm', {}).catch(() => {});
    }, 5 * 60 * 1000);
  }

  function watchForReadiness() {
    clearInterval(readinessTimer);
    readinessTimer = setInterval(async () => {
      if (!wakeEnabled || microphone || starting) return;
      await refreshRuntime();
      if (voiceInputAvailable()) {
        clearInterval(readinessTimer);
        readinessTimer = null;
        startListening();
      }
    }, 5000);
  }

  function applyWakePreference(enabled) {
    wakeEnabled = Boolean(enabled);
    localStorage.setItem('buddy:wake', wakeEnabled ? 'on' : 'off');
    // With no way to transcribe, opening the microphone would be pointless —
    // and worse, dishonest about what Buddy is doing with it.
    if (wakeEnabled && voiceInputAvailable()) {
      clearInterval(readinessTimer);
      readinessTimer = null;
      startListening();
    } else {
      stopListening();
      if (wakeEnabled) watchForReadiness();
    }
    keepWarm(wakeEnabled);
    refreshHotState();
  }

  window.buddy.onWakeToggled((enabled) => applyWakePreference(enabled));

  window.buddy.onPanelVisibility((visible) => {
    panelVisible = Boolean(visible);
    // Buddy should not listen for its own name while you already have it open.
    if (panelVisible) {
      speaker.stop();
      if (microphone) microphone.cancelClip();
      stage.classList.remove('hearing');
    } else if (detector) {
      // The room may have changed while the panel was up.
      detector.restart();
    }
    refreshHotState();
  });

  // The panel owns speaking once it is open, so the orb goes quiet.
  window.buddy.onRuntimeChanged(() => {
    if (wakeEnabled && voiceInputAvailable() && !microphone) startListening();
    else if (!voiceInputAvailable() && microphone) stopListening();
    refreshHotState();
  });

  window.buddy.onActiveChat((id) => {
    activeChatId = id || null;
  });

  // Pick up whichever conversation the panel already has open.
  window.buddy.getActiveChat().then((id) => {
    if (id) activeChatId = id;
  });

  panelVisible = boot.panelVisible;
  // main.js owns the persisted setting; localStorage mirrors it per the spec.
  const stored = localStorage.getItem('buddy:wake');
  applyWakePreference(boot.wakeEnabled !== undefined ? boot.wakeEnabled : stored !== 'off');
}
