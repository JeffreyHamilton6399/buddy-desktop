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

import { $, api, boot, runtime, voiceInputAvailable } from './core.js';
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
  const ASR_MIN_GAP_MS = 900;

  let wakeEnabled = true;
  let panelVisible = false;
  let microphone = null;
  let detector = null;
  let starting = false;
  let lastAsrAt = 0;
  let cooldownUntil = 0;
  let toastTimer = null;
  let levelFrame = null;

  const speaker = createSpeaker({
    onStart: () => stage.classList.add('answering'),
    onEnd: () => stage.classList.remove('answering'),
  });

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

  function listening() {
    return Boolean(microphone) && wakeEnabled && !panelVisible;
  }

  function refreshHotState() {
    const hot = listening();
    stage.classList.toggle('hot', hot);
    if (!voiceInputAvailable()) tooltip.textContent = 'Ask Buddy (listening is off)';
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

  async function considerClip(samples) {
    if (!samples.length) return;
    if (Date.now() - lastAsrAt < ASR_MIN_GAP_MS) return;
    if (!wakeEnabled || panelVisible || Date.now() < cooldownUntil) return;
    lastAsrAt = Date.now();

    let heard = '';
    try {
      const { text } = await api('/asr', {
        pcm: samplesToBase64(samples),
        sampleRate: microphone ? microphone.sampleRate : 16000,
      });
      heard = text || '';
    } catch (error) {
      // A failing wake check is not worth shouting about on every clip.
      console.warn('[buddy] wake check failed:', error.message);
      return;
    }

    if (!heard || !isWakePhrase(heard)) return;

    cooldownUntil = Date.now() + WAKE_COOLDOWN_MS;
    flash('fired', 900);
    showToast('Hey!');

    const question = tailAfterWake(heard);
    window.buddy.requestOpenPanel();

    if (question) {
      // They asked in the same breath — pass it straight through rather than
      // greeting them and making them repeat it.
      window.buddy.sendWakeQuestion(question);
    } else {
      speaker.say(runtime.greeting || 'Yeah?');
    }
  }

  function paintLevel() {
    levelFrame = requestAnimationFrame(paintLevel);
    if (!microphone || !detector) return;
    const value = listening() ? detector.level(microphone.rms) : 0;
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
    showToast('Listening');
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

  panelVisible = boot.panelVisible;
  // main.js owns the persisted setting; localStorage mirrors it per the spec.
  const stored = localStorage.getItem('buddy:wake');
  applyWakePreference(boot.wakeEnabled !== undefined ? boot.wakeEnabled : stored !== 'off');
}
