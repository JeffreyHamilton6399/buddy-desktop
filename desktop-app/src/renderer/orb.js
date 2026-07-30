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

import { $, api, boot, refreshRuntime, voiceInputAvailable } from './core.js';
import { openMicrophone, createVoiceDetector, samplesToBase64 } from './capture.js';
import { createSpeaker } from './speech.js';

/**
 * What counts as being called. Whisper transcribes the same two words a dozen
 * ways depending on the microphone, so the list is mishearings as much as
 * phrasings — "hey buddha" and "hey body" are what a narrowband headset mic
 * routinely produces for "hey buddy".
 *
 * Bare "buddy" is included because that is what people actually say once they
 * are used to it. It costs the occasional false wake when the word comes up in
 * conversation, which is a far smaller annoyance than not being heard.
 */
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
  'buddy',
  'buddie',
  'hey there buddy',
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

  /**
   * Interrupting Buddy while it is talking.
   *
   * The microphone is open the whole time Buddy speaks, so the audio it is
   * hearing is mostly its own voice coming back off the speakers. Echo
   * cancellation removes a lot of that but never all of it, which is why this
   * needs its own detector rather than the ordinary one: a higher trigger and
   * a longer run of sound before it believes anyone. Under-sensitive is the
   * right failure here — a missed interruption costs a repeated "Hey Buddy",
   * while a false one cuts Buddy off mid-sentence for no reason.
   */
  const BARGE_IN_BOOST = 2.6;
  const BARGE_IN_SUSTAIN_MS = 320;
  /**
   * The first words of the interruption land before the detector is sure, so
   * the clip is seeded from further back than usual — the whole point is that
   * you should not have to repeat yourself after cutting in.
   */
  const BARGE_IN_PRE_ROLL_S = 1.0;

  /**
   * Nothing should be able to leave the orb permanently mid-exchange. If a
   * reply never arrives, or the panel opened at exactly the wrong moment, this
   * is what puts it back to listening for its name.
   */
  const STUCK_MODE_MS = 90000;

  let wakeEnabled = true;
  let panelVisible = false;
  let microphone = null;
  let detector = null;
  let starting = false;
  /** When the run of sound loud enough to be an interruption began. */
  let bargeSince = 0;
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
  /** When the orb last left 'wake', so a wedged exchange can be timed out. */
  let modeSince = 0;
  /** Set when the user talks over Buddy, so answer() knows not to reset. */
  let interrupted = false;
  /** Set alongside it, so the next clip reaches back over what they said. */
  let seedDeeply = false;
  /**
   * The conversation both windows are working in, so what you say out loud is
   * waiting in the panel when you open it rather than filed somewhere separate.
   */
  let activeChatId = null;

  const speaker = createSpeaker({
    onStart: () => {
      stage.classList.add('answering');
      wakeVisually();
    },
    onEnd: () => {
      stage.classList.remove('answering');
      refreshRest();
    },
  });

  function showToast(message, bad, holdMs) {
    // Nothing worth saying is worth saying invisibly.
    wakeVisually();
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

  // ── resting out of the way ──────────────────────────────────────────────

  /**
   * How long the orb stays visible after something happens before fading back.
   * Long enough to read a toast, short enough not to linger.
   */
  const REST_AFTER_MS = 2500;

  let pointerOver = false;
  let restTimer = null;
  /**
   * Declared here rather than down with the drag handlers that own it: this is
   * read by refreshRest(), which is defined above them, and a `let` read before
   * its declaration is evaluated is a ReferenceError rather than `undefined`.
   * Nothing calls refreshRest() that early today, which is exactly the kind of
   * thing that stays true until it doesn't.
   */
  let dragging = false;

  /**
   * The orb fades back when it has nothing to say, and returns the instant it
   * is wanted. It stays fully visible whenever the pointer is near it, whenever
   * it is doing anything other than waiting, and whenever it is being dragged —
   * dragging something you can barely see is horrible.
   */
  function refreshRest() {
    const busy = mode !== 'wake' || speaker.speaking || dragging || panelVisible;
    const awake = pointerOver || busy;

    if (awake) {
      clearTimeout(restTimer);
      restTimer = null;
      stage.classList.remove('resting');
      return;
    }
    // Already counting down, or already faded — leave it be.
    if (restTimer || stage.classList.contains('resting')) return;
    restTimer = setTimeout(() => {
      restTimer = null;
      // Re-check: something may have happened while the timer ran.
      if (!pointerOver && mode === 'wake' && !speaker.speaking && !dragging && !panelVisible) {
        stage.classList.add('resting');
      }
    }, REST_AFTER_MS);
  }

  /** Bring it back now, and start the countdown to fading again. */
  function wakeVisually() {
    clearTimeout(restTimer);
    restTimer = null;
    stage.classList.remove('resting');
    refreshRest();
  }

  stage.addEventListener('mouseenter', () => {
    pointerOver = true;
    refreshRest();
  });

  stage.addEventListener('mouseleave', () => {
    pointerOver = false;
    refreshRest();
  });

  function refreshHotState() {
    const hot = listening();
    stage.classList.toggle('hot', hot);
    if (!voiceInputAvailable()) tooltip.textContent = 'Ask Buddy (listening is off)';
    else if (mode === 'question') tooltip.textContent = 'Go ahead…';
    else tooltip.textContent = hot ? 'Listening for “Hey Buddy”' : 'Ask Buddy';
  }

  // ── click vs. drag ──────────────────────────────────────────────────────

  let pressedAt = 0;
  let pressOrigin = null;

  orb.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pressedAt = Date.now();
    pressOrigin = { x: event.screenX, y: event.screenY };
    dragging = true;
    stage.classList.add('dragging');
    // Dragging something you can barely see is horrible.
    wakeVisually();
    window.buddy.startOrbDrag();
  });

  function endPress(event) {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('dragging');
    refreshRest();
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
    modeSince = next === 'wake' ? 0 : Date.now();
    stage.classList.toggle('asking', next === 'question');
    stage.classList.toggle('thinking', next === 'busy');
    refreshHotState();
    // Anything other than waiting means the orb should be visible; going back
    // to waiting starts the countdown to fading out again.
    refreshRest();
  }

  function backToWaiting() {
    clearTimeout(questionTimer);
    questionTimer = null;
    interrupted = false;
    seedDeeply = false;
    bargeSince = 0;
    setMode('wake');
    if (detector) {
      detector.configure({ hangoverMs: WAKE_HANGOVER_MS, maxClipMs: WAKE_CLIP_MS });
      // reset rather than restart, again: the room is the same room it was
      // before the exchange, and re-measuring would leave Buddy deaf for the
      // two seconds immediately after it finishes speaking.
      detector.reset();
    }
    refreshHotState();
  }

  /**
   * Someone started talking while Buddy was talking. Stop, and listen.
   *
   * Waiting politely for a long answer to finish is the single most irritating
   * thing about talking to a machine, so cutting in has to work the way it does
   * with a person: you start speaking, the other side stops, and what you said
   * while they were trailing off still counts.
   */
  function interruptSpeech() {
    if (!speaker.speaking) return;
    bargeSince = 0;
    interrupted = true;
    seedDeeply = true;
    speaker.stop();
    hideToast();
    openQuestionWindow();
  }

  /**
   * Watch for a voice over the top of Buddy's own.
   *
   * The microphone hears Buddy through the speakers, so this runs against a
   * much higher bar than ordinary speech detection and wants a sustained run
   * rather than a single loud frame. Both are deliberately conservative: being
   * cut off by a cough is worse than having to say "Hey Buddy" twice.
   */
  function considerBargeIn(rms, now = Date.now()) {
    // Only ever cuts short a greeting or an answer. Anything else that manages
    // to be speaking is not something to interrupt into a question window.
    if (mode !== 'busy' || !detector || !detector.calibrated) return;
    if (rms < detector.trigger * BARGE_IN_BOOST) {
      bargeSince = 0;
      return;
    }
    if (!bargeSince) bargeSince = now;
    if (now - bargeSince >= BARGE_IN_SUSTAIN_MS) interruptSpeech();
  }

  /** Buddy has said hello — now listen for what they actually want. */
  function openQuestionWindow() {
    if (!listening()) return backToWaiting();
    setMode('question');
    showToast('Listening…', false, 0);
    if (detector) {
      // Room to finish a sentence, and to pause in the middle of one.
      detector.configure({ hangoverMs: 950, maxClipMs: QUESTION_MAX_MS });
      // reset, not restart: the room was measured when the microphone opened, and
      // re-measuring here would spend the first two seconds of the answer deaf.
      detector.reset();
    }
    waitForQuestion();
  }

  /**
   * Give up if nothing is said — but never in the middle of a sentence.
   *
   * A fixed timer expiring mid-question was worse than useless: it put the orb
   * back into wake mode, so when the sentence finally ended the recording was
   * checked against "hey buddy", failed, and was thrown away. From outside that
   * looks exactly like Buddy listening far too long and then ignoring you.
   */
  function waitForQuestion() {
    clearTimeout(questionTimer);
    questionTimer = setTimeout(() => {
      if (mode !== 'question') return;
      // Still talking — keep listening rather than discarding what they said.
      if (detector && detector.speaking) return waitForQuestion();
      hideToast();
      backToWaiting();
    }, QUESTION_WINDOW_MS);
  }

  /**
   * Carry out whatever the reply asked for, and say so if it did not work.
   *
   * The orb has nowhere to print a note, so a failure is spoken through the
   * toast instead. A success needs no announcement — the page opening is the
   * announcement, and Buddy is already saying it out loud.
   */
  async function performAction(payload) {
    if (payload.actionRefused) {
      showToast(payload.actionRefused.slice(0, 60), true, 4000);
      return;
    }
    if (!payload.action) return;

    try {
      const result = await window.buddy.runAction(payload.action);
      if (!result || !result.ok) {
        showToast(`Couldn't: ${(result && result.error) || 'unknown'}`.slice(0, 60), true, 4000);
      }
    } catch (error) {
      showToast(`Couldn't: ${error.message}`.slice(0, 60), true, 4000);
    }
  }

  /**
   * Answer out loud, at the orb. The panel is deliberately left shut: being able
   * to ask a question without a window appearing over your work is the point.
   */
  async function answer(question) {
    clearTimeout(questionTimer);
    questionTimer = null;
    interrupted = false;
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
      /**
       * Do the thing before saying it is being done.
       *
       * This was missing entirely: the server parsed the action and handed it
       * back, the panel performed it, and the orb — the half you actually talk
       * to — dropped it on the floor. So asking by voice got "Opening YouTube
       * now" and then nothing at all, which is the worst of both worlds, since
       * Buddy sounded like it had succeeded.
       *
       * It runs before the sentence is spoken so the page is already on its way
       * up while Buddy is still saying so.
       */
      performAction(payload);
      await speaker.speak(reply);
    } catch (error) {
      showToast(error.message.slice(0, 60), true, 4000);
    } finally {
      // Being talked over already moved the orb into listening for what was
      // said. Resetting here would throw that away and go deaf mid-sentence.
      if (!interrupted) backToWaiting();
    }
  }

  async function considerClip(samples) {
    if (!samples.length) return;
    if (!wakeEnabled || panelVisible) return;

    // ── already awake: this clip is the question ──
    if (mode === 'question') {
      const seconds = samples.length / (microphone ? microphone.sampleRate : 16000);
      let question = '';
      try {
        question = await transcribe(samples);
      } catch (error) {
        console.warn('[buddy] could not transcribe the question:', error.message);
        window.buddy.reportHeard({ seconds, text: '', matched: false, note: `question: ${error.message}` });
        hideToast();
        return backToWaiting();
      }
      // Recorded like a wake attempt, so a question that was heard but not
      // understood shows up somewhere rather than vanishing. Tagged as a question
      // rather than a match — marking these "woke" made every line in the list
      // green and hid which one had actually been the wake phrase.
      window.buddy.reportHeard({ seconds, text: question, matched: false, kind: 'question' });
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

    const seconds = samples.length / (microphone ? microphone.sampleRate : 16000);

    let heard = '';
    try {
      heard = await transcribe(samples);
    } catch (error) {
      // A failing wake check is not worth shouting about on every clip.
      console.warn('[buddy] wake check failed:', error.message);
      window.buddy.reportHeard({ seconds, text: '', matched: false, note: error.message });
      return;
    }

    const matched = Boolean(heard) && isWakePhrase(heard);
    // Recorded whether it matched or not: a clip that came back as the wrong
    // words is the single most useful thing to see when the wake word "does
    // nothing", and it is invisible from outside the orb.
    window.buddy.reportHeard({ seconds, text: heard, matched });

    if (!matched) return;

    cooldownUntil = Date.now() + WAKE_COOLDOWN_MS;
    // Heard its name: come back into view before anything else happens.
    wakeVisually();
    flash('fired', 900);

    // Start loading whatever is cold now, while the user is drawing breath to
    // ask, so the answer does not have to wait for it. Costs nothing when
    // everything is already warm.
    api('/warm', {}).catch(() => {});

    const tail = tailAfterWake(heard);
    if (tail) {
      // They asked in the same breath — skip the pleasantries.
      return answer(tail);
    }

    /**
     * Straight to listening — no spoken "Yeah? What would you like?".
     *
     * Saying hello took the best part of two seconds during which Buddy was
     * deliberately deaf, so anyone who said "Hey Buddy, what's the weather" at
     * a natural pace had the middle of it swallowed and had to start again.
     * The point of a wake word is to be quicker than clicking, and a greeting
     * you have to sit through is slower. The flash and the "Listening…" label
     * say it heard you; they just do it without taking a turn to do it.
     */
    openQuestionWindow();
  }

  /**
   * Drive the orb's size from whichever voice is currently the interesting one.
   *
   * Answering, that is Buddy's own output, so the orb visibly moves with what
   * it is saying instead of running a fixed animation next to it. Waiting for a
   * question, it is yours. Idle, nothing — reacting to every noise in the room
   * while doing nothing is what made the orb feel permanently busy.
   */
  function paintLevel() {
    levelFrame = requestAnimationFrame(paintLevel);

    let value = 0;
    if (speaker.speaking) value = speaker.level;
    else if (mode === 'question' && listening() && microphone && detector) {
      value = detector.level(microphone.rms);
    }

    stage.style.setProperty('--level', value.toFixed(3));
  }

  async function startListening() {
    if (microphone || starting) return;
    starting = true;

    try {
      microphone = await openMicrophone({
        onFrame: (_frame, rms) => {
          if (!detector || panelVisible) return;
          // While Buddy is talking the microphone is mostly hearing Buddy, so
          // the ordinary detector would trip on its own voice. Watch for
          // someone talking over it instead.
          if (speaker.speaking) return considerBargeIn(rms);
          bargeSince = 0;
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
        // Seeded from the ring buffer, so the leading "Hey" is not lost. After
        // an interruption it reaches back further still: the first few words
        // were spoken over Buddy, before this detector was even being fed.
        microphone.beginClip(seedDeeply ? BARGE_IN_PRE_ROLL_S : 0.4);
        seedDeeply = false;
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
  }

  async function stopListening() {
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

  /**
   * Last resort: nothing may leave the orb permanently mid-exchange.
   *
   * Every path out of 'question' and 'busy' is supposed to end in
   * backToWaiting(), but a request that never returns — or a case nobody
   * thought of — would otherwise leave the wake word silently dead until the
   * app was restarted. Whatever went wrong, this notices and puts it back.
   */
  setInterval(() => {
    if (mode === 'wake' || !modeSince) return;
    if (Date.now() - modeSince < STUCK_MODE_MS) return;
    console.warn(`[buddy] orb was stuck in "${mode}" — going back to listening`);
    hideToast();
    speaker.stop();
    if (microphone) microphone.cancelClip();
    backToWaiting();
  }, 5000);

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
      /**
       * And it must not still be half-way through a spoken exchange when the
       * panel closes again. Opening the panel mid-question used to leave the
       * orb in 'question' mode with a timer that kept re-arming itself, so
       * when you came back it was no longer listening for its name at all —
       * it was waiting for the rest of a sentence you had long since
       * abandoned. From outside, "Hey Buddy" had simply stopped working.
       */
      backToWaiting();
    } else {
      // Deliberately no re-calibration on the way back. Measuring the room
      // again costs nearly two seconds of being completely deaf, and closing
      // the panel is exactly the moment someone is most likely to say "Hey
      // Buddy". The floor drifts on its own during quiet stretches anyway.
      // A plain reset is enough to clear anything stale.
      if (detector) detector.reset();
      hideToast();
    }

    refreshHotState();
    refreshRest();
  });

  /**
   * Something changed in settings. Re-read what the server says before acting
   * on it: this used to decide from the orb's own cached copy, which the orb
   * only ever refreshed while it was waiting to start — so a stale snapshot
   * saying "hearing not ready" could close a microphone that was working
   * perfectly well, and nothing would reopen it.
   */
  window.buddy.onRuntimeChanged(async () => {
    await refreshRuntime();
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

  // Runs for the life of the window, not just while the microphone is open:
  // the orb has to keep moving with Buddy's own voice, and that happens whether
  // or not anything is listening.
  paintLevel();
  // Visible on arrival, then it settles back on its own.
  refreshRest();

  panelVisible = boot.panelVisible;
  // main.js owns the persisted setting; localStorage mirrors it per the spec.
  const stored = localStorage.getItem('buddy:wake');
  applyWakePreference(boot.wakeEnabled !== undefined ? boot.wakeEnabled : stored !== 'off');
}
