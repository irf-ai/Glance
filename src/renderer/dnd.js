// Dragging pages, images and whole documents between Glance windows.
// A drag carries a small token; the window it's dropped on asks the source
// window (through the main process) for the bytes, so the source's markup and
// edits come along. Files dragged from Explorer are read from disk.

import { extractGroups } from "./tools.js";

export const GLANCE_TYPE = "application/x-glance";
export const PAGE_TYPE = "application/x-glance-page";
export const INSTANCE = crypto.randomUUID();

const SUPPORTED = /\.(pdf|png|jpe?g|gif|bmp|webp|avif|ico)$/i;
const registry = new Map(); // token → what to provide: { kind: "pages", indices } | { kind: "image" } | { kind: "file", path } | { kind: "whole" }

const stem = (filePath) => filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");

// Call from a dragstart handler.
export function startDrag(event, spec, label) {
  const token = crypto.randomUUID();
  registry.set(token, spec);
  if (registry.size > 200) registry.delete(registry.keys().next().value);
  window.glance.registerDrag(token);
  event.dataTransfer.setData(GLANCE_TYPE, JSON.stringify({ token, instance: INSTANCE, label }));
  event.dataTransfer.effectAllowed = "copyMove";
}

export function hasDroppable(transfer) {
  return transfer.types.includes(GLANCE_TYPE) || transfer.types.includes("Files");
}

// Reads everything usable from a drop synchronously (the data is gone once the
// handler returns). Drags from this same window are skipped.
export function readDrop(transfer, { includeOwn = false } = {}) {
  const sources = [];
  const raw = transfer.getData(GLANCE_TYPE);
  if (raw) {
    try {
      const drag = JSON.parse(raw);
      if (includeOwn || drag.instance !== INSTANCE) sources.push({ token: drag.token, label: drag.label, own: drag.instance === INSTANCE });
    } catch {
      // Not a Glance drag after all.
    }
  }
  for (const file of transfer.files) {
    const filePath = window.glance.pathForFile(file) || file.path;
    if (filePath && SUPPORTED.test(filePath)) sources.push({ path: filePath, label: filePath.split(/[\\/]/).pop() });
  }
  return sources;
}

// → { kind: "pdf" | "image", name, bytes }
export async function resolveSource(source) {
  if (source.path) {
    const bytes = await window.glance.readFile(source.path);
    return { kind: source.path.toLowerCase().endsWith(".pdf") ? "pdf" : "image", name: source.path.split(/[\\/]/).pop(), bytes };
  }
  if (source.own) return provide(currentDoc(), registry.get(source.token));
  return window.glance.fetchDrag(source.windowId !== undefined ? { windowId: source.windowId } : { token: source.token });
}

let currentDoc = () => null;
let currentPermissions = () => ({ edit: true });

// Answers other windows' requests for what was dragged out of this one.
export function installDragProvider(getDoc, getPermissions) {
  currentDoc = getDoc;
  currentPermissions = getPermissions;
  window.glance.onDragRequest(({ token, whole }) => provide(getDoc(), whole ? { kind: "whole" } : registry.get(token)));
}

async function provide(doc, spec) {
  if (!doc) throw new Error("Nothing is open in that window.");
  if (!spec) throw new Error("That drag has expired. Drag it again.");
  if (spec.kind === "file") {
    const bytes = await window.glance.readFile(spec.path);
    return { kind: spec.path.toLowerCase().endsWith(".pdf") ? "pdf" : "image", name: spec.path.split(/[\\/]/).pop(), bytes };
  }
  if (!currentPermissions().edit) throw new Error(`The owner of ${doc.filePath.split(/[\\/]/).pop()} doesn't allow its pages to be reused.`);
  if (doc.kind === "image") return { kind: "image", name: `${stem(doc.filePath)}.png`, bytes: await doc.export("png") };
  const bytes = await doc.buildPdf();
  if (spec.kind === "whole") return { kind: "pdf", name: doc.filePath.split(/[\\/]/).pop(), bytes };
  const [file] = await extractGroups(bytes, [{ label: "pages", indices: spec.indices }]);
  const pages = spec.indices.map((i) => i + 1).join(", ");
  return { kind: "pdf", name: `${stem(doc.filePath)} (page ${pages}).pdf`, bytes: file.bytes };
}
