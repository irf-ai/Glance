import {
  FONT_STACK,
  LINE_HEIGHT,
  RESIZABLE_TYPES,
  annotationToSvg,
  isTooSmall,
  newId,
  translateAnnotation,
} from "./annotations.js";
import { icon } from "./icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const DRAW_TOOLS = new Set([
  "highlight", "rect", "ellipse", "line", "arrow", "pen", "text", "crop",
  "note", "check", "cross", "dot", "date",
]);
// Tools that place something with a single click instead of a drag.
const STAMP_TOOLS = new Set(["check", "cross", "dot", "date"]);
const MARK_SCREEN_PX = 18;

const formatDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// One MarkupLayer sits on top of each page and edits that page record's annotations.
export class MarkupLayer {
  constructor({ pageEl, record, baseSize, app }) {
    this.pageEl = pageEl;
    this.record = record;
    this.baseSize = baseSize;
    this.app = app;
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("markup");
    this.svg.setAttribute("preserveAspectRatio", "none");
    pageEl.append(this.svg);
    this.draft = null;
    this.drag = null;
    this.editing = null;
    this.note = null;
    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.svg.addEventListener("pointercancel", () => this.cancel());
    this.svg.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    this.updateSize(baseSize);
  }

  updateSize(baseSize) {
    this.baseSize = baseSize;
    this.svg.setAttribute("viewBox", `0 0 ${baseSize.w} ${baseSize.h}`);
    this.render();
  }

  get scale() {
    return this.pageEl.clientWidth / this.baseSize.w || 1;
  }

  updateMode() {
    this.svg.classList.toggle("drawing", DRAW_TOOLS.has(this.app.tool));
    this.svg.dataset.tool = this.app.tool;
  }

