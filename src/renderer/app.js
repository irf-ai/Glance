import { loadAnnotationImage, newId } from "./annotations.js";
import { applyIcons } from "./icons.js";
import { ImageDocument } from "./image-doc.js";
import { hasDroppable, installDragProvider, readDrop, resolveSource, startDrag } from "./dnd.js";
import { DRAW_TOOLS } from "./markup.js";
import { renderAttachments, renderComments, showPanel } from "./panels.js";
import { PdfDocument } from "./pdf-doc.js";
import { scrollWithin } from "./scroll.js";
import {
  addImageDialog,
  combineDialog,
  compareDialog,
  compressDialog,
  passwordPrompt,
  printDialog,
  propertiesDialog,
  protectDialog,
  shortcutsDialog,
  signatureDialog,
  splitDialog,
} from "./tool-dialogs.js";
import { combine, imageBytesToDataUrl } from "./tools.js";
import { Presentation } from "./viewing.js";

const ALL_ALLOWED = { print: true, copy: true, edit: true, forms: true, encrypted: false, decrypted: true };

function loadPreference(key, fallback) {
  try {
    const value = localStorage.getItem(`glance.${key}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(`glance.${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience only.
  }
}

const $ = (id) => document.getElementById(id);
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
const VIEWER_PADDING = 48;
const HISTORY_LIMIT = 100;

const viewer = $("viewer");
const sidebarList = $("sidebarList");
const emptyState = $("emptyState");

const app = {
  doc: null,
  zoom: 1,
  fitting: true,
  tool: "select",
  color: "#e5322d",
  highlightColor: "#ffd400",
  strokeWidth: 3,
  fontSize: 18,
  selection: null,
  crop: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
  currentPage: 0,
  userName: "",
  permissions: ALL_ALLOWED,
  spread: loadPreference("spread", false),
  darkPages: loadPreference("darkPages", false),

  get noteColor() {
    return this.highlightColor;
  },

  // ---- Called by markup layers ----

  closeNotes() {
    this.doc?.layers.forEach((layer) => layer.closeNote?.());
  },

  select(layer, id) {
    this.selection = layer ? { layer, id } : null;
    this.renderLayers();
    updateControls();
    refreshComments();
  },

  setCrop(layer, rect) {
    const previous = this.crop?.layer;
    this.crop = layer ? { layer, rect } : null;
    previous?.render();
    layer?.render();
    updateControls();
  },

  beginChange() {
    this.undoStack.push(this.doc.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  },

  discardChange() {
    this.undoStack.pop();
    updateControls();
  },

  changed({ structural = false } = {}) {
    setDirty(true);
    if (structural) remount();
    else {
      this.renderLayers();
      refreshThumbs();
    }
    refreshComments();
    updateControls();
  },

  markDirty() {
    setDirty(true);
  },

  renderLayers() {
    this.doc?.layers.forEach((layer) => layer.render());
  },

  openPath: (filePath) => openPath(filePath),
  goToPage: (index) => goToPage(index),
  movePage: (from, to) => editPages(() => app.doc.movePage(from, to), to),
  insertDropped: (sources, at) => insertDropped(sources, at),
};

// ---------- Status and controls ----------

let messageTimer;
function setMessage(text, { error = false, sticky = false } = {}) {
  const el = $("statusMessage");
  el.textContent = text;
  el.classList.toggle("error", error);
  clearTimeout(messageTimer);
  if (!sticky && text) messageTimer = setTimeout(() => (el.textContent = ""), error ? 8000 : 4000);
}

function showError(prefix, err) {
  console.error(err);
  setMessage(`${prefix}: ${err?.message ?? err}`, { error: true });
}

function setDirty(dirty) {
  if (app.dirty === dirty) return;
  app.dirty = dirty;
  window.glance.setDirty(dirty);
}

function fileName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

let commentsTimer;
function refreshComments() {
  clearTimeout(commentsTimer);
  commentsTimer = setTimeout(() => renderComments(toolContext), 120);
}

function updateStatus() {
  const doc = app.doc;
  $("statusLeft").textContent = doc?.kind === "image" ? doc.describe() : "";
  if (doc?.kind === "pdf") {
    if (document.activeElement !== $("pageInput")) $("pageInput").value = String(app.currentPage + 1);
    $("pageTotal").textContent = `of ${doc.pageCount()}`;
  }
  $("statusRight").textContent = doc ? `${Math.round(app.zoom * 100)}%` : "";
  $("zoomLabel").textContent = `${Math.round(app.zoom * 100)}%`;
  $("docMeta").textContent = doc ? (doc.kind === "pdf" ? `${doc.pageCount()} pages` : doc.describe()) : "";
}

function updateControls() {
  const doc = app.doc;
  document.body.classList.toggle("has-doc", Boolean(doc));
  document.body.classList.toggle("is-pdf", doc?.kind === "pdf");
  document.body.classList.toggle("is-image", doc?.kind === "image");
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === app.tool);
    button.setAttribute("aria-checked", String(button.dataset.tool === app.tool));
  });
  $("undoBtn").disabled = !app.undoStack.length;
  $("redoBtn").disabled = !app.redoStack.length;
  $("deleteBtn").disabled = !app.selection;
  $("applyCropBtn").hidden = !app.crop;
  $("applyCropBtn").lastChild.textContent = doc?.kind === "pdf" ? "Crop page" : "Crop";
  $("applyCropAllBtn").hidden = !app.crop || doc?.kind !== "pdf" || doc.pageCount() < 2;
  $("pageDeleteBtn").disabled = doc?.kind !== "pdf" || doc.pageCount() <= 1;
  $("markupBtn").setAttribute("aria-pressed", String(!$("markupBar").hidden));
  $("sidebarBtn").setAttribute("aria-pressed", String(!document.body.classList.contains("sidebar-hidden")));
  emptyState.hidden = Boolean(doc);

  const perms = app.permissions;
  document.body.classList.toggle("read-only", !perms.edit);
  viewer.classList.toggle("no-copy", !perms.copy);
  viewer.classList.toggle("no-forms", !perms.forms);
  $("markupBtn").disabled = !perms.edit;
  $("printBtn").disabled = !perms.print;
  $("exportBtn").disabled = !perms.edit && !perms.copy;
  const limits = [!perms.edit && "editing", !perms.copy && "copying", !perms.print && "printing"].filter(Boolean);
  $("lockBadge").hidden = !doc || !perms.encrypted;
  $("lockBadge").textContent = limits.length ? `Protected · no ${limits.join(", ")}` : "Password protected";
  $("lockBadge").title = !perms.decrypted
    ? "Glance can't remove this file's encryption, so it can only be viewed."
    : limits.length
      ? "The file's owner restricted these actions. Remove the restrictions in the app that set them."
      : "Exported copies are not password protected unless you use Protect with password.";

  const spread = app.spread && doc?.kind === "pdf";
  $("singleBtn").setAttribute("aria-pressed", String(!spread));
  $("spreadBtn").setAttribute("aria-pressed", String(spread));
  $("darkBtn").setAttribute("aria-pressed", String(app.darkPages));
  updateStatus();
}

