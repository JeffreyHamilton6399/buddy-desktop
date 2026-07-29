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

  startOrbDrag: () => ipcRenderer.send('buddy:orb-drag-start'),
  endOrbDrag: () => ipcRenderer.send('buddy:orb-drag-end'),

  onWakeToggled: (handler) => subscribe('buddy:wake-toggled', handler),
  onPanelVisibility: (handler) => subscribe('buddy:panel-visibility', handler),
});
