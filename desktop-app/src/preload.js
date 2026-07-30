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

  /** Carry out an action the model asked for. Re-validated in the main process. */
  runAction: (action) => ipcRenderer.invoke('buddy:run-action', action),

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

  onWakeToggled: (handler) => subscribe('buddy:wake-toggled', handler),
  onPanelVisibility: (handler) => subscribe('buddy:panel-visibility', handler),
  onRuntimeChanged: (handler) => subscribe('buddy:runtime-changed', handler),
  onActiveChat: (handler) => subscribe('buddy:active-chat', handler),
  onChatUpdated: (handler) => subscribe('buddy:chat-updated', handler),
});