// ---------- Opening documents ----------

async function openPath(filePath) {
  if (app.dirty && !(await window.glance.confirmDiscard())) return;
  setMessage(`Opening ${fileName(filePath)}…`, { sticky: true });
  let doc;
  try {
    const bytes = await window.glance.readFile(filePath);
    doc = filePath.toLowerCase().endsWith(".pdf")
      ? await PdfDocument.load(filePath, bytes, { askPassword: (retry) => passwordPrompt(fileName(filePath), retry) })
      : await ImageDocument.load(filePath, bytes);
  } catch (err) {
    if (!app.doc) window.glance.setDocument(null);
    if (err.cancelled) setMessage("");
    else showError(`Couldn't open ${fileName(filePath)}`, err);
    return;
  }
  app.closeNotes();
  app.doc?.destroy();
  Object.assign(app, { doc, selection: null, crop: null, undoStack: [], redoStack: [], currentPage: 0, fitting: true });
  app.permissions = doc.kind === "pdf" ? doc.permissions() : ALL_ALLOWED;
  if (!app.permissions.edit) {
    $("markupBar").hidden = true;
    app.tool = "select";
  }
  if (doc.kind !== "pdf" && document.body.dataset.panel === "attachments") showPanel("pages");
  $("attachmentCount").textContent = "";
  setDirty(false);
  window.glance.setDocument(filePath);
  $("docTitle").querySelector(".doc-name").textContent = fileName(filePath);
  $("docTitle").draggable = true;
  $("docTitle").title = "Drag into another Glance window or a Combine list to add this document";
  $("searchInput").value = "";
  $("searchCount").textContent = "";
  if (app.tool === "highlight" || app.tool === "crop") app.tool = "select";
  remount({ fit: true });
  setMessage("");
}

function emptyViewer() {
  viewer.replaceChildren(emptyState);
}

// Rebuilds page views and the sidebar, keeping the scroll position where possible.
function remount({ fit = false } = {}) {
  const doc = app.doc;
  if (!doc) return emptyViewer();
  const scrollRatio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
  app.closeNotes();
  app.selection = null;
  if (app.crop) app.crop = null;
  doc.mount(viewer, app);
  applyViewMode();
  if (fit || app.fitting) app.zoom = fitZoom();
  doc.layout(app.zoom);
  if (!fit) viewer.scrollTop = scrollRatio * viewer.scrollHeight;
  else viewer.scrollTop = 0;
  doc.renderSidebar(sidebarList);
  document.body.classList.toggle("image-thumbs", doc.kind === "image");
  applyTool();
  if (doc.kind === "pdf") {
    app.currentPage = Math.min(doc.currentIndex(), doc.pageCount() - 1);
    doc.markCurrentThumb(app.currentPage);
  }
  renderComments(toolContext);
  renderAttachments(toolContext);
  updateControls();
}

// Two-page spreads put a line break after every second page.
function applyViewMode() {
  const spread = app.spread && app.doc?.kind === "pdf";
  viewer.classList.toggle("spread", spread);
  viewer.classList.toggle("dark-pages", app.darkPages);
  viewer.querySelectorAll(".spread-break").forEach((el) => el.remove());
  if (spread) {
    viewer.querySelectorAll(".pdf-page").forEach((page, i) => {
      if (i % 2 === 1) page.after(Object.assign(document.createElement("div"), { className: "spread-break" }));
    });
  }
}

function setSpread(spread) {
  if (app.doc?.kind !== "pdf") return;
  const page = app.currentPage;
  app.spread = spread;
  savePreference("spread", spread);
  applyViewMode();
  setZoom(fitZoom(), { fitting: true });
  goToPage(page);
  updateControls();
}

