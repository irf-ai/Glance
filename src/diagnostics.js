// Crash and problem reporting for the main process: a small log file, local
// crash dumps, recovery when a window crashes, and an automatic switch to
// software graphics when the graphics driver keeps crashing Glance.

const { app, crashReporter, dialog, shell } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_LOG_BYTES = 1024 * 1024;
let safeGraphics = false;
let errorShown = false;

const logFile = () => path.join(app.getPath("logs"), "glance.log");
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function log(message) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never be the thing that breaks Glance.
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    log(`Couldn't save settings: ${err.message}`);
  }
}

// "Windows 10.0.26200" or "macOS 14.5".
function osLabel() {
  return process.platform === "darwin" ? `macOS ${process.getSystemVersion()}` : `Windows ${os.release()}`;
}

function describe(err) {
  return err?.stack || err?.message || String(err);
}

// Call once, before the app is ready (graphics settings must be chosen early).
function setupDiagnostics() {
  crashReporter.start({ uploadToServer: false });
  safeGraphics = process.argv.includes("--safe-mode") || Boolean(readSettings().safeGraphics);
  if (safeGraphics) app.disableHardwareAcceleration();
  log(
    `Glance ${app.getVersion()} starting · Electron ${process.versions.electron} · ${osLabel()} ${process.arch}` +
      `${safeGraphics ? " · safe graphics" : ""}`,
  );

  process.on("uncaughtException", (err) => {
    log(`Unexpected error: ${describe(err)}`);
    if (!errorShown && app.isReady()) {
      errorShown = true;
      dialog.showErrorBox(
        "Glance hit an unexpected problem",
        `${err?.message ?? err}\n\nDetails were saved to:\n${logFile()}\n\nYou can keep working; if something looks wrong, restart Glance.`,
      );
    }
  });
  process.on("unhandledRejection", (reason) => log(`Unhandled rejection: ${describe(reason)}`));

  app.on("child-process-gone", (_event, details) => {
    log(`${details.type} process ended: ${details.reason} (exit code ${details.exitCode})`);
    const crashed = !["clean-exit", "killed"].includes(details.reason);
    if (details.type === "GPU" && crashed && !safeGraphics) {
      // A crashing graphics driver is the most common reason Electron apps
      // close on some PCs. Switch to software graphics and start again.
      log("Graphics process crashed; switching to safe graphics and restarting.");
      writeSettings({ ...readSettings(), safeGraphics: true });
      app.relaunch();
      app.exit(0);
    }
  });
}

// Per-window: log load failures and renderer errors, and offer to reopen the
// document if the window's process crashes.
function watchWindow(win) {
  const contents = win.webContents;
  contents.on("did-fail-load", (_event, code, description, url) => log(`Load failed (${code} ${description}): ${url}`));
  contents.on("unresponsive", () => log("Window stopped responding."));
  contents.on("console-message", (event, ...legacy) => {
    const level = event.level ?? legacy[0];
    if (level === "error" || level === 3) log(`Window error: ${event.message ?? legacy[1]}`);
  });
  contents.on("render-process-gone", (_event, details) => {
    log(`Window process ended: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "error",
      buttons: ["Reopen document", "Close window"],
      defaultId: 0,
      cancelId: 1,
      message: "This Glance window stopped unexpectedly.",
      detail: `Unexported markup in it was lost. Details were saved to:\n${logFile()}`,
    });
    if (choice === 0) {
      win.glance.pendingFile = win.glance.document;
      win.glance.document = null;
      win.glance.dirty = false;
      contents.reload();
    } else {
      win.glance.dirty = false;
      win.destroy();
    }
  });
}

function openLogFolder() {
  fs.mkdirSync(app.getPath("logs"), { recursive: true });
  shell.openPath(app.getPath("logs"));
}

function isSafeGraphics() {
  return safeGraphics;
}

// Turns safe graphics on or off and restarts Glance.
function restartWithSafeGraphics(on) {
  writeSettings({ ...readSettings(), safeGraphics: on });
  log(`Restarting with ${on ? "safe" : "normal"} graphics.`);
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== "--safe-mode") });
  app.exit(0);
}

function showAbout(win) {
  dialog.showMessageBox(win, {
    type: "info",
    title: "About Glance",
    message: `Glance ${app.getVersion()}`,
    detail: [
      "View, mark up and convert PDFs and images.",
      "",
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node.js ${process.versions.node}`,
      `${osLabel()} (${process.arch})`,
      `Graphics: ${safeGraphics ? "safe (software)" : "hardware accelerated"}`,
      `Log: ${logFile()}`,
    ].join("\n"),
  });
}

module.exports = { log, setupDiagnostics, watchWindow, openLogFolder, isSafeGraphics, restartWithSafeGraphics, showAbout };
