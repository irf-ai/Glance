import * as PDFLib from "app://glance/pdf-lib/pdf-lib.esm.js";
import { cloneAnnotations, drawAnnotationsToCanvas, transformAnnotations } from "./annotations.js";
import { startDrag } from "./dnd.js";
import { buildDocx } from "./docx.js";
import { MarkupLayer } from "./markup.js";
import { scrollWithin } from "./scroll.js";

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.className = "base";
  return canvas;
}

async function canvasToBytes(canvas, mime, quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error("This image is too large to encode.");
  return new Uint8Array(await blob.arrayBuffer());
}

export class ImageDocument {
  kind = "image";

  constructor(filePath, canvas) {
    this.filePath = filePath;
    this.pages = [{ canvas, annotations: [] }];
    this.layers = [];
    this.thumbUrls = [];
  }

  static async load(filePath, bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = makeCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    return new ImageDocument(filePath, canvas);
  }

  get record() {
    return this.pages[0];
  }

  baseSize(record = this.record) {
    return { w: record.canvas.width, h: record.canvas.height };
  }

  mount(viewer, app) {
    this.viewer = viewer;
    this.app = app;
    viewer.replaceChildren();
    viewer.classList.add("single");
    this.pageEl = document.createElement("div");
    this.pageEl.className = "page image-page";
    this.pageEl.append(this.record.canvas);
    viewer.append(this.pageEl);
    this.layers = [new MarkupLayer({ pageEl: this.pageEl, record: this.record, baseSize: this.baseSize(), app })];
  }

  layout(zoom) {
    const { w, h } = this.baseSize();
    this.pageEl.style.width = `${w * zoom}px`;
    this.pageEl.style.height = `${h * zoom}px`;
    this.pageEl.classList.toggle("pixelated", zoom >= 3);
    this.layers[0].updateSize(this.baseSize());
  }

  fitZoom(width, height) {
    const { w, h } = this.baseSize();
    return Math.min(1, width / w, height / h);
  }

  currentIndex() {
    return 0;
  }

  pageCount() {
    return 1;
  }

  describe() {
    const { w, h } = this.baseSize();
    return `${w} × ${h} px`;
  }

  snapshot() {
    return { canvas: this.record.canvas, annotations: cloneAnnotations(this.record.annotations) };
  }

  // Returns true when the page itself changed and the view must be rebuilt.
  restore(snapshot) {
    const structural = snapshot.canvas !== this.record.canvas;
    this.record.canvas = snapshot.canvas;
    this.record.annotations = cloneAnnotations(snapshot.annotations);
    return structural;
  }

  replaceCanvas(canvas, mapPoint, scale = 1) {
    transformAnnotations(this.record.annotations, mapPoint, scale);
    this.record.canvas = canvas;
  }

  rotate(direction) {
    const { w, h } = this.baseSize();
    const canvas = makeCanvas(h, w);
    const ctx = canvas.getContext("2d");
    ctx.translate(h / 2, w / 2);
    ctx.rotate((direction * Math.PI) / 2);
    ctx.drawImage(this.record.canvas, -w / 2, -h / 2);
    this.replaceCanvas(canvas, direction > 0 ? (x, y) => [h - y, x] : (x, y) => [y, w - x]);
  }

  flip(axis) {
    const { w, h } = this.baseSize();
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (axis === "h") ctx.setTransform(-1, 0, 0, 1, w, 0);
    else ctx.setTransform(1, 0, 0, -1, 0, h);
    ctx.drawImage(this.record.canvas, 0, 0);
    this.replaceCanvas(canvas, axis === "h" ? (x, y) => [w - x, y] : (x, y) => [x, h - y]);
  }

  crop(rect) {
    const canvas = makeCanvas(rect.w, rect.h);
    canvas.getContext("2d").drawImage(this.record.canvas, -rect.x, -rect.y);
    this.replaceCanvas(canvas, (x, y) => [x - rect.x, y - rect.y]);
  }

