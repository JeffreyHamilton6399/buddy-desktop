/**
 * Microphone capture and voice detection, shared by the orb (which listens for
 * "Hey Buddy") and the panel (which records what you dictate).
 *
 * The audio context is opened at 16 kHz so samples arrive at exactly the rate
 * Whisper wants and nothing has to be resampled. Everything is kept as raw floats
 * in this process until a clip is finished, at which point it goes to the server
 * as base64 — no container, no codec.
 *
 * A ring buffer holds the most recent second and a half at all times. This is the
 * fix for a subtle problem: voice detection can only tell that speech started
 * *after* hearing enough of it, so a recording begun at that moment has already
 * missed the first syllable — which for a two-word wake phrase is most of the
 * word "Hey". Clips therefore start from the buffer, not from now.
 */
'use strict';

export const SAMPLE_RATE = 16000;
const WORKLET_URL = 'capture-worklet.js';
const PRE_ROLL_SECONDS = 1.5;

/** Turn float samples into the base64 the /asr endpoint expects. */
export function samplesToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  // Chunked so a long clip cannot blow the argument limit on String.fromCharCode.
  const STEP = 0x8000;
  for (let at = 0; at < bytes.length; at += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + STEP));
  }
  return btoa(binary);
}

function rmsOf(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/**
 * An open microphone.
 *
 * @param {{ onFrame?: (frame: Float32Array, rms: number) => void }} options
 */
export async function openMicrophone({ onFrame } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Buddy is often listening while it is also speaking through the same
      // speakers, so the browser's own cancellation is worth having.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  /**
   * Asking for a 16 kHz context is the convenient thing — it is Whisper's rate,
   * so nothing has to be resampled — but some Windows audio drivers refuse a
   * rate their device does not run at and throw. That threw away the whole
   * microphone, and with it the wake word, for a reason nobody could see. So
   * try it, and fall back to whatever rate the device does want.
   */
  let context = null;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    context = null;
  }
  if (!context) context = new AudioContext();
  if (context.state === 'suspended') await context.resume();

  const rate = context.sampleRate;

  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => {});
    throw new Error(`Could not start the microphone processor: ${error.message}`);
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'buddy-capture');
  source.connect(node);
  // A worklet with no destination is not guaranteed to be pulled, so terminate
  // the graph in a gain node muted to silence rather than in the speakers.
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(context.destination);

  const ringLength = Math.ceil(rate * PRE_ROLL_SECONDS);
  const ring = new Float32Array(ringLength);
  let ringAt = 0;
  let ringFilled = 0;

  /** @type {Float32Array[]|null} */
  let capturing = null;
  let closed = false;
  let latestRms = 0;

  node.port.onmessage = (event) => {
    const frame = event.data;
    if (closed || !(frame instanceof Float32Array)) return;

    // Into the ring buffer, wrapping.
    let offset = 0;
    while (offset < frame.length) {
      const take = Math.min(ringLength - ringAt, frame.length - offset);
      ring.set(frame.subarray(offset, offset + take), ringAt);
      ringAt = (ringAt + take) % ringLength;
      offset += take;
    }
    ringFilled = Math.min(ringLength, ringFilled + frame.length);

    if (capturing) capturing.push(frame);

    latestRms = rmsOf(frame);
    if (onFrame) onFrame(frame, latestRms);
  };

  /** The last `seconds` of audio, oldest first. */
  function preRoll(seconds) {
    const want = Math.min(ringFilled, Math.ceil(rate * seconds));
    const out = new Float32Array(want);
    // Walk back from the write head, wrapping.
    const start = (ringAt - want + ringLength) % ringLength;
    const firstRun = Math.min(want, ringLength - start);
    out.set(ring.subarray(start, start + firstRun), 0);
    if (want > firstRun) out.set(ring.subarray(0, want - firstRun), firstRun);
    return out;
  }

  return {
    /** The rate actually in use, which /asr resamples from when it is not 16 kHz. */
    sampleRate: rate,
    get rms() {
      return latestRms;
    },
    get capturing() {
      return capturing !== null;
    },

    /** Start a clip, seeded with whatever was said just before this was called. */
    beginClip(preRollSeconds = 0.35) {
      const seed = preRollSeconds > 0 ? preRoll(preRollSeconds) : new Float32Array(0);
      capturing = seed.length ? [seed] : [];
    },

    /** Finish the clip and hand back every sample in it. */
    endClip() {
      if (!capturing) return new Float32Array(0);
      const frames = capturing;
      capturing = null;

      let total = 0;
      for (const frame of frames) total += frame.length;
      const clip = new Float32Array(total);
      let at = 0;
      for (const frame of frames) {
        clip.set(frame, at);
        at += frame.length;
      }
      return clip;
    },

    /** Throw away the clip in progress. */
    cancelClip() {
      capturing = null;
    },

    async close() {
      if (closed) return;
      closed = true;
      capturing = null;
      node.port.onmessage = null;
      try {
        node.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => {});
    },
  };
}

