/**
 * Letting Buddy read and write files — inside folders you have named, and
 * nowhere else.
 *
 * This is the most dangerous thing in the app, so the design assumes the model
 * is actively trying to escape rather than merely confused:
 *
 *   * There is no default folder. Until the user picks one, every path is
 *     refused, so turning the setting on alone grants nothing.
 *   * A path is resolved and then checked to sit inside a named folder. Both
 *     halves matter — `..` is handled by resolving, and a symlink pointing out
 *     of the folder is handled by resolving the real path of the deepest part
 *     that actually exists before comparing.
 *   * Writes back up whatever was there first. A model that misunderstands
 *     "tidy up my notes" should cost you a `.bak` file, not your notes.
 *   * Only text, and only so much of it. Buddy has no business rewriting a
 *     database or a disk image, and the size cap is what stops a loop from
 *     filling the drive.
 *
 * Nothing here trusts its caller: main.js validates again before touching the
 * filesystem, because that is the only place in Buddy that does.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** Big enough for notes, code and documents; small enough to never be a disk image. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTING = 200;

/**
 * Extensions Buddy will not touch even inside an allowed folder. These are
 * things that run, or things whose corruption is unrecoverable — a model has no
 * business writing either, and refusing by name is cheap insurance on top of
 * the folder scoping.
 */
const FORBIDDEN = new Set([
  '.exe', '.dll', '.so', '.dylib', '.sys', '.msi', '.scr', '.com', '.pif',
  '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.app',
  '.lnk', '.reg', '.db', '.sqlite', '.sqlite3', '.iso', '.img', '.vhd',
  '.key', '.pem', '.pfx', '.p12', '.keychain',
]);

/** Absolute, resolved, de-duplicated. Anything unusable is dropped. */
function normaliseRoots(list) {
  const seen = new Set();
  const roots = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    let resolved = path.resolve(entry.trim());
    try {
      // Follow the folder itself, so a root given as a symlink still matches
      // the real paths that come back out of readdir.
      resolved = fs.realpathSync(resolved);
    } catch {
      /* not there any more — keep it, it may come back on a removable drive */
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(resolved);
  }
  return roots;
}

/** Is `candidate` the same as, or inside, `root`? */
function isWithin(root, candidate) {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * The real location of a path, following symlinks as far as the filesystem
 * actually goes. A file that does not exist yet still has a parent that does,
 * and it is the parent that could be a symlink pointing somewhere else.
 */
function realish(candidate) {
  let current = path.resolve(candidate);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      // Reached the drive root without finding anything real.
      if (parent === current) return path.resolve(candidate);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Turn whatever the model wrote into a real path inside an allowed folder.
 *
 * @param {string[]} roots folders the user has allowed
 * @param {string} candidate what the model asked for, absolute or relative
 * @returns {{ok: true, path: string, root: string} | {ok: false, error: string}}
 */
function resolveWithin(roots, candidate) {
  const allowed = normaliseRoots(roots);
  if (!allowed.length) {
    return { ok: false, error: 'no folders have been shared with Buddy yet' };
  }

  const wanted = String(candidate || '').trim().replace(/^["']|["']$/g, '');
  if (!wanted) return { ok: false, error: 'no file was named' };
  // A bare drive or UNC share is never a file, and `\\host\share` would sail
  // past a naive prefix check against a local root.
  if (/^\\\\/.test(wanted)) return { ok: false, error: 'network paths are not allowed' };

  // Relative paths are tried against each folder in turn, so "notes.txt" means
  // the obvious thing when only one folder is shared.
  const attempts = path.isAbsolute(wanted) ? [wanted] : allowed.map((root) => path.join(root, wanted));

  for (const attempt of attempts) {
    const resolved = realish(attempt);
    const root = allowed.find((entry) => isWithin(entry, resolved));
    if (root) {
      const extension = path.extname(resolved).toLowerCase();
      if (FORBIDDEN.has(extension)) {
        return { ok: false, error: `Buddy will not touch ${extension} files` };
      }
      return { ok: true, path: resolved, root };
    }
  }

  return {
    ok: false,
    error: path.isAbsolute(wanted)
      ? 'that is outside the folders you have shared with Buddy'
      : `no shared folder contains "${wanted}"`,
  };
}

// ── the operations themselves ─────────────────────────────────────────────

async function readTextFile(target) {
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return { ok: false, error: 'there is no such file' };
  }
  if (stat.isDirectory()) return { ok: false, error: 'that is a folder, not a file' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: 'that file is too big to read' };

  const text = await fsp.readFile(target, 'utf8');
  // A NUL byte means this was never text, whatever the extension claimed.
  if (text.includes('\u0000')) return { ok: false, error: 'that file is not text' };
  return { ok: true, text };
}

/**
 * Write a file, keeping whatever was there before.
 *
 * The backup is the whole safety story for overwrites: the model does not get
 * to be right about what the old contents were worth.
 */
async function writeTextFile(target, content, { append = false } = {}) {
  const text = String(content == null ? '' : content);
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    return { ok: false, error: 'that is too much text to write at once' };
  }

  let backedUp = null;
  const existed = fs.existsSync(target);
  if (existed && !append) {
    backedUp = `${target}.bak`;
    try {
      await fsp.copyFile(target, backedUp);
    } catch {
      return { ok: false, error: 'the existing file could not be backed up, so it was left alone' };
    }
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (append) await fsp.appendFile(target, text, 'utf8');
  else await fsp.writeFile(target, text, 'utf8');

  return { ok: true, existed, backedUp, bytes: Buffer.byteLength(text, 'utf8') };
}

async function listFolder(target) {
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return { ok: false, error: 'there is no such folder' };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'that is a file, not a folder' };

  const entries = await fsp.readdir(target, { withFileTypes: true });
  const rows = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .slice(0, MAX_LISTING)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  return { ok: true, entries: rows, truncated: entries.length > MAX_LISTING };
}

module.exports = {
  MAX_FILE_BYTES,
  normaliseRoots,
  resolveWithin,
  readTextFile,
  writeTextFile,
  listFolder,
};
