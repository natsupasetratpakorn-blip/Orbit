const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orbit", {
  captureScreen: () => ipcRenderer.invoke("screen:capture"),
  captureRegion: () => ipcRenderer.invoke("screen:capture-region"),
  savePastedImage: (dataUrl) => ipcRenderer.invoke("screen:save-pasted-image", { dataUrl }),
  loadHistory: (workspacePath) => ipcRenderer.invoke("history:load", workspacePath),
  saveHistory: (history) => ipcRenderer.invoke("history:save", history),
  snapshotHistory: (history) => ipcRenderer.invoke("history:snapshot", history),
  setOverlayState: (state) => ipcRenderer.invoke("overlay:set-state", state),
  sendToAI: (payload) => ipcRenderer.invoke("ai:send", payload),
  abortAI: (streamId) => ipcRenderer.invoke("ai:abort", { streamId }),
  // Conversation memory: summarize older turns + harvest durable user facts.
  summarizeMemory: (payload) => ipcRenderer.invoke("ai:summarize", payload),
  getMemory: () => ipcRenderer.invoke("memory:get"),
  clearMemory: () => ipcRenderer.invoke("memory:clear"),
  // Orbit Cloud license — owned by the main process so the app and overlay
  // share one license and both route through the gateway.
  getCloud: () => ipcRenderer.invoke("cloud:get"),
  setCloud: (cfg) => ipcRenderer.invoke("cloud:set", cfg),
  onAIChunk: (handler) => {
    const wrapped = (_, data) => handler(data);
    ipcRenderer.on("ai:chunk", wrapped);
    return () => ipcRenderer.removeListener("ai:chunk", wrapped);
  },
  onAIUsage: (handler) => {
    const wrapped = (_, data) => handler(data);
    ipcRenderer.on("ai:usage", wrapped);
    return () => ipcRenderer.removeListener("ai:usage", wrapped);
  },
  onSelectionContext: (handler) => {
    const wrapped = (_, data) => handler(data);
    ipcRenderer.on("overlay:selection-context", wrapped);
    return () => ipcRenderer.removeListener("overlay:selection-context", wrapped);
  },
  setWidth: (width) => ipcRenderer.invoke("overlay:set-width", width),
  snapToCursor: () => ipcRenderer.invoke("overlay:snap-to-cursor"),
  dragWindow: (payload) => ipcRenderer.send("window:drag", payload),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  setAppMode: (mode) => ipcRenderer.invoke("app:set-mode", mode),
  
  // Workspace integration APIs
  selectWorkspaceDir: () => ipcRenderer.invoke("workspace:select-dir"),
  selectFiles: () => ipcRenderer.invoke("dialog:open-files"),
  getWorkspaceInfo: (workspacePath) => ipcRenderer.invoke("workspace:get-info", workspacePath),
  readWorkspaceFile: (payload) => ipcRenderer.invoke("workspace:read-file", payload),
  readWorkspaceFiles: (payload) => ipcRenderer.invoke("workspace:read-files", payload),
  searchWorkspace: (payload) => ipcRenderer.invoke("workspace:search", payload),
  writeWorkspaceFile: (payload) => ipcRenderer.invoke("workspace:write-file", payload),
  deleteWorkspaceFile: (payload) => ipcRenderer.invoke("workspace:delete-file", payload),
  moveWorkspaceFile: (payload) => ipcRenderer.invoke("workspace:move-file", payload),
  createWorkspaceDir: (payload) => ipcRenderer.invoke("workspace:create-dir", payload),
  runWorkspaceCommand: (payload) => ipcRenderer.invoke("workspace:run-command", payload),
  typeIntoWindow: (payload) => ipcRenderer.invoke("desktop:type-text", payload),
  listWindows: () => ipcRenderer.invoke("desktop:list-windows"),
  transcribeAudio: (payload) => ipcRenderer.invoke("ai:transcribe", payload),
  clickPixel: (payload) => ipcRenderer.invoke("desktop:click-pixel", payload),
  scrollAt: (payload) => ipcRenderer.invoke("desktop:scroll", payload),
  keystroke: (payload) => ipcRenderer.invoke("desktop:keystroke", payload),
  focusWindow: (payload) => ipcRenderer.invoke("desktop:focus-window", payload),
  waitMs: (payload) => ipcRenderer.invoke("desktop:wait", payload),
  openBrowser: (payload) => ipcRenderer.invoke("desktop:open-browser", payload),
  openApp: (payload) => ipcRenderer.invoke("desktop:open-app", payload),
  deployAgent: (payload) => ipcRenderer.invoke("workspace:deploy-agent", payload),
  getActiveAgentsCount: () => ipcRenderer.invoke("workspace:get-active-agents-count"),
  listAgentTimeline: (workspacePath) => ipcRenderer.invoke("agent:list-timeline", { workspacePath }),
  revertAgentWrite: (workspacePath, index) => ipcRenderer.invoke("agent:revert-write", { workspacePath, index }),
  listPlugins: () => ipcRenderer.invoke("plugins:list")
});
