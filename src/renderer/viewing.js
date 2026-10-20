const $ =(id) => document.getElementById(id);
const PRINT_RESOLUTION = 150;

// ---------- Presentation ----------

// Full-screen, one page at a time. Arrow keys, Space, Page Up/Down, Home/End
// and clicks move between pages; Esc leaves.
export class Presentation {
  constructor(ctx) {
    this.ctx = ctx;
    this.overlay = $("presentation");
    this.canvas = $("presentationCanvas");
    this.hint = $("presentationHint");
    this.index = 0;
    this.onKey = (e) => this.handleKey(e);
    this.onResize = () => this.render();
    this.overlay.addEventListener("click", (e) => this.go(this.index + (e.clientX < window.innerWidth / 4 ? -1 : 1)));
    this.overlay.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.go(this.index - 1);
    });
    this.overlay.addEventListener("mousemove", () => this.showCursor());
  }

  get active() {
    return !this.overlay.hidden;
  }

  start(index) {
    const doc = this.ctx.app.doc;
    if (!doc) return;
    this.index = index;
    this.overlay.hidden = false;
    this.overlay.focus();
    window.glance.setFullScreen(true);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    this.hint.classList.remove("hidden");
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hint.classList.add("hidden"), 2500);
    // Renders now; the resize when the window goes full screen renders again.
    this.render();
  }

  stop() {
    if (!this.active) return;
    this.overlay.hidden = true;
    window.glance.setFullScreen(false);
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    this.ctx.goToPage?.(this.index);
  }

  showCursor() {
    this.overlay.classList.add("show-cursor");
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => this.overlay.classList.remove("show-cursor"), 1500);
  }

  go(index) {
    const count = this.ctx.app.doc.pageCount();
    const next = Math.max(0, Math.min(count - 1, index));
    if (next === this.index) return;
    this.index = next;
    this.render();
  }

  handleKey(e) {
    const keys = {
      ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, Enter: 1, n: 1,
      ArrowLeft: -1, ArrowUp: -1, PageUp: -1, Backspace: -1, p: -1,
    };
    if (e.key === "Escape" || e.key === "F5") this.stop();
    else if (e.key === "Home") this.go(0);
    else if (e.key === "End") this.go(this.ctx.app.doc.pageCount() - 1);
    else if (keys[e.key]) this.go(this.index + keys[e.key]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  async render() {
    const doc = this.ctx.app.doc;
    const token = (this.token = (this.token ?? 0) + 1);
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth * ratio;
    const height = window.innerHeight * ratio;
    const offscreen = document.createElement("canvas");
    if (doc.kind === "pdf") {
      const { w, h } = doc.baseSize(doc.pages[this.index]);
      await doc.drawPage(this.index, offscreen, Math.min(width / w, height / h));
    } else {
      const source = doc.composite();
      const scale = Math.min(width / source.width, height / source.height);
      offscreen.width = Math.round(source.width * scale);
      offscreen.height = Math.round(source.height * scale);
      const ctx = offscreen.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, offscreen.width, offscreen.height);
    }
    if (token !== this.token || !this.active) return;
    this.canvas.width = offscreen.width;
    this.canvas.height = offscreen.height;
    this.canvas.getContext("2d").drawImage(offscreen, 0, 0);
    this.canvas.style.width = `${offscreen.width / ratio}px`;
    this.canvas.style.height = `${offscreen.height / ratio}px`;
  }
}

// ---------- Print ----------

// Renders the chosen pages (with markup and form entries) and prints them.
// options: { indices, deviceName, copies, color, orientation: "auto" | "portrait" | "landscape" }.
// Without a deviceName the Windows print dialog is shown instead.
export async function printDocument(ctx, options = {}) {
  const { app } = ctx;
  const doc = app.doc;
  if (!doc) return;
  if (!app.permissions.print) {
    ctx.setMessage("This PDF's owner doesn't allow printing.", { error: true });
    return;
  }
  try {
    const pages = [];
    if (doc.kind === "pdf") {
      const indices = options.indices ?? doc.pages.map((_, i) => i);
      for (const [n, i] of indices.entries()) {
        ctx.setMessage(`Preparing page ${n + 1} of ${indices.length} for printing…`, { sticky: true });
        const { w, h } = doc.baseSize(doc.pages[i]);
        pages.push({ width: w, height: h, mime: "image/jpeg", bytes: await doc.renderPageImage(i, { resolution: PRINT_RESOLUTION, mime: "image/jpeg", quality: 0.92 }) });
      }
    } else {
      ctx.setMessage("Preparing for printing…", { sticky: true });
      const canvas = doc.composite();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      pages.push({ width: canvas.width * 0.75, height: canvas.height * 0.75, mime: "image/png", bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    const orientation = options.orientation ?? "auto";
    const landscape = orientation === "landscape" || (orientation === "auto" && pages.every((p) => p.width > p.height));
    ctx.setMessage(options.deviceName ? `Sending to ${options.deviceName}…` : "Opening the Windows print dialog…", { sticky: true });
    const result = await window.glance.printPages({
      title: doc.filePath.split(/[\\/]/).pop(),
      pages,
      landscape,
      deviceName: options.deviceName,
      copies: options.copies,
      color: options.color,
    });
    const count = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
    ctx.setMessage(
      result.success ? `Sent ${count} to ${options.deviceName ?? "the printer"}.` : result.reason === "cancelled" ? "" : `Printing failed: ${result.reason}`,
      { error: !result.success && result.reason !== "cancelled" },
    );
  } catch (err) {
    ctx.showError("Couldn't print", err);
  }
}
