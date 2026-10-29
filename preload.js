const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cocoa', {
  onState: fn => ipcRenderer.on('state', (_, s) => fn(s)),
  onToast: fn => ipcRenderer.on('toast', (_, m) => fn(m)),
  importDialog: () => ipcRenderer.invoke('import-dialog'),
  importFiles: files => ipcRenderer.invoke('import-paths', [...files].map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  saveLink: url => ipcRenderer.invoke('save-link', url),
  setDuration: (id, d) => ipcRenderer.invoke('set-duration', id, d),
  setPinned: on => ipcRenderer.invoke('set-pinned', on),
  setMini: on => ipcRenderer.invoke('set-mini', on),
  close: () => ipcRenderer.invoke('close'),
  createPlaylist: name => ipcRenderer.invoke('playlist-create', name),
  trackMenu: (id, playlistId) => ipcRenderer.invoke('track-menu', id, playlistId),
  playlistMenu: id => ipcRenderer.invoke('playlist-menu', id),
  appMenu: () => ipcRenderer.invoke('app-menu'),
});