function toggleDarkPages() {
  app.darkPages = !app.darkPages;
  savePreference("darkPages", app.darkPages);
  applyViewMode();
  updateControls();
}

function fitZoom() {
  const spread = app.spread && app.doc?.kind === "pdf";
  const width = (viewer.clientWidth - VIEWER_PADDING - (spread ? 16 : 0)) / (spread ? 2 : 1);
  const height = viewer.clientHeight - VIEWER_PADDING;
  return Math.max(0.05, app.doc.fitZoom(width, height));
}

// Shows a piece of markup from the Comments panel: scroll to it and select it.
function revealAnnotation(pageIndex, id) {
  const doc = app.doc;
  if (!doc) return;
  if (doc.kind === "pdf") goToPage(pageIndex);
  const layer = doc.layers[pageIndex];
  const annotation = layer?.find(id);
  if (!annotation) return;
  app.select(layer, id);
  const el = layer.svg.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (el) scrollWithin(viewer, el, "center");
  if (annotation.type === "note") layer.openNote(annotation, false);
}

function goToPageNumber(value) {
  const doc = app.doc;
  if (doc?.kind !== "pdf") return;
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 1 || number > doc.pageCount()) {
    setMessage(`Enter a page from 1 to ${doc.pageCount()}.`, { error: true });
    updateStatus();
    return;
  }
  goToPage(number - 1);
  viewer.focus();
}

// Actions that change the document need the owner's permission on protected PDFs.
function requireEdit() {
  if (app.permissions.edit) return true;
  setMessage(
    app.permissions.decrypted ? "This PDF's owner doesn't allow changes." : "Glance can't remove this file's encryption, so it can only be viewed.",
    { error: true },
  );
  return false;
}

// ---------- Zoom ----------

function setZoom(zoom, { fitting = false } = {}) {
  if (!app.doc) return;
  zoom = Math.min(8, Math.max(0.05, zoom));
  const centerX = (viewer.scrollLeft + viewer.clientWidth / 2) / (viewer.scrollWidth || 1);
  const centerY = (viewer.scrollTop + viewer.clientHeight / 2) / (viewer.scrollHeight || 1);
  app.zoom = zoom;
  app.fitting = fitting;
  app.doc.layout(zoom);
  viewer.scrollLeft = centerX * viewer.scrollWidth - viewer.clientWidth / 2;
  viewer.scrollTop = centerY * viewer.scrollHeight - viewer.clientHeight / 2;
  updateStatus();
}

function zoomStep(direction) {
  const current = app.zoom;
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > current + 0.001) ?? 8
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? 0.1;
  setZoom(next);
}

// ---------- Pages ----------

function onScroll() {
  const doc = app.doc;
  if (doc?.kind !== "pdf") return;
  const index = doc.currentIndex();
  if (index !== app.currentPage) {
    app.currentPage = index;
    doc.markCurrentThumb(index);
    updateStatus();
  }
}

function goToPage(index) {
  if (app.doc?.kind !== "pdf") return;
  app.doc.scrollToPage(index);
  app.currentPage = index;
  app.doc.markCurrentThumb(index);
  updateStatus();
}

// Thumbnails show markup too; redraw the ones already rendered after an edit settles.
let thumbTimer;
function refreshThumbs() {
  const doc = app.doc;
  if (doc?.kind !== "pdf") return;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => doc.pages.forEach((_, i) => doc.refreshThumb(i)), 300);
}

async function editPages(change, focusIndex = app.currentPage) {
  if (!requireEdit()) return;
  try {
    app.beginChange();
    await change();
    app.changed({ structural: true });
    const index = Math.min(focusIndex, app.doc.pageCount() - 1);
    requestAnimationFrame(() => goToPage(index));
  } catch (err) {
    app.discardChange();
    showError("Couldn't change pages", err);
  }
}

function rotate(direction) {
  const doc = app.doc;
  if (!doc) return;
  if (doc.kind === "pdf") {
    editPages(() => doc.rotatePage(app.currentPage, direction));
  } else {
    app.beginChange();
    doc.rotate(direction);
    app.changed({ structural: true });
  }
}

function flip(axis) {
  if (app.doc?.kind !== "image") return;
  app.beginChange();
  app.doc.flip(axis);
  app.changed({ structural: true });
}

async function applyCrop({ allPages = false } = {}) {
  const doc = app.doc;
  if (!doc) return;
  const rect = app.crop?.rect;
  if (!rect || rect.w < 1 || rect.h < 1) {
    $("markupBar").hidden = false;
    setTool("crop");
    setMessage(`Drag over the ${doc.kind === "pdf" ? "page" : "image"} to choose the area to keep, then press Enter.`);
    return;
  }
  if (doc.kind === "image") {
    app.beginChange();
    doc.crop(rect);
    app.crop = null;
    setTool("select");
    app.changed({ structural: true });
    setMessage(`Cropped to ${rect.w} × ${rect.h} px`);
    return;
  }
  const pageIndex = doc.layers.indexOf(app.crop.layer);
  const indices = allPages ? doc.pages.map((_, i) => i) : [pageIndex];
  app.crop = null;
  setTool("select");
  setMessage("Cropping…", { sticky: true });
  await editPages(() => doc.cropPages(indices, rect), pageIndex);
  setMessage(allPages ? `Cropped all ${indices.length} pages` : `Cropped page ${pageIndex + 1}`);
}