  toBase(e) {
    const rect = this.svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * this.baseSize.w) / rect.width;
    const y = ((e.clientY - rect.top) * this.baseSize.h) / rect.height;
    return [Math.max(0, Math.min(this.baseSize.w, x)), Math.max(0, Math.min(this.baseSize.h, y))];
  }

  render() {
    this.updateMode();
    this.svg.replaceChildren();
    const selectedId = this.app.selection?.layer === this ? this.app.selection.id : null;
    const scale = this.scale;
    for (const a of this.record.annotations) {
      if (this.editing?.annotation === a) continue;
      const g = annotationToSvg(a, scale);
      this.svg.append(g);
      if (a.id === selectedId) {
        this.svg.append(this.selectionOutline(g));
        if (RESIZABLE_TYPES.has(a.type)) this.svg.append(this.resizeHandle(a));
      }
    }
    if (this.draft) this.svg.append(annotationToSvg(this.draft, scale));
    const crop = this.app.crop?.layer === this ? this.app.crop.rect : null;
    if (crop) this.svg.append(...this.cropOverlay(crop));
    this.positionNote();
  }

  selectionOutline(g) {
    const box = g.getBBox();
    const pad = 4 / this.scale;
    const rect = document.createElementNS(SVG_NS, "rect");
    Object.entries({
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2,
      class: "selection-outline",
      "stroke-width": 1.5 / this.scale,
      "stroke-dasharray": `${4 / this.scale} ${3 / this.scale}`,
    }).forEach(([k, v]) => rect.setAttribute(k, v));
    return rect;
  }

  // Bottom-right handle that scales a picture while keeping its proportions.
  resizeHandle(annotation) {
    const [, [x2, y2]] = annotation.points;
    const size = 10 / this.scale;
    const handle = document.createElementNS(SVG_NS, "rect");
    Object.entries({
      x: x2 - size / 2,
      y: y2 - size / 2,
      width: size,
      height: size,
      class: "resize-handle",
      "data-handle": annotation.id,
      "stroke-width": 1.5 / this.scale,
    }).forEach(([k, v]) => handle.setAttribute(k, v));
    return handle;
  }

  cropOverlay(rect) {
    const { w, h } = this.baseSize;
    const shade = document.createElementNS(SVG_NS, "path");
    shade.setAttribute("d", `M0,0 H${w} V${h} H0 Z M${rect.x},${rect.y} v${rect.h} h${rect.w} v${-rect.h} Z`);
    shade.setAttribute("fill-rule", "evenodd");
    shade.setAttribute("class", "crop-shade");
    const border = document.createElementNS(SVG_NS, "rect");
    Object.entries({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      class: "crop-border",
      "stroke-width": 1.5 / this.scale,
      "stroke-dasharray": `${6 / this.scale} ${4 / this.scale}`,
    }).forEach(([k, v]) => border.setAttribute(k, v));
    return [shade, border];
  }

  find(id) {
    return this.record.annotations.find((a) => a.id === id);
  }

  onPointerDown(e) {
    if (e.button !== 0 || this.editing) return;
    const tool = this.app.tool;
    const point = this.toBase(e);

    if (!DRAW_TOOLS.has(tool) && e.target.dataset.handle) {
      e.preventDefault();
      const annotation = this.find(e.target.dataset.handle);
      const [[x1, y1], [x2, y2]] = annotation.points;
      this.drag = { id: annotation.id, resize: { x1, y1, aspect: (x2 - x1) / (y2 - y1 || 1) }, moved: false };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }

    if (!DRAW_TOOLS.has(tool)) {
      const g = e.target.closest("[data-id]");
      if (!g) return;
      e.preventDefault();
      this.app.select(this, g.dataset.id);
      this.drag = { id: g.dataset.id, last: point, moved: false };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }

    e.preventDefault();
    this.app.select(null);
    if (tool === "text") {
      const annotation = {
        id: newId(),
        type: "text",
        points: [point],
        text: "",
        color: this.app.color,
        width: 1,
        fontSize: this.app.fontSize,
      };
      this.app.beginChange();
      this.record.annotations.push(annotation);
      this.startTextEdit(annotation, true);
      return;
    }
    if (tool === "note") {
      // Keep the viewer's "click elsewhere closes notes" handler away from the new note.
      e.stopPropagation();
      const now = new Date().toISOString();
      const note = {
        id: newId(),
        type: "note",
        points: [point],
        text: "",
        color: this.app.noteColor,
        width: 1,
        author: this.app.userName,
        created: now,
        modified: now,
      };
      this.app.beginChange();
      this.record.annotations.push(note);
      this.app.select(this, note.id);
      this.openNote(note, true);
      return;
    }
    if (STAMP_TOOLS.has(tool)) {
      this.placeMark(tool, point);
      return;
    }
    if (tool === "crop") {
      this.app.setCrop(this, { x: point[0], y: point[1], w: 0, h: 0 });
      this.drag = { crop: point };
    } else {
      this.draft = {
        id: newId(),
        type: tool,
        points: tool === "pen" ? [point] : [point, point],
        color: tool === "highlight" ? this.app.highlightColor : this.app.color,
        // Stroke width is chosen in screen pixels; store it in base units.
        width: this.app.strokeWidth / this.scale,
      };
    }
    this.svg.setPointerCapture(e.pointerId);
    this.render();
  }

  onPointerMove(e) {
    if (!this.draft && !this.drag) return;
    let point = this.toBase(e);
    if (this.drag?.crop) {
      const [x0, y0] = this.drag.crop;
      this.app.setCrop(this, {
        x: Math.round(Math.min(x0, point[0])),
        y: Math.round(Math.min(y0, point[1])),
        w: Math.round(Math.abs(point[0] - x0)),
        h: Math.round(Math.abs(point[1] - y0)),
      });
      return;
    }
    if (this.drag) {
      const annotation = this.find(this.drag.id);
      if (!annotation) return;
      if (!this.drag.moved) {
        this.app.beginChange();
        this.drag.moved = true;
      }
      if (this.drag.resize) {
        const { x1, y1, aspect } = this.drag.resize;
        const width = Math.max(8 / this.scale, point[0] - x1, (point[1] - y1) * aspect);
        annotation.points = [[x1, y1], [x1 + width, y1 + width / aspect]];
      } else {
        translateAnnotation(annotation, point[0] - this.drag.last[0], point[1] - this.drag.last[1]);
        this.drag.last = point;
      }
      this.render();
      return;
    }
    if (this.draft.type === "pen") {
      const last = this.draft.points.at(-1);
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) * this.scale < 1.5) return;
      this.draft.points.push(point);
    } else {
      if (e.shiftKey) point = this.constrain(this.draft.points[0], point, this.draft.type);
      this.draft.points[1] = point;
    }
    this.render();
  }

  // Shift keeps lines at 45° steps and shapes square.
  constrain([x0, y0], [x, y], type) {
    const dx = x - x0;
    const dy = y - y0;
    if (type === "line" || type === "arrow") {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(dx, dy);
      return [x0 + length * Math.cos(angle), y0 + length * Math.sin(angle)];
    }
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + Math.sign(dx || 1) * size, y0 + Math.sign(dy || 1) * size];
  }

  onPointerUp(e) {
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    if (this.drag) {
      const { moved, crop, id, resize } = this.drag;
      this.drag = null;
      if (moved) this.app.changed();
      const clicked = !moved && !crop && !resize && this.find(id);
      if (clicked?.type === "note") this.openNote(clicked, false);
      if (crop && this.app.crop?.rect && Math.min(this.app.crop.rect.w, this.app.crop.rect.h) < 2) this.app.setCrop(null);
      return;
    }
    if (!this.draft) return;
    const draft = this.draft;
    this.draft = null;
    if (!isTooSmall(draft)) {
      this.app.beginChange();
      this.record.annotations.push(draft);
      this.app.changed();
    }
    this.render();
  }

  cancel() {
    this.draft = null;
    this.drag = null;
    this.render();
  }

  onDoubleClick(e) {
    const g = e.target.closest("[data-id]");
    const annotation = g && this.find(g.dataset.id);
    if (annotation?.type === "text") {
      this.app.beginChange();
      this.startTextEdit(annotation, false);
    }
  }

  startTextEdit(annotation, isNew) {
    const scale = this.scale;
    const box = document.createElement("textarea");
    box.className = "text-editor";
    box.value = annotation.text;
    box.spellcheck = true;
    Object.assign(box.style, {
      left: `${annotation.points[0][0] * scale}px`,
      top: `${annotation.points[0][1] * scale}px`,
      fontSize: `${annotation.fontSize * scale}px`,
      lineHeight: String(LINE_HEIGHT),
      fontFamily: FONT_STACK,
      color: annotation.color,
    });
    const autosize = () => {
      box.style.height = "auto";
      box.style.width = "auto";
      box.style.height = `${box.scrollHeight + 2}px`;
      box.style.width = `${Math.max(box.scrollWidth + 8, 60)}px`;
    };
    box.addEventListener("input", () => {
      annotation.text = box.value;
      autosize();
    });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) box.blur();
    });
    box.addEventListener("pointerdown", (e) => e.stopPropagation());
    box.addEventListener("blur", () => {
      this.editing = null;
      box.remove();
      if (!annotation.text.trim()) {
        this.record.annotations.splice(this.record.annotations.indexOf(annotation), 1);
        if (isNew) this.app.discardChange();
      } else {
        this.app.changed();
      }
      this.render();
    });
    this.editing = { annotation, box };
    this.pageEl.append(box);
    this.render();
    autosize();
    requestAnimationFrame(() => box.focus());
  }

  // Check, cross, dot or today's date, centred on the click.
  placeMark(tool, [x, y]) {
    let annotation;
    if (tool === "date") {
      const fontSize = this.app.fontSize;
      annotation = {
        id: newId(),
        type: "text",
        points: [[x, y - fontSize * 0.6]],
        text: new Date().toLocaleDateString(undefined, { dateStyle: "medium" }),
        color: this.app.color,
        width: 1,
        fontSize,
      };
    } else {
      const half = MARK_SCREEN_PX / this.scale / 2;
      annotation = { id: newId(), type: tool, points: [[x - half, y - half], [x + half, y + half]], color: this.app.color, width: 1 };
    }
    this.app.beginChange();
    this.record.annotations.push(annotation);
    this.app.changed();
  }

  // ---- Sticky-note popup ----

  openNote(annotation, isNew) {
    this.app.closeNotes?.();
    const popup = document.createElement("div");
    popup.className = "note-popup";
    popup.innerHTML = `
      <div class="note-head">
        <span class="note-author"></span>
        <span class="note-date"></span>
        <button type="button" class="tool small" data-delete title="Delete note" aria-label="Delete note">${icon("trash")}</button>
        <button type="button" class="tool small" data-close title="Close (Esc)" aria-label="Close note">${icon("close")}</button>
      </div>
      <textarea placeholder="Write a note…" aria-label="Note text"></textarea>`;
    popup.querySelector(".note-author").textContent = annotation.author || "Note";
    popup.querySelector(".note-date").textContent = formatDateTime(annotation.modified || annotation.created || Date.now());
    const box = popup.querySelector("textarea");
    box.value = annotation.text;
    let recorded = isNew;
    box.addEventListener("input", () => {
      if (!recorded) {
        this.app.beginChange();
        recorded = true;
      }
      annotation.text = box.value;
      annotation.modified = new Date().toISOString();
      this.app.markDirty();
    });
    popup.addEventListener("pointerdown", (e) => e.stopPropagation());
    popup.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.closeNote();
    });
    popup.querySelector("[data-close]").onclick = () => this.closeNote();
    popup.querySelector("[data-delete]").onclick = () => {
      this.closeNote({ remove: true });
    };
    this.note = { annotation, popup, isNew, recorded: () => recorded };
    this.pageEl.append(popup);
    this.positionNote();
    requestAnimationFrame(() => box.focus());
  }

  positionNote() {
    if (!this.note) return;
    const scale = this.scale;
    const [x, y] = this.note.annotation.points[0];
    const left = x * scale + 28;
    const maxLeft = this.pageEl.clientWidth - 250;
    this.note.popup.style.left = `${Math.max(4, left > maxLeft ? x * scale - 254 : left)}px`;
    this.note.popup.style.top = `${Math.max(4, y * scale)}px`;
  }

  closeNote({ remove = false } = {}) {
    if (!this.note) return;
    const { annotation, popup, isNew, recorded } = this.note;
    this.note = null;
    popup.remove();
    const index = this.record.annotations.indexOf(annotation);
    if (index < 0) return;
    if (remove || !annotation.text.trim()) {
      if (isNew && !annotation.text.trim() && !remove) {
        this.record.annotations.splice(index, 1);
        this.app.discardChange();
        this.app.select(null);
        return;
      }
      if (!recorded()) this.app.beginChange();
      this.record.annotations.splice(index, 1);
      this.app.select(null);
    }
    this.app.changed();
  }

  deleteAnnotation(id) {
    const index = this.record.annotations.findIndex((a) => a.id === id);
    if (index < 0) return;
    this.app.beginChange();
    this.record.annotations.splice(index, 1);
    this.app.changed();
  }

  nudge(id, dx, dy) {
    const annotation = this.find(id);
    if (!annotation) return;
    this.app.beginChange();
    translateAnnotation(annotation, dx / this.scale, dy / this.scale);
    this.app.changed();
  }
}
