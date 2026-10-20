const { app, BrowserWindow, ClipboardItem, Menu, clipboard, dialog, ipcMain, nativeImage, net, protocol, webContents } = require("electron");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const diagnostics = require("./diagnostics");

const APP_ROOT = path.join(__dirname, "..");
// Only these folders are reachable through the app:// scheme.
const SERVED_ROOTS = [
  path.join(APP_ROOT, "src", "renderer"),
  path.join(APP_ROOT, "node_modules", "pdfjs-dist"),
  path.join(APP_ROOT, "node_modules", "pdf-lib", "dist"),
  path.join(APP_ROOT, "node_modules", "@cantoo", "pdf-lib", "dist"),
];

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DRAG_TIMEOUT_MS = 60_000;
const dragSources = new Map(); // token → webContents id of the window the drag started in
const pendingRequests = new Map(); // requestId → { resolve, reject, timer }

function requestFrom(source, request) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("The other window didn't respond."));
    }, DRAG_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, reject, timer });
    source.send("drag:request", { requestId, token: request.token ?? null, whole: Boolean(request.windowId !== undefined) });
  });
}
const IMAGE_EXTENSIONS =[".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".avif", ".ico"];
const SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ".pdf"];
const OPEN_FILTERS = [
  { name: "PDFs and images", extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)) },
  { name: "PDF documents", extensions: ["pdf"] },
  { name: "Images", extensions: IMAGE_EXTENSIONS.map((ext) => ext.slice(1)) },
];

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function isSupported(filePath) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function fileFromArgs(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith("-") && isSupported(arg)) ?? null;
}

function resolveServedPath(url) {
  const { pathname } = new URL(url);
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const [first, ...rest] = relative.split("/");
  let candidate;
  if (first === "pdfjs") candidate = path.join(SERVED_ROOTS[1], ...rest);
  else if (first === "pdf-lib") candidate = path.join(SERVED_ROOTS[2], ...rest);
  else if (first === "pdf-crypto") candidate = path.join(SERVED_ROOTS[3], ...rest);
  else candidate = path.join(SERVED_ROOTS[0], relative);
  const normalized = path.normalize(candidate);
  return SERVED_ROOTS.some((root) => normalized.startsWith(root + path.sep)) ? normalized : null;
}

function createWindow(filePath = null) {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    title: "Glance",
    backgroundColor: "#1e1e1e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.glance = { pendingFile: filePath, document: null, dirty: false, savePaths: new Set(), saveFolders: new Set() };
  win.once("ready-to-show", () => win.show());
  // The window title tracks the open document, not the page's <title>.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.loadURL("app://glance/index.html");

  win.on("close", (event) => {
    if (!win.glance.dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Discard changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Close without saving?",
      detail: "Your markup and edits since the last export will be lost.",
    });
    if (choice === 1) event.preventDefault();
  });

  const contentsId = win.webContents.id;
  win.webContents.on("destroyed", () => {
    for (const [token, id] of dragSources) if (id === contentsId) dragSources.delete(token);
  });

  diagnostics.watchWindow(win);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  return win;
}

// Open in the focused window when it is empty, otherwise in a new window.
function openFile(filePath) {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (target && !target.glance.document) {
    target.glance.document = filePath;
    target.webContents.send("open-file", filePath);
    target.focus();
  } else {
    createWindow(filePath);
  }
}

async function showOpenDialog(win, kind = "any") {
  const filters = kind === "pdf" ? [OPEN_FILTERS[1]] : kind === "images" ? [OPEN_FILTERS[2]] : OPEN_FILTERS;
  const result = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters });
  return result.canceled ? [] : result.filePaths;
}

function sendMenu(action) {
  return () => BrowserWindow.getFocusedWindow()?.webContents.send("menu", action);
}

