const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("ttsStudio", {
  getStatus: () => ipcRenderer.invoke("studio:get-status"),
  getSettings: () => ipcRenderer.invoke("studio:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("studio:save-settings", settings),
  pickLocation: (key) => ipcRenderer.invoke("studio:pick-location", key),
  startTextVoices: (options) => ipcRenderer.invoke("studio:start-text-voices", options),
  selectTextVoice: (token) => ipcRenderer.invoke("studio:select-text-voice", token),
  startFinetune: (options) => ipcRenderer.invoke("studio:start-finetune", options),
  listOutputs: () => ipcRenderer.invoke("studio:list-outputs"),
  setOutputReview: (target, status) => ipcRenderer.invoke("studio:set-output-review", target, status),
  setClearedFindings: (target, keys) => ipcRenderer.invoke("studio:set-cleared-findings", target, keys),
  renameOutput: (target, name) => ipcRenderer.invoke("studio:rename-output", target, name),
  deleteOutput: (target) => ipcRenderer.invoke("studio:delete-output", target),
  renameVideo: (token, name) => ipcRenderer.invoke("studio:rename-video", token, name),
  pickVideos: (multiple) => ipcRenderer.invoke("studio:pick-videos", Boolean(multiple)),
  pickAudio: () => ipcRenderer.invoke("studio:pick-audio"),
  reviewWaveform: options => ipcRenderer.invoke('studio:review-waveform',options),
  reviewPreview: options => ipcRenderer.invoke('studio:review-preview',options),
  // FileList 는 이 경계를 건너오지 못한다. 건너편에서는 length 도 없는 빈 객체가
  // 되어 Array.from 이 조용히 0개를 내고, 놓은 파일이 통째로 사라진다. File 을
  // 담은 '배열'은 그대로 건너오므로 넘기는 쪽에서 펼쳐야 한다. 약속이 깨지면
  // 빈 목록으로 넘기지 않고 여기서 말한다 — 조용히 0개가 되는 것이 이 버그였다.
  registerDroppedFiles: (files, kind) => {
    if (!Array.isArray(files)) {
      throw new TypeError("끌어다 놓은 파일은 File 배열로 넘겨 주세요. FileList 는 전달되지 않습니다.");
    }
    const paths = files.map((file) => {
      try { return webUtils.getPathForFile(file); } catch { return ""; }
    }).filter(Boolean);
    return ipcRenderer.invoke("studio:register-dropped-files", paths, kind);
  },
  adoptResultVideo: (target) => ipcRenderer.invoke("studio:adopt-result-video", target),
  startEdit: (options) => ipcRenderer.invoke("studio:start-edit", options),
  start: (options) => ipcRenderer.invoke("studio:start", options),
  cancel: () => ipcRenderer.invoke("studio:cancel"),
  pause: () => ipcRenderer.invoke("studio:pause"),
  resume: () => ipcRenderer.invoke("studio:resume"),
  getResumable: () => ipcRenderer.invoke("studio:get-resumable"),
  resumeJob: () => ipcRenderer.invoke("studio:resume-job"),
  discardResumable: () => ipcRenderer.invoke("studio:discard-resumable"),
  reveal: (target) => ipcRenderer.invoke("studio:reveal", target),
  open: (target) => ipcRenderer.invoke("studio:open", target),
  onJobEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("studio:job-event", listener);
    return () => ipcRenderer.removeListener("studio:job-event", listener);
  },
});
