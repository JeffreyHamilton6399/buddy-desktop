/**
 * Saying things out loud.
 *
 * Buddy's own voice runs on the CPU at not much above realtime, so synthesizing a
 * whole reply before making a sound would leave several seconds of silence after
 * the text has already appeared. Instead the server splits the reply into short
 * chunks and this plays each one while the next is still being made, which gets
 * the first word out in about a second and keeps the rest seamless.
 *
 * The OS voices are a different shape — the server hands back text instead of
 * audio and speechSynthesis says it here — so both paths live behind one speak().
 */
'use strict';

import { api, runtime } from './core.js';

/**
 * A tap on whatever is being played, so the orb can move with the voice rather
 * than to a fixed animation. One context and one analyser for the whole
 * renderer: each chunk is a fresh <audio> element, but they all feed this.
 *
 * Everything here is best effort. If the browser refuses the graph — a
 * suspended context, an element it will not let us tap — playback falls back to
 * the plain element and the orb simply keeps its idle animation.
 */
let audioContext = null;
let analyser = null;
let scratch = null;

function tapInto(element) {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      // Enough smoothing that the orb swells with speech instead of buzzing.
      analyser.smoothingTimeConstant = 0.7;
      scratch = new Uint8Array(analyser.fftSize);
      analyser.connect(audioContext.destination);
    }
    // Routing through WebAudio means a suspended context is silence, not just
    // a missing meter — so this has to succeed before the element is played.
    if (audioContext.state === 'suspended') audioContext.resume();
    const source = audioContext.createMediaElementSource(element);
    source.connect(analyser);
    return () => source.disconnect();
  } catch {
    return null;
  }
}

/** How loud the voice is this instant, 0..1. */
function outputLevel() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i++) {
    const deviation = (scratch[i] - 128) / 128;
    sum += deviation * deviation;
  }
  // Speech sits well below full scale, so the raw figure is scaled up to use
  // the whole range rather than nudging the orb by a couple of pixels.
  return Math.min(1, Math.sqrt(sum / scratch.length) * 3.4);
}

/**
 * @param {{ onStart?: () => void, onEnd?: () => void, onError?: (error: Error) => void }} hooks
 */