// Places a picture or signature in the middle of the visible part of the current page.
async function placeImage({ src, width, height }, { signature }) {
  const doc = app.doc;
  if (!doc || !requireEdit()) return;
  await loadAnnotationImage(src);
  const index = doc.kind === "pdf" ? app.currentPage : 0;
  const layer = doc.layers[index];
  const record = doc.pages[index];
  const base = doc.kind === "pdf" ? doc.baseSize(record) : doc.baseSize();
  let w = signature ? (doc.kind === "pdf" ? 170 : base.w * 0.3) : Math.min(width * (doc.kind === "pdf" ? 0.75 : 1), base.w * 0.6);
  let h = (w * height) / width;
  if (h > base.h * 0.6) {
    h = base.h * 0.6;
    w = (h * width) / height;
  }
  const pageBox = layer.pageEl.getBoundingClientRect();
  const viewBox = viewer.getBoundingClientRect();
  const visibleTop = Math.max(pageBox.top, viewBox.top);
  const visibleBottom = Math.min(pageBox.bottom, viewBox.bottom);
  const scale = pageBox.width / base.w;
  const cx = base.w / 2;
  const cy = visibleBottom > visibleTop ? ((visibleTop + visibleBottom) / 2 - pageBox.top) / scale : base.h / 2;
  const x = Math.max(0, Math.min(base.w - w, cx - w / 2));
  const y = Math.max(0, Math.min(base.h - h, cy - h / 2));
  const annotation = { id: newId(), type: "image", points: [[x, y], [x + w, y + h]], src, color: "#000000", width: 1 };
  app.beginChange();
  record.annotations.push(annotation);
  setTool("select");
  app.changed();
  app.select(layer, annotation.id);
  setMessage(`${signature ? "Signature" : "Image"} added. Drag to move it; drag the corner handle to resize.`);
}

function openResult(filePath) {
  if (app.doc) window.glance.openInNewWindow(filePath);
  else openPath(filePath);
}

const toolContext = { app, setMessage, showError, placeImage, openResult, revealAnnotation, showPanel, goToPage: (i) => goToPage(i) };
const presentation = new Presentation(toolContext);

async function insertPdf() {
  if (app.doc?.kind !== "pdf") return;
  const paths = await window.glance.openDialog();
  const pdfPath = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
  if (!pdfPath) {
    if (paths.length) setMessage("Choose a PDF to insert pages from.", { error: true });
    return;
  }
  const at = app.currentPage + 1;
  let count = 0;
  await editPages(async () => {
    count = await app.doc.insertPdf(await window.glance.readFile(pdfPath), at, {
      askPassword: (retry) => passwordPrompt(fileName(pdfPath), retry),
    });
  }, at);
  if (count) setMessage(`Inserted ${count} page${count === 1 ? "" : "s"} from ${fileName(pdfPath)}`);
}

// Inserts dropped PDFs, images and pages from other windows at page index `at`.
// Images become pages the size of the page they're inserted after.
async function insertDropped(sources, at) {
  const doc = app.doc;
  if (doc?.kind !== "pdf") {
    setMessage("Open a PDF to add pages to it, or use Tools › Combine files.", { error: true });
    return;
  }
  const neighbour = doc.pages[Math.max(0, Math.min(at - 1, doc.pageCount() - 1))];
  const { w, h } = doc.baseSize(neighbour);
  let inserted = 0;
  setMessage(`Adding ${sources.length === 1 ? sources[0].label : `${sources.length} items`}…`, { sticky: true });
  await editPages(async () => {
    for (const source of sources) {
      const payload = await resolveSource(source);
      const bytes =
        payload.kind === "pdf"
          ? payload.bytes
          : await combine([{ name: payload.name, kind: "image", bytes: payload.bytes }], { pageSize: [w, h], orientation: "auto", margin: "small" });
      inserted += await doc.insertPdf(bytes, at + inserted, { askPassword: (retry) => passwordPrompt(payload.name, retry) });
    }
  }, at);
  if (inserted) setMessage(`Added ${inserted} page${inserted === 1 ? "" : "s"}`);
}

