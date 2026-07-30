/**
 * Buddy's microphone tap.
 *
 * An AudioWorklet rather than a MediaRecorder because Whisper wants raw 16 kHz
 * float samples: recording to webm/opus only to decode it again server-side would
 * mean shipping an Opus decoder into the server process for no gain.
 *
 * `process` is called every 128 samples — 8 ms at 16 kHz — which is far too often
 * to post a message for, so blocks are gathered into ~32 ms batches first. That
 * is still fine for voice detection and cuts the message traffic eightfold.
 */

const BATCH_SAMPLES = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet (or the track ended) — stay alive and wait for one.
    if (!channel || !channel.length) return true;

    let read = 0;
    while (read < channel.length) {
      const room = BATCH_SAMPLES - this.filled;
      const take = Math.min(room, channel.length - read);
      this.batch.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;

      if (this.filled === BATCH_SAMPLES) {
        // Hand over a copy: this buffer is reused on the next call.
        this.port.postMessage(this.batch.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('buddy-capture', CaptureProcessor);