  resize(width, height) {
    const { w, h } = this.baseSize();
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.record.canvas, 0, 0, canvas.width, canvas.height);
    const sx = canvas.width / w;
    const sy = canvas.height / h;
    this.replaceCanvas(canvas, (x, y) => [x * sx, y * sy], (sx + sy) / 2);
  }

  composite(background = null) {
    const { w, h } = this.baseSize();
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(this.record.canvas, 0, 0);
    drawAnnotationsToCanvas(ctx, this.record.annotations);
    return canvas;
  }

  exportFormats() {
    return [
      { id: "png", label: "PNG", ext: "png", quality: false, saves: true },
      { id: "jpeg", label: "JPEG", ext: "jpg", quality: true, saves: true },
      { id: "webp", label: "WebP", ext: "webp", quality: true, saves: true },
      { id: "pdf", label: "PDF", ext: "pdf", quality: false, saves: true },
      { id: "docx", label: "Word document (.docx)", ext: "docx", quality: false, saves: false },
    ];
  }

  async export(format, quality) {
    if (format === "docx") {
      const canvas = this.composite();
      const bytes = await canvasToBytes(canvas, MIME.png);
      // The page fits the picture (96 dpi), within Word's 22-inch page limit.
      const scale = Math.min(0.75, 1584 / Math.max(canvas.width, canvas.height));
      const size = { w: canvas.width * scale + 108, h: canvas.height * scale + 108 };
      return buildDocx({
        pages: [{ blocks: [], image: { bytes, mime: "image/png", widthPt: canvas.width * scale, heightPt: canvas.height * scale } }],
        pageSize: size,
        title: this.filePath.split(/[\\/]/).pop(),
      });
    }
    if (format === "pdf") {
      const pdf = await PDFLib.PDFDocument.create();
      const png = await pdf.embedPng(await canvasToBytes(this.composite(), MIME.png));
      // 96 dpi screen pixels → 72 dpi PDF points.
      const page = pdf.addPage([png.width * 0.75, png.height * 0.75]);
      page.drawImage(png, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      return pdf.save();
    }
    const canvas = this.composite(format === "jpeg" ? "#ffffff" : null);
    return canvasToBytes(canvas, MIME[format], quality);
  }

  async renderSidebar(container) {
    this.sidebarObserver?.disconnect();
    container.replaceChildren();
    const siblings = await window.glance.listSiblings(this.filePath);
    if (!siblings.length) siblings.push(this.filePath);
    this.sidebarObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.sidebarObserver.unobserve(entry.target);
          this.loadThumb(entry.target);
        }
      },
      { root: container, rootMargin: "300px 0px" },
    );
    for (const filePath of siblings) {
      const item = document.createElement("button");
      item.className = "thumb";
      item.dataset.path = filePath;
      item.title = filePath;
      item.classList.toggle("current", filePath === this.filePath);
      const frame = document.createElement("div");
      frame.className = "thumb-frame";
      const label = document.createElement("span");
      label.className = "thumb-label";
      label.textContent = filePath.split(/[\\/]/).pop();
      item.append(frame, label);
      item.addEventListener("click", () => {
        if (filePath !== this.filePath) this.app.openPath(filePath);
      });
      // Drag into a PDF window's page list or a Combine list. The open image
      // brings its markup; the others come straight from disk.
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        const spec = filePath === this.filePath ? { kind: "image" } : { kind: "file", path: filePath };
        startDrag(e, spec, filePath.split(/[\\/]/).pop());
      });
      container.append(item);
      this.sidebarObserver.observe(item);
    }
    const current = container.querySelector(".current");
    if (current) scrollWithin(container, current, "center");
    this.siblings = siblings;
  }

  async loadThumb(item) {
    const frame = item.querySelector(".thumb-frame");
    try {
      let source;
      if (item.dataset.path === this.filePath) {
        source = this.record.canvas;
      } else {
        const bytes = await window.glance.readFile(item.dataset.path);
        source = await createImageBitmap(new Blob([bytes]));
      }
      const scale = Math.min(140 / source.width, 110 / source.height, 1);
      const canvas = makeCanvas(source.width * scale, source.height * scale);
      canvas.className = "thumb-canvas";
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "medium";
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      source.close?.();
      frame.replaceChildren(canvas);
    } catch {
      frame.textContent = "Can't preview";
    }
  }

  // Neighbouring images in the same folder, for arrow-key browsing.
  neighbour(step) {
    if (!this.siblings) return null;
    const index = this.siblings.indexOf(this.filePath);
    return this.siblings[index + step] ?? null;
  }

  destroy() {
    this.sidebarObserver?.disconnect();
    this.viewer?.classList.remove("single");
  }
}
