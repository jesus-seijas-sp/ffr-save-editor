const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  defaultDir: () => ipcRenderer.invoke('saves:defaultDir'),
  pickDir: (current) => ipcRenderer.invoke('saves:pickDir', current),
  detectDirs: () => ipcRenderer.invoke('saves:detect'),
  gameInfo: () => ipcRenderer.invoke('game:info'),
  listBackups: (dir) => ipcRenderer.invoke('backup:list', dir),
  backupAll: (dir) => ipcRenderer.invoke('backup:all', dir),
  restoreBackup: (dir, itemPath) => ipcRenderer.invoke('backup:restore', dir, itemPath),
  openBackupFolder: (dir) => ipcRenderer.invoke('backup:openFolder', dir),
  rememberDir: (dir) => ipcRenderer.invoke('saves:remember', dir),
  listSaves: (dir) => ipcRenderer.invoke('saves:list', dir),
  openSave: (file) => ipcRenderer.invoke('save:open', file),
  writeSave: (file, header, plain) => ipcRenderer.invoke('save:write', file, header, plain),
  catalog: () => ipcRenderer.invoke('catalog:get'),
  setDirty: (v) => ipcRenderer.send('state:dirty', v),
  screenshot: () => ipcRenderer.invoke('debug:screenshot'),
});