// Ctrl+V: places a copied picture on the current page.
async function pasteImage(clipboardData) {
  if (!app.doc || !requireEdit()) return;
  try {
    let bytes = null;
    const file = [...(clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (file) bytes = new Uint8Array(await file.arrayBuffer());
    else bytes = await window.glance.readClipboardImage();
    if (!bytes) {
      setMessage("There's no picture on the clipboard to paste.", { error: true });
      return;
    }
    await placeImage(await imageBytesToDataUrl(bytes), { signature: false });
    setMessage("Pasted the picture. Drag to move it; drag the corner handle to resize.");
  } catch (err) {
    showError("Couldn't paste the picture", err);
  }
}

// Ctrl+Shift+C: copies the current page (or the image) with markup as a picture.
async function copyPageImage() {
  const doc = app.doc;
  if (!doc) return;
  if (!app.permissions.copy) {
    setMessage("This PDF's owner doesn't allow copying.", { error: true });
    return;
  }
  try {
    const bytes = doc.kind === "pdf" ? await doc.renderPageImage(app.currentPage, { resolution: 200, mime: "image/png" }) : await doc.export("png");
    await window.glance.writeClipboardImage(bytes);
    setMessage(doc.kind === "pdf" ? `Copied page ${app.currentPage + 1} as a picture` : "Copied the image");
  } catch (err) {
    showError("Couldn't copy", err);
  }
}

function deleteCurrentPage() {
  if (app.doc?.kind !== "pdf" || app.doc.pageCount() <= 1) return;
  const index = app.currentPage;
  editPages(() => app.doc.deletePage(index), index);
}

// ---------- Markup ----------

function setTool(tool) {
  if (!app.doc) return;
  if (DRAW_TOOLS.has(tool) && !requireEdit()) return;
  if (tool === "highlight" && app.doc.kind === "pdf" && highlightTextSelection()) return;
  app.tool = tool;
  if (tool !== "crop" && app.crop) app.setCrop(null);
  if (DRAW_TOOLS.has(tool)) app.select(null);
  applyTool();
  updateControls();
}

function applyTool() {
  viewer.dataset.tool = app.tool;
  app.doc?.layers.forEach((layer) => layer.updateMode());
}

// Turns selected PDF text into highlight markup, merged line by line.
function highlightTextSelection() {
  const rects = app.doc.selectionRects();
  if (!rects.length) return false;
  const merged = [];
  rects
    .sort((a, b) => a.view.el.dataset.index - b.view.el.dataset.index || a.y - b.y || a.x - b.x)
    .forEach((rect) => {
      const last = merged.at(-1);
      if (
        last &&
        last.view === rect.view &&
        Math.abs(last.y - rect.y) < Math.min(last.h, rect.h) * 0.5 &&
        rect.x <= last.x + last.w + 2
      ) {
        const right = Math.max(last.x + last.w, rect.x + rect.w);
        const bottom = Math.max(last.y + last.h, rect.y + rect.h);
        last.y = Math.min(last.y, rect.y);
        last.w = right - last.x;
        last.h = bottom - last.y;
      } else {
        merged.push({ ...rect });
      }
    });
  app.beginChange();
  for (const rect of merged) {
    rect.view.record.annotations.push({
      id: newId(),
      type: "highlight",
      points: [
        [rect.x, rect.y],
        [rect.x + rect.w, rect.y + rect.h],
      ],
      color: app.highlightColor,
      width: 1,
    });
  }
  window.getSelection().removeAllRanges();
  app.changed();
  setMessage(`Highlighted ${merged.length} line${merged.length === 1 ? "" : "s"}`);
  return true;
}

function deleteSelection() {
  const selection = app.selection;
  if (!selection) return;
  app.selection = null;
  selection.layer.deleteAnnotation(selection.id);
}

function undo() {
  if (!app.undoStack.length) return;
  app.redoStack.push(app.doc.snapshot());
  restore(app.undoStack.pop());
}

function redo() {
  if (!app.redoStack.length) return;
  app.undoStack.push(app.doc.snapshot());
  restore(app.redoStack.pop());
}

function restore(snapshot) {
  const structural = app.doc.restore(snapshot);
  app.selection = null;
  app.changed({ structural });
}

// ---------- Search ----------

let searchToken = 0;
let lastQuery = "";
async function runSearch() {
  if (app.doc?.kind !== "pdf") return;
  const query = $("searchInput").value;
  const token = ++searchToken;
  lastQuery = query;
  if (!query.trim()) {
    app.doc.clearSearch();
    $("searchCount").textContent = "";
    return;
  }
  $("searchCount").textContent = "…";
  const count = await app.doc.search(query);
  if (token !== searchToken) return;
  if (count) app.doc.showMatch(0);
  updateSearchCount();
}

function updateSearchCount() {
  const doc = app.doc;
  const count = doc.matches.length;
  $("searchCount").textContent = count ? `${doc.currentMatch + 1} of ${count}` : "No results";
}

function stepMatch(direction) {
  const doc = app.doc;
  if (doc?.kind !== "pdf") return;
  if (!doc.matches.length) {
    runSearch();
    return;
  }
  doc.showMatch(doc.currentMatch + direction);
  updateSearchCount();
}

// ---------- Export ----------

function baseName(filePath) {
  return filePath.replace(/\.[^.\\/]+$/, "");
}

const EXPORT_NOTES = {
  pdf: "Markup is added as drawings and text. Page order, rotation and filled-in form fields are kept.",
  "page-png": "Exports the current page with its markup.",
  "page-jpeg": "Exports the current page with its markup.",
  "pages-jpeg": "Saves one image per page into a folder you choose.",
  "pages-png": "Saves one image per page into a folder you choose.",
  markdown: "Headings and lists are guessed from font sizes and bullets. Scanned pages have no text to export.",
  docx: "Editable text with headings, paragraphs and bullet lists; each PDF page starts a new Word page. Pages without text (scans) are added as pictures. Layout, images and markup aren't kept.",
  text: "Keeps the original line breaks. Pages are separated by a page-break character.",
  jpeg: "JPEG has no transparency; transparent areas become white.",
};

async function openExportDialog(preselect = null) {
  const doc = app.doc;
  if (!doc) return;
  // A full PDF copy needs edit permission; page images and text need copy permission.
  const formats = doc.exportFormats().filter((f) => (f.id === "pdf" ? app.permissions.edit : app.permissions.copy));
  if (!formats.length) {
    setMessage("This PDF's owner doesn't allow exporting.", { error: true });
    return;
  }
  const select = $("exportFormat");
  select.replaceChildren(...formats.map((f) => new Option(f.label, f.id)));
  if (preselect && formats.some((f) => f.id === preselect)) select.value = preselect;
  const syncFields = () => {
    const format = formats.find((f) => f.id === select.value);
    $("qualityField").hidden = !format.quality;
    $("resolutionField").hidden = !format.resolution;
    $("exportConfirm").textContent = format.folder ? "Choose folder…" : "Save…";
    $("exportNote").textContent =
      (EXPORT_NOTES[format.id] ?? "Markup is merged into the exported image.") +
      (format.id === "pdf" && app.permissions.encrypted ? " The copy has no password; use Protect with password to add one." : "");
  };
  select.onchange = syncFields;
  $("exportQuality").oninput = () => ($("qualityValue").textContent = `${$("exportQuality").value}%`);
  syncFields();

  const dialog = $("exportDialog");
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue !== "ok") return;

  const format = formats.find((f) => f.id === select.value);
  const quality = Number($("exportQuality").value) / 100;
  const resolution = Number($("exportResolution").value);
  if (format.folder) return exportAllPages(format, quality, resolution);
  const suffix = format.id.startsWith("page-") ? `-page${app.currentPage + 1}` : "";
  const defaultPath = `${baseName(doc.filePath)}${suffix}${doc.kind === "pdf" && format.id === "pdf" ? "-edited" : ""}.${format.ext}`;
  const target = await window.glance.saveDialog({
    defaultPath,
    filters: [{ name: format.label, extensions: [format.ext] }],
  });
  if (!target) return;
  setMessage("Exporting…", { sticky: true });
  try {
    const bytes = await doc.export(format.id, quality, { pageIndex: app.currentPage, resolution });
    await window.glance.writeFile(target, bytes);
    if (format.saves) setDirty(false);
    setMessage(`Saved ${fileName(target)}`);
  } catch (err) {
    showError("Export failed", err);
  }
}

async function exportAllPages(format, quality, resolution) {
  const doc = app.doc;
  const folder = await window.glance.chooseFolder();
  if (!folder) return;
  const stem = fileName(baseName(doc.filePath));
  const count = doc.pageCount();
  const digits = String(count).length;
  try {
    for (let i = 0; i < count; i++) {
      setMessage(`Exporting page ${i + 1} of ${count}…`, { sticky: true });
      const bytes = await doc.renderPageImage(i, {
        resolution,
        mime: format.ext === "png" ? "image/png" : "image/jpeg",
        quality,
      });
      await window.glance.writeInFolder(folder, `${stem}-${String(i + 1).padStart(digits, "0")}.${format.ext}`, bytes);
    }
    setMessage(`Saved ${count} image${count === 1 ? "" : "s"} to ${fileName(folder) || folder}`);
  } catch (err) {
    showError("Export failed", err);
  }
}

function toggleToolsMenu(open = $("toolsMenu").hidden) {
  $("toolsMenu").hidden = !open;
  $("toolsBtn").setAttribute("aria-expanded", String(open));
  if (open) $("toolsMenu").querySelector("button:not([hidden])")?.focus();
}

async function openResizeDialog() {
  const doc = app.doc;
  if (doc?.kind !== "image") return;
  const { w, h } = doc.baseSize();
  const width = $("resizeWidth");
  const height = $("resizeHeight");
  const lock = $("resizeLock");
  const preset = $("resizePreset");
  width.value = w;
  height.value = h;
  preset.value = "1";
  const note = () => {
    const pixels = (Number(width.value) * Number(height.value)) / 1e6;
    $("resizeNote").textContent = `Currently ${w} × ${h} px. New size ${pixels.toFixed(1)} megapixels.`;
  };
  width.oninput = () => {
    if (lock.checked) height.value = Math.max(1, Math.round((Number(width.value) * h) / w));
    preset.value = "";
    note();
  };
  height.oninput = () => {
    if (lock.checked) width.value = Math.max(1, Math.round((Number(height.value) * w) / h));
    preset.value = "";
    note();
  };
  preset.onchange = () => {
    if (!preset.value) return;
    width.value = Math.max(1, Math.round(w * Number(preset.value)));
    height.value = Math.max(1, Math.round(h * Number(preset.value)));
    note();
  };
  note();
  const dialog = $("resizeDialog");
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue !== "ok") return;
  const newW = Math.round(Number(width.value));
  const newH = Math.round(Number(height.value));
  if (!(newW > 0 && newH > 0) || (newW === w && newH === h)) return;
  if (newW * newH > 268_000_000) {
    setMessage("That size is too large.", { error: true });
    return;
  }
  app.beginChange();
  doc.resize(newW, newH);
  app.changed({ structural: true });
  setMessage(`Resized to ${newW} × ${newH} px`);
}