/**
 * Energy-based voice detection over the frames from openMicrophone.
 *
 * The room is measured before any threshold is trusted, because a fan or an open
 * window sets a floor that a fixed number would either sit under (recording all
 * day) or over (never hearing anything). The floor then drifts toward sustained
 * quiet so the room is allowed to change.
 */
export function createVoiceDetector({
  onSpeechStart,
  onSpeechEnd,
  calibrationMs = 1500,
  sustainMs = 180,
  hangoverMs: initialHangoverMs = 650,
  maxClipMs: initialMaxClipMs = 5000,
} = {}) {
  let hangoverMs = initialHangoverMs;
  let maxClipMs = initialMaxClipMs;

  const FLOOR_FACTOR = 2.2;
  const FLOOR_MARGIN = 0.012;
  const MIN_THRESHOLD = 0.02;
  /**
   * A microphone is not immediately truthful. Bluetooth headsets in particular
   * deliver near-silence for a moment while the link and the gain control settle,
   * and calibrating across that measures a room far quieter than it is — which
   * sets the trigger so low that ordinary noise counts as speech forever after.
   * Throw the settling period away before measuring anything.
   */
  const SETTLE_MS = 400;
  /**
   * The 75th percentile rather than the median: the floor should sit above most
   * of the room's noise, not in the middle of it.
   */
  const FLOOR_PERCENTILE = 0.75;

  let settleEndsAt = 0;
  let calibrationEndsAt = 0;
  let floorSamples = [];
  let noiseFloor = 0.01;
  let loudSince = 0;
  let quietSince = 0;
  let speaking = false;
  let startedAt = 0;
  let calibrated = false;
  let lastPushAt = 0;

  /**
   * A gap this long means frames stopped arriving — the panel opened, or the
   * detector was parked while Buddy spoke. Whatever it believed about someone
   * mid-sentence is stale by the time they resume, so treat the next frame as
   * a fresh start rather than the continuation of a very long utterance.
   */
  const CONTINUITY_GAP_MS = 700;

  function threshold() {
    return Math.max(noiseFloor * FLOOR_FACTOR, noiseFloor + FLOOR_MARGIN, MIN_THRESHOLD);
  }

  return {
    get calibrated() {
      return calibrated;
    },
    get speaking() {
      return speaking;
    },

    /**
     * Retune mid-flight. A two-word wake phrase and a spoken question want
     * different limits: the phrase is over in a second, while a question needs
     * room to run and tolerance for someone pausing to think.
     */
    configure(options = {}) {
      if (Number.isFinite(options.hangoverMs)) hangoverMs = options.hangoverMs;
      if (Number.isFinite(options.maxClipMs)) maxClipMs = options.maxClipMs;
    },

    get noiseFloor() {
      return noiseFloor;
    },
    /**
     * How loud a frame has to be to count as speech, in the same units as rms.
     * Exposed so the orb can listen for someone talking over Buddy against a
     * deliberately higher bar than this one, without measuring the room twice.
     */
    get trigger() {
      return threshold();
    },
    /** How loud the room is right now, as a 0..1 fraction of the trigger point. */
    level(rms) {
      return Math.min(1, rms / Math.max(threshold(), 0.0001));
    },

    restart() {
      settleEndsAt = Date.now() + SETTLE_MS;
      calibrationEndsAt = settleEndsAt + calibrationMs;
      floorSamples = [];
      loudSince = 0;
      quietSince = 0;
      speaking = false;
      calibrated = false;
      lastPushAt = 0;
    },

    /**
     * Forget what is being said without forgetting the room.
     *
     * restart() re-measures, which costs the best part of two seconds of being
     * completely deaf. That is right when the microphone has just opened and
     * wrong the rest of the time — notably when Buddy has finished saying hello
     * and is about to listen for the actual question, which is the exact moment
     * someone starts talking.
     */
    reset() {
      loudSince = 0;
      quietSince = 0;
      speaking = false;
    },

    /** Feed one frame. Returns true while it believes someone is talking. */
    push(rms, now = Date.now()) {
      if (!calibrationEndsAt) {
        settleEndsAt = now + SETTLE_MS;
        calibrationEndsAt = settleEndsAt + calibrationMs;
      }

      /**
       * Frames stopped for a while and have now resumed. Without this, the
       * stale `speaking` flag survives the gap and the very next frame trips
       * the maximum-clip-length branch below — which does not just end a clip
       * that was never recording, it raises the noise floor to whatever the
       * room happens to be doing and starts a two-second recalibration. That
       * is the "Hey Buddy stopped working after I opened settings" bug: come
       * back from the panel and the wake word is deaf, then over-threshold.
       */
      if (lastPushAt && now - lastPushAt > CONTINUITY_GAP_MS) {
        loudSince = 0;
        quietSince = 0;
        speaking = false;
      }
      lastPushAt = now;

      // Let the stream settle before believing anything it says.
      if (now < settleEndsAt) return false;

      if (now < calibrationEndsAt) {
        floorSamples.push(rms);
        return false;
      }
      if (floorSamples.length) {
        floorSamples.sort((a, b) => a - b);
        noiseFloor = floorSamples[Math.floor(floorSamples.length * FLOOR_PERCENTILE)] || 0.01;
        floorSamples = [];
        calibrated = true;
      }

      const limit = threshold();

      if (rms >= limit) {
        quietSince = 0;
        if (!loudSince) loudSince = now;
        if (!speaking && now - loudSince >= sustainMs) {
          speaking = true;
          startedAt = now;
          if (onSpeechStart) onSpeechStart();
        }
      } else {
        loudSince = 0;
        // Drift the floor toward sustained quiet so the room can change.
        noiseFloor = noiseFloor * 0.995 + rms * 0.005;
        if (speaking) {
          if (!quietSince) quietSince = now;
          if (now - quietSince >= hangoverMs) {
            speaking = false;
            if (onSpeechEnd) onSpeechEnd('silence');
          }
        }
      }

      if (speaking && now - startedAt >= maxClipMs) {
        speaking = false;
        /**
         * Nobody speaks for the entire maximum length. A clip that runs to the
         * limit means the trigger is sitting below the room rather than above it
         * — the state the wake word gets stuck in, listening to noise all day and
         * never hearing its name inside it. Take the current level as evidence of
         * where the floor really is and measure again.
         */
        noiseFloor = Math.max(noiseFloor, rms);
        settleEndsAt = now;
        calibrationEndsAt = now + calibrationMs;
        floorSamples = [];
        calibrated = false;
        loudSince = 0;
        quietSince = 0;
        if (onSpeechEnd) onSpeechEnd('too-long');
      }
      return speaking;
    },
  };
}
