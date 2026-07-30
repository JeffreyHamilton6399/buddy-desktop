/**
 * Buddy — Electron main process.
 *
 * Owns three windows (setup, orb, panel), the tray, the manual orb drag, and
 * the loopback server. The renderer is served over a privileged `buddy://`
 * scheme so the CSP can name the server's actual port, which is only known at
 * runtime.
 */
'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  protocol,
  session,
  nativeImage,
  shell,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const ICON_PATH = path.join(__dirname, '..', 'buddy-icon.png');
const STATE_FILE = () => path.join(app.getPath('userData'), 'buddy-state.json');

/**
 * The orb is 64px of visible circle, but its glow and its listening pulse reach
 * past that. A window sized to the circle clips them square, which is exactly the
 * "square ring" the orb used to show: a transparent window cannot paint outside
 * itself, so the halo simply stopped at the edge. The window is therefore padded,
 * and everything the renderer draws is sized to fit inside it — see styles.css,
 * which must stay in step with these numbers.
 *
 * The padding is kept as small as the glow allows, because a transparent window
 * still captures clicks across its whole rectangle. Making the surplus
 * click-through was tried and abandoned: it depends on Electron forwarding mouse
 * move messages, that forwarding proved unreliable here, and its failure mode is
 * an orb that cannot be clicked at all.
 */
const ORB_VISUAL = 64;
const ORB_WINDOW = 128;
const ORB_INSET = (ORB_WINDOW - ORB_VISUAL) / 2;

const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 620;
const SETUP_WIDTH = 470;
const SETUP_HEIGHT = 520;
const DRAG_INTERVAL_MS = 8;

// Handed to the renderer so only Buddy can talk to Buddy's server.
const AUTH_TOKEN = crypto.randomBytes(24).toString('hex');

/** @type {{ port: number|null, token: string }} */
const serverInfo = { port: null, token: AUTH_TOKEN };

let orbWindow = null;
let panelWindow = null;
let setupWindow = null;
let tray = null;
let wakeEnabled = true;
let quitting = false;
let setupCompleted = false;
let dragTimer = null;
/** The conversation the orb and the panel are both working in. */
let activeChatId = null;
/** The last few things the orb heard, newest first, for the settings panel. */
const recentlyHeard = [];

// ── persisted state ───────────────────────────────────────────────────────

let state = { orb: null, wakeEnabled: true, orbWindowSize: ORB_WINDOW };

function loadState() {
  try {
    // A byte-order mark makes JSON.parse throw, which would silently reset the
    // orb's position. Nothing Buddy writes has one, but anything that has ever
    // opened this file in an editor might.
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object') {
      state = {
        orb: parsed.orb || null,
        wakeEnabled: parsed.wakeEnabled !== false,
        orbWindowSize: Number(parsed.orbWindowSize) || 80,
      };
    }
  } catch {
    /* first run, or unreadable — defaults are fine */
  }

  // A saved position is the window's corner, so growing the window would shift
  // the visible orb. Move the corner by half the difference to leave the circle
  // exactly where the user last put it.
  if (state.orb && state.orbWindowSize !== ORB_WINDOW) {
    const shift = (ORB_WINDOW - state.orbWindowSize) / 2;
    state.orb = { x: Math.round(state.orb.x - shift), y: Math.round(state.orb.y - shift) };
  }
  state.orbWindowSize = ORB_WINDOW;

  wakeEnabled = state.wakeEnabled;
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp
      .writeFile(STATE_FILE(), JSON.stringify(state, null, 2))
      .catch((error) => console.error('[buddy] could not save state:', error.message));
  }, 250);
}

// ── platform capability ───────────────────────────────────────────────────

/**
 * Transparent always-on-top windows need a compositor. Without one, X11 paints
 * a black square where the orb should be, which looks broken. We cannot query
 * the compositor from Electron, so on Linux we assume it works only on desktops
 * that composite by default, and fall back to a small opaque window otherwise.
 * Override either way with BUDDY_TRANSPARENT=1 / =0.
 */
