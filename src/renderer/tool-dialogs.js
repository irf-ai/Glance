import { newId } from "./annotations.js";
import { hasDroppable, readDrop, resolveSource } from "./dnd.js";
import { icon } from "./icons.js";
import { encryptPdf } from "./pdf-crypto.js";
import { PdfDocument } from "./pdf-doc.js";
import { printDocument } from "./viewing.js";
import {
  combine,
  compareWords,
  documentWords,
  everyNPages,
  extractGroups,
  formatBytes,
  imageBytesToDataUrl,
  parseRanges,
  trimCanvas,
} from "./tools.js";

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|avif|ico)$/i;
const SIGNATURE_KEY = "glance.lastSignature";

const fileName = (filePath) => filePath.split(/[\\/]/).pop();
const folderOf = (filePath) => filePath.replace(/[\\/][^\\/]*$/, "");
const stemOf = (filePath) => fileName(filePath).replace(/\.[^.]+$/, "");

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// Builds a modal <dialog> with a form; resolves true when confirmed.
function modal({ title, body, ok, wide = false, onReady }) {
  const dialog = document.createElement("dialog");
  dialog.className = `dialog${wide ? " wide" : ""}`;
  dialog.innerHTML = `
    <form method="dialog">
      <h2>${escapeHtml(title)}</h2>
      ${body}
      <p class="dialog-note dialog-error" role="alert"></p>
      <div class="dialog-actions">
        <button class="button" value="cancel" formnovalidate>Cancel</button>
        <button class="button primary" value="ok" data-ok>${escapeHtml(ok)}</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const q = (selector) => dialog.querySelector(selector);
  const fail = (message) => (q(".dialog-error").textContent = message);
  let validate = () => true;
  const api = { dialog, q, fail, setValidator: (fn) => (validate = fn) };
  dialog.addEventListener("input", () => fail(""));
  dialog.addEventListener("change", () => fail(""));
  onReady?.(api);
  dialog.querySelector("form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "ok") return;
    fail("");
    try {
      if (validate() === false) e.preventDefault();
    } catch (err) {
      e.preventDefault();
      fail(err.message);
    }
  });
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        resolve({ ok: dialog.returnValue === "ok", ...api });
        setTimeout(() => dialog.remove(), 0);
      },
      { once: true },
    );
    dialog.showModal();
  });
}

// ---------- Combine ----------

export async function combineDialog(ctx) {
  const { app } = ctx;
  const items = [];
  if (app.doc && app.permissions.edit) items.push({ current: true, name: fileName(app.doc.filePath), kind: app.doc.kind === "pdf" ? "pdf" : "image" });

  const kindOf = (name) => (name.toLowerCase().endsWith(".pdf") ? "pdf" : IMAGE_EXT.test(name) ? "image" : "page");
  const addPaths = (paths, at = items.length) => {
    const added = paths.filter((p) => kindOf(p) !== "page").map((filePath) => ({ path: filePath, name: fileName(filePath), kind: kindOf(filePath) }));
    items.splice(at, 0, ...added);
  };
  // Drops from Explorer or from other Glance windows (pages, images, whole documents).
  const addDropped = (sources, at = items.length) => {
    const added = sources.map((source) =>
      source.path ? { path: source.path, name: source.label, kind: kindOf(source.path) } : { source, name: source.label, kind: kindOf(source.label) },
    );
    items.splice(at, 0, ...added);
  };

  const result = await modal({
    title: "Combine files into PDF",
    ok: "Combine…",
    wide: true,
    body: `
      <p class="dialog-note">PDFs keep all their pages. Each image becomes one page. Drop files from Explorer, or pages and images from other Glance windows, into the list. Drag items or use the arrows to set the order.</p>
      <ol class="file-list" data-list></ol>
      <div class="dialog-buttons">
        <button type="button" class="button" data-add>${icon("file-plus")} Add files…</button>
        <button type="button" class="button" data-open-docs>${icon("combine")} Add open documents</button>
      </div>
      <fieldset class="image-options" data-image-options>
        <legend>Image pages</legend>
        <div class="field-row">
          <label class="field"><span>Page size</span>
            <select data-size><option value="fit">Same as image</option><option value="a4">A4</option><option value="letter">Letter</option></select></label>
          <label class="field"><span>Orientation</span>
            <select data-orientation><option value="auto">Automatic</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
          <label class="field"><span>Margin</span>
            <select data-margin><option value="none">None</option><option value="small" selected>Small</option><option value="large">Large</option></select></label>
        </div>
      </fieldset>`,
    onReady: ({ q, setValidator }) => {
      const list = q("[data-list]");
      let dragFrom = null;
      const render = () => {
        list.replaceChildren(
          ...items.map((item, i) => {
            const li = document.createElement("li");
            li.draggable = true;
            const badge = { pdf: "PDF", image: "IMG", page: "PAGE" }[item.kind] ?? "PDF";
            const from = item.current ? " <em>(open now, with your edits)</em>" : item.source ? " <em>(from another Glance window, with its edits)</em>" : "";
            li.innerHTML = `
              <span class="file-kind ${item.kind}">${badge}</span>
              <span class="file-name" title="${escapeHtml(item.path ?? item.name)}">${escapeHtml(item.name)}${from}</span>
              <button type="button" class="tool small" data-up title="Move up" aria-label="Move up">${icon("chevron-up")}</button>
              <button type="button" class="tool small" data-down title="Move down" aria-label="Move down">${icon("chevron-down")}</button>
              <button type="button" class="tool small" data-remove title="Remove" aria-label="Remove">${icon("close")}</button>`;
            const move = (to) => {
              if (to < 0 || to >= items.length) return;
              items.splice(to, 0, items.splice(i, 1)[0]);
              render();
            };
            li.querySelector("[data-up]").onclick = () => move(i - 1);
            li.querySelector("[data-down]").onclick = () => move(i + 1);
            li.querySelector("[data-remove]").onclick = () => {
              items.splice(i, 1);
              render();
            };
            li.ondragstart = () => (dragFrom = i);
            li.ondragend = () => (dragFrom = null);
            li.ondragover = (e) => e.preventDefault();
            li.ondrop = (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragFrom !== null) {
                if (dragFrom !== i) items.splice(i, 0, items.splice(dragFrom, 1)[0]);
                dragFrom = null;
              } else {
                addDropped(readDrop(e.dataTransfer), i);
              }
              render();
            };
            return li;
          }),
        );
        if (!items.length) list.innerHTML = `<li class="empty-list">No files yet. Add PDFs or images.</li>`;
        q("[data-image-options]").hidden = !items.some((item) => item.kind === "image");
        q("[data-ok]").disabled = !items.length;
      };
      q("[data-add]").onclick = async () => {
        addPaths(await window.glance.openDialog("any"));
        render();
      };
      q("[data-open-docs]").onclick = async () => {
        const docs = await window.glance.openDocuments();
        const fresh = docs.filter((d) => !items.some((item) => item.source?.windowId === d.windowId));
        if (!fresh.length) {
          ctx.setMessage(docs.length ? "Those documents are already in the list." : "No other Glance windows have a document open.");
          return;
        }
        fresh.forEach((d) => items.push({ source: { windowId: d.windowId, label: d.name }, name: d.name, kind: kindOf(d.name) }));
        render();
      };
      list.ondragover = (e) => {
        if (dragFrom !== null || hasDroppable(e.dataTransfer)) e.preventDefault();
      };
      list.ondrop = (e) => {
        e.preventDefault();
        if (dragFrom !== null) {
          items.push(items.splice(dragFrom, 1)[0]);
          dragFrom = null;
        } else {
          addDropped(readDrop(e.dataTransfer));
        }
        render();
      };
      q("[data-size]").onchange = () => (q("[data-orientation]").disabled = q("[data-size]").value === "fit");
      q("[data-orientation]").disabled = true;
      setValidator(() => {
        if (!items.length) throw new Error("Add at least one file.");
      });
      render();
    },
  });
  if (!result.ok) return;

  const layout = {
    pageSize: result.q("[data-size]").value,
    orientation: result.q("[data-orientation]").value,
    margin: result.q("[data-margin]").value,
  };
  const firstPath = items.find((item) => item.path)?.path ?? app.doc?.filePath;
  const target = await window.glance.saveDialog({
    defaultPath: firstPath ? `${folderOf(firstPath)}\\Combined.pdf` : "Combined.pdf",
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (!target) return;
  try {
    const loaded = [];
    for (const item of items) {
      ctx.setMessage(`Reading ${item.name}…`, { sticky: true });
      if (item.current) {
        const bytes = await app.doc.export(item.kind === "pdf" ? "pdf" : "png", 1);
        loaded.push({ ...item, name: item.kind === "pdf" ? item.name : `${stemOf(item.name)}.png`, bytes });
      } else if (item.source) {
        const payload = await resolveSource(item.source);
        loaded.push({ ...item, kind: payload.kind, name: payload.name, bytes: payload.bytes });
      } else {
        loaded.push({ ...item, bytes: await window.glance.readFile(item.path) });
      }
    }
    const bytes = await combine(loaded, layout, (n, total) => ctx.setMessage(`Combining ${n} of ${total}…`, { sticky: true }));
    await window.glance.writeFile(target, bytes);
    ctx.setMessage(`Combined ${items.length} file${items.length === 1 ? "" : "s"} into ${fileName(target)}`);
    ctx.openResult(target);
  } catch (err) {
    ctx.showError("Couldn't combine files", err);
  }
}

// ---------- Split ----------

export async function splitDialog(ctx) {
  const doc = ctx.app.doc;
  if (doc?.kind !== "pdf") return;
  const count = doc.pageCount();
  const result = await modal({
    title: "Split PDF",
    ok: "Split…",
    body: `
      <p class="dialog-note">Uses the document as it is now, including markup and page changes. ${count} pages.</p>
      <label class="radio"><input type="radio" name="mode" value="ranges" checked /> One PDF per range</label>
      <label class="radio"><input type="radio" name="mode" value="every" /> A new PDF every
        <input type="number" class="inline-number" data-every min="1" max="${count}" value="1" /> page(s)</label>
      <label class="radio"><input type="radio" name="mode" value="extract" /> Extract pages into one PDF</label>
      <label class="field" data-ranges-field><span>Pages</span>
        <input type="text" data-ranges value="1-${count}" placeholder="e.g. 1-3, 5, 8-" spellcheck="false" /></label>
      <p class="dialog-note">Separate ranges with commas. "8-" means page 8 to the end.</p>`,
    onReady: ({ q, dialog, setValidator }) => {
      const mode = () => dialog.querySelector("input[name=mode]:checked").value;
      const sync = () => (q("[data-ranges-field]").hidden = mode() === "every");
      dialog.querySelectorAll("input[name=mode]").forEach((radio) => (radio.onchange = sync));
      q("[data-every]").onfocus = () => (dialog.querySelector("input[value=every]").checked = true) && sync();
      setValidator(() => {
        if (mode() === "every") {
          const n = Number(q("[data-every]").value);
          if (!(n >= 1 && n <= count)) throw new Error(`Choose between 1 and ${count} pages.`);
        } else {
          parseRanges(q("[data-ranges]").value, count);
        }
      });
    },
  });
  if (!result.ok) return;
  const mode = result.dialog.querySelector("input[name=mode]:checked").value;
  const stem = stemOf(doc.filePath);
  try {
    let groups =
      mode === "every" ? everyNPages(Number(result.q("[data-every]").value), count) : parseRanges(result.q("[data-ranges]").value, count);
    if (mode === "extract") {
      groups = [{ label: "extract", indices: [...new Set(groups.flatMap((g) => g.indices))] }];
      const target = await window.glance.saveDialog({
        defaultPath: `${folderOf(doc.filePath)}\\${stem}-extract.pdf`,
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
      });
      if (!target) return;
      ctx.setMessage("Extracting pages…", { sticky: true });
      const [file] = await extractGroups(await doc.buildPdf(), groups);
      await window.glance.writeFile(target, file.bytes);
      ctx.setMessage(`Saved ${groups[0].indices.length} pages to ${fileName(target)}`);
      return;
    }
    const folder = await window.glance.chooseFolder();
    if (!folder) return;
    ctx.setMessage("Splitting…", { sticky: true });
    const files = await extractGroups(await doc.buildPdf(), groups);
    for (const file of files) await window.glance.writeInFolder(folder, `${stem}-pages-${file.label}.pdf`, file.bytes);
    ctx.setMessage(`Saved ${files.length} PDF${files.length === 1 ? "" : "s"} to ${fileName(folder) || folder}`);
  } catch (err) {
    ctx.showError("Couldn't split the PDF", err);
  }
}

// ---------- Compress ----------

const COMPRESSION = {
  light: null,
  strong: { resolution: 150, quality: 0.7 },
  extreme: { resolution: 96, quality: 0.5 },
};

export async function compressDialog(ctx) {
  const doc = ctx.app.doc;
  if (doc?.kind !== "pdf") return;
  const result = await modal({
    title: "Compress PDF",
    ok: "Compress…",
    body: `
      <label class="radio stacked"><input type="radio" name="level" value="light" checked />
        <span><strong>Light</strong><small>Tidies the file structure. Text stays selectable; savings are usually small.</small></span></label>
      <label class="radio stacked"><input type="radio" name="level" value="strong" />
        <span><strong>Strong</strong><small>Turns each page into a 150 dpi JPEG. Much smaller, but text can't be selected or searched.</small></span></label>
      <label class="radio stacked"><input type="radio" name="level" value="extreme" />
        <span><strong>Extreme</strong><small>96 dpi at lower quality. Smallest file; fine print may blur.</small></span></label>`,
  });
  if (!result.ok) return;
  const level = result.dialog.querySelector("input[name=level]:checked").value;
  try {
    ctx.setMessage("Measuring the current file…", { sticky: true });
    const current = await doc.buildPdf();
    const before = doc.isOriginalLayout() && !doc.pages.some((p) => p.annotations.length) ? doc.pages[0].source.bytes.length : current.length;
    const settings = COMPRESSION[level];
    const compressed = settings
      ? await doc.rasterize({ ...settings, onProgress: (n, total) => ctx.setMessage(`Compressing page ${n} of ${total}…`, { sticky: true }) })
      : current;
    if (compressed.length >= before) {
      ctx.setMessage(
        `This PDF is already compact (${formatBytes(before)}); ${level} compression would give ${formatBytes(compressed.length)}. Nothing saved.`,
        { error: true },
      );
      return;
    }
    const target = await window.glance.saveDialog({
      defaultPath: `${folderOf(doc.filePath)}\\${stemOf(doc.filePath)}-compressed.pdf`,
      filters: [{ name: "PDF document", extensions: ["pdf"] }],
    });
    if (!target) return ctx.setMessage("");
    await window.glance.writeFile(target, compressed);
    const saving = Math.round((1 - compressed.length / before) * 100);
    ctx.setMessage(`Saved ${fileName(target)}: ${formatBytes(before)} → ${formatBytes(compressed.length)} (${saving}% smaller)`);
  } catch (err) {
    ctx.showError("Couldn't compress the PDF", err);
  }
}

// ---------- Signature ----------

// Saved signatures live in this computer's Glance profile:
// [{ id, name, src, width, height, created, lastUsed }], most recently used first.
const SIGNATURES_KEY = "glance.signatures";
const MAX_SIGNATURES = 20;

export function loadSignatures() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(SIGNATURES_KEY)) ?? [];
    // Glance 1.1–1.2 remembered only the last signature; keep it as a preset.
    const legacy = JSON.parse(localStorage.getItem(SIGNATURE_KEY));
    if (legacy?.src && !list.some((s) => s.src === legacy.src)) {
      list.push({ id: newId(), name: "My signature", src: legacy.src, width: legacy.width, height: legacy.height, created: Date.now(), lastUsed: Date.now() });
      localStorage.setItem(SIGNATURES_KEY, JSON.stringify(list));
      localStorage.removeItem(SIGNATURE_KEY);
    }
  } catch {
    // Unreadable storage: start with an empty list.
  }
  return list.filter((s) => typeof s?.src === "string" && s.src.startsWith("data:image/")).sort((a, b) => b.lastUsed - a.lastUsed);
}

function storeSignatures(list) {
  try {
    localStorage.setItem(SIGNATURES_KEY, JSON.stringify(list.slice(0, MAX_SIGNATURES)));
    return true;
  } catch {
    return false;
  }
}

function uniqueName(name, list) {
  const base = name.trim() || "Signature";
  let candidate = base;
  for (let n = 2; list.some((s) => s.name === candidate); n++) candidate = `${base} (${n})`;
  return candidate;
}

// Makes near-white pixels transparent, for photographed or scanned signatures.
function removeWhite(canvas) {
  const ctx = canvas.getContext("2d");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const lightness = Math.min(d[i], d[i + 1], d[i + 2]);
    if (lightness > 200) d[i + 3] = Math.max(0, 255 - (lightness - 200) * 4.6);
  }
  ctx.putImageData(image, 0, 0);
}

export async function signatureDialog(ctx) {
  if (!ctx.app.doc) return;
  let signatures = loadSignatures();
  let selectedId = signatures[0]?.id ?? null;
  let uploaded = null;
  let drawn = false;
  const startTab = signatures.length ? "saved" : "draw";
  const result = await modal({
    title: "Add signature",
    ok: "Place signature",
    wide: true,
    body: `
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" data-tab="saved">My signatures</button>
        <button type="button" role="tab" class="tab" data-tab="draw">Draw</button>
        <button type="button" role="tab" class="tab" data-tab="type">Type</button>
        <button type="button" role="tab" class="tab" data-tab="image">Image</button>
      </div>
      <div class="tab-panel" data-panel="saved">
        <div class="signature-grid" data-grid></div>
        <p class="dialog-note">Double-click a signature to place it. Click a name to rename it.</p>
      </div>
      <div class="tab-panel" data-panel="draw">
        <canvas class="signature-pad" data-pad width="1040" height="320"></canvas>
        <div class="pad-actions"><span class="dialog-note">Sign with your mouse, pen or finger.</span>
          <button type="button" class="button" data-clear>Clear</button></div>
      </div>
      <div class="tab-panel" data-panel="type" hidden>
        <label class="field"><span>Your name</span><input type="text" data-name placeholder="Type your name" /></label>
        <label class="field"><span>Style</span>
          <select data-font>
            <option value="Segoe Script">Segoe Script</option>
            <option value="Ink Free">Ink Free</option>
            <option value="Lucida Handwriting">Lucida Handwriting</option>
            <option value="Segoe Print">Segoe Print</option>
            <option value="Brush Script MT">Brush Script</option>
          </select></label>
        <canvas class="signature-pad" data-typed width="1040" height="240"></canvas>
      </div>
      <div class="tab-panel" data-panel="image" hidden>
        <button type="button" class="button" data-choose>Choose image…</button>
        <label class="checkbox"><input type="checkbox" data-white checked /> Make white background transparent</label>
        <div class="image-preview" data-preview></div>
      </div>
      <div class="ink-row" data-ink-row><span>Ink</span>
        <label class="ink"><input type="radio" name="ink" value="#111111" checked /><span style="background:#111111"></span></label>
        <label class="ink"><input type="radio" name="ink" value="#1a3fb8" /><span style="background:#1a3fb8"></span></label>
        <label class="ink"><input type="radio" name="ink" value="#b3261e" /><span style="background:#b3261e"></span></label>
      </div>
      <div class="field-row save-row" data-save-row>
        <label class="checkbox"><input type="checkbox" data-save checked /> Save to My signatures as</label>
        <input type="text" data-save-name placeholder="Name, e.g. Full signature or Initials" maxlength="60" />
      </div>`,
    onReady: ({ q, dialog, setValidator }) => {
      let tab = startTab;
      let nameEdited = false;
      const ink = () => dialog.querySelector("input[name=ink]:checked").value;
      const showTab = (name) => {
        tab = name;
        dialog.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
        dialog.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
        q("[data-ink-row]").hidden = name === "image" || name === "saved";
        q("[data-save-row]").hidden = name === "saved";
      };
      dialog.querySelectorAll("[data-tab]").forEach((button) => (button.onclick = () => showTab(button.dataset.tab)));
      q("[data-save-name]").oninput = () => (nameEdited = true);
      q("[data-save-name]").value = uniqueName(`Signature ${signatures.length + 1}`, signatures);

      // My signatures: pick, rename, delete; double-click places right away.
      const renderGrid = () => {
        const grid = q("[data-grid]");
        q('[data-tab="saved"]').textContent = `My signatures${signatures.length ? ` (${signatures.length})` : ""}`;
        if (!signatures.length) {
          grid.innerHTML = `<p class="panel-empty">No saved signatures yet. Create one with Draw, Type or Image; it's saved here for next time.</p>`;
          return;
        }
        grid.replaceChildren(
          ...signatures.map((sig) => {
            const card = document.createElement("div");
            card.className = "signature-card";
            card.classList.toggle("selected", sig.id === selectedId);
            card.tabIndex = 0;
            card.innerHTML = `
              <div class="signature-preview"><img alt="" /></div>
              <input type="text" class="signature-name" maxlength="60" aria-label="Signature name" />
              <div class="signature-meta"><span></span>
                <button type="button" class="tool small" data-delete title="Delete signature" aria-label="Delete signature">${icon("trash")}</button></div>`;
            card.querySelector("img").src = sig.src;
            card.querySelector(".signature-name").value = sig.name;
            card.querySelector(".signature-meta span").textContent = `Used ${new Date(sig.lastUsed).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
            card.onclick = () => {
              selectedId = sig.id;
              grid.querySelectorAll(".signature-card").forEach((c) => c.classList.toggle("selected", c === card));
            };
            card.ondblclick = (e) => {
              if (e.target.closest("input, button")) return;
              selectedId = sig.id;
              q("[data-ok]").click();
            };
            card.querySelector(".signature-name").onkeydown = (e) => {
              // Enter renames; it shouldn't also place the signature.
              if (e.key === "Enter") {
                e.preventDefault();
                e.target.blur();
              }
            };
            card.querySelector(".signature-name").onchange = (e) => {
              sig.name = uniqueName(e.target.value, signatures.filter((s) => s !== sig));
              e.target.value = sig.name;
              storeSignatures(signatures);
            };
            card.querySelector("[data-delete]").onclick = (e) => {
              e.stopPropagation();
              signatures = signatures.filter((s) => s !== sig);
              if (selectedId === sig.id) selectedId = signatures[0]?.id ?? null;
              storeSignatures(signatures);
              renderGrid();
            };
            return card;
          }),
        );
      };
      renderGrid();
      showTab(startTab);

      // Draw tab: smoothed strokes on a 2× canvas.
      const pad = q("[data-pad]");
      const pctx = pad.getContext("2d");
      pctx.lineCap = "round";
      pctx.lineJoin = "round";
      let last = null;
      const point = (e) => {
        const r = pad.getBoundingClientRect();
        return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height, e.pressure || 0.5];
      };
      pad.onpointerdown = (e) => {
        pad.setPointerCapture(e.pointerId);
        last = point(e);
        drawn = true;
      };
      pad.onpointermove = (e) => {
        if (!last) return;
        const next = point(e);
        pctx.strokeStyle = ink();
        pctx.lineWidth = 3 + next[2] * 3;
        pctx.beginPath();
        pctx.moveTo(last[0], last[1]);
        pctx.quadraticCurveTo(last[0], last[1], (last[0] + next[0]) / 2, (last[1] + next[1]) / 2);
        pctx.lineTo(next[0], next[1]);
        pctx.stroke();
        last = next;
      };
      pad.onpointerup = () => (last = null);
      q("[data-clear]").onclick = () => {
        pctx.clearRect(0, 0, pad.width, pad.height);
        drawn = false;
      };

      // Type tab: render the name in a handwriting font.
      const typed = q("[data-typed]");
      const renderTyped = () => {
        const tctx = typed.getContext("2d");
        tctx.clearRect(0, 0, typed.width, typed.height);
        tctx.fillStyle = ink();
        tctx.font = `96px "${q("[data-font]").value}", cursive`;
        tctx.textAlign = "center";
        tctx.textBaseline = "middle";
        tctx.fillText(q("[data-name]").value, typed.width / 2, typed.height / 2, typed.width - 40);
      };
      q("[data-name]").oninput = () => {
        renderTyped();
        if (!nameEdited && q("[data-name]").value.trim()) q("[data-save-name]").value = uniqueName(q("[data-name]").value, signatures);
      };
      q("[data-font]").onchange = renderTyped;
      dialog.querySelectorAll("input[name=ink]").forEach((radio) => (radio.onchange = renderTyped));

      // Image tab.
      const showUpload = async () => {
        if (!uploaded) return;
        const img = new Image();
        img.src = uploaded.src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        if (q("[data-white]").checked) removeWhite(canvas);
        uploaded.prepared = canvas;
        q("[data-preview]").replaceChildren(canvas);
      };
      q("[data-choose]").onclick = async () => {
        const [path] = await window.glance.openDialog("images");
        if (!path) return;
        uploaded = await imageBytesToDataUrl(await window.glance.readFile(path), 1600);
        showUpload();
      };
      q("[data-white]").onchange = showUpload;

      setValidator(() => {
        let signature = null;
        if (tab === "saved") {
          signature = signatures.find((s) => s.id === selectedId);
          if (!signature) throw new Error(signatures.length ? "Choose a signature." : "Create a signature with Draw, Type or Image first.");
        } else {
          if (tab === "draw") signature = drawn ? trimCanvas(pad) : null;
          if (tab === "type") signature = q("[data-name]").value.trim() ? trimCanvas(typed) : null;
          if (tab === "image") signature = uploaded?.prepared ? trimCanvas(uploaded.prepared, 0) : null;
          if (!signature) throw new Error(tab === "type" ? "Type your name first." : tab === "image" ? "Choose an image first." : "Sign in the box first.");
          if (q("[data-save]").checked && !q("[data-save-name]").value.trim()) throw new Error("Give the signature a name, or untick Save.");
        }
        dialog.signature = signature;
        dialog.saveAs = tab !== "saved" && q("[data-save]").checked ? q("[data-save-name]").value : null;
      });
    },
  });
  const signature = result.ok ? result.dialog.signature : null;
  if (!signature) return;
  const now = Date.now();
  if (result.dialog.saveAs !== null && result.dialog.saveAs !== undefined) {
    const preset = { id: newId(), name: uniqueName(result.dialog.saveAs, signatures), src: signature.src, width: signature.width, height: signature.height, created: now, lastUsed: now };
    signatures = [preset, ...signatures];
    if (!storeSignatures(signatures)) ctx.setMessage("Couldn't save the signature for later; storage is full.", { error: true });
  } else if (signature.id) {
    signature.lastUsed = now;
    storeSignatures(signatures);
  }
  await ctx.placeImage(signature, { signature: true });
}

// ---------- Keyboard shortcuts ----------

const SHORTCUTS = [
  ["Files", [
    ["Open", "Ctrl+O"], ["New window", "Ctrl+N"], ["Combine files into PDF", "Ctrl+Shift+M"],
    ["Export", "Ctrl+Shift+S"], ["Print", "Ctrl+P"], ["Document properties", "Ctrl+D"], ["Close window", "Ctrl+W"],
  ]],
  ["Edit", [
    ["Undo", "Ctrl+Z"], ["Redo", "Ctrl+Y"], ["Copy selected text", "Ctrl+C"],
    ["Copy page as a picture", "Ctrl+Shift+C"], ["Paste a picture onto the page", "Ctrl+V"],
    ["Delete selected markup", "Delete"], ["Move selected markup", "Arrow keys (Shift = 10×)"],
    ["Finish text box", "Ctrl+Enter or Esc"],
  ]],
  ["Find and navigate", [
    ["Find", "Ctrl+F"], ["Next / previous match", "Enter / Shift+Enter"], ["Go to page", "Ctrl+G"],
    ["Previous / next image in folder", "← / →"],
  ]],
  ["View", [
    ["Zoom in / out", "Ctrl+= / Ctrl+-"], ["Zoom with the mouse wheel", "Ctrl+Wheel"], ["Actual size", "Ctrl+0"],
    ["Zoom to fit", "Ctrl+9"], ["Single page / two pages", "Ctrl+1 / Ctrl+2"], ["Dark pages", "Ctrl+Shift+D"],
    ["Presentation", "F5"], ["Sidebar", "Ctrl+Alt+S"], ["Markup toolbar", "Ctrl+Shift+A"], ["Full screen", "F11"],
  ]],
  ["Markup and pages", [
    ["Square, circle, 45° lines", "Hold Shift while drawing"], ["Back to the select tool", "Esc"],
    ["Crop to selection", "Ctrl+K or Enter"], ["Rotate left / right", "Ctrl+L / Ctrl+R"],
  ]],
  ["Help", [["This list", "F1 or ?"]]],
];

export async function shortcutsDialog() {
  if (document.querySelector("dialog[open]")) return;
  await modal({
    title: "Keyboard shortcuts",
    ok: "Close",
    wide: true,
    body: `
      <input type="text" data-filter placeholder="Search shortcuts" aria-label="Search shortcuts" />
      <div class="shortcut-list" data-list></div>`,
    onReady: ({ q }) => {
      const render = () => {
        const term = q("[data-filter]").value.trim().toLowerCase();
        const parts = [];
        for (const [group, rows] of SHORTCUTS) {
          const shown = rows.filter(([action, keys]) => !term || `${action} ${keys}`.toLowerCase().includes(term));
          if (!shown.length) continue;
          parts.push(`<div class="shortcut-group">${escapeHtml(group)}</div>`);
          for (const [action, keys] of shown) {
            parts.push(`<div class="shortcut-row"><span>${escapeHtml(action)}</span><kbd>${escapeHtml(keys)}</kbd></div>`);
          }
        }
        q("[data-list]").innerHTML = parts.join("") || `<p class="panel-empty">No shortcuts match.</p>`;
      };
      q("[data-filter]").oninput = render;
      q("[data-filter]").onkeydown = (e) => {
        if (e.key === "Enter") e.preventDefault();
      };
      render();
      requestAnimationFrame(() => q("[data-filter]").focus());
    },
  });
}

// ---------- Print ----------

const PRINT_PREFS_KEY = "glance.print";

// Glance's own print dialog: opens instantly, lists the printers and previews
// the first page; printing then goes straight to the chosen printer.
export async function printDialog(ctx) {
  const { app } = ctx;
  const doc = app.doc;
  if (!doc) return;
  if (!app.permissions.print) {
    ctx.setMessage("This PDF's owner doesn't allow printing.", { error: true });
    return;
  }
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PRINT_PREFS_KEY)) ?? {};
  } catch {
    prefs = {};
  }
  const isPdf = doc.kind === "pdf";
  const count = isPdf ? doc.pageCount() : 1;
  let useSystemDialog = false;
  const result = await modal({
    title: "Print",
    ok: "Print",
    wide: true,
    body: `
      <div class="print-layout">
        <div class="print-options">
          <label class="field"><span>Printer</span><select data-printer><option value="">Finding printers…</option></select></label>
          ${isPdf ? `
          <fieldset><legend>Pages</legend>
            <label class="radio"><input type="radio" name="range" value="all" checked /> All ${count} pages</label>
            <label class="radio"><input type="radio" name="range" value="current" /> Current page (${app.currentPage + 1})</label>
            <label class="radio"><input type="radio" name="range" value="custom" /> Pages
              <input type="text" class="inline-text" data-pages placeholder="e.g. 1-3, 5" spellcheck="false" /></label>
          </fieldset>` : ""}
          <div class="field-row">
            <label class="field"><span>Copies</span><input type="number" data-copies min="1" max="99" value="1" /></label>
            <label class="field"><span>Colour</span><select data-color><option value="color">Colour</option><option value="mono">Black and white</option></select></label>
          </div>
          <label class="field"><span>Orientation</span>
            <select data-orientation><option value="auto">Automatic</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
          <button type="button" class="link-button" data-system>Use the Windows print dialog instead…</button>
        </div>
        <div class="print-preview"><canvas data-preview></canvas><span class="dialog-note" data-preview-label></span></div>
      </div>`,
    onReady: async ({ q, dialog, setValidator }) => {
      q("[data-color]").value = prefs.color === false ? "mono" : "color";
      q("[data-orientation]").value = prefs.orientation ?? "auto";
      const pagesInput = q("[data-pages]");
      if (pagesInput) pagesInput.onfocus = () => (dialog.querySelector("input[value=custom]").checked = true);
      q("[data-system]").onclick = () => {
        useSystemDialog = true;
        q("[data-ok]").click();
      };
      const chosenIndices = () => {
        if (!isPdf) return [0];
        const range = dialog.querySelector("input[name=range]:checked").value;
        if (range === "current") return [app.currentPage];
        if (range === "custom") return [...new Set(parseRanges(pagesInput.value, count).flatMap((g) => g.indices))];
        return doc.pages.map((_, i) => i);
      };
      setValidator(() => {
        const copies = Number(q("[data-copies]").value);
        if (!(copies >= 1 && copies <= 99)) throw new Error("Copies must be between 1 and 99.");
        if (!useSystemDialog && !q("[data-printer]").value) throw new Error("Choose a printer, or use the Windows print dialog.");
        dialog.indices = chosenIndices();
      });

      // Preview the first page that will print.
      const preview = q("[data-preview]");
      const showPreview = async () => {
        let indices;
        try {
          indices = chosenIndices();
        } catch {
          return;
        }
        q("[data-preview-label]").textContent = isPdf ? `${indices.length} page${indices.length === 1 ? "" : "s"}` : "";
        if (isPdf) {
          const { w } = doc.baseSize(doc.pages[indices[0]]);
          await doc.drawPage(indices[0], preview, 220 / w);
        } else {
          const source = doc.composite();
          const scale = Math.min(220 / source.width, 300 / source.height);
          preview.width = Math.round(source.width * scale);
          preview.height = Math.round(source.height * scale);
          preview.getContext("2d").drawImage(source, 0, 0, preview.width, preview.height);
        }
      };
      dialog.querySelectorAll("input[name=range]").forEach((r) => (r.onchange = showPreview));
      if (pagesInput) pagesInput.oninput = showPreview;
      showPreview();

      const select = q("[data-printer]");
      try {
        const printers = await window.glance.printers();
        if (!printers.length) {
          select.innerHTML = `<option value="">No printers found</option>`;
          return;
        }
        select.replaceChildren(...printers.map((p) => new Option(p.displayName, p.name)));
        const remembered = printers.find((p) => p.name === prefs.printer);
        select.value = (remembered ?? printers.find((p) => p.isDefault) ?? printers[0]).name;
      } catch {
        select.innerHTML = `<option value="">Couldn't list printers</option>`;
      }
    },
  });
  if (!result.ok) return;
  const q = result.q;
  const options = {
    indices: result.dialog.indices,
    copies: Number(q("[data-copies]").value),
    color: q("[data-color]").value === "color",
    orientation: q("[data-orientation]").value,
    deviceName: useSystemDialog ? undefined : q("[data-printer]").value,
  };
  try {
    localStorage.setItem(PRINT_PREFS_KEY, JSON.stringify({ printer: options.deviceName ?? prefs.printer, color: options.color, orientation: options.orientation }));
  } catch {
    // Remembering print settings is a convenience only.
  }
  await printDocument(ctx, options);
}

