/**
 * Saying things out loud.
 *
 * Buddy's own voice runs on the CPU at not much above realtime, so synthesizing a
 * whole reply before making a sound would leave several seconds of silence after
 * the text has already appeared. Instead the server splits the reply into short
 * chunks and this plays each one while the next is still being made, which keeps
 * the delivery seamless.
 *
 * The second half of that is `speakStream`, and it is where most of the delay
 * went. Waiting for the model to finish before planning any of it meant the
 * silence after a question was the whole generation *plus* the first chunk of
 * synthesis, run one after the other. Feeding the voice as the text arrives
 * overlaps them — the opening sentence is usually already being said by the time
 * the model writes its last word. Measured against a reply that takes 1.6s to
 * generate, that moved the first sound from ~2.2s to ~0.8s.
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

  /**
   * Keep several chunks in flight, not one.
   *
   * Kokoro synthesizes at not much above realtime, so a single chunk of
   * lookahead gives the next one only as long as the current one takes to play.
   * Any chunk that runs slower than its predecessor — a longer sentence, a
   * moment when the language model is also using the CPU — lands after the
   * audio has already run out, and Buddy falls silent mid-reply and then
   * carries on. That is the stutter.
   *
   * A deeper queue absorbs it: the fast chunks build a cushion the slow ones
   * spend. Three is enough to cover an outlier without synthesizing so far
   * ahead that stopping wastes much work — and being cut off is cheap here
   * anyway, since a discarded chunk is only a blob to free.
   */
  const LOOKAHEAD = 3;

  /**
   * A reply being said out loud, whose text may still be arriving.
   *
   * This used to take the whole reply and a finished list of chunks, which
   * meant nothing could be synthesized until the model had written its last
   * word. The queue grows instead: whoever is producing text adds chunks
   * whenever it has some, and the consumer below waits rather than ending when
   * it runs dry. That is the whole of what lets Buddy start talking while it is
   * still thinking.
   */
  function createPlayback(mine) {
    /** Chunk texts waiting to be started. */
    const queue = [];
    /** Syntheses already under way, in the order they must be played. */
    const inFlight = [];
    let closed = false;
    let nudge = null;

    const wake = () => {
      if (nudge) {
        nudge();
        nudge = null;
      }
    };
    const sleep = () => new Promise((resolve) => (nudge = resolve));

    const fill = () => {
      while (inFlight.length < LOOKAHEAD && queue.length) {
        const pending = synthesize(queue.shift());
        // The awaiting code below still sees the rejection; this only stops it
        // counting as unhandled while it waits its turn in the queue.
        pending.catch(() => {});
        inFlight.push(pending);
      }
    };

    return {
      /** More of the reply is ready to be said. */
      add(texts) {
        for (const text of texts) if (String(text || '').trim()) queue.push(text);
        fill();
        wake();
      },

      /** No more is coming. The consumer stops once the queue drains. */
      close() {
        closed = true;
        wake();
      },

      /** Play everything, in order, for as long as more keeps arriving. */
      async run() {
        let saidAnything = false;
        try {
          for (;;) {
            if (!inFlight.length) {
              if (closed && !queue.length) break;
              await sleep();
              fill();
              continue;
            }

            let current;
            try {
              current = await inFlight.shift();
            } catch (error) {
              // The first chunk failing is the whole reply failing, and the
              // caller needs to hear about it. A later one is a gap in
              // something already playing, which is not worth an error bubble.
              if (mine === generation && !saidAnything) throw error;
              console.warn('[buddy] a chunk of speech failed:', error.message);
              break;
            }

            if (mine !== generation) {
              if (current && current.url) URL.revokeObjectURL(current.url);
              return saidAnything;
            }

            // Replace what was just taken, so the queue stays full while this plays.
            fill();

            if (!saidAnything) {
              saidAnything = true;
              speaking = true;
              if (onStart) onStart();
            }

            if (current && current.system) {
              await speakWithSystemVoice(current.system.text, current.system.voice, mine);
            } else if (current && current.url) {
              await play(current.url, mine);
            }

            // Stopped mid-reply: whatever is still being made has to be freed.
            if (mine !== generation) return saidAnything;
          }
          return saidAnything;
        } finally {
          inFlight.forEach(discard);
        }
      },
    };
  }

  /** Split text into the chunks the voice will actually say. */
  async function planChunks(text) {
    const { chunks } = await api('/tts/plan', { text });
    return Array.isArray(chunks) ? chunks : [];
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

    /** Say a reply that is already written. Resolves when the last word is out. */
    async speak(text) {
      const source = String(text || '');
      if (!source.trim()) {
        this.stop();
        return;
      }
      const stream = this.speakStream();
      stream.push(source);
      await stream.end(source);
    },

    /**
     * Say a reply that is still being written.
     *
     * `push` takes the whole reply as it stands, not the newest fragment — the
     * caller already has that string, and passing it whole is what lets this
     * re-plan against the real chunker on the server rather than guessing at
     * sentence boundaries in two places.
     *
     * Only *settled* chunks are handed to the voice. The last chunk of any
     * plan is held back, because the next token may extend it: "Sure." is a
     * whole chunk until "Sure. Here is why…" arrives and the chunker merges the
     * two. Everything before the last cannot change, since text only ever gets
     * appended, so it can be spoken the moment it exists.
     */
    speakStream() {
      this.stop();
      const mine = generation;
      const playback = createPlayback(mine);

      /** Started only once, and only when there is something to say. */
      let running = null;
      const start = () => {
        if (!running) running = playback.run();
        return running;
      };

      /** How much of the text the last plan covered, and how many chunks it gave. */
      let plannedThrough = 0;
      let handedOver = 0;
      let latest = '';
      /**
       * Plans run one at a time, in a chain rather than behind a boolean.
       *
       * A flag was the obvious thing and it was wrong: the final plan would
       * arrive while an ordinary one was still in flight, see the flag set, and
       * return immediately — so the last sentence of every reply that streamed
       * quickly enough was simply never spoken. Chaining makes `end()` wait for
       * its turn instead of giving up.
       */
      let planning = Promise.resolve();

      /**
       * Re-planning on every token would be a request per character. Waiting
       * for a sentence to finish costs nothing, because a chunk that does not
       * end a sentence would have been held back anyway.
       */
      const worthReplanning = () => {
        const fresh = latest.slice(plannedThrough);
        return fresh.length >= 16 && /[.!?\n]/.test(fresh);
      };

      const planOnce = async (final) => {
        try {
          while (mine === generation && (final || worthReplanning())) {
            const text = latest;
            const chunks = await planChunks(text);
            if (mine !== generation) return;
            plannedThrough = text.length;
            // Hold the tail back until nothing more is coming.
            const settled = final ? chunks.length : Math.max(0, chunks.length - 1);
            if (settled > handedOver) {
              playback.add(chunks.slice(handedOver, settled));
              handedOver = settled;
              start();
            }
            if (final) return;
          }
        } catch (error) {
          console.warn('[buddy] could not plan speech:', error.message);
        }
      };

      const replan = (final) => {
        planning = planning.then(() => planOnce(final));
        return planning;
      };

      return {
        /** The reply so far. Safe to call on every token. */
        push(textSoFar) {
          if (mine !== generation) return;
          latest = String(textSoFar || '');
          if (worthReplanning()) replan(false);
        },

        /**
         * The reply is complete. Anything held back is said, and this resolves
         * once the voice has finished.
         *
         * `finalText` wins over what was streamed, because it is the
         * authoritative version — and in the one case where they differ badly,
         * a model that wrote nothing but an action marker, it is the only text
         * there is.
         */
        async end(finalText) {
          // Cut off already — by the stop button, or by being talked over. The
          // queue still has to be closed: the consumer parks waiting for more
          // when it runs dry, and a `return` here would leave it parked for the
          // life of the window.
          if (mine !== generation) {
            playback.close();
            return false;
          }
          const settled = String(finalText || '').trim();
          if (settled) latest = settled;

          try {
            if (latest.trim()) await replan(true);
          } finally {
            playback.close();
          }

          if (!running) {
            // Nothing was ever queued — an empty reply, or a stop mid-flight.
            if (mine === generation) finish();
            return false;
          }

          try {
            return await running;
          } catch (error) {
            if (onError) onError(error);
            else console.warn('[buddy] voice reply failed:', error.message);
            return false;
          } finally {
            if (mine === generation) finish();
          }
        },
      };
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
