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

      const done = () => {
        URL.revokeObjectURL(url);
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

        // Start the first chunk, then always keep one in flight ahead of playback.
        let pending = synthesize(chunks[0]);

        for (let index = 0; index < chunks.length; index++) {
          let current;
          try {
            current = await pending;
          } catch (error) {
            if (mine === generation && index === 0) throw error;
            // A later chunk failing should not kill what is already playing.
            console.warn('[buddy] a chunk of speech failed:', error.message);
            break;
          }
          if (mine !== generation) {
            if (current && current.url) URL.revokeObjectURL(current.url);
            return discard(pending);
          }

          pending =
            index + 1 < chunks.length
              ? synthesize(chunks[index + 1]).catch((error) => {
                  console.warn('[buddy] could not prepare the next chunk:', error.message);
                  return null;
                })
              : Promise.resolve(null);

          if (current.system) {
            await speakWithSystemVoice(current.system.text, current.system.voice, mine);
          } else if (current.url) {
            await play(current.url, mine);
          }
          // Stopped mid-reply: the chunk already being made still has to be freed.
          if (mine !== generation) return discard(pending);
        }
      } catch (error) {
        if (onError) onError(error);
        else console.warn('[buddy] voice reply failed:', error.message);
      } finally {
        if (mine === generation) finish();
      }
    },

    /**
     * Play a wav the server already has cached, in one go. Used for the wake-word
     * greeting, where a chunking round trip would add latency to a fixed line.
     */
    async say(text) {
      this.stop();
      const mine = generation;
      try {
        const result = await synthesize(text);
        if (mine !== generation) {
          if (result.url) URL.revokeObjectURL(result.url);
          return;
        }
        speaking = true;
        if (onStart) onStart();
        if (result.system) await speakWithSystemVoice(result.system.text, result.system.voice, mine);
        else if (result.url) await play(result.url, mine);
      } catch (error) {
        if (onError) onError(error);
        else console.warn('[buddy] could not speak:', error.message);
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
