import * as pdfjsLib from "app://glance/pdfjs/build/pdf.mjs";
import * as PDFLib from "app://glance/pdf-lib/pdf-lib.esm.js";
import {
  addNoteAnnotations,
  cloneAnnotations,
  drawAnnotationsToCanvas,
  drawAnnotationsToPdf,
  embedAnnotationImages,
  transformAnnotations,
} from "./annotations.js";
import { MarkupLayer } from "./markup.js";
import { decryptPdf } from "./pdf-crypto.js";
import { scrollWithin } from "./scroll.js";
import { GLANCE_TYPE, INSTANCE, PAGE_TYPE, hasDroppable, readDrop, startDrag } from "./dnd.js";
import { buildDocx } from "./docx.js";
import { extractBlocks, extractText } from "./tools.js";

export { pdfjsLib };

pdfjsLib.GlobalWorkerOptions.workerSrc = "app://glance/pdfjs/build/pdf.worker.mjs";

const LOAD_OPTIONS = {
  cMapUrl: "app://glance/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "app://glance/pdfjs/standard_fonts/",
  isEvalSupported: false,
};
const MAX_CANVAS_PIXELS = 16_777_216;
const ENCRYPT_MARKER = new TextEncoder().encode("/Encrypt");

function hasBytes(haystack, needle) {
  outer: for (let i = haystack.indexOf(needle[0]); i !== -1 && i <= haystack.length - needle.length; i = haystack.indexOf(needle[0], i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
// Thumbnails and exports draw typed-in form values into the page. pdf.js only
// supports that reliably with the "print" intent: a "display" render with
// storage values never settles once a field has been edited.
const OFFSCREEN_RENDER = { intent: "print", annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE };
const THUMB_WIDTH = 132;

export class PdfDocument {
  kind = "pdf";

  constructor(filePath, source, pages) {
    this.filePath = filePath;
    this.sources = new Set([source]);
    this.pages = pages;
    this.views = [];
    this.layers = [];
    this.zoom = 1;
    this.matches = [];
    this.currentMatch = -1;
  }

  // pdf.js takes ownership of the bytes it is given, so keep a copy for export.
  // Protected files: pdf.js asks for the password through askPassword(retry), and
  // a decrypted copy is kept for editing and export. `bytes` is null when the
  // encryption can't be removed, which makes the document view-only.
  static async loadSource(bytes, { askPassword } = {}) {
    const original = bytes.slice();
    let password;
    let cancelled = false;
    const task = pdfjsLib.getDocument({ data: bytes, ...LOAD_OPTIONS });
    task.onPassword = (update, reason) => {
      const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      Promise.resolve(askPassword ? askPassword(retry) : null).then((value) => {
        if (value == null) {
          cancelled = true;
          task.destroy();
        } else {
          password = value;
          update(value);
        }
      });
    };
    let pdf;
    try {
      pdf = await task.promise;
    } catch (err) {
      if (cancelled) throw Object.assign(new Error("Opening cancelled."), { cancelled: true });
      if (err?.name === "PasswordException") throw new Error("This PDF is password-protected.");
      throw err;
    }
    const permissions = await pdf.getPermissions();
    const source = { bytes: original, pdf, encrypted: false, password, permissions: permissions ? new Set(permissions) : null };
    if (password !== undefined || permissions || hasBytes(original, ENCRYPT_MARKER)) {
      try {
        const plain = await decryptPdf(original, password ?? "");
        if (plain) Object.assign(source, { bytes: plain, encrypted: true });
      } catch {
        Object.assign(source, { bytes: null, encrypted: true });
      }
    }
    return source;
  }

  static async pagesOf(source) {
    const pages = [];
    for (let i = 1; i <= source.pdf.numPages; i++) {
      pages.push({ source, index: i - 1, page: await source.pdf.getPage(i), rotation: 0, annotations: [] });
    }
    return pages;
  }

  static async load(filePath, bytes, options) {
    const source = await PdfDocument.loadSource(bytes, options);
    return new PdfDocument(filePath, source, await PdfDocument.pagesOf(source));
  }

  // What the file's owner allows. Unencrypted files allow everything.
  permissions() {
    const source = this.pages[0].source;
    const has = (flag) => !source.permissions || source.permissions.has(flag);
    const flags = pdfjsLib.PermissionFlag;
    const decrypted = source.bytes !== null;
    return {
      print: has(flags.PRINT),
      copy: has(flags.COPY),
      edit: decrypted && has(flags.MODIFY_CONTENTS) && has(flags.MODIFY_ANNOTATIONS),
      forms: has(flags.FILL_INTERACTIVE_FORMS) || has(flags.MODIFY_ANNOTATIONS),
      encrypted: source.encrypted,
      decrypted,
    };
  }

  // Title, author and other document information, from the first file.
  async info() {
    this.cachedInfo ??= (await this.pages[0].source.pdf.getMetadata()).info ?? {};
    return { ...this.cachedInfo, ...this.metadataEdits };
  }

  setMetadata(edits) {
    this.metadataEdits = { ...this.metadataEdits, ...edits };
  }

  // Files embedded in the PDF, loaded once from the first file.
  async loadAttachments() {
    if (!this.attachments) {
      const raw = (await this.pages[0].source.pdf.getAttachments()) ?? {};
      this.attachments = Object.values(raw).map((a) => ({
        name: a.filename,
        bytes: a.content,
        description: a.description ?? "",
      }));
    }
    return this.attachments;
  }

  addAttachment(file) {
    this.attachments.push({ name: file.name, bytes: file.bytes, description: "", modified: file.modified });
    this.attachmentsChanged = true;
  }

  removeAttachment(index) {
    this.attachments.splice(index, 1);
    this.attachmentsChanged = true;
  }

  rotationOf(record) {
    return (record.page.rotate + record.rotation + 360) % 360;
  }

  baseViewport(record) {
    return record.page.getViewport({ scale: 1, rotation: this.rotationOf(record) });
  }

  baseSize(record) {
    const { width, height } = this.baseViewport(record);
    return { w: width, h: height };
  }

  mount(viewer, app) {
    this.viewer = viewer;
    this.app = app;
    this.observer?.disconnect();
    this.views.forEach((view) => view.task?.cancel());
    viewer.replaceChildren();
    this.views = this.pages.map((record, index) => {
      const el = document.createElement("div");
      el.className = "page pdf-page";
      el.dataset.index = index;
      const canvas = document.createElement("canvas");
      canvas.className = "base";
      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";
      const formDiv = document.createElement("div");
      formDiv.className = "annotationLayer";
      el.append(canvas, textDiv, formDiv);
      viewer.append(el);
      const layer = new MarkupLayer({ pageEl: el, record, baseSize: this.baseSize(record), app });
      return { record, el, canvas, textDiv, formDiv, layer, textLayer: null, renderedZoom: null, pendingZoom: null, task: null, visible: false };
    });
    this.layers = this.views.map((view) => view.layer);
    // Typing into a form field counts as an unsaved change.
    this.sources.forEach((source) => (source.pdf.annotationStorage.onSetModified = () => app.markDirty()));
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const view = this.views[Number(entry.target.dataset.index)];
          if (!view) continue;
          view.visible = entry.isIntersecting;
          if (view.visible) this.renderView(view);
        }
      },
      { root: viewer, rootMargin: "900px 0px" },
    );
    this.views.forEach((view) => this.observer.observe(view.el));
  }

  layout(zoom) {
    this.zoom = zoom;
    for (const view of this.views) {
      const size = this.baseSize(view.record);
      view.el.style.width = `${size.w * zoom}px`;
      view.el.style.height = `${size.h * zoom}px`;
      view.el.style.setProperty("--scale-factor", zoom);
      view.layer.updateSize(size);
      if (view.visible) this.renderView(view);
    }
  }

  fitZoom(width) {
    const widest = Math.max(...this.pages.map((record) => this.baseSize(record).w));
    return Math.min(width / widest, 4);
  }

  async renderView(view) {
    const zoom = this.zoom;
    if (view.renderedZoom === zoom || view.pendingZoom === zoom) return;
    view.pendingZoom = zoom;
    view.task?.cancel();
    const viewport = view.record.page.getViewport({ scale: zoom, rotation: this.rotationOf(view.record) });
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
    const canvas = document.createElement("canvas");
    canvas.className = "base";
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    const task = view.record.page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
    });
    view.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error(err);
      return;
    }
    if (view.pendingZoom !== zoom || !view.el.isConnected) return;
    view.canvas.replaceWith(canvas);
    view.canvas = canvas;
    view.renderedZoom = zoom;
    view.pendingZoom = null;

    view.textLayer?.cancel();
    const textDiv = document.createElement("div");
    textDiv.className = "textLayer";
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: view.record.page.streamTextContent(),
      container: textDiv,
      viewport,
    });
    view.textLayer = textLayer;
    try {
      await textLayer.render();
    } catch {
      return;
    }
    if (view.textLayer !== textLayer || view.renderedZoom !== zoom) return;
    view.textDiv.replaceWith(textDiv);
    view.textDiv = textDiv;
    this.applySearchHighlights(view);
    await this.renderForms(view, viewport, zoom);
  }

  // Interactive form fields and links, drawn by pdf.js above the text layer.
  async renderForms(view, viewport, zoom) {
    const annotations = await view.record.page.getAnnotations({ intent: "display" });
    if (!annotations.length || view.renderedZoom !== zoom) return;
    const formDiv = document.createElement("div");
    formDiv.className = "annotationLayer";
    const layer = new pdfjsLib.AnnotationLayer({
      div: formDiv,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      page: view.record.page,
      viewport: viewport.clone({ dontFlip: true }),
      structTreeLayer: null,
    });
    try {
      await layer.render({
        viewport: viewport.clone({ dontFlip: true }),
        div: formDiv,
        annotations,
        page: view.record.page,
        linkService: this.linkServiceFor(view.record.source),
        renderForms: true,
        annotationStorage: view.record.source.pdf.annotationStorage,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: null,
      });
    } catch (err) {
      console.error(err);
      return;
    }
    if (view.renderedZoom !== zoom || !view.el.isConnected) return;
    view.formDiv.replaceWith(formDiv);
    view.formDiv = formDiv;
  }

  // Minimal pdf.js link service: internal links jump to their page; web links only show their address.
  linkServiceFor(source) {
    return {
      eventBus: null,
      externalLinkEnabled: false,
      isInPresentationMode: false,
      addLinkAttributes: (link, url) => {
        link.href = "#";
        link.title = url;
        link.onclick = (e) => e.preventDefault();
      },
      getDestinationHash: () => "#",
      getAnchorUrl: () => "#",
      goToDestination: async (dest) => {
        const explicit = typeof dest === "string" ? await source.pdf.getDestination(dest) : dest;
        if (!Array.isArray(explicit)) return;
        const target = explicit[0];
        const pageIndex = Number.isInteger(target) ? target : await source.pdf.getPageIndex(target);
        const index = this.pages.findIndex((r) => r.source === source && r.index === pageIndex);
        if (index >= 0) this.app.goToPage(index);
      },
      goToPage: () => {},
      executeNamedAction: () => {},
      executeSetOCGState: () => {},
    };
  }

  currentIndex() {
    // At the very end the last page may never reach the top of the view.
    const { scrollTop, clientHeight, scrollHeight } = this.viewer;
    if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2) {
      const last = this.views.at(-1);
      const bottom = scrollTop + clientHeight;
      if (last && last.el.offsetTop < bottom) {
        const rowStart = this.views.findIndex((v) => Math.abs(v.el.offsetTop - last.el.offsetTop) <= 1);
        return rowStart;
      }
    }
    const middle = this.viewer.scrollTop + this.viewer.clientHeight * 0.4;
    let index = 0;
    let rowTop = -Infinity;
    for (const view of this.views) {
      const top = view.el.offsetTop;
      if (top > middle) break;
      // In two-page rows the left page counts as the current one.
      if (top > rowTop + 1) {
        index = Number(view.el.dataset.index);
        rowTop = top;
      }
    }
    return index;
  }

  pageCount() {
    return this.pages.length;
  }

  describe(index) {
    return `Page ${index + 1} of ${this.pages.length}`;
  }

  scrollToPage(index, block = "start") {
    const view = this.views[index];
    if (view) scrollWithin(this.viewer, view.el, block);
  }

  snapshot() {
    return this.pages.map((record) => ({ ...record, annotations: cloneAnnotations(record.annotations) }));
  }

  // Returns true when pages were added, removed, reordered or rotated.
  restore(snapshot) {
    const sameLayout =
      snapshot.length === this.pages.length &&
      snapshot.every((s, i) => s.page === this.pages[i].page && s.rotation === this.pages[i].rotation);
    if (sameLayout) {
      snapshot.forEach((s, i) => (this.pages[i].annotations = cloneAnnotations(s.annotations)));
      return false;
    }
    this.pages = snapshot.map((s) => ({ ...s, annotations: cloneAnnotations(s.annotations) }));
    this.clearSearch();
    return true;
  }

  rotatePage(index, direction) {
    const record = this.pages[index];
    const { w, h } = this.baseSize(record);
    transformAnnotations(record.annotations, direction > 0 ? (x, y) => [h - y, x] : (x, y) => [y, w - x]);
    record.rotation = (record.rotation + direction * 90 + 360) % 360;
    this.clearSearch();
  }

  deletePage(index) {
    if (this.pages.length <= 1) throw new Error("A PDF needs at least one page.");
    this.pages.splice(index, 1);
    this.clearSearch();
  }

  movePage(from, to) {
    const [record] = this.pages.splice(from, 1);
    this.pages.splice(to, 0, record);
    this.clearSearch();
  }

  async insertPdf(bytes, at, options) {
    const source = await PdfDocument.loadSource(bytes, options);
    if (source.bytes === null || (source.permissions && !source.permissions.has(pdfjsLib.PermissionFlag.ASSEMBLE))) {
      source.pdf.destroy();
      throw new Error("That PDF's owner doesn't allow its pages to be reused.");
    }
    this.sources.add(source);
    const pages = await PdfDocument.pagesOf(source);
    this.pages.splice(at, 0, ...pages);
    this.clearSearch();
    return pages.length;
  }

  // ---- Search -------------------------------------------------------------

  async ensureText(record) {
    if (record.text) return record.text;
    const content = await record.page.getTextContent();
    let value = "";
    const ranges = [];
    for (const item of content.items) {
      if (item.str === undefined) continue;
      const start = value.length;
      value += item.str;
      ranges.push([start, value.length]);
      if (item.hasEOL) value += " ";
    }
    record.text = { lower: value.toLowerCase(), ranges };
    return record.text;
  }

  async search(query) {
    const needle = query.trim().toLowerCase();
    this.matches = [];
    this.currentMatch = -1;
    if (needle) {
      for (const [pageIndex, record] of this.pages.entries()) {
        const { lower } = await this.ensureText(record);
        for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
          this.matches.push({ record, pageIndex, start: at, end: at + needle.length });
        }
      }
    }
    this.views.forEach((view) => this.applySearchHighlights(view));
    return this.matches.length;
  }

  showMatch(n) {
    if (!this.matches.length) return;
    this.currentMatch = (n + this.matches.length) % this.matches.length;
    const match = this.matches[this.currentMatch];
    this.scrollToPage(match.pageIndex, "center");
    this.scrollToSelectedMatch = true;
    this.views.forEach((view) => this.applySearchHighlights(view));
  }

  clearSearch() {
    this.matches = [];
    this.currentMatch = -1;
    this.views.forEach((view) => this.applySearchHighlights(view));
  }

  // Wraps just the matched characters of each text span, like pdf.js's own viewer.
  applySearchHighlights(view) {
    const spans = view.textLayer?.textDivs;
    const strings = view.textLayer?.textContentItemsStr;
    if (!spans?.length) return;
    view.highlighted?.forEach((i) => (spans[i].textContent = strings[i]));
    view.highlighted = [];
    const ranges = view.record.text?.ranges;
    if (!ranges || !this.matches.length) return;
    const perSpan = new Map();
    this.matches.forEach((match, n) => {
      if (match.record !== view.record) return;
      ranges.forEach(([start, end], i) => {
        if (start >= match.end || end <= match.start || !spans[i]) return;
        if (!perSpan.has(i)) perSpan.set(i, []);
        perSpan.get(i).push({ from: Math.max(0, match.start - start), to: Math.min(end, match.end) - start, current: n === this.currentMatch });
      });
    });
    let selectedSpan = null;
    for (const [i, parts] of perSpan) {
      const text = strings[i];
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const part of parts.sort((a, b) => a.from - b.from)) {
        if (part.from > cursor) fragment.append(text.slice(cursor, part.from));
        const mark = document.createElement("span");
        mark.className = part.current ? "highlight selected" : "highlight";
        mark.textContent = text.slice(Math.max(cursor, part.from), part.to);
        fragment.append(mark);
        cursor = Math.max(cursor, part.to);
        if (part.current) selectedSpan ??= mark;
      }
      if (cursor < text.length) fragment.append(text.slice(cursor));
      spans[i].replaceChildren(fragment);
      view.highlighted.push(i);
    }
    if (selectedSpan && this.scrollToSelectedMatch) {
      this.scrollToSelectedMatch = false;
      scrollWithin(this.viewer, selectedSpan, "center");
    }
  }

  // ---- Export -------------------------------------------------------------

  exportFormats() {
    return [
      { id: "pdf", label: "PDF (with markup)", ext: "pdf", quality: false, saves: true },
      { id: "page-png", label: "Current page as PNG", ext: "png", quality: false, saves: false, resolution: true },
      { id: "page-jpeg", label: "Current page as JPEG", ext: "jpg", quality: true, saves: false, resolution: true },
      { id: "pages-jpeg", label: "All pages as JPEG files", ext: "jpg", quality: true, saves: false, resolution: true, folder: true },
      { id: "pages-png", label: "All pages as PNG files", ext: "png", quality: false, saves: false, resolution: true, folder: true },
      { id: "docx", label: "Word document (.docx)", ext: "docx", quality: false, saves: false },
      { id: "markdown", label: "Markdown text (.md)", ext: "md", quality: false, saves: false },
      { id: "text", label: "Plain text (.txt)", ext: "txt", quality: false, saves: false },
    ];
  }

  async export(format, quality, { pageIndex = 0, resolution = 150 } = {}) {
    if (format === "pdf") return this.buildPdf();
    if (format === "markdown" || format === "text") {
      return new TextEncoder().encode(await extractText(this.pages, { markdown: format === "markdown" }));
    }
    if (format === "docx") return this.exportDocx();
    const mime = format.endsWith("png") ? "image/png" : "image/jpeg";
    return this.renderPageImage(pageIndex, { resolution, mime, quality });
  }

  // Editable Word text: headings, paragraphs and bullet lists, one Word page
  // break per PDF page. Pages without text (scans) become pictures instead.
  async exportDocx() {
    const pages = await extractBlocks(this.pages);
    for (const [i, page] of pages.entries()) {
      if (page.blocks.length) continue;
      const { w, h } = this.baseSize(this.pages[i]);
      page.image = { bytes: await this.renderPageImage(i, { resolution: 150, mime: "image/jpeg", quality: 0.85 }), mime: "image/jpeg", widthPt: w, heightPt: h };
    }
    const info = await this.info();
    const first = this.baseSize(this.pages[0]);
    return buildDocx({ pages, pageSize: first, title: info.Title || "", author: info.Author || "" });
  }

  // Draws one page with its markup and filled-in form values onto `canvas` at `scale`.
  async drawPage(index, canvas, scale) {
    const record = this.pages[index];
    const viewport = record.page.getViewport({ scale, rotation: this.rotationOf(record) });
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await record.page.render({ canvasContext: ctx, viewport, ...OFFSCREEN_RENDER }).promise;
    drawAnnotationsToCanvas(ctx, record.annotations, scale);
    return canvas;
  }

  async renderPageImage(index, { resolution = 150, mime = "image/png", quality = 0.9 } = {}) {
    const canvas = await this.drawPage(index, document.createElement("canvas"), resolution / 72);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
    if (!blob) throw new Error(`Page ${index + 1} is too large to export at this resolution.`);
    return new Uint8Array(await blob.arrayBuffer());
  }

  // pdf.js writes typed-in form values back into the file it loaded; for a
  // protected file that copy is encrypted again, so it is decrypted once more.
  async sourceBytes(source) {
    if (source.bytes === null) throw new Error("Glance can't remove this file's encryption, so it can only be viewed.");
    if (source.pdf.annotationStorage.size === 0) return source.bytes;
    const saved = await source.pdf.saveDocument();
    return source.encrypted ? decryptPdf(saved, source.password ?? "") : saved;
  }

  // True when the pages are exactly the original file's pages, in order.
  isOriginalLayout() {
    const [first] = this.pages;
    return (
      first.source.pdf.numPages === this.pages.length &&
      this.pages.every((record, i) => record.source === first.source && record.index === i)
    );
  }

  // Builds the current document as PDF bytes.
  // When the page layout is unchanged the original file is edited in place, which
  // keeps bookmarks, metadata and fillable form fields; otherwise pages are copied.
  async buildPdf({ markup = true, crop = null } = {}) {
    let output;
    let pages;
    const preserved = this.isOriginalLayout();
    if (preserved) {
      output = await PDFLib.PDFDocument.load(await this.sourceBytes(this.pages[0].source), { updateMetadata: false });
      pages = output.getPages();
    } else {
      output = await PDFLib.PDFDocument.create();
      const copied = new Map();
      for (const source of new Set(this.pages.map((record) => record.source))) {
        const input = await PDFLib.PDFDocument.load(await this.sourceBytes(source), { updateMetadata: false });
        const indices = [...new Set(this.pages.filter((r) => r.source === source).map((r) => r.index))];
        const copies = await output.copyPages(input, indices);
        indices.forEach((index, i) => copied.set(source, (copied.get(source) ?? new Map()).set(index, copies[i])));
      }
      pages = this.pages.map((record) => output.addPage(copied.get(record.source).get(record.index)));
    }
    const font = markup ? await output.embedFont(PDFLib.StandardFonts.Helvetica) : null;
    const images = markup ? await embedAnnotationImages(output, this.pages.map((r) => r.annotations)) : null;
    this.pages.forEach((record, i) => {
      const page = pages[i];
      const rotation = this.rotationOf(record);
      page.setRotation(PDFLib.degrees(rotation));
      const viewport = this.baseViewport(record);
      const toPdf = (x, y) => viewport.convertToPdfPoint(x, y);
      const box = crop?.(record, i);
      if (box) {
        const [x1, y1] = toPdf(box.x, box.y);
        const [x2, y2] = toPdf(box.x + box.w, box.y + box.h);
        page.setCropBox(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      if (markup) {
        drawAnnotationsToPdf(PDFLib, page, record.annotations, toPdf, rotation, font, images);
        addNoteAnnotations(PDFLib, output, page, record.annotations, toPdf);
      }
    });
    await this.applyMetadata(output, preserved);
    await this.applyAttachments(output, preserved);
    return output.save();
  }

  async applyMetadata(output, preserved) {
    const info = preserved ? this.metadataEdits ?? {} : await this.info();
    if (info.Title !== undefined) output.setTitle(info.Title);
    if (info.Author !== undefined) output.setAuthor(info.Author);
    if (info.Subject !== undefined) output.setSubject(info.Subject);
    if (info.Keywords !== undefined) output.setKeywords(info.Keywords.split(/[,;]\s*/).filter(Boolean));
    if (!preserved) {
      output.setCreator(this.cachedInfo?.Creator || "Glance");
      output.setProducer("Glance");
    }
    if (!preserved || this.metadataEdits) output.setModificationDate(new Date());
  }

  // The original file's attachments survive an in-place export untouched; after
  // edits to the list, or when pages were copied, the list is written afresh.
  async applyAttachments(output, preserved) {
    if (preserved && !this.attachmentsChanged) return;
    const attachments = await this.loadAttachments();
    output.catalog.lookupMaybe(PDFLib.PDFName.of("Names"), PDFLib.PDFDict)?.delete(PDFLib.PDFName.of("EmbeddedFiles"));
    for (const file of attachments) {
      await output.attach(file.bytes, file.name, {
        description: file.description || undefined,
        modificationDate: file.modified ? new Date(file.modified) : undefined,
      });
    }
  }

  // Compress by replacing every page with a JPEG of itself. Text stops being selectable.
  async rasterize({ resolution, quality, onProgress }) {
    const output = await PDFLib.PDFDocument.create();
    for (const [i, record] of this.pages.entries()) {
      onProgress?.(i + 1, this.pages.length);
      const jpeg = await output.embedJpg(await this.renderPageImage(i, { resolution, mime: "image/jpeg", quality }));
      const { w, h } = this.baseSize(record);
      output.addPage([w, h]).drawImage(jpeg, { x: 0, y: 0, width: w, height: h });
    }
    return output.save({ useObjectStreams: true });
  }

  // Crops pages to a rectangle in page space. The document is rebuilt with the new
  // crop boxes (rotation baked in) and markup is shifted to match.
  async cropPages(indices, rect) {
    const selected = new Set(indices);
    const boxes = new Map();
    for (const i of selected) {
      const { w, h } = this.baseSize(this.pages[i]);
      const x = Math.max(0, Math.min(rect.x, w - 1));
      const y = Math.max(0, Math.min(rect.y, h - 1));
      boxes.set(i, { x, y, w: Math.min(rect.w, w - x), h: Math.min(rect.h, h - y) });
    }
    const bytes = await this.buildPdf({ markup: false, crop: (_record, i) => boxes.get(i) });
    const source = await PdfDocument.loadSource(bytes);
    const pages = await PdfDocument.pagesOf(source);
    pages.forEach((record, i) => {
      record.annotations = cloneAnnotations(this.pages[i].annotations);
      const box = boxes.get(i);
      if (box) transformAnnotations(record.annotations, (x, y) => [x - box.x, y - box.y]);
    });
    this.sources.add(source);
    this.pages = pages;
    this.clearSearch();
  }

  // ---- Sidebar ------------------------------------------------------------

  renderSidebar(container) {
    this.thumbObserver?.disconnect();
    container.replaceChildren();
    this.thumbs = [];
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this.thumbObserver.unobserve(entry.target);
          this.renderThumb(Number(entry.target.dataset.index));
        }
      },
      { root: container, rootMargin: "400px 0px" },
    );
    this.pages.forEach((record, index) => {
      const item = document.createElement("button");
      item.className = "thumb";
      item.dataset.index = index;
      item.draggable = true;
      item.title = `Page ${index + 1}`;
      const frame = document.createElement("div");
      frame.className = "thumb-frame";
      const { w, h } = this.baseSize(record);
      frame.style.aspectRatio = `${w} / ${h}`;
      const label = document.createElement("span");
      label.className = "thumb-label";
      label.textContent = String(index + 1);
      item.append(frame, label);
      item.addEventListener("click", () => this.app.goToPage(index));
      // Dragging a thumbnail reorders pages here, or copies the page (with its
      // markup) into another Glance window or its Combine list.
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(PAGE_TYPE, String(index));
        startDrag(e, { kind: "pages", indices: [index] }, `Page ${index + 1} of ${this.filePath.split(/[\\/]/).pop()}`);
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
      item.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes(PAGE_TYPE) && !hasDroppable(e.dataTransfer)) return;
        e.preventDefault();
        const below = e.offsetY > item.clientHeight / 2;
        item.classList.toggle("drop-before", !below);
        item.classList.toggle("drop-after", below);
      });
      item.addEventListener("dragleave", () => item.classList.remove("drop-before", "drop-after"));
      item.addEventListener("drop", (e) => {
        item.classList.remove("drop-before", "drop-after");
        e.preventDefault();
        e.stopPropagation();
        const at = index + (e.offsetY > item.clientHeight / 2 ? 1 : 0);
        const raw = e.dataTransfer.getData(PAGE_TYPE);
        let own = false;
        try {
          own = JSON.parse(e.dataTransfer.getData(GLANCE_TYPE) || "{}").instance === INSTANCE;
        } catch {
          own = false;
        }
        if (raw !== "" && own) {
          const from = Number(raw);
          const to = from < at ? at - 1 : at;
          if (from !== to) this.app.movePage(from, to);
          return;
        }
        const sources = readDrop(e.dataTransfer);
        if (sources.length) this.app.insertDropped(sources, at);
      });
      container.append(item);
      this.thumbs.push(item);
      this.thumbObserver.observe(item);
    });
  }

  async renderThumb(index) {
    const record = this.pages[index];
    const item = this.thumbs[index];
    if (!record || !item) return;
    const base = this.baseSize(record);
    const scale = (THUMB_WIDTH * (window.devicePixelRatio || 1)) / base.w;
    const viewport = record.page.getViewport({ scale, rotation: this.rotationOf(record) });
    const canvas = document.createElement("canvas");
    canvas.className = "thumb-canvas";
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    try {
      await record.page.render({ canvasContext: ctx, viewport, ...OFFSCREEN_RENDER }).promise;
    } catch {
      return;
    }
    drawAnnotationsToCanvas(ctx, record.annotations, scale);
    item.querySelector(".thumb-frame").replaceChildren(canvas);
  }

  refreshThumb(index) {
    if (this.thumbs?.[index]?.querySelector("canvas")) this.renderThumb(index);
  }

  markCurrentThumb(index) {
    this.thumbs?.forEach((item, i) => item.classList.toggle("current", i === index));
    const thumb = this.thumbs?.[index];
    if (thumb?.parentElement) scrollWithin(thumb.parentElement, thumb);
  }

  // Page index and base-space rectangles for the current text selection.
  selectionRects() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
    const result = [];
    for (const rect of selection.getRangeAt(0).getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const view = this.views.find((v) => {
        const box = v.el.getBoundingClientRect();
        return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
      });
      if (!view) continue;
      const box = view.el.getBoundingClientRect();
      const scale = box.width / this.baseSize(view.record).w;
      result.push({
        view,
        x: (rect.left - box.left) / scale,
        y: (rect.top - box.top) / scale,
        w: rect.width / scale,
        h: rect.height / scale,
      });
    }
    return result;
  }

  destroy() {
    this.observer?.disconnect();
    this.thumbObserver?.disconnect();
    this.views.forEach((view) => view.task?.cancel());
    this.sources.forEach((source) => source.pdf.destroy());
  }
}
