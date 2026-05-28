const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orbitPicker", {
  commit: (rect) => ipcRenderer.send("region-picker:commit", rect),
  cancel: () => ipcRenderer.send("region-picker:cancel")
});
