import { bounds } from "./annotations.js";
import { icon } from "./icons.js";
import { formatBytes } from "./tools.js";

const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
  note: "Note",
  highlight: "Highlight",
  rect: "Rectangle",
  ellipse: "Oval",
  line: "Line",
  arrow: "Arrow",
  pen: "Sketch",
  text: "Text",
  image: "Image",
  check: "Check mark",
  cross: "Cross mark",
  dot: "Dot",
};

// ---------- Sidebar tabs ----------

export function showPanel(name) {
  document.querySelectorAll(".sidebar-tab").forEach((tab) => {
    const active = tab.dataset.panel === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-panel-body]").forEach((el) => (el.hidden = el.dataset.panelBody !== name));
  document.body.dataset.panel = name;
}

// ---------- Comments ----------

// Every piece of markup on every page, in reading order, with the notes' text.
export function renderComments(ctx) {
  const { app } = ctx;
  const panel = $("commentsPanel");
  const doc = app.doc;
  const items = [];
  doc?.pages.forEach((record, pageIndex) => {
    for (const a of record.annotations) {
      const box = bounds(a.points);
      items.push({ a, pageIndex, y: box.y, x: box.x });
    }
  });
  items.sort((p, q) => p.pageIndex - q.pageIndex || p.y - q.y || p.x - q.x);
  $("commentCount").textContent = items.length ? String(items.length) : "";
  if (!items.length) {
    panel.innerHTML = `<p class="panel-empty">No comments yet.<br />Use the markup toolbar to add sticky notes, highlights and drawings.</p>`;
    return;
  }
  const selectedId = app.selection?.id;
  panel.replaceChildren(
    ...items.map(({ a, pageIndex }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "comment-item";
      item.classList.toggle("current", a.id === selectedId);
      item.style.setProperty("--swatch", a.color);
      const meta = document.createElement("div");
      meta.className = "comment-meta";
      const type = document.createElement("span");
      type.className = "comment-type";
      type.textContent = TYPE_LABELS[a.type] ?? a.type;
      const where = document.createElement("span");
      where.textContent = doc.kind === "pdf" ? `Page ${pageIndex + 1}` : "";
      meta.append(type, where);
      item.append(meta);
      const text = a.type === "note" || a.type === "text" ? a.text : "";
      if (text) {
        const body = document.createElement("div");
        body.className = "comment-text";
        body.textContent = text;
        item.append(body);
      }
      if (a.author) {
        const author = document.createElement("div");
        author.className = "comment-meta";
        author.textContent = `${a.author} · ${new Date(a.modified || a.created).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
        item.append(author);
      }
      item.onclick = () => ctx.revealAnnotation(pageIndex, a.id);
      return item;
    }),
  );
}

// ---------- Attachments ----------

export async function renderAttachments(ctx) {
  const { app } = ctx;
  const panel = $("attachmentsPanel");
  const doc = app.doc;
  if (doc?.kind !== "pdf") {
    panel.replaceChildren();
    return;
  }
  const attachments = await doc.loadAttachments();
  if (app.doc !== doc) return;
  $("attachmentCount").textContent = attachments.length ? String(attachments.length) : "";
  const list = attachments.map((file, index) => {
    const row = document.createElement("div");
    row.className = "attachment-item";
    row.innerHTML = `${icon("paperclip")}<span class="attachment-name"></span><small></small>
      <button type="button" class="tool small" data-save title="Save a copy…" aria-label="Save a copy">${icon("save")}</button>
      <button type="button" class="tool small" data-remove title="Remove from PDF" aria-label="Remove from PDF">${icon("trash")}</button>`;
    row.querySelector(".attachment-name").textContent = file.name;
    row.querySelector(".attachment-name").title = file.description || file.name;
    row.querySelector("small").textContent = formatBytes(file.bytes.length);
    row.querySelector("[data-save]").onclick = () => saveAttachment(ctx, file);
    const remove = row.querySelector("[data-remove]");
    remove.disabled = !app.permissions.edit;
    remove.onclick = () => {
      doc.removeAttachment(index);
      app.markDirty();
      renderAttachments(ctx);
      ctx.setMessage(`Removed ${file.name}. Export to save the change.`);
    };
    return row;
  });
  const empty = document.createElement("p");
  empty.className = "panel-empty";
  empty.textContent = "No files are attached to this PDF.";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "button";
  add.innerHTML = `${icon("paperclip")} Attach files…`;
  add.disabled = !app.permissions.edit;
  add.onclick = () => addAttachments(ctx);
  panel.replaceChildren(...(list.length ? list : [empty]), add);
}

async function saveAttachment(ctx, file) {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  const target = await window.glance.saveDialog({
    defaultPath: file.name,
    filters: ext ? [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }, { name: "All files", extensions: ["*"] }] : [{ name: "All files", extensions: ["*"] }],
  });
  if (!target) return;
  try {
    await window.glance.writeFile(target, file.bytes);
    ctx.setMessage(`Saved ${target.split(/[\\/]/).pop()}`);
  } catch (err) {
    ctx.showError("Couldn't save the attachment", err);
  }
}

async function addAttachments(ctx) {
  const doc = ctx.app.doc;
  try {
    const files = await window.glance.pickAttachments();
    if (!files.length) return;
    await doc.loadAttachments();
    files.forEach((file) => doc.addAttachment(file));
    ctx.app.markDirty();
    renderAttachments(ctx);
    ctx.setMessage(`Attached ${files.length} file${files.length === 1 ? "" : "s"}. Export to save them in the PDF.`);
  } catch (err) {
    ctx.showError("Couldn't attach the file", err);
  }
}