function supportsTransparency() {
  const override = process.env.BUDDY_TRANSPARENT;
  if (override === '1') return true;
  if (override === '0') return false;
  if (process.platform !== 'linux') return true;

  if ((process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') return true;
  const desktop = `${process.env.XDG_CURRENT_DESKTOP || ''} ${process.env.DESKTOP_SESSION || ''}`.toLowerCase();
  return /gnome|kde|plasma|sway|hyprland|wayfire|enlightenment|cinnamon|deepin|pantheon/.test(desktop);
}

const TRANSPARENT = supportsTransparency();

// ── renderer transport: buddy:// with a per-launch CSP ────────────────────

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'buddy',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function contentSecurityPolicy() {
  const origin = `http://127.0.0.1:${serverInfo.port}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `media-src 'self' blob: data: ${origin}`,
    `connect-src 'self' ${origin}`,
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-src 'none'",
  ].join('; ');
}

function registerRendererProtocol() {
  protocol.handle('buddy', async (request) => {
    const requested = new URL(request.url);
    const relative = decodeURIComponent(requested.pathname).replace(/^\/+/, '') || 'index.html';
    const resolved = path.join(RENDERER_DIR, relative);

    // Never serve anything outside the renderer directory.
    if (!resolved.startsWith(RENDERER_DIR + path.sep) && resolved !== RENDERER_DIR) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const body = await fsp.readFile(resolved);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
          'Content-Security-Policy': contentSecurityPolicy(),
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function rendererUrl(mode) {
  const params = new URLSearchParams({ mode });
  if (!TRANSPARENT) params.set('flat', '1');
  return `buddy://app/index.html?${params.toString()}`;
}

/**
 * A renderer that fails to boot just paints nothing, which on a transparent
 * window looks identical to "working". Surface the failure instead.
 */
function attachDiagnostics(window, label) {
  const { webContents } = window;

  webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[buddy] ${label} failed to load (${code} ${description}) ${url}`);
  });
  webContents.on('preload-error', (_event, file, error) => {
    console.error(`[buddy] ${label} preload error in ${file}:`, error.message);
  });
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[buddy] ${label} render process gone:`, details.reason);
  });
  if (!app.isPackaged) {
    // Electron 35 replaced the positional arguments with a single details
    // object, so accept whichever shape this runtime hands us.
    webContents.on('console-message', (...args) => {
      const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
      const level = details ? details.level : args[1];
      const message = details ? details.message : args[2];
      const line = details ? details.lineNumber : args[3];
      const source = details ? details.sourceId : args[4];
      const isProblem = typeof level === 'string' ? level === 'error' || level === 'warning' : level >= 2;
      if (isProblem) console.error(`[${label}] ${message} (${source}:${line})`);
    });
  }
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  spellcheck: false,
});

// ── windows ───────────────────────────────────────────────────────────────

function defaultOrbPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  // Offsets are measured to the visible circle, not the padded window.
  return {
    x: Math.round(workArea.x + workArea.width - ORB_INSET - ORB_VISUAL - 32),
    y: Math.round(workArea.y + 48 - ORB_INSET),
  };
}

/** Keep a saved position usable after monitors change. */
function clampToDisplays(position) {
  const displays = screen.getAllDisplays();
  const fits = displays.some((display) => {
    const a = display.workArea;
    return (
      position.x + ORB_WINDOW > a.x &&
      position.x < a.x + a.width &&
      position.y + ORB_WINDOW > a.y &&
      position.y < a.y + a.height
    );
  });
  return fits ? position : defaultOrbPosition();
}

function createOrbWindow() {
  const position = clampToDisplays(state.orb || defaultOrbPosition());

  orbWindow = new BrowserWindow({
    width: ORB_WINDOW,
    height: ORB_WINDOW,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: TRANSPARENT,
    backgroundColor: TRANSPARENT ? '#00000000' : '#0b0b0f',
    hasShadow: false,
    // Windows draws a thin frame on frameless windows unless this is off, which
    // reads as a faint square outline around a transparent orb.
    thickFrame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: 'Buddy',
    icon: trayImage(64) || undefined,
    webPreferences: webPreferences(),
  });

  orbWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') orbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  attachDiagnostics(orbWindow, 'orb');
  orbWindow.loadURL(rendererUrl('orb'));

  orbWindow.on('moved', () => {
    if (!orbWindow || orbWindow.isDestroyed()) return;
    const [x, y] = orbWindow.getPosition();
    state.orb = { x, y };
    saveState();
  });

  orbWindow.on('closed', () => {
    orbWindow = null;
  });
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    transparent: TRANSPARENT,
    backgroundColor: TRANSPARENT ? '#00000000' : '#0b0b0f',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    title: 'Buddy',
    icon: trayImage(64) || undefined,
    webPreferences: webPreferences(),
  });

  panelWindow.setAlwaysOnTop(true, 'screen-saver');
  attachDiagnostics(panelWindow, 'panel');
  panelWindow.loadURL(rendererUrl('panel'));

  // Hide instead of destroy so reopening is instant and the chat is still there.
  panelWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePanel();
  });

  panelWindow.on('show', () => broadcastPanelVisibility(true));
  panelWindow.on('hide', () => broadcastPanelVisibility(false));
  panelWindow.on('closed', () => {
    panelWindow = null;
  });
}

