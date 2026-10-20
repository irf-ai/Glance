import * as PDFLib from "app://glance/pdf-lib/pdf-lib.esm.js";

// ---- Page layout for images placed into PDFs ----

export const PAGE_SIZES = { fit: null, a4: [595.28, 841.89], letter: [612, 792] };
export const MARGINS = { none: 0, small: 20, large: 50 };
const PX_TO_PT = 0.75; // 96 dpi screen pixels → 72 dpi PDF points

// Reads the EXIF orientation of a JPEG (1 = upright). Returns 1 when absent.
function jpegOrientation(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1;
    offset += 2 + length;
  }
  return 1;
}

async function reencode(bytes, mime, quality) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (mime === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// Embeds any browser-readable image. JPEG and PNG go in untouched unless a JPEG
// needs its EXIF rotation applied; other formats are converted to PNG.
export async function embedImage(pdfDoc, bytes, name) {
  const lower = name.toLowerCase();
  if (/\.jpe?g$/.test(lower)) {
    const upright = jpegOrientation(bytes) === 1 ? bytes : await reencode(bytes, "image/jpeg", 0.92);
    return pdfDoc.embedJpg(upright);
  }
  if (lower.endsWith(".png")) return pdfDoc.embedPng(bytes);
  return pdfDoc.embedPng(await reencode(bytes, "image/png"));
}

export function addImagePage(pdfDoc, image, { pageSize = "fit", orientation = "auto", margin = "small" } = {}) {
  const gap = MARGINS[margin] ?? 0;
  const imageW = image.width * PX_TO_PT;
  const imageH = image.height * PX_TO_PT;
  let pageW;
  let pageH;
  // pageSize is "fit", a named size, or an explicit [width, height] in points.
  const fixed = Array.isArray(pageSize) ? pageSize : PAGE_SIZES[pageSize];
  if (!fixed) {
    pageW = imageW + gap * 2;
    pageH = imageH + gap * 2;
  } else {
    [pageW, pageH] = [Math.min(...fixed), Math.max(...fixed)];
    const landscape = orientation === "landscape" || (orientation === "auto" && imageW > imageH);
    if (landscape) [pageW, pageH] = [pageH, pageW];
  }
  const scale = Math.min((pageW - gap * 2) / imageW, (pageH - gap * 2) / imageH);
  const width = imageW * scale;
  const height = imageH * scale;
  const page = pdfDoc.addPage([pageW, pageH]);
  page.drawImage(image, { x: (pageW - width) / 2, y: (pageH - height) / 2, width, height });
}

// ---- Combine ----

// items: [{ name, kind: "pdf" | "image", bytes }] in output order.
export async function combine(items, layout, onProgress) {
  const output = await PDFLib.PDFDocument.create();
  for (const [i, item] of items.entries()) {
    onProgress?.(i + 1, items.length, item.name);
    if (item.kind === "pdf") {
      const input = await PDFLib.PDFDocument.load(item.bytes, { ignoreEncryption: true });
      if (input.isEncrypted) throw new Error(`${item.name} is password-protected.`);
      const pages = await output.copyPages(input, input.getPageIndices());
      pages.forEach((page) => output.addPage(page));
    } else {
      addImagePage(output, await embedImage(output, item.bytes, item.name), layout);
    }
  }
  return output.save();
}

// ---- Split ----

// Parses "1-3, 5, 8-" into page-index groups. Throws a readable error on bad input.
export function parseRanges(text, pageCount) {
  const groups = [];
  for (const part of text.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const match = part.match(/^(\d*)\s*(?:-\s*(\d*))?$/);
    if (!match || (!match[1] && !match[2])) throw new Error(`"${part}" isn't a page or range.`);
    const isRange = part.includes("-");
    const start = match[1] ? Number(match[1]) : 1;
    const end = isRange ? (match[2] ? Number(match[2]) : pageCount) : start;
    if (start < 1 || end > pageCount || start > end) {
      throw new Error(`"${part}" is outside pages 1–${pageCount}.`);
    }
    groups.push({ label: start === end ? String(start) : `${start}-${end}`, indices: Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i) });
  }
  if (!groups.length) throw new Error("Enter at least one page or range.");
  return groups;
}

