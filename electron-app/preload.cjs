const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ttsStudio", {
  getStatus: () => ipcRenderer.invoke("studio:get-status"),
  getSettings: () => ipcRenderer.invoke("studio:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("studio:save-settings", settings),
  startFinetune: (options) => ipcRenderer.invoke("studio:start-finetune", options),
  listOutputs: () => ipcRenderer.invoke("studio:list-outputs"),
  pickVideos: (multiple) => ipcRenderer.invoke("studio:pick-videos", Boolean(multiple)),
  pickAudio: () => ipcRenderer.invoke("studio:pick-audio"),
  registerDroppedFiles: (files, kind) => {
    const paths = Array.from(files || []).map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke("studio:register-dropped-files", paths, kind);
  },
  startEdit: (options) => ipcRenderer.invoke("studio:start-edit", options),
  start: (options) => ipcRenderer.invoke("studio:start", options),
  cancel: () => ipcRenderer.invoke("studio:cancel"),
  reveal: (target) => ipcRenderer.invoke("studio:reveal", target),
  open: (target) => ipcRenderer.invoke("studio:open", target),
  onJobEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("studio:job-event", listener);
    return () => ipcRenderer.removeListener("studio:job-event", listener);
  },
});