function positionPanelNearOrb() {
  if (!panelWindow || panelWindow.isDestroyed()) return;

  const anchor =
    orbWindow && !orbWindow.isDestroyed()
      ? orbWindow.getBounds()
      : { ...defaultOrbPosition(), width: ORB_WINDOW, height: ORB_WINDOW };
  const { workArea } = screen.getDisplayNearestPoint({
    x: anchor.x + ORB_WINDOW / 2,
    y: anchor.y + ORB_WINDOW / 2,
  });

  let x = Math.round(anchor.x + anchor.width / 2 - PANEL_WIDTH / 2);
  // Measured from the bottom of the visible circle, not of the padded window,
  // or the panel would float an inset's worth too far away.
  let y = Math.round(anchor.y + ORB_INSET + ORB_VISUAL + 12);

  // If there is no room below the orb, sit above it instead.
  if (y + PANEL_HEIGHT > workArea.y + workArea.height) {
    y = Math.round(anchor.y + ORB_INSET - PANEL_HEIGHT - 12);
  }
  x = Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - PANEL_WIDTH - 8);
  y = Math.min(Math.max(y, workArea.y + 8), workArea.y + workArea.height - PANEL_HEIGHT - 8);

  panelWindow.setPosition(x, y);
}

function showPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) createPanelWindow();
  positionPanelNearOrb();
  panelWindow.show();
  panelWindow.focus();
}

function hidePanel() {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.hide();
}

function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) hidePanel();
  else showPanel();
}

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: SETUP_WIDTH,
    height: SETUP_HEIGHT,
    frame: false,
    transparent: TRANSPARENT,
    backgroundColor: TRANSPARENT ? '#00000000' : '#0b0b0f',
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Welcome to Buddy',
    icon: trayImage(64) || undefined,
    webPreferences: webPreferences(),
  });

  attachDiagnostics(setupWindow, 'setup');
  setupWindow.loadURL(rendererUrl('setup'));
  setupWindow.once('ready-to-show', () => setupWindow && setupWindow.show());

  setupWindow.on('closed', () => {
    setupWindow = null;
    // Buddy cannot do anything without a key, so an abandoned setup ends the run.
    // `setupCompleted` is what distinguishes that from the window closing
    // because setup succeeded — do not rely on orbWindow existing yet, since
    // this event can arrive before the orb has been created.
    if (!setupCompleted) {
      quitting = true;
      app.quit();
    }
  });
}

// ── tray ──────────────────────────────────────────────────────────────────

