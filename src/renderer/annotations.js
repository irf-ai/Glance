// Markup annotations are stored in a page's "base" space: image pixels for
// images, and PDF points of the rotated page (scale 1) for PDFs.
// Every annotation is { id, type, points: [[x, y], ...], color, width, text?, fontSize?, src? }.
// Image annotations (signatures, placed pictures) keep a PNG data URL in `src`.

const SVG_NS = "http://www.w3.org/2000/svg";
export const HIGHLIGHT_OPACITY = 0.35;
export const LINE_HEIGHT = 1.25;
export const FONT_STACK = "Helvetica, Arial, sans-serif";

let counter = 0;
export const newId = () => `a${Date.now().toString(36)}${(counter++).toString(36)}`;

export function cloneAnnotations(list) {
  return list.map((a) => ({ ...a, points: a.points.map((p) => [...p]) }));
}

// Sticky notes are a point plus text. On screen the icon keeps a constant size;
// in exports it is NOTE_SIZE base units.
export const NOTE_SIZE = 20;
const NOTE_SCREEN_PX = 22;

// Boxes that keep their shape when the page is rotated or flipped.
const UPRIGHT_TYPES = new Set(["image", "check", "cross", "dot"]);
export const RESIZABLE_TYPES = new Set(["image", "check", "cross", "dot"]);

// Fill & Sign marks drawn inside their box: strokes and an optional filled shape.
export function markGeometry(a) {
  const b = bounds(a.points);
  const at = (fx, fy) => [b.x + b.w * fx, b.y + b.h * fy];
  const width = Math.max(1, Math.min(b.w, b.h) * 0.13);
  if (a.type === "check") return { width, strokes: [[at(0.12, 0.55), at(0.4, 0.84), at(0.9, 0.16)]] };
  if (a.type === "cross") return { width, strokes: [[at(0.16, 0.16), at(0.84, 0.84)], [at(0.84, 0.16), at(0.16, 0.84)]] };
  const inset = { points: [at(0.22, 0.22), at(0.78, 0.78)] };
  return { width, strokes: [], fill: ellipsePoints(inset, 36) };
}