export function createSpeaker({ onStart, onEnd, onError } = {}) {
  /** Bumped on every stop() so a chunk that arrives late knows it is stale. */
  let generation = 0;
  let audio = null;
  let speaking = false;

  function finish() {
    if (!speaking) return;
    speaking = false;
    if (onEnd) onEnd();
  }

  /** Fetch one chunk's audio as a blob URL, or null when the OS voice is in use. */
  async function synthesize(text) {
    const response = await api('/tts', { text }, { raw: true });

    if (!response.ok) {
      let message = `The voice service returned ${response.status}`;
      try {
        const payload = await response.json();
        if (payload && payload.error) message = payload.error;
      } catch {
        /* keep the generic message */
      }
      throw new Error(message);
    }

    if ((response.headers.get('content-type') || '').includes('application/json')) {
      const payload = await response.json();
      if (payload && payload.mode === 'system') return { system: payload };
      throw new Error((payload && payload.error) || 'The voice service returned no audio');
    }

    return { url: URL.createObjectURL(await response.blob()) };
  }

  /** Throw away a chunk that was being prepared when speaking was cut short. */
  function discard(pending) {
    Promise.resolve(pending)
      .then((chunk) => {
        if (chunk && chunk.url) URL.revokeObjectURL(chunk.url);
      })
      .catch(() => {});
  }

  function play(url, mine) {
    return new Promise((resolve) => {
      if (mine !== generation) {
        URL.revokeObjectURL(url);
        return resolve();
      }
      const element = new Audio(url);
      audio = element;
      const untap = tapInto(element);

      const done = () => {
        URL.revokeObjectURL(url);
        if (untap) untap();
        if (audio === element) audio = null;
        resolve();
      };
      element.addEventListener('ended', done, { once: true });
      element.addEventListener('error', done, { once: true });
      element.play().catch(done);
    });
  }

  /** The OS voices, spoken in this process. Nothing leaves the machine either. */
  function speakWithSystemVoice(text, voiceName, mine) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const chosen = voices.find((voice) => voice.name === voiceName);
      if (chosen) utterance.voice = chosen;
      utterance.rate = Number(runtime.ttsSpeed) || 1;

      const done = () => resolve();
      utterance.addEventListener('end', done, { once: true });
      utterance.addEventListener('error', done, { once: true });
      if (mine !== generation) return resolve();
      speechSynthesis.speak(utterance);
    });
  }

  return {
    get speaking() {
      return speaking;
    },

    /**
     * How loud Buddy is talking right now, 0..1, for anything that wants to
     * move with the voice. Zero when silent, and zero on the OS voices, which
     * speechSynthesis gives no way to measure.
     */
    get level() {
      return speaking ? outputLevel() : 0;
    },

    /** Say a reply. Resolves once the last chunk has finished playing. */
    async speak(text) {
      this.stop();
      const mine = generation;
      const source = String(text || '');
      if (!source.trim()) return;

      try {
        const { chunks } = await api('/tts/plan', { text: source });
        if (!chunks || !chunks.length || mine !== generation) return;

        speaking = true;
        if (onStart) onStart();

        /**
         * Keep several chunks in flight, not one.
         *
         * Kokoro synthesizes at not much above realtime, so a single chunk of
         * lookahead gives the next one only as long as the current one takes to
         * play. Any chunk that runs slower than its predecessor — a longer
         * sentence, a moment when the language model is also using the CPU —
         * lands after the audio has already run out, and Buddy falls silent
         * mid-reply and then carries on. That is the stutter.
         *
         * A deeper queue absorbs it: the fast chunks build a cushion the slow
         * ones spend. Three is enough to cover an outlier without synthesizing
         * so far ahead that stopping wastes much work — and being cut off is
         * cheap here anyway, since a discarded chunk is only a blob to free.
         */
        const LOOKAHEAD = 3;
        const inFlight = [];
        let nextToMake = 0;

        const fill = () => {
          while (inFlight.length < LOOKAHEAD && nextToMake < chunks.length) {
            const pending = synthesize(chunks[nextToMake++]);
            // The awaiting code below still sees the rejection; this only stops
            // it counting as unhandled while it waits its turn in the queue.
            pending.catch(() => {});
            inFlight.push(pending);
          }
        };
        fill();

        for (let index = 0; index < chunks.length; index++) {
          let current;
          try {
            current = await inFlight.shift();
          } catch (error) {
            if (mine === generation && index === 0) throw error;
            // A later chunk failing should not kill what is already playing.
            console.warn('[buddy] a chunk of speech failed:', error.message);
            break;
          }
          if (mine !== generation) {
            if (current && current.url) URL.revokeObjectURL(current.url);
            return inFlight.forEach(discard);
          }

          // Replace what was just taken, so the queue stays full while this plays.
          fill();

          if (current && current.system) {
            await speakWithSystemVoice(current.system.text, current.system.voice, mine);
          } else if (current && current.url) {
            await play(current.url, mine);
          }
          // Stopped mid-reply: whatever is still being made has to be freed.
          if (mine !== generation) return inFlight.forEach(discard);
        }

        // Nothing should be left, but a chunk made past a break must not leak.
        inFlight.forEach(discard);
      } catch (error) {
        if (onError) onError(error);
        else console.warn('[buddy] voice reply failed:', error.message);
      } finally {
        if (mine === generation) finish();
      }
    },

    stop() {
      generation += 1;
      if (audio) {
        audio.pause();
        if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
        audio = null;
      }
      if (window.speechSynthesis) speechSynthesis.cancel();
      finish();
    },
  };
}

/**
 * Preview a voice without changing anything. Goes straight to /tts with an
 * explicit voice so the picker can be auditioned before it is saved.
 */
export async function previewVoice(voiceId, text = "Hey, I'm Buddy. This is how I sound.") {
  const response = await api('/tts', { text, voice: voiceId }, { raw: true });
  if (!response.ok) {
    let message = `Preview failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* keep the generic message */
    }
    throw new Error(message);
  }

  // The OS voices answer with text rather than audio; say it here instead.
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    const payload = await response.json();
    if (payload && payload.mode === 'system' && window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(payload.text);
      const chosen = speechSynthesis.getVoices().find((voice) => voice.name === voiceId);
      if (chosen) utterance.voice = chosen;
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    }
    return null;
  }

  const url = URL.createObjectURL(await response.blob());
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
  await audio.play();
  return audio;
}