// ---------- Input wiring ----------

async function chooseAndOpen() {
  const paths = await window.glance.openDialog();
  if (paths.length) openPath(paths[0]);
}

function isEditingText() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

const actions = {
  export: openExportDialog,
  "insert-pdf": insertPdf,
  undo: () => (isEditingText() ? document.execCommand("undo") : undo()),
  redo: () => (isEditingText() ? document.execCommand("redo") : redo()),
  find: () => {
    if (app.doc?.kind !== "pdf") return;
    $("searchInput").focus();
    $("searchInput").select();
  },
  "toggle-sidebar": () => {
    document.body.classList.toggle("sidebar-hidden");
    if (app.fitting) setZoom(fitZoom(), { fitting: true });
    updateControls();
  },
  "toggle-markup": () => {
    if ($("markupBar").hidden && !requireEdit()) return;
    $("markupBar").hidden = !$("markupBar").hidden;
    if ($("markupBar").hidden) setTool("select");
    updateControls();
  },
  "zoom-in": () => zoomStep(1),
  "zoom-out": () => zoomStep(-1),
  "zoom-actual": () => setZoom(1),
  "zoom-fit": () => app.doc && setZoom(fitZoom(), { fitting: true }),
  "rotate-left": () => rotate(-1),
  "rotate-right": () => rotate(1),
  "flip-h": () => flip("h"),
  "flip-v": () => flip("v"),
  resize: openResizeDialog,
  crop: () => {
    if (!requireEdit()) return;
    $("markupBar").hidden = false;
    applyCrop();
  },
  "crop-pages": () => requireEdit() && applyCrop(),
  combine: () => combineDialog(toolContext),
  split: () => requireEdit() && splitDialog(toolContext),
  compress: () => requireEdit() && compressDialog(toolContext),
  protect: () => requireEdit() && protectDialog(toolContext),
  compare: () => compareDialog(toolContext),
  signature: () => requireEdit() && signatureDialog(toolContext),
  "add-image": () => requireEdit() && addImageDialog(toolContext),
  "export-pages": () => app.doc?.kind === "pdf" && openExportDialog("pages-jpeg"),
  "export-text": () => app.doc?.kind === "pdf" && openExportDialog("markdown"),
  print: () => printDialog(toolContext),
  properties: () => propertiesDialog(toolContext),
  presentation: () => app.doc && presentation.start(app.doc.kind === "pdf" ? app.currentPage : 0),
  "go-to-page": () => {
    if (app.doc?.kind !== "pdf") return;
    $("pageInput").focus();
    $("pageInput").select();
  },
  "copy-page": copyPageImage,
  shortcuts: () => shortcutsDialog(),
  "view-single": () => setSpread(false),
  "view-spread": () => setSpread(true),
  "dark-pages": toggleDarkPages,
};

