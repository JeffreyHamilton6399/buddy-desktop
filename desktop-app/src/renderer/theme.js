/**
 * How Buddy looks: the accent colour, the light/dark theme, and how big the orb
 * is. One module, shared by all three windows, because the orb and the panel are
 * separate documents that have to agree — a recoloured orb beside a panel still
 * painting itself rose would look broken.
 *
 * Everything here writes CSS custom properties defined at the top of styles.css
 * and nothing else. That is the whole contract: no rule anywhere names a colour
 * literally, so setting a handful of variables here repaints the entire app.
 */
'use strict';

import { runtime } from './core.js';

/**
 * Colours worth offering before anyone reaches for the picker. Warm first,
 * because that is what Buddy has always looked like.
 */
export const ACCENT_PRESETS = [
  { id: 'rose', label: 'Sunset', accent: '#f43f5e' },
  { id: 'amber', label: 'Ember', accent: '#f59e0b' },
  { id: 'violet', label: 'Violet', accent: '#8b5cf6' },
  { id: 'sky', label: 'Lagoon', accent: '#0ea5e9' },
  { id: 'emerald', label: 'Moss', accent: '#10b981' },
  { id: 'slate', label: 'Graphite', accent: '#64748b' },
];

// ── colour maths ──────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value) || full.length !== 6) return { r: 244, g: 63, b: 94 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgbToHsl({ r, g, b }) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;

  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360;
  const sn = s / 100;
  const ln = l / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;

  const [r, g, b] =
    hn < 60
      ? [c, x, 0]
      : hn < 120
        ? [x, c, 0]
        : hn < 180
          ? [0, c, x]
          : hn < 240
            ? [0, x, c]
            : hn < 300
              ? [x, 0, c]
              : [c, 0, x];

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const triple = ({ r, g, b }) => `${r}, ${g}, ${b}`;

/**
 * Build the orb's three-stop gradient from the one colour the user picked.
 *
 * The original palette is the measurement this is derived from: amber sits 53°
 * around the wheel from the rose in the middle and fuchsia sits 58° the other
 * way, with the outer two slightly more and slightly less saturated than the
 * centre. Applying those same offsets to any hue keeps the orb reading as one
 * lit sphere rather than three colours in a row.
 *
 * Saturation and lightness are clamped into a band the orb can survive. A very
 * dark or very grey accent would otherwise produce a flat disc with no glow at
 * all — the hue the user chose is honoured exactly, but it has to be a colour
 * that can plausibly light up.
 */
export function accentStops(accent) {
  const base = rgbToHsl(hexToRgb(accent));
  const h = base.h;
  const s = clamp(base.s, 38, 100);
  const l = clamp(base.l, 44, 68);

  return {
    amber: hslToRgb({ h: h + 53, s: clamp(s + 7, 0, 100), l: clamp(l - 4, 0, 100) }),
    rose: hslToRgb({ h, s, l }),
    fuchsia: hslToRgb({ h: h - 58, s: clamp(s - 5, 0, 100), l: clamp(l + 1, 0, 100) }),
  };
}

// ── applying it ───────────────────────────────────────────────────────────

/** Sizes must match ORB_SIZES in server/providers.js. */
const ORB_PIXELS = { small: 48, medium: 64, large: 88 };

const DEFAULTS = { theme: 'dark', accent: '#f43f5e', orbSize: 'medium' };

const systemPrefersLight = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;

/** 'system' is resolved here so styles.css only has to carry one light palette. */
export function resolveTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'system') return systemPrefersLight() ? 'light' : 'dark';
  return 'dark';
}

/**
 * Paint the document from a `look` settings object. Safe to call as often as
 * you like — it only ever sets properties, and setting them to what they
 * already are costs nothing.
 */
export function applyLook(look) {
  const settings = { ...DEFAULTS, ...(look || {}) };
  const root = document.documentElement;

  root.dataset.theme = resolveTheme(settings.theme);

  const stops = accentStops(settings.accent);
  root.style.setProperty('--amber-rgb', triple(stops.amber));
  root.style.setProperty('--rose-rgb', triple(stops.rose));
  root.style.setProperty('--fuchsia-rgb', triple(stops.fuchsia));

  root.style.setProperty('--orb', `${ORB_PIXELS[settings.orbSize] || ORB_PIXELS.medium}px`);
}

/** Paint from whatever /health last reported. */
export function applyLookFromRuntime() {
  applyLook(runtime.look);
}

/**
 * Follow the OS when the user asked to. Without this, "match my system" would
 * only be matched at launch and would then sit there being wrong until Buddy
 * was restarted.
 */
export function watchSystemTheme() {
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const react = () => {
    if ((runtime.look || DEFAULTS).theme === 'system') applyLookFromRuntime();
  };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', react);
  else if (typeof query.addListener === 'function') query.addListener(react);
}