// ---------- Passwords ----------

export async function passwordPrompt(name, retry) {
  const result = await modal({
    title: "Password required",
    ok: "Open",
    body: `
      <p class="dialog-note">${retry ? "<strong>That password didn't work.</strong> " : ""}${escapeHtml(name)} is protected. Enter its password to open it.</p>
      <label class="field"><span>Password</span><input type="password" data-password autocomplete="off" /></label>`,
    onReady: ({ q }) => requestAnimationFrame(() => q("[data-password]").focus()),
  });
  return result.ok ? result.q("[data-password]").value : null;
}

export async function protectDialog(ctx) {
  const doc = ctx.app.doc;
  if (doc?.kind !== "pdf") return;
  const result = await modal({
    title: "Protect with password",
    ok: "Save protected copy…",
    body: `
      <p class="dialog-note">Saves an AES-256 encrypted copy. The document open in Glance isn't changed.</p>
      <fieldset>
        <legend>Password to open</legend>
        <div class="field-row">
          <label class="field"><span>Password</span><input type="password" data-user autocomplete="new-password" /></label>
          <label class="field"><span>Confirm</span><input type="password" data-user2 autocomplete="new-password" /></label>
        </div>
      </fieldset>
      <label class="checkbox"><input type="checkbox" data-restrict /> Restrict printing and editing</label>
      <fieldset data-restrictions disabled>
        <legend>Permissions</legend>
        <label class="field"><span>Permissions password (needed to change these later)</span>
          <input type="password" data-owner autocomplete="new-password" /></label>
        <label class="checkbox"><input type="checkbox" data-allow="printing" checked /> Allow printing</label>
        <label class="checkbox"><input type="checkbox" data-allow="copying" /> Allow copying text and images</label>
        <label class="checkbox"><input type="checkbox" data-allow="annotating" checked /> Allow comments and form filling</label>
        <label class="checkbox"><input type="checkbox" data-allow="modifying" /> Allow editing and page changes</label>
      </fieldset>`,
    onReady: ({ q, setValidator }) => {
      q("[data-restrict]").onchange = () => (q("[data-restrictions]").disabled = !q("[data-restrict]").checked);
      setValidator(() => {
        const user = q("[data-user]").value;
        if (user !== q("[data-user2]").value) throw new Error("The passwords don't match.");
        const restrict = q("[data-restrict]").checked;
        if (!user && !restrict) throw new Error("Enter a password, or choose restrictions.");
        if (restrict && !q("[data-owner]").value) throw new Error("Enter a permissions password.");
        if (restrict && q("[data-owner]").value === user) throw new Error("Use a different permissions password from the open password.");
      });
    },
  });
  if (!result.ok) return;
  const q = result.q;
  const restrict = q("[data-restrict]").checked;
  const allow = (key) => !restrict || q(`[data-allow=${key}]`).checked;
  const permissions = {
    printing: allow("printing"),
    copying: allow("copying"),
    annotating: allow("annotating"),
    fillingForms: allow("annotating"),
    modifying: allow("modifying"),
  };
  // Without restrictions the permissions password is random and never shown.
  const ownerPassword = restrict ? q("[data-owner]").value : crypto.randomUUID() + crypto.randomUUID();
  const target = await window.glance.saveDialog({
    defaultPath: `${folderOf(doc.filePath)}\\${stemOf(doc.filePath)}-protected.pdf`,
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (!target) return;
  try {
    ctx.setMessage("Encrypting…", { sticky: true });
    const bytes = await encryptPdf(await doc.buildPdf(), { userPassword: q("[data-user]").value, ownerPassword, permissions });
    await window.glance.writeFile(target, bytes);
    ctx.setMessage(`Saved protected copy ${fileName(target)}`);
  } catch (err) {
    ctx.showError("Couldn't protect the PDF", err);
  }
}

// ---------- Document properties ----------

const PDF_DATE = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/;
function formatPdfDate(value) {
  const match = typeof value === "string" && value.match(PDF_DATE);
  if (!match) return value || "—";
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export async function propertiesDialog(ctx) {
  const doc = ctx.app.doc;
  if (!doc) return;
  const rows = [
    ["File", fileName(doc.filePath)],
    ["Location", folderOf(doc.filePath)],
  ];
  let info = null;
  if (doc.kind === "pdf") {
    info = await doc.info();
    const source = doc.pages[0].source;
    const { w, h } = doc.baseSize(doc.pages[ctx.app.currentPage]);
    const perms = doc.permissions();
    rows.push(
      ["File size", formatBytes(source.bytes?.length ?? 0)],
      ["Pages", String(doc.pageCount())],
      ["Page size", `${(w / 72 * 25.4).toFixed(0)} × ${(h / 72 * 25.4).toFixed(0)} mm (${(w / 72).toFixed(2)} × ${(h / 72).toFixed(2)} in)`],
      ["PDF version", info.PDFFormatVersion || "—"],
      ["Created", formatPdfDate(info.CreationDate)],
      ["Modified", formatPdfDate(info.ModDate)],
      ["Application", info.Creator || "—"],
      ["PDF producer", info.Producer || "—"],
      ["Security", perms.encrypted ? (perms.edit ? "Password protected" : "Protected — editing not allowed") : "None"],
    );
  } else {
    const { w, h } = doc.baseSize();
    rows.push(["Dimensions", `${w} × ${h} px`]);
  }
  const editable = doc.kind === "pdf" && ctx.app.permissions.edit;
  const field = (key, label) =>
    `<label class="field"><span>${label}</span><input type="text" data-meta="${key}" value="${escapeHtml(String(info?.[key] ?? ""))}" ${editable ? "" : "disabled"} /></label>`;
  const result = await modal({
    title: "Document properties",
    ok: editable ? "Apply" : "Close",
    wide: true,
    body: `
      <dl class="properties-grid">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
      ${doc.kind === "pdf" ? `<fieldset><legend>Description</legend>${field("Title", "Title")}${field("Author", "Author")}${field("Subject", "Subject")}${field("Keywords", "Keywords (separate with commas)")}
      <p class="dialog-note">${editable ? "Saved into the PDF when you export it." : "This PDF's owner doesn't allow changes."}</p></fieldset>` : ""}`,
  });
  if (!result.ok || !editable) return;
  const edits = {};
  result.dialog.querySelectorAll("[data-meta]").forEach((input) => {
    if (input.value !== String(info[input.dataset.meta] ?? "")) edits[input.dataset.meta] = input.value;
  });
  if (Object.keys(edits).length) {
    doc.setMetadata(edits);
    ctx.app.markDirty();
    ctx.setMessage("Document properties updated. Export to save them.");
  }
}

// ---------- Compare ----------

const COMPARE_REMOVED_COLOR = "#ff6b6b";
const COMPARE_NOTE_COLOR = "#7fd1ff";
const quote = (words, limit = 40) => {
  const text = words.map((w) => w.text).join(" ");
  return text.length > limit * 6 ? `${text.slice(0, limit * 6)}…` : text;
};

export async function compareDialog(ctx) {
  if (ctx.app.doc?.kind !== "pdf") return;
  const [otherPath] = await window.glance.openDialog("pdf");
  if (otherPath) await compareWithFile(ctx, otherPath);
}

export async function compareWithFile(ctx, otherPath) {
  const doc = ctx.app.doc;
  let other;
  try {
    ctx.setMessage(`Reading ${fileName(otherPath)}…`, { sticky: true });
    const source = await PdfDocument.loadSource(await window.glance.readFile(otherPath), {
      askPassword: (retry) => passwordPrompt(fileName(otherPath), retry),
    });
    other = { source, pages: await PdfDocument.pagesOf(source) };
  } catch (err) {
    if (!err.cancelled) ctx.showError(`Couldn't open ${fileName(otherPath)}`, err);
    else ctx.setMessage("");
    return;
  }
  let comparison;
  try {
    ctx.setMessage("Comparing…", { sticky: true });
    const wordsA = await documentWords(doc.pages, (record) => doc.baseViewport(record));
    const wordsB = await documentWords(other.pages);
    comparison = compareWords(wordsA, wordsB);
    ctx.setMessage("");
  } catch (err) {
    ctx.showError("Couldn't compare", err);
    return;
  } finally {
    other.source.pdf.destroy();
  }
  const { hunks } = comparison;
  const nameA = fileName(doc.filePath);
  const nameB = fileName(otherPath);
  const removedWords = hunks.reduce((n, h) => n + h.removed.length, 0);
  const addedWords = hunks.reduce((n, h) => n + h.added.length, 0);
  const shown = hunks.slice(0, 300);
  const result = await modal({
    title: "Compare documents",
    ok: hunks.length ? "Add changes as comments" : "Close",
    wide: true,
    body: `
      <p class="dialog-note">This document: <strong>${escapeHtml(nameA)}</strong> (${doc.pageCount()} pages) · Other: <strong>${escapeHtml(nameB)}</strong> (${other.pages.length} pages). Text only; images and layout aren't compared.</p>
      <div class="compare-summary">
        <span><strong>${hunks.length}</strong> changes</span>
        <span><strong>${removedWords}</strong> words only here</span>
        <span><strong>${addedWords}</strong> words only in the other file</span>
      </div>
      ${hunks.length ? `<div class="compare-list" data-list></div>` : `<p>The text of both documents is identical.</p>`}
      ${hunks.length > shown.length ? `<p class="dialog-note">Showing the first ${shown.length} changes.</p>` : ""}
      ${hunks.length ? `<p class="dialog-note">"Add changes as comments" highlights text that is only in this document and adds a note wherever the other file has different text. Review them in the Comments panel.</p>` : ""}`,
    onReady: ({ q, dialog }) => {
      const list = q("[data-list]");
      if (!list) return;
      for (const hunk of shown) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "compare-item";
        const where = `Page ${hunk.pageA + 1} here · page ${hunk.pageB + 1} in other`;
        item.innerHTML = `<div class="where">${escapeHtml(where)}</div>
          ${hunk.removed.length ? `<del>${escapeHtml(quote(hunk.removed))}</del> ` : ""}
          ${hunk.added.length ? `<ins>${escapeHtml(quote(hunk.added))}</ins>` : ""}`;
        item.onclick = () => {
          dialog.close("cancel");
          ctx.app.goToPage(hunk.pageA);
        };
        list.append(item);
      }
    },
  });
  if (!result.ok || !hunks.length) return;

  ctx.app.beginChange();
  let notes = 0;
  for (const hunk of hunks) {
    // One highlight per line rather than per word.
    const lines = [];
    for (const word of hunk.removed) {
      if (!word.box) continue;
      const last = lines.at(-1);
      const b = word.box;
      if (last && last.record === word.record && Math.abs(last.y - b.y) < b.h * 0.5 && b.x - (last.x + last.w) < b.h) {
        const right = Math.max(last.x + last.w, b.x + b.w);
        last.y = Math.min(last.y, b.y);
        last.h = Math.max(last.h, b.h);
        last.w = right - last.x;
      } else {
        lines.push({ record: word.record, ...b });
      }
    }
    for (const line of lines) {
      line.record.annotations.push({
        id: newId(),
        type: "highlight",
        points: [[line.x, line.y], [line.x + line.w, line.y + line.h]],
        color: COMPARE_REMOVED_COLOR,
        width: 1,
      });
    }
    const anchor = hunk.anchor;
    if (!anchor?.box) continue;
    const text = hunk.added.length
      ? hunk.removed.length
        ? `Changed in ${nameB}: "${quote(hunk.removed)}" → "${quote(hunk.added)}"`
        : `Added in ${nameB}: "${quote(hunk.added)}"`
      : `Removed in ${nameB}: "${quote(hunk.removed)}"`;
    const now = new Date().toISOString();
    anchor.record.annotations.push({
      id: newId(),
      type: "note",
      points: [[Math.max(0, anchor.box.x - 22), Math.max(0, anchor.box.y - 4)]],
      text,
      color: COMPARE_NOTE_COLOR,
      width: 1,
      author: "Compare",
      created: now,
      modified: now,
    });
    notes++;
  }
  ctx.app.changed();
  ctx.showPanel("comments");
  ctx.setMessage(`Added ${notes} comparison note${notes === 1 ? "" : "s"}`);
}

export async function addImageDialog(ctx) {
  if (!ctx.app.doc) return;
  const [path] = await window.glance.openDialog("images");
  if (!path) return;
  try {
    await ctx.placeImage(await imageBytesToDataUrl(await window.glance.readFile(path)), { signature: false });
  } catch (err) {
    ctx.showError("Couldn't add the image", err);
  }
}