function wire() {
  applyIcons();
  window.glance.onMenu((action) => actions[action]?.());
  window.glance.onOpenFile((filePath) => openPath(filePath));

  $("openBtn").onclick = chooseAndOpen;
  $("emptyOpenBtn").onclick = chooseAndOpen;
  $("printBtn").onclick = actions.print;
  $("singleBtn").onclick = actions["view-single"];
  $("spreadBtn").onclick = actions["view-spread"];
  $("darkBtn").onclick = actions["dark-pages"];
  document.querySelectorAll(".sidebar-tab").forEach((tab) => (tab.onclick = () => showPanel(tab.dataset.panel)));
  $("pageInput").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") goToPageNumber($("pageInput").value);
    if (e.key === "Escape") {
      updateStatus();
      viewer.focus();
    }
  });
  $("pageInput").addEventListener("blur", () => updateStatus());
  $("sidebarBtn").onclick = actions["toggle-sidebar"];
  $("markupBtn").onclick = actions["toggle-markup"];
  $("zoomInBtn").onclick = actions["zoom-in"];
  $("zoomOutBtn").onclick = actions["zoom-out"];
  $("zoomLabel").onclick = actions["zoom-actual"];
  $("fitBtn").onclick = actions["zoom-fit"];
  $("rotateLeftBtn").onclick = actions["rotate-left"];
  $("rotateRightBtn").onclick = actions["rotate-right"];
  $("exportBtn").onclick = openExportDialog;
  $("flipHBtn").onclick = actions["flip-h"];
  $("flipVBtn").onclick = actions["flip-v"];
  $("resizeBtn").onclick = openResizeDialog;
  $("applyCropBtn").onclick = () => applyCrop();
  $("applyCropAllBtn").onclick = () => applyCrop({ allPages: true });
  $("emptyCombineBtn").onclick = actions.combine;
  $("toolsBtn").onclick = (e) => {
    e.stopPropagation();
    toggleToolsMenu();
  };
  $("toolsMenu").querySelectorAll("[data-action]").forEach((item) => {
    item.onclick = () => {
      toggleToolsMenu(false);
      actions[item.dataset.action]?.();
    };
  });
  document.addEventListener("pointerdown", (e) => {
    if (!$("toolsMenu").hidden && !e.target.closest(".menu-anchor")) toggleToolsMenu(false);
  });
  $("toolsMenu").addEventListener("keydown", (e) => {
    const items = [...$("toolsMenu").querySelectorAll("button")].filter((b) => b.offsetParent);
    const index = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      toggleToolsMenu(false);
      $("toolsBtn").focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("deleteBtn").onclick = deleteSelection;
  $("pageRotateLeftBtn").onclick = () => rotate(-1);
  $("pageRotateRightBtn").onclick = () => rotate(1);
  $("pageDeleteBtn").onclick = deleteCurrentPage;
  $("insertPdfBtn").onclick = insertPdf;
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.onclick = () => setTool(button.dataset.tool);
    // Keep the PDF text selection alive so Highlight can use it.
    button.onmousedown = (e) => e.preventDefault();
  });

  $("colorInput").oninput = (e) => {
    app.color = e.target.value;
    recolorSelection("color", e.target.value);
  };
  $("highlightColorInput").oninput = (e) => {
    app.highlightColor = e.target.value;
    recolorSelection("highlight", e.target.value);
  };
  $("strokeSelect").onchange = (e) => (app.strokeWidth = Number(e.target.value));
  $("fontSelect").onchange = (e) => (app.fontSize = Number(e.target.value));

  let searchDebounce;
  $("searchInput").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runSearch, 250);
  });
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchDebounce);
      if (app.doc?.matches.length && lastQuery === $("searchInput").value) stepMatch(e.shiftKey ? -1 : 1);
      else runSearch();
    } else if (e.key === "Escape") {
      $("searchInput").value = "";
      runSearch();
      viewer.focus();
    }
  });
  $("searchPrevBtn").onclick = () => stepMatch(-1);
  $("searchNextBtn").onclick = () => stepMatch(1);

  viewer.addEventListener("scroll", () => requestAnimationFrame(onScroll), { passive: true });
  viewer.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !app.doc) return;
      e.preventDefault();
      setZoom(app.zoom * Math.exp(-e.deltaY * 0.002));
    },
    { passive: false },
  );
  viewer.addEventListener("pointerdown", (e) => {
    app.closeNotes();
    if (!e.target.closest(".annotation, .resize-handle") && app.selection) app.select(null);
  });

  // Refit on the next frame: resizing pages inside the observer callback
  // would trigger the "ResizeObserver loop" warning.
  let refitFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(refitFrame);
    refitFrame = requestAnimationFrame(() => {
      if (app.doc && app.fitting) setZoom(fitZoom(), { fitting: true });
    });
  }).observe(viewer);

  document.addEventListener("keydown", onKeyDown);

  // Drag and drop files from Explorer.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer?.types.includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    document.body.classList.add("drag-over");
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) document.body.classList.remove("drag-over");
  });
  window.addEventListener("dragover", (e) => {
    if (hasDroppable(e.dataTransfer)) e.preventDefault();
  });
  // Files from Explorer open; pages and documents dragged from other Glance
  // windows are added after the current page.
  window.addEventListener("drop", (e) => {
    if (!hasDroppable(e.dataTransfer) || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("drag-over");
    const sources = readDrop(e.dataTransfer);
    const fromGlance = sources.filter((s) => !s.path);
    if (fromGlance.length) insertDropped(fromGlance, app.currentPage + 1);
    else if (sources[0]) openPath(sources[0].path);
  });

  // The page list takes drops too: at the end of the list when not on a page.
  sidebarList.addEventListener("dragover", (e) => {
    if (app.doc?.kind !== "pdf" || !hasDroppable(e.dataTransfer)) return;
    e.preventDefault();
    sidebarList.classList.add("drop-target");
  });
  sidebarList.addEventListener("dragleave", (e) => {
    if (!sidebarList.contains(e.relatedTarget)) sidebarList.classList.remove("drop-target");
  });
  sidebarList.addEventListener("drop", (e) => {
    sidebarList.classList.remove("drop-target");
    if (app.doc?.kind !== "pdf") return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    document.body.classList.remove("drag-over");
    const sources = readDrop(e.dataTransfer);
    if (sources.length) insertDropped(sources, app.doc.pageCount());
  });

  // Drag the document's name to another window or a Combine list.
  $("docTitle").addEventListener("dragstart", (e) => {
    if (!app.doc) return e.preventDefault();
    startDrag(e, { kind: "whole" }, fileName(app.doc.filePath));
  });

  document.addEventListener("paste", (e) => {
    if (isEditingText() || document.querySelector("dialog[open]") || !app.doc) return;
    e.preventDefault();
    pasteImage(e.clipboardData);
  });

  installDragProvider(() => app.doc, () => app.permissions);
}

