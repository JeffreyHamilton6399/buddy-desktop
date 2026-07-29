#!/usr/bin/env node
/**
 * Dev launcher: runs the local server on its own and then Electron alongside it,
 * so you can curl the API while the app is open. Electron also starts its own
 * in-process server — this one is purely for poking at by hand.
 *
 * Ctrl+C stops both.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const children = [];
let shuttingDown = false;

function run(label, command, args, extraEnv) {
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm/electron are .cmd shims on Windows
    env: { ...process.env, ...extraEnv },
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`\n[dev] ${label} exited (${signal || code}) — stopping everything`);
    shutdown(typeof code === 'number' ? code : 1);
  });

  child.on('error', (error) => {
    console.error(`[dev] could not start ${label}:`, error.message);
    shutdown(1);
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] starting standalone server (for curl) + Electron\n');

// A fixed port for convenience here; the server falls back to a free one if
// it is taken, and Electron's own instance always uses an OS-assigned port.
run('server', process.execPath, [path.join(ROOT, 'src', 'server', 'server.js')], {
  BUDDY_PORT: process.env.BUDDY_PORT || '3005',
});

setTimeout(() => {
  run('electron', 'npx', ['electron', '.']);
}, 400);
