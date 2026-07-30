/**
 * Raw audio helpers.
 *
 * The renderer captures microphone audio as 16 kHz mono float samples, because
 * that is exactly what Whisper wants and it keeps an Opus decoder out of this
 * process. The other transcription providers want a file, so when one of those
 * is in use the same samples get a wav header put on them here rather than the
 * renderer having to know which provider it is talking to and capture twice.
 */
'use strict';

/** Base64 of little-endian Float32 samples -> Float32Array. */
function float32FromBase64(base64) {
  const bytes = Buffer.from(String(base64 || '').trim(), 'base64');
  if (bytes.length < 4) return new Float32Array(0);
  // A Buffer's memory may sit at any offset, and Float32Array needs a multiple
  // of four, so copy into a fresh aligned buffer rather than viewing in place.
  const usable = bytes.length - (bytes.length % 4);
  const copy = Buffer.allocUnsafe(usable);
  bytes.copy(copy, 0, 0, usable);
  return new Float32Array(copy.buffer, copy.byteOffset, usable / 4);
}

/** Float samples -> a canonical 16-bit PCM wav file. */
function wavFromFloat32(samples, sampleRate) {
  const rate = Number(sampleRate) || 16000;
  const wav = Buffer.alloc(44 + samples.length * 2);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // fmt chunk length
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples.length * 2, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return wav;
}

/** Linear resample. Only used off the hot path; the mic already arrives at 16 kHz. */
function resample(samples, from, to) {
  if (!from || !to || from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, samples.length - 1);
    out[i] = samples[low] + (samples[high] - samples[low]) * (at - low);
  }
  return out;
}

/** How long a clip is, in seconds. */
function durationOf(samples, sampleRate) {
  return samples.length / (Number(sampleRate) || 16000);
}

module.exports = { float32FromBase64, wavFromFloat32, resample, durationOf };