function trayImage(size) {
  try {
    if (!fs.existsSync(ICON_PATH)) return null;
    const image = nativeImage.createFromPath(ICON_PATH);
    if (image.isEmpty()) return null;
    return size ? image.resize({ width: size, height: size }) : image;
  } catch {
    return null;
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Buddy', click: () => showPanel() },
    {
      label: 'Wake word: ' + (wakeEnabled ? 'On' : 'Off'),
      type: 'checkbox',
      checked: wakeEnabled,
      click: (item) => setWakeEnabled(item.checked, 'tray'),
    },
    { type: 'separator' },
    {
      label: 'Quit Buddy',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTray() {
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(wakeEnabled ? "Buddy — listening for 'Hey Buddy'" : 'Buddy');
  }
}

function createTray() {
  // A missing or unreadable icon must never take the app down with it.
  const image = trayImage(process.platform === 'darwin' ? 18 : 16);
  try {
    tray = image ? new Tray(image) : new Tray(nativeImage.createEmpty());
  } catch (error) {
    console.error('[buddy] tray unavailable:', error.message);
    tray = null;
    return;
  }
  refreshTray();
  tray.on('click', () => togglePanel());
}

/**
 * Windows does not remove a tray icon when its owner disappears — it leaves the
 * dead icon in the notification area until something makes the shell re-check
 * it, which is why a few unclean exits leave a row of identical ghosts. Tearing
 * the tray down explicitly means a normal quit never contributes one.
 */
function destroyTray() {
  if (!tray) return;
  try {
    if (!tray.isDestroyed()) tray.destroy();
  } catch {
    /* already gone */
  }
  tray = null;
}

// ── wake word / panel state fan-out ───────────────────────────────────────

function eachRenderer(callback) {
  for (const window of [orbWindow, panelWindow]) {
    if (window && !window.isDestroyed()) callback(window);
  }
}

function setWakeEnabled(enabled, source) {
  wakeEnabled = Boolean(enabled);
  state.wakeEnabled = wakeEnabled;
  saveState();
  refreshTray();
  eachRenderer((window) => window.webContents.send('buddy:wake-toggled', wakeEnabled, source || 'main'));
}

function broadcastPanelVisibility(visible) {
  eachRenderer((window) => window.webContents.send('buddy:panel-visibility', visible));
}

// ── manual orb drag ───────────────────────────────────────────────────────

/**
 * `-webkit-app-region: drag` swallows hover and click on a 64px target, so the
 * drag is driven from here: remember the grab offset, then follow the cursor.
 */
function startDrag() {
  if (!orbWindow || orbWindow.isDestroyed()) return;
  stopDrag();

  const cursor = screen.getCursorScreenPoint();
  const [windowX, windowY] = orbWindow.getPosition();
  const offsetX = cursor.x - windowX;
  const offsetY = cursor.y - windowY;

  dragTimer = setInterval(() => {
    if (!orbWindow || orbWindow.isDestroyed()) return stopDrag();
    const point = screen.getCursorScreenPoint();
    orbWindow.setPosition(point.x - offsetX, point.y - offsetY);
  }, DRAG_INTERVAL_MS);
}

function stopDrag() {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (orbWindow && !orbWindow.isDestroyed()) {
    const [x, y] = orbWindow.getPosition();
    state.orb = { x, y };
    saveState();
  }
}

// ── ipc ───────────────────────────────────────────────────────────────────

function registerIpc() {
  const { isConfigured } = require('./server/server.js');

  ipcMain.handle('buddy:boot', () => ({
    port: serverInfo.port,
    token: serverInfo.token,
    wakeEnabled,
    configured: isConfigured(),
    platform: process.platform,
    transparent: TRANSPARENT,
    version: app.getVersion(),
    panelVisible: Boolean(panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()),
  }));

  ipcMain.on('buddy:request-open-panel', () => showPanel());
  ipcMain.on('buddy:close-panel', () => hidePanel());
  ipcMain.on('buddy:set-wake-enabled', (_event, enabled) => setWakeEnabled(enabled, 'renderer'));
  ipcMain.on('buddy:orb-drag-start', () => startDrag());
  ipcMain.on('buddy:orb-drag-end', () => stopDrag());
  ipcMain.on('buddy:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.on('buddy:open-config-folder', () => shell.openPath(app.getPath('userData')));

  /**
   * Carry out an action the model asked for.
   *
   * The server already validated this, and it is validated again here. That is
   * not redundancy for its own sake: this is the only place in Buddy that hands
   * something to the operating system, and it should not be reachable by anyone
   * who manages to put a message on the wire. A name off the list, or a URL that
   * is not http, gets nothing done.
   */
  ipcMain.handle('buddy:run-action', async (_event, action) => {
    const name = action && typeof action.name === 'string' ? action.name : '';
    const value = action && typeof action.value === 'string' ? action.value : '';

    if (name === 'open_url' || name === 'search_web') {
      let url;
      try {
        url = new URL(value);
      } catch {
        return { ok: false, error: 'That was not a valid address.' };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'Only web addresses can be opened.' };
      }
      await shell.openExternal(url.toString());
      return { ok: true };
    }

    if (name === 'open_folder') {
      // Names map to folders; a path never arrives from outside.
      const folders = {
        models: path.join(app.getPath('userData'), 'models'),
        chats: path.join(app.getPath('userData'), 'chats'),
        config: app.getPath('userData'),
      };
      const target = folders[value];
      if (!target) return { ok: false, error: 'There is no such folder.' };
      await shell.openPath(target);
      return { ok: true };
    }

    return { ok: false, error: `Buddy cannot do "${name}".` };
  });

  ipcMain.on('buddy:runtime-changed', () => {
    eachRenderer((window) => window.webContents.send('buddy:runtime-changed'));
  });

  /**
   * Which conversation is "the current one", shared between the orb and the panel.
   *
   * Without this they each kept their own, so anything said out loud went into a
   * separate conversation from anything typed — you would ask Buddy something,
   * open the panel, and find no trace of it. The orb starts a spoken exchange in
   * whatever the panel is showing, and the panel follows when the orb moves on.
   */
  ipcMain.on('buddy:set-active-chat', (event, id) => {
    activeChatId = typeof id === 'string' && id ? id : null;
    eachRenderer((window) => {
      // Do not echo back to whoever just said so.
      if (window.webContents.id !== event.sender.id) {
        window.webContents.send('buddy:active-chat', activeChatId);
      }
    });
  });

  ipcMain.handle('buddy:get-active-chat', () => activeChatId);

  /**
   * A short record of what the orb has actually heard.
   *
   * The wake word failing is otherwise invisible: the orb is a separate window
   * with no console anybody looks at, and "nothing happened" covers a dozen
   * different faults. Keeping the last few attempts where the settings panel can
   * show them turns "it doesn't work" into "it heard you and transcribed it as
   * this", which is a fixable statement.
   */
  ipcMain.on('buddy:heard', (_event, entry) => {
    if (!entry || typeof entry !== 'object') return;
    recentlyHeard.unshift({
      at: Date.now(),
      seconds: Number(entry.seconds) || 0,
      text: typeof entry.text === 'string' ? entry.text.slice(0, 200) : '',
      matched: Boolean(entry.matched),
      note: typeof entry.note === 'string' ? entry.note.slice(0, 120) : '',
    });
    recentlyHeard.length = Math.min(recentlyHeard.length, 8);
  });

  ipcMain.handle('buddy:get-heard', () => recentlyHeard);

  ipcMain.on('buddy:chat-updated', (event, id) => {
    eachRenderer((window) => {
      if (window.webContents.id !== event.sender.id) {
        window.webContents.send('buddy:chat-updated', typeof id === 'string' ? id : null);
      }
    });
  });

  ipcMain.on('buddy:setup-complete', () => {
    setupCompleted = true;
    if (setupWindow && !setupWindow.isDestroyed()) {
      const window = setupWindow;
      setupWindow = null; // so the closed handler does not quit the app
      window.close();
    }
    if (!orbWindow) {
      createOrbWindow();
      createPanelWindow();
      createTray();
    }
  });
}

// ── startup ───────────────────────────────────────────────────────────────

function grantMediaPermissions() {
  const isOurs = (url) => typeof url === 'string' && url.startsWith('buddy://');

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = permission === 'media' || permission === 'audioCapture';
    callback(allowed && isOurs(contents.getURL()));
  });

  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => {
    if (permission !== 'media' && permission !== 'audioCapture') return false;
    return isOurs(origin) || (contents ? isOurs(contents.getURL()) : false);
  });
}