export function everyNPages(n, pageCount) {
  const groups = [];
  for (let start = 0; start < pageCount; start += n) {
    const end = Math.min(start + n, pageCount);
    groups.push({
      label: end - start === 1 ? String(start + 1) : `${start + 1}-${end}`,
      indices: Array.from({ length: end - start }, (_, i) => start + i),
    });
  }
  return groups;
}

export async function extractGroups(bytes, groups) {
  const input = await PDFLib.PDFDocument.load(bytes);
  const files = [];
  for (const group of groups) {
    const output = await PDFLib.PDFDocument.create();
    const pages = await output.copyPages(input, group.indices);
    pages.forEach((page) => output.addPage(page));
    files.push({ label: group.label, bytes: await output.save() });
  }
  return files;
}

// ---- Text and Markdown ----

const BULLET = /^[•◦▪▫●○■□‣⁃–—*-]\s+/;
const NUMBERED = /^\d{1,3}[.)]\s+/;

// Groups pdf.js text items into visual lines with their font size and baseline.
function toLines(items) {
  const lines = [];
  let line = null;
  for (const item of items) {
    if (item.str === undefined) continue;
    const [, , c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || item.height || 10;
    if (item.str !== "") {
      if (!line || Math.abs(line.y - y) > size * 0.5) {
        line = { text: "", y, size, end: x };
        lines.push(line);
      } else if (x - line.end > size * 0.2 && !/\s$/.test(line.text) && !/^\s/.test(item.str)) {
        line.text += " ";
      }
      line.text += item.str;
      line.size = Math.max(line.size, size);
      line.end = x + item.width;
    }
    if (item.hasEOL) line = null;
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
}

// The most common font size, weighted by characters, is treated as body text.
function bodySize(lines) {
  const weights = new Map();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + line.text.length);
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

function headingLevel(line, body) {
  if (line.text.length > 120) return 0;
  const ratio = line.size / body;
  if (ratio >= 1.6) return 1;
  if (ratio >= 1.3) return 2;
  if (ratio >= 1.12) return 3;
  return 0;
}

function joinWrapped(paragraph, next) {
  if (/[A-Za-z]-$/.test(paragraph) && /^[a-z]/.test(next)) return paragraph.slice(0, -1) + next;
  return `${paragraph} ${next}`;
}

const escapeMarkdown = (text) => text.replace(/^([#>+]|\d+\.(?=\s))/, "\\$1");

// Reads each page's text as structured blocks, guessing headings from font
// size and list items from leading symbols, and reflowing wrapped lines:
//   { type: "heading", level, text } | { type: "bullet" | "numbered" | "paragraph", text }
// Each page also keeps `plain`: its original lines, with blank lines between paragraphs.
export async function extractBlocks(records) {
  const pages = [];
  const allLines = [];
  for (const record of records) {
    const content = await record.page.getTextContent();
    const lines = toLines(content.items);
    pages.push(lines);
    allLines.push(...lines);
  }
  const body = bodySize(allLines);
  return pages.map((lines) => {
    const blocks = [];
    const plain = [];
    let paragraph = null;
    let previous = null;
    const flush = () => {
      if (paragraph) blocks.push(paragraph);
      paragraph = null;
    };
    for (const line of lines) {
      const gap = previous ? previous.y - line.y : 0;
      const newParagraph = !previous || gap > previous.size * 1.8 || gap < 0;
      previous = line;
      if (newParagraph && plain.length) plain.push("");
      plain.push(line.text);
      const level = headingLevel(line, body);
      if (level) {
        flush();
        blocks.push({ type: "heading", level, text: line.text });
      } else if (BULLET.test(line.text)) {
        flush();
        paragraph = { type: "bullet", text: line.text.replace(BULLET, "") };
      } else if (NUMBERED.test(line.text)) {
        flush();
        paragraph = { type: "numbered", text: line.text };
      } else if (newParagraph || !paragraph) {
        flush();
        paragraph = { type: "paragraph", text: line.text };
      } else {
        paragraph.text = joinWrapped(paragraph.text, line.text);
      }
    }
    flush();
    return { blocks, plain: plain.join("\n") };
  });
}

function blockToMarkdown(block) {
  if (block.type === "heading") return `${"#".repeat(block.level)} ${block.text}`;
  if (block.type === "bullet") return `- ${escapeMarkdown(block.text)}`;
  if (block.type === "numbered") return block.text;
  return escapeMarkdown(block.text);
}

// Plain text keeps the page's line breaks; Markdown reflows paragraphs and
// marks headings and list items.
export async function extractText(records, { markdown }) {
  const pages = await extractBlocks(records);
  const output = pages.map((page) => (markdown ? page.blocks.map(blockToMarkdown).join("\n\n") : page.plain));
  return `${output.join(markdown ? "\n\n---\n\n" : "\n\n\f\n\n").trim()}\n`;
}

// ---- Compare ----

const normalizeWord = (word) => word.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Splits each page's text into words. `viewportFor(record)` gives the page's
// base viewport so each word gets a box in page space (approximate: glyph
// widths are spread evenly across a text run).
export async function documentWords(records, viewportFor) {
  const words = [];
  for (const [pageIndex, record] of records.entries()) {
    const viewport = viewportFor?.(record);
    const content = await record.page.getTextContent();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const [a, b, c, d, e, f] = item.transform;
      const height = item.height || Math.hypot(c, d) || 10;
      const horizontal = Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3 && a > 0;
      for (const match of item.str.matchAll(/\S+/g)) {
        const word = { text: match[0], key: normalizeWord(match[0]), pageIndex, record };
        if (viewport && horizontal) {
          const x1 = e + (item.width * match.index) / item.str.length;
          const x2 = e + (item.width * (match.index + match[0].length)) / item.str.length;
          const [px1, py1] = viewport.convertToViewportPoint(x1, f - height * 0.22);
          const [px2, py2] = viewport.convertToViewportPoint(x2, f + height * 0.88);
          word.box = { x: Math.min(px1, px2), y: Math.min(py1, py2), w: Math.abs(px2 - px1), h: Math.abs(py2 - py1) };
        }
        words.push(word);
      }
    }
  }
  return words;
}

// Myers' O(ND) diff on word keys. Returns ["=", "-", "+"] operations as runs
// {op, a: [start, end), b: [start, end)}. Throws when the documents differ by
// more than maxEdits words, to keep time and memory bounded.
function myers(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, v, d, n, m, offset);
    }
  }
  throw new Error("These documents are too different to compare word by word.");
}

function backtrack(trace, last, d, n, m, offset) {
  const ops = [];
  let x = n;
  let y = m;
  trace.push(last);
  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const k = x - y;
    const prevK = k === -step || (k !== step && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push(["=", --x, --y]);
    if (x === prevX) ops.push(["+", x, --y]);
    else ops.push(["-", --x, y]);
  }
  while (x > 0 && y > 0) ops.push(["=", --x, --y]);
  return ops.reverse();
}

// Compares two word lists and groups the differences into hunks:
// { removed: words only in A, added: words only in B, anchor: word in A to mark }.
export function compareWords(wordsA, wordsB, { maxEdits = 4000 } = {}) {
  const a = wordsA.map((w) => w.key);
  const b = wordsB.map((w) => w.key);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = myers(a.slice(start, endA), b.slice(start, endB), maxEdits).map(([op, i, j]) => [op, i + start, j + start]);
  const hunks = [];
  let hunk = null;
  for (const [op, i, j] of ops) {
    if (op === "=") {
      hunk = null;
      continue;
    }
    if (!hunk) {
      hunk = { removed: [], added: [], beforeA: i - 1, afterA: i, pageB: wordsB[j]?.pageIndex ?? wordsB.at(-1)?.pageIndex ?? 0 };
      hunks.push(hunk);
    }
    if (op === "-") hunk.removed.push(wordsA[i]);
    else hunk.added.push(wordsB[j]);
  }
  for (const h of hunks) {
    h.anchor = h.removed[0] ?? wordsA[h.beforeA] ?? wordsA[h.afterA] ?? null;
    h.pageA = h.anchor?.pageIndex ?? 0;
    h.context = [wordsA[h.beforeA - 1], wordsA[h.beforeA]].filter(Boolean).map((w) => w.text).join(" ");
  }
  return { hunks, wordsA: a.length, wordsB: b.length };
}

// ---- Images for markup ----

// Loads image bytes into a PNG data URL no larger than maxSide pixels.
export async function imageBytesToDataUrl(bytes, maxSide = 2000) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { src: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

// Crops a canvas to its non-transparent pixels (plus padding) and returns a PNG data URL.
export function trimCanvas(canvas, padding = 6) {
  const ctx = canvas.getContext("2d");
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/png"), width: out.width, height: out.height };
}

export function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
