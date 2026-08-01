/**
 * The only bridge between Buddy's renderer and the main process.
 * Subscription helpers return an unsubscribe function.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('buddy', {
  /** @returns {Promise<{port:number, token:string, wakeEnabled:boolean, configured:boolean, platform:string, transparent:boolean, panelVisible:boolean}>} */
  getBoot: () => ipcRenderer.invoke('buddy:boot'),

  requestOpenPanel: () => ipcRenderer.send('buddy:request-open-panel'),
  closePanel: () => ipcRenderer.send('buddy:close-panel'),
  setWakeEnabled: (enabled) => ipcRenderer.send('buddy:set-wake-enabled', Boolean(enabled)),
  setupComplete: () => ipcRenderer.send('buddy:setup-complete'),
  openExternal: (url) => ipcRenderer.send('buddy:open-external', String(url)),
  openConfigFolder: () => ipcRenderer.send('buddy:open-config-folder'),

  /**
   * Put text on the clipboard.
   *
   * Electron's own clipboard rather than navigator.clipboard, which is refused
   * in this renderer — the web API wants a permission that a custom protocol
   * page does not get, so the copy button silently failed every time.
   */
  copyText: (text) => ipcRenderer.send('buddy:copy-text', String(text)),

  /** Native folder picker, for choosing where Buddy may read and write. */
  pickFolder: () => ipcRenderer.invoke('buddy:pick-folder'),

  /** Carry out an action the model asked for. Re-validated in the main process. */
  runAction: (action) => ipcRenderer.invoke('buddy:run-action', action),

  /**
   * A picture of the screen, for showing Buddy what you are looking at. Only
   * ever called from a button the user pressed — the model cannot ask for it.
   */
  captureScreen: () => ipcRenderer.invoke('buddy:capture-screen'),

  startOrbDrag: () => ipcRenderer.send('buddy:orb-drag-start'),
  endOrbDrag: () => ipcRenderer.send('buddy:orb-drag-end'),

  /** Settings changed somewhere; every window should re-read the runtime. */
  notifyRuntimeChanged: () => ipcRenderer.send('buddy:runtime-changed'),

  /**
   * The conversation the orb and the panel share, so a spoken exchange and a
   * typed one end up in the same place.
   */
  setActiveChat: (id) => ipcRenderer.send('buddy:set-active-chat', id || null),
  getActiveChat: () => ipcRenderer.invoke('buddy:get-active-chat'),
  notifyChatUpdated: (id) => ipcRenderer.send('buddy:chat-updated', id || null),

  /** What the orb heard, so the settings panel can show why it did not wake. */
  reportHeard: (entry) => ipcRenderer.send('buddy:heard', entry),
  getHeard: () => ipcRenderer.invoke('buddy:get-heard'),

  onWakeToggled: (handler) => subscribe('buddy:wake-toggled', handler),
  onPanelVisibility: (handler) => subscribe('buddy:panel-visibility', handler),
  onRuntimeChanged: (handler) => subscribe('buddy:runtime-changed', handler),
  /** The global shortcuts, arriving from whichever window has focus — or none. */
  onFocusComposer: (handler) => subscribe('buddy:focus-composer', handler),
  onSilence: (handler) => subscribe('buddy:silence', handler),
  onActiveChat: (handler) => subscribe('buddy:active-chat', handler),
  onChatUpdated: (handler) => subscribe('buddy:chat-updated', handler),
});