function buildMenu() {
  const template = [
    {
      label: "&File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const paths = await showOpenDialog(BrowserWindow.getFocusedWindow());
            paths.forEach(openFile);
          },
        },
        { type: "separator" },
        { label: "Combine Files into PDF…", accelerator: "CmdOrCtrl+Shift+M", click: sendMenu("combine") },
        { type: "separator" },
        { label: "Export…", accelerator: "CmdOrCtrl+Shift+S", click: sendMenu("export") },
        { label: "Insert Pages from PDF…", click: sendMenu("insert-pdf") },
        { label: "Protect with Password…", click: sendMenu("protect") },
        { type: "separator" },
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: sendMenu("print") },
        { label: "Document Properties…", accelerator: "CmdOrCtrl+D", click: sendMenu("properties") },
        { type: "separator" },
        { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        { role: "quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: sendMenu("undo") },
        { label: "Redo", accelerator: "CmdOrCtrl+Y", click: sendMenu("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Copy Page as Image", accelerator: "CmdOrCtrl+Shift+C", click: sendMenu("copy-page") },
        { type: "separator" },
        { label: "Find…", accelerator: "CmdOrCtrl+F", click: sendMenu("find") },
        { label: "Go to Page…", accelerator: "CmdOrCtrl+G", click: sendMenu("go-to-page") },
      ],
    },
    {
      label: "&View",
      submenu: [
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+Alt+S", click: sendMenu("toggle-sidebar") },
        { label: "Show Markup Toolbar", accelerator: "CmdOrCtrl+Shift+A", click: sendMenu("toggle-markup") },
        { type: "separator" },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: sendMenu("zoom-in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: sendMenu("zoom-out") },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: sendMenu("zoom-actual") },
        { label: "Zoom to Fit", accelerator: "CmdOrCtrl+9", click: sendMenu("zoom-fit") },
        { type: "separator" },
        { label: "Single Page", accelerator: "CmdOrCtrl+1", click: sendMenu("view-single") },
        { label: "Two Pages", accelerator: "CmdOrCtrl+2", click: sendMenu("view-spread") },
        { label: "Dark Pages", accelerator: "CmdOrCtrl+Shift+D", click: sendMenu("dark-pages") },
        { label: "Presentation", accelerator: "F5", click: sendMenu("presentation") },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "&Help",
      submenu: [
        { label: "Keyboard Shortcuts", accelerator: "F1", click: sendMenu("shortcuts") },
        { type: "separator" },
        { label: "Open Log Folder", click: () => diagnostics.openLogFolder() },
        {
          label: diagnostics.isSafeGraphics() ? "Restart with Normal Graphics" : "Restart with Safe Graphics",
          click: () => diagnostics.restartWithSafeGraphics(!diagnostics.isSafeGraphics()),
        },
        { type: "separator" },
        { label: "About Glance", click: () => diagnostics.showAbout(BrowserWindow.getFocusedWindow()) },
      ],
    },
    {
      label: "&Tools",
      submenu: [
        { label: "Rotate Left", accelerator: "CmdOrCtrl+L", click: sendMenu("rotate-left") },
        { label: "Rotate Right", accelerator: "CmdOrCtrl+R", click: sendMenu("rotate-right") },
        { label: "Flip Horizontal", click: sendMenu("flip-h") },
        { label: "Flip Vertical", click: sendMenu("flip-v") },
        { type: "separator" },
        { label: "Adjust Size…", click: sendMenu("resize") },
        { label: "Crop to Selection", accelerator: "CmdOrCtrl+K", click: sendMenu("crop") },
        { type: "separator" },
        { label: "Add Signature…", click: sendMenu("signature") },
        { label: "Add Image…", click: sendMenu("add-image") },
        { type: "separator" },
        { label: "Split PDF…", click: sendMenu("split") },
        { label: "Compress PDF…", click: sendMenu("compress") },
        { label: "Compare with Another PDF…", click: sendMenu("compare") },
        { label: "Export All Pages as Images…", click: sendMenu("export-pages") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle("file:open-dialog", (event, kind = "any") => showOpenDialog(windowOf(event), kind));

  // Any file the user picks, to embed as a PDF attachment.
  ipcMain.handle("file:pick-attachment", async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), { properties: ["openFile", "multiSelections"] });
    if (result.canceled) return [];
    const files = [];
    for (const filePath of result.filePaths) {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(filePath)} is larger than 100 MB.`);
      files.push({ name: path.basename(filePath), bytes: new Uint8Array(await fs.readFile(filePath)), modified: stat.mtime });
    }
    return files;
  });

  ipcMain.handle("app:info", () => ({ username: os.userInfo().username, version: app.getVersion() }));

  ipcMain.on("app:set-fullscreen", (event, on) => windowOf(event)?.setFullScreen(Boolean(on)));

  // Prints pre-rendered page images through the Windows print dialog.
  ipcMain.handle("print:printers", async (event) => {
    const printers = await event.sender.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: Boolean(p.isDefault) }));
  });

  // Prints pre-rendered page images. With a deviceName it prints straight to that
  // printer (Glance's own print dialog already asked); otherwise it shows the
  // Windows print dialog, owned by the Glance window so it opens in front of it.
  ipcMain.handle("print:pages", async (event, { title, pages, landscape, deviceName, copies = 1, color = true }) => {
    const owner = windowOf(event);
    const dir = await fs.mkdtemp(path.join(app.getPath("temp"), "glance-print-"));
    const printWin = new BrowserWindow({
      show: false,
      parent: owner ?? undefined,
      title: String(title),
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
    });
    try {
      const images = [];
      for (const [i, page] of pages.entries()) {
        const name = `page-${i + 1}.${page.mime === "image/png" ? "png" : "jpg"}`;
        await fs.writeFile(path.join(dir, name), Buffer.from(page.bytes));
        images.push(`<img src="${name}" alt="">`);
      }
      const safeTitle = String(title).replace(/[<>&"]/g, "");
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>@page{margin:0}html,body{margin:0;padding:0}img{display:block;width:100vw;height:100vh;object-fit:contain;break-after:page}img:last-child{break-after:auto}</style>
</head><body>${images.join("")}</body></html>`;
      await fs.writeFile(path.join(dir, "print.html"), html);
      await printWin.loadFile(path.join(dir, "print.html"));
      const options = { printBackground: true, landscape: Boolean(landscape), margins: { marginType: "none" } };
      if (deviceName) Object.assign(options, { silent: true, deviceName, copies: Math.max(1, Math.min(99, copies | 0)), color: Boolean(color) });
      else options.silent = false;
      return await new Promise((resolve) => printWin.webContents.print(options, (success, reason) => resolve({ success, reason })));
    } finally {
      printWin.destroy();
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle("file:choose-folder", async (event) => {
    const win = windowOf(event);
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    win.glance.saveFolders.add(result.filePaths[0]);
    return result.filePaths[0];
  });

  // Writes a new file into a folder the user picked; never overwrites.
  ipcMain.handle("file:write-in-folder", async (event, folder, name, bytes) => {
    const win = windowOf(event);
    if (!win.glance.saveFolders.has(folder)) throw new Error("Folder was not chosen in a folder dialog.");
    if (typeof name !== "string" || name !== path.basename(name) || name.startsWith(".")) throw new Error("Invalid file name.");
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 0; n < 1000; n++) {
      const candidate = path.join(folder, n ? `${stem} (${n})${ext}` : name);
      try {
        await fs.writeFile(candidate, Buffer.from(bytes), { flag: "wx" });
        return candidate;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
    throw new Error("Too many files with the same name.");
  });

  ipcMain.handle("file:read", async (_event, filePath) => {
    if (typeof filePath !== "string" || !isSupported(filePath)) throw new Error("Unsupported file type.");
    return new Uint8Array(await fs.readFile(filePath));
  });

  ipcMain.handle("file:siblings", async (_event, filePath) => {
    if (typeof filePath !== "string") return [];
    const dir = path.dirname(filePath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
      .map((name) => path.join(dir, name));
  });

  ipcMain.handle("file:save-dialog", async (event, { defaultPath, filters }) => {
    const win = windowOf(event);
    const result = await dialog.showSaveDialog(win, { defaultPath, filters });
    if (result.canceled || !result.filePath) return null;
    win.glance.savePaths.add(result.filePath);
    return result.filePath;
  });

  // Writes are limited to paths the user picked in a save dialog for this window.
  ipcMain.handle("file:write", async (event, filePath, bytes) => {
    const win = windowOf(event);
    if (!win.glance.savePaths.has(filePath)) throw new Error("Path was not chosen in a save dialog.");
    await fs.writeFile(filePath, Buffer.from(bytes));
    return filePath;
  });

  ipcMain.on("app:open-window", (_event, filePath) => {
    if (typeof filePath === "string" && isSupported(filePath)) createWindow(filePath);
  });

  // ---- Clipboard images ----

  // Electron 44's clipboard follows the W3C async API: ClipboardItem + Blob.
  ipcMain.handle("clipboard:write-image", async (_event, pngBytes) => {
    if (nativeImage.createFromBuffer(Buffer.from(pngBytes)).isEmpty()) throw new Error("Couldn't copy the image.");
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([pngBytes], { type: "image/png" }) })]);
  });

  ipcMain.handle("clipboard:read-image", async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) return new Uint8Array(await (await item.getType(type)).arrayBuffer());
    }
    return null;
  });

  // ---- Dragging pages and documents between windows ----
  // A drag carries only a token. The window it is dropped on asks the source
  // window, through here, for the actual bytes (with that window's markup).

  ipcMain.on("drag:register", (event, token) => {
    if (typeof token === "string" && token.length <= 64) dragSources.set(token, event.sender.id);
  });

  ipcMain.handle("drag:fetch", (_event, request) => {
    const sourceId = request.windowId ?? dragSources.get(request.token);
    const source = sourceId === undefined ? null : webContents.fromId(sourceId);
    if (!source || source.isDestroyed()) throw new Error("The window it came from has been closed.");
    return requestFrom(source, request);
  });

  ipcMain.on("drag:response", (_event, { requestId, result, error }) => {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result);
  });

  // Other windows' open documents, for Combine's "Add open documents".
  ipcMain.handle("app:open-documents", (event) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.webContents !== event.sender && win.glance?.document)
      .map((win) => ({ windowId: win.webContents.id, name: path.basename(win.glance.document), path: win.glance.document })),
  );

  ipcMain.handle("app:initial-file", (event) => {
    const win = windowOf(event);
    const pending = win.glance.pendingFile;
    win.glance.pendingFile = null;
    return pending;
  });

  ipcMain.handle("app:confirm-discard", (event) => {
    const choice = dialog.showMessageBoxSync(windowOf(event), {
      type: "warning",
      buttons: ["Discard changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Discard unsaved changes?",
      detail: "Export first if you want to keep your markup and edits.",
    });
    return choice === 0;
  });

  ipcMain.on("doc:opened", (event, filePath) => {
    const win = windowOf(event);
    win.glance.document = filePath;
    win.setTitle(filePath ? `${path.basename(filePath)} — Glance` : "Glance");
    if (filePath) app.addRecentDocument(filePath);
  });

  ipcMain.on("doc:dirty", (event, dirty) => {
    const win = windowOf(event);
    win.glance.dirty = Boolean(dirty);
    const name = win.glance.document ? path.basename(win.glance.document) : "Glance";
    win.setTitle(`${dirty ? "• " : ""}${name}${win.glance.document ? " — Glance" : ""}`);
  });
}

// Development runs keep their own profile, so they don't hand off to an installed Glance.
if (!app.isPackaged) app.setPath("userData", `${app.getPath("userData")}-dev`);
diagnostics.setupDiagnostics();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const filePath = fileFromArgs(argv);
    if (filePath) openFile(filePath);
    else BrowserWindow.getAllWindows()[0]?.focus();
  });

  app.whenReady().then(() => {
    protocol.handle("app", (request) => {
      const filePath = resolveServedPath(request.url);
      if (!filePath) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    });
    registerIpc();
    buildMenu();
    createWindow(fileFromArgs(process.argv));
  });

  app.on("window-all-closed", () => app.quit());
}