function noteIconParts(x, y, size) {
  const r = size * 0.12;
  const h = size * 0.74;
  const bubble = `M${x + r},${y} H${x + size - r} Q${x + size},${y} ${x + size},${y + r} V${y + h - r} Q${x + size},${y + h} ${x + size - r},${y + h}
    H${x + size * 0.45} L${x + size * 0.2},${y + size} L${x + size * 0.25},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
  const lines = [0.25, 0.42, 0.59].map((f) => [[x + size * 0.22, y + size * f], [x + size * (f === 0.59 ? 0.6 : 0.78), y + size * f]]);
  return { bubble, lines };
}

// Decoded images for image annotations, keyed by data URL, so canvas drawing stays synchronous.
const imageCache = new Map();

export async function loadAnnotationImage(src) {
  if (!imageCache.has(src)) {
    const img = new Image();
    img.src = src;
    await img.decode();
    imageCache.set(src, img);
  }
  return imageCache.get(src);
}

export function transformAnnotations(list, mapPoint, scale = 1) {
  for (const a of list) {
    if (UPRIGHT_TYPES.has(a.type)) {
      // Pictures and marks stay upright: move the centre and keep the aspect ratio.
      const b = bounds(a.points);
      const [cx, cy] = mapPoint(b.x + b.w / 2, b.y + b.h / 2);
      const w = (b.w * scale) / 2;
      const h = (b.h * scale) / 2;
      a.points = [[cx - w, cy - h], [cx + w, cy + h]];
      continue;
    }
    a.points = a.points.map(([x, y]) => mapPoint(x, y));
    a.width *= scale;
    if (a.fontSize) a.fontSize *= scale;
    // Two-point shapes keep their corners ordered after a flip or rotation.
    if (["rect", "ellipse", "highlight"].includes(a.type)) {
      const b = bounds(a.points);
      a.points = [[b.x, b.y], [b.x + b.w, b.y + b.h]];
    }
  }
}

export function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function translateAnnotation(a, dx, dy) {
  a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
}

export function isTooSmall(a) {
  if (["text", "image", "note", "check", "cross", "dot"].includes(a.type)) return false;
  if (a.type === "pen") return a.points.length < 2;
  const b = bounds(a.points);
  return Math.max(b.w, b.h) < 3;
}

function rectCorners(a) {
  const b = bounds(a.points);
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
}

export function ellipsePoints(a, segments = 72) {
  const b = bounds(a.points);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const points = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    points.push([cx + (b.w / 2) * Math.cos(t), cy + (b.h / 2) * Math.sin(t)]);
  }
  return points;
}

export function arrowHead(a) {
  const [[x0, y0], [x1, y1]] = a.points;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const size = Math.max(10, a.width * 4);
  const spread = Math.PI / 7;
  return [
    [x1, y1],
    [x1 - size * Math.cos(angle - spread), y1 - size * Math.sin(angle - spread)],
    [x1 - size * Math.cos(angle + spread), y1 - size * Math.sin(angle + spread)],
  ];
}

// Shorten the arrow shaft so its square end stays hidden under the head.
function arrowShaft(a) {
  const [[x0, y0], [x1, y1]] = a.points;
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  const inset = Math.min(length, Math.max(10, a.width * 4) * 0.6);
  return [[x0, y0], [x1 - ((x1 - x0) / length) * inset, y1 - ((y1 - y0) / length) * inset]];
}

export function textLines(a) {
  return (a.text ?? "").split("\n");
}

export function textBaseline(a, lineIndex) {
  return a.points[0][1] + a.fontSize * (0.9 + lineIndex * LINE_HEIGHT);
}

const polyline = (points) => points.map(([x, y]) => `${x},${y}`).join(" ");

function svg(tag, attributes) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
  return el;
}

function strokeAttributes(a) {
  return {
    fill: "none",
    stroke: a.color,
    "stroke-width": a.width,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  };
}

// Returns an SVG group; shapes get a wide transparent copy so thin strokes are easy to click.
// `scale` (screen pixels per base unit) keeps sticky-note icons a constant size on screen.
export function annotationToSvg(a, scale = 1) {
  const g = svg("g", { "data-id": a.id, class: `annotation annotation-${a.type}` });
  const add = (el, hit = true) => {
    g.append(el);
    if (hit && el.getAttribute("stroke")) {
      const clone = el.cloneNode();
      clone.setAttribute("stroke", "transparent");
      clone.setAttribute("stroke-width", Math.max(a.width + 10, 12));
      clone.setAttribute("class", "hit");
      g.append(clone);
    }
  };
  const b = bounds(a.points);
  switch (a.type) {
    case "highlight":
      add(svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.color, "fill-opacity": HIGHLIGHT_OPACITY, class: "highlight-fill" }), false);
      break;
    case "rect":
      add(svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h, ...strokeAttributes(a) }));
      break;
    case "ellipse":
      add(svg("ellipse", { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, ...strokeAttributes(a) }));
      break;
    case "line":
      add(svg("polyline", { points: polyline(a.points), ...strokeAttributes(a) }));
      break;
    case "arrow":
      add(svg("polyline", { points: polyline(arrowShaft(a)), ...strokeAttributes(a) }));
      add(svg("polygon", { points: polyline(arrowHead(a)), fill: a.color }), false);
      break;
    case "pen":
      add(svg("polyline", { points: polyline(a.points), ...strokeAttributes(a) }));
      break;
    case "note": {
      const size = NOTE_SCREEN_PX / scale;
      const [x, y] = a.points[0];
      const { bubble, lines } = noteIconParts(x, y, size);
      g.append(
        svg("path", { d: bubble, fill: a.color, stroke: "#5c4a00", "stroke-width": 1 / scale, class: "note-icon" }),
        ...lines.map((line) => svg("polyline", { points: polyline(line), stroke: "#5c4a00", "stroke-width": 1.2 / scale, fill: "none" })),
      );
      break;
    }
    case "check":
    case "cross":
    case "dot": {
      const mark = markGeometry(a);
      mark.strokes.forEach((points) => add(svg("polyline", { points: polyline(points), ...strokeAttributes({ ...a, width: mark.width }) }), false));
      if (mark.fill) g.append(svg("polygon", { points: polyline(mark.fill), fill: a.color }));
      g.append(svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "transparent", class: "image-hit" }));
      break;
    }
    case "image": {
      const image = svg("image", { x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: "none" });
      image.setAttribute("href", a.src);
      g.append(image, svg("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: "transparent", class: "image-hit" }));
      break;
    }
    case "text": {
      const text = svg("text", {
        x: a.points[0][0],
        "font-size": a.fontSize,
        "font-family": FONT_STACK,
        fill: a.color,
        "xml:space": "preserve",
      });
      textLines(a).forEach((line, i) => {
        const tspan = svg("tspan", { x: a.points[0][0], y: textBaseline(a, i) });
        tspan.textContent = line || " ";
        text.append(tspan);
      });
      g.append(text);
      break;
    }
  }
  return g;
}

function tracePath(ctx, points, close) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

// Draws annotations onto a canvas whose pixels are `scale` times the base space.
export function drawAnnotationsToCanvas(ctx, list, scale = 1) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const a of list) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.width;
    switch (a.type) {
      case "highlight": {
        const b = bounds(a.points);
        ctx.globalAlpha = HIGHLIGHT_OPACITY;
        ctx.globalCompositeOperation = "multiply";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        break;
      }
      case "rect":
        tracePath(ctx, rectCorners(a), true);
        ctx.stroke();
        break;
      case "ellipse":
        tracePath(ctx, ellipsePoints(a), true);
        ctx.stroke();
        break;
      case "arrow":
        tracePath(ctx, arrowShaft(a), false);
        ctx.stroke();
        tracePath(ctx, arrowHead(a), true);
        ctx.fill();
        break;
      case "line":
      case "pen":
        tracePath(ctx, a.points, false);
        ctx.stroke();
        break;
      case "image": {
        const img = imageCache.get(a.src);
        const b = bounds(a.points);
        if (img) ctx.drawImage(img, b.x, b.y, b.w, b.h);
        break;
      }
      case "note": {
        const { bubble, lines } = noteIconParts(a.points[0][0], a.points[0][1], NOTE_SIZE);
        const path = new Path2D(bubble);
        ctx.fill(path);
        ctx.strokeStyle = "#5c4a00";
        ctx.lineWidth = 1;
        ctx.stroke(path);
        lines.forEach((line) => {
          tracePath(ctx, line, false);
          ctx.stroke();
        });
        break;
      }
      case "check":
      case "cross":
      case "dot": {
        const mark = markGeometry(a);
        ctx.lineWidth = mark.width;
        mark.strokes.forEach((points) => {
          tracePath(ctx, points, false);
          ctx.stroke();
        });
        if (mark.fill) {
          tracePath(ctx, mark.fill, true);
          ctx.fill();
        }
        break;
      }
      case "text":
        ctx.font = `${a.fontSize}px ${FONT_STACK}`;
        ctx.textBaseline = "alphabetic";
        textLines(a).forEach((line, i) => ctx.fillText(line, a.points[0][0], textBaseline(a, i)));
        break;
    }
    ctx.restore();
  }
  ctx.restore();
}

function hexToRgb(PDFLib, hex) {
  const value = parseInt(hex.replace("#", ""), 16);
  return PDFLib.rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

// Standard PDF fonts only cover WinAnsi; replace anything else so export never fails.
function winAnsiSafe(font, text) {
  return Array.from(text)
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return "?";
      }
    })
    .join("");
}

function dataUrlBytes(src) {
  const binary = atob(src.slice(src.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Writes sticky notes as standard PDF Text annotations, so other PDF apps show
// them as editable notes rather than drawings.
export function addNoteAnnotations(PDFLib, pdfDoc, page, list, toPdf) {
  for (const a of list) {
    if (a.type !== "note" || !a.text?.trim()) continue;
    const [x, y] = a.points[0];
    const [x1, y1] = toPdf(x, y);
    const [x2, y2] = toPdf(x + NOTE_SIZE, y + NOTE_SIZE);
    const value = parseInt(a.color.replace("#", ""), 16);
    const annotation = pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
      Contents: PDFLib.PDFHexString.fromText(a.text),
      T: PDFLib.PDFHexString.fromText(a.author || ""),
      M: PDFLib.PDFString.fromDate(new Date(a.modified || Date.now())),
      C: [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255],
      Name: "Comment",
      F: 4 | 8 | 16, // Print, NoZoom, NoRotate
      Open: false,
    });
    page.node.addAnnot(pdfDoc.context.register(annotation));
  }
}

// Embeds each distinct image annotation once per output document.
export async function embedAnnotationImages(pdfDoc, lists) {
  const images = new Map();
  for (const list of lists) {
    for (const a of list) {
      if (a.type === "image" && !images.has(a.src)) images.set(a.src, await pdfDoc.embedPng(dataUrlBytes(a.src)));
    }
  }
  return images;
}

// Draws annotations as real vector content on a pdf-lib page.
// toPdf maps base-space points to PDF user space; rotation is the page's display rotation.
export function drawAnnotationsToPdf(PDFLib, page, list, toPdf, rotation, font, images = new Map()) {
  const svgPath = (points, close) => {
    const d = points
      .map(([x, y], i) => {
        const [px, py] = toPdf(x, y);
        return `${i ? "L" : "M"}${px.toFixed(3)},${(-py).toFixed(3)}`;
      })
      .join(" ");
    return close ? `${d} Z` : d;
  };
  const stroke = (a, points, close) =>
    page.drawSvgPath(svgPath(points, close), {
      x: 0,
      y: 0,
      borderColor: hexToRgb(PDFLib, a.color),
      borderWidth: a.width,
      borderLineCap: PDFLib.LineCapStyle.Round,
    });
  const fill = (a, points, opacity = 1) =>
    page.drawSvgPath(svgPath(points, true), { x: 0, y: 0, color: hexToRgb(PDFLib, a.color), opacity });

  for (const a of list) {
    switch (a.type) {
      case "highlight":
        fill(a, rectCorners(a), HIGHLIGHT_OPACITY);
        break;
      case "rect":
        stroke(a, rectCorners(a), true);
        break;
      case "ellipse":
        stroke(a, ellipsePoints(a), true);
        break;
      case "arrow":
        stroke(a, arrowShaft(a), false);
        fill(a, arrowHead(a));
        break;
      case "line":
      case "pen":
        stroke(a, a.points, false);
        break;
      case "check":
      case "cross":
      case "dot": {
        const mark = markGeometry(a);
        mark.strokes.forEach((points) => stroke({ ...a, width: mark.width }, points, false));
        if (mark.fill) fill(a, mark.fill);
        break;
      }
      case "note":
        // Written separately as a real PDF sticky-note annotation (addNoteAnnotations).
        break;
      case "image": {
        // pdf-lib rotates around the image's own bottom-left corner, which is
        // the box's bottom-left as displayed.
        const b = bounds(a.points);
        const [x, y] = toPdf(b.x, b.y + b.h);
        const image = images.get(a.src);
        if (image) page.drawImage(image, { x, y, width: b.w, height: b.h, rotate: PDFLib.degrees(rotation) });
        break;
      }
      case "text":
        textLines(a).forEach((line, i) => {
          if (!line.trim()) return;
          const [px, py] = toPdf(a.points[0][0], textBaseline(a, i));
          page.drawText(winAnsiSafe(font, line), {
            x: px,
            y: py,
            size: a.fontSize,
            font,
            color: hexToRgb(PDFLib, a.color),
            rotate: PDFLib.degrees(rotation),
          });
        });
        break;
    }
  }
}