/**
 * server.js freezes its auth token at require time, so this has to run before
 * anything — including registerIpc() — pulls the module in.
 */
function prepareServerEnv() {
  process.env.BUDDY_CONFIG_DIR = app.getPath('userData');
  process.env.BUDDY_TOKEN = AUTH_TOKEN;
}

async function startServer() {
  const { start, isConfigured } = require('./server/server.js');
  const { port } = await start({ port: 0 });
  serverInfo.port = port;
  return isConfigured();
}

function fatal(error) {
  console.error('[buddy] fatal:', error && error.stack ? error.stack : error);
  const { dialog } = require('electron');
  try {
    dialog.showErrorBox('Buddy could not start', String((error && error.message) || error));
  } catch {
    /* no display */
  }
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPanel();
    if (orbWindow && !orbWindow.isDestroyed()) orbWindow.showInactive();
  });

  app.whenReady().then(async () => {
    try {
      prepareServerEnv();
      loadState();
      registerRendererProtocol();
      grantMediaPermissions();
      registerIpc();

      const configured = await startServer();
      if (process.platform === 'darwin' && app.dock) app.dock.hide();

      if (!configured) {
        // The panel starts hidden, so first-run setup needs a window of its own.
        createSetupWindow();
      } else {
        createOrbWindow();
        createPanelWindow();
        createTray();
      }
    } catch (error) {
      fatal(error);
    }
  });

  app.on('window-all-closed', () => {
    // Buddy lives in the tray; closing the panel is not quitting.
    if (!tray) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopDrag();
    destroyTray();
  });

  // A crash or a kill cannot be helped, but every exit we do control should
  // leave the notification area as it found it.
  app.on('will-quit', destroyTray);
  process.on('exit', destroyTray);

  app.on('activate', () => {
    if (orbWindow && !orbWindow.isDestroyed()) orbWindow.showInactive();
    else if (!setupWindow) createOrbWindow();
  });
}
