#!/usr/bin/env node
/**
 * Generates buddy-icon.png — a 256x256 RGBA orb (amber -> rose -> fuchsia).
 * Dependency-free: writes the PNG chunks by hand using zlib.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const OUT = path.join(__dirname, '..', 'buddy-icon.png');

// Warm palette only — no blue, no indigo.
const AMBER = [251, 191, 36];
const ROSE = [244, 63, 94];
const FUCHSIA = [217, 70, 239];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function ramp(t) {
  // t in [0,1] -> amber (core highlight) through rose to fuchsia (rim)
  if (t < 0.5) {
    const k = t / 0.5;
    return [
      lerp(AMBER[0], ROSE[0], k),
      lerp(AMBER[1], ROSE[1], k),
      lerp(AMBER[2], ROSE[2], k),
    ];
  }
  const k = (t - 0.5) / 0.5;
  return [
    lerp(ROSE[0], FUCHSIA[0], k),
    lerp(ROSE[1], FUCHSIA[1], k),
    lerp(ROSE[2], FUCHSIA[2], k),
  ];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function buildRaw() {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const core = SIZE * 0.36; // solid orb radius
  const glow = SIZE * 0.5; // outer glow radius
  // Light source sits up and to the left so the orb reads as a sphere.
  const hx = cx - SIZE * 0.11;
  const hy = cy - SIZE * 0.13;

  // Each scanline is prefixed with a filter-type byte (0 = None).
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let p = 0;

  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0;
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dCenter = Math.hypot(px - cx, py - cy);
      const dLight = Math.hypot(px - hx, py - hy);

      const t = Math.min(1, dLight / (core * 1.45));
      let [r, g, b] = ramp(t);

      // Specular sheen near the light source.
      const sheen = Math.pow(1 - Math.min(1, dLight / (core * 0.62)), 2.2) * 0.55;
      r = lerp(r, 255, sheen);
      g = lerp(g, 255, sheen);
      b = lerp(b, 255, sheen);

      // Solid inside the core, then a soft glow that fades to transparent.
      let a;
      if (dCenter <= core) {
        a = 1;
      } else {
        a = (1 - smoothstep(core, glow, dCenter)) * 0.5;
      }
      // Feather the very edge of the core so it does not alias.
      a *= 1 - smoothstep(core - 1.2, core + 1.2, dCenter) * 0;
      if (dCenter > core - 1 && dCenter <= core) {
        a = lerp(a, 0.85, smoothstep(core - 1, core, dCenter));
      }

      raw[p++] = Math.round(Math.min(255, Math.max(0, r)));
      raw[p++] = Math.round(Math.min(255, Math.max(0, g)));
      raw[p++] = Math.round(Math.min(255, Math.max(0, b)));
      raw[p++] = Math.round(Math.min(255, Math.max(0, a * 255)));
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function main() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(buildRaw(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(OUT, png);
  console.log(`buddy-icon.png written (${SIZE}x${SIZE}, ${png.length} bytes) -> ${OUT}`);
}

main();
