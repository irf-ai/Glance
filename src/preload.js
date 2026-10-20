const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("glance", {
  openDialog: (kind) => ipcRenderer.invoke("file:open-dialog", kind),
  chooseFolder: () => ipcRenderer.invoke("file:choose-folder"),
  pickAttachments: () => ipcRenderer.invoke("file:pick-attachment"),
  appInfo: () => ipcRenderer.invoke("app:info"),
  setFullScreen: (on) => ipcRenderer.send("app:set-fullscreen", on),
  printPages: (job) => ipcRenderer.invoke("print:pages", job),
  printers: () => ipcRenderer.invoke("print:printers"),
  writeClipboardImage: (pngBytes) => ipcRenderer.invoke("clipboard:write-image", pngBytes),
  readClipboardImage: () => ipcRenderer.invoke("clipboard:read-image"),
  registerDrag: (token) => ipcRenderer.send("drag:register", token),
  fetchDrag: (request) => ipcRenderer.invoke("drag:fetch", request),
  openDocuments: () => ipcRenderer.invoke("app:open-documents"),
  onDragRequest: (handler) =>
    ipcRenderer.on("drag:request", async (_event, request) => {
      try {
        ipcRenderer.send("drag:response", { requestId: request.requestId, result: await handler(request) });
      } catch (err) {
        ipcRenderer.send("drag:response", { requestId: request.requestId, error: err?.message ?? String(err) });
      }
    }),
  writeInFolder: (folder, name, bytes) => ipcRenderer.invoke("file:write-in-folder", folder, name, bytes),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  listSiblings: (filePath) => ipcRenderer.invoke("file:siblings", filePath),
  saveDialog: (options) => ipcRenderer.invoke("file:save-dialog", options),
  writeFile: (filePath, bytes) => ipcRenderer.invoke("file:write", filePath, bytes),
  initialFile: () => ipcRenderer.invoke("app:initial-file"),
  openInNewWindow: (filePath) => ipcRenderer.send("app:open-window", filePath),
  confirmDiscard: () => ipcRenderer.invoke("app:confirm-discard"),
  setDocument: (filePath) => ipcRenderer.send("doc:opened", filePath),
  setDirty: (dirty) => ipcRenderer.send("doc:dirty", dirty),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenu: (callback) => ipcRenderer.on("menu", (_event, action) => callback(action)),
  onOpenFile: (callback) => ipcRenderer.on("open-file", (_event, filePath) => callback(filePath)),
});