function recolorSelection(kind, color) {
  const selection = app.selection;
  if (!selection) return;
  const annotation = selection.layer.find(selection.id);
  const usesHighlightColor = annotation?.type === "highlight" || annotation?.type === "note";
  if (!annotation || (kind === "highlight") !== usesHighlightColor) return;
  app.beginChange();
  annotation.color = color;
  app.changed();
}

function onKeyDown(e) {
  if (isEditingText() || document.querySelector("dialog[open]")) return;
  if (e.key === "?") {
    e.preventDefault();
    shortcutsDialog();
    return;
  }
  const doc = app.doc;
  if (!doc) return;
  switch (e.key) {
    case "Delete":
    case "Backspace":
      if (app.selection) {
        e.preventDefault();
        deleteSelection();
      }
      break;
    case "Escape":
      if (app.crop) app.setCrop(null);
      if (app.selection) app.select(null);
      if (app.tool !== "select") setTool("select");
      break;
    case "Enter":
      if (app.crop) {
        e.preventDefault();
        applyCrop();
      }
      break;
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown": {
      const step = e.shiftKey ? 10 : 1;
      if (app.selection) {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        app.selection.layer.nudge(app.selection.id, dx, dy);
      } else if (doc.kind === "image" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const next = doc.neighbour(e.key === "ArrowLeft" ? -1 : 1);
        if (next) {
          e.preventDefault();
          openPath(next);
        }
      }
      break;
    }
  }
}

async function start() {
  wire();
  showPanel("pages");
  updateControls();
  window.glance.appInfo().then((info) => (app.userName = info.username));
  const initial = await window.glance.initialFile();
  if (initial) openPath(initial);
}

start();

// Exported so automated checks can drive the app through DevTools.
export {
  app,
  actions,
  applyCrop,
  openPath,
  placeImage,
  presentation,
  revealAnnotation,
  rotate,
  flip,
  setTool,
  undo,
  redo,
  runSearch,
  setZoom,
  toolContext,
  setSpread,
};
