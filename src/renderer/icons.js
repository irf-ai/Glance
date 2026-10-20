// 24×24 stroke icons, drawn with currentColor.
const PATHS = {
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  open: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  "zoom-in": '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"/>',
  "zoom-out": '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M7.5 10.5h6"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  "rotate-left": '<path d="M4 4v5h5"/><path d="M4.6 9A8 8 0 1 1 6 16.5"/>',
  "rotate-right": '<path d="M20 4v5h-5"/><path d="M19.4 9A8 8 0 1 0 18 16.5"/>',
  markup: '<path d="M14.5 4.5 19.5 9.5 9 20H4v-5z"/><path d="M12.5 6.5l5 5"/>',
  export: '<path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v6.5A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V12"/>',
  select: '<path d="M5 3.5 19 11l-6.2 1.6L9.6 19z"/>',
  "text-select": '<path d="M9 4h6M9 20h6M12 4v16"/>',
  highlight: '<path d="m9 15 7.5-11 3.5 2.5L13 17.5z"/><path d="M9 15l-2.5 3.5h4.5L13 17.5"/><path d="M3 21h18" stroke-width="2.5"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  pen: '<path d="M3.5 17c3-6 5.5-9 7.5-9s-1.5 9 1.5 9 4-7 8-7"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
  crop: '<path d="M7 3v14h14M3 7h14v14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  "flip-h": '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 6 3 18h6zM15 6l6 12h-6z"/>',
  "flip-v": '<path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M6 9 18 3v6zM6 15l12 6v-6z"/>',
  resize: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A1.5 1.5 0 0 0 8 21h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  "chevron-up": '<path d="m6 15 6-6 6 6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "file-plus": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  tools: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  combine: '<rect x="3" y="3" width="10" height="13" rx="1.5"/><rect x="11" y="8" width="10" height="13" rx="1.5"/>',
  split: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 17M8 16.5 20 7"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  signature: '<path d="M3 17c2.5 0 3.5-9 6-9s0 9 2.5 9 2-4 3.5-4 1 3 2.5 3H21"/><path d="M3 21h18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  "file-text": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 12.5h7M8.5 16h7"/>',
  images: '<rect x="6" y="3" width="15" height="13" rx="2"/><path d="M3 7v11a3 3 0 0 0 3 3h11"/><path d="m21 12-4-4-7 7"/>',
  note: '<path d="M5 4h14a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 5 4z"/><path d="M8 9h8M8 12.5h5"/>',
  "mark-check": '<path d="m5 12.5 4.5 4.5L19 7.5" stroke-width="2.2"/>',
  "mark-cross": '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke-width="2.2"/>',
  "mark-dot": '<circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h3"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.5"/>',
  paperclip: '<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/>',
  compare: '<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/><path d="M5.5 9h2.5M16 9h2.5M5.5 13h2.5M16 13h2.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  present: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8M10 8l4 2-4 2z"/>',
  "single-page": '<rect x="7" y="3.5" width="10" height="17" rx="1.5"/>',
  spread: '<rect x="2.5" y="4.5" width="9" height="15" rx="1.5"/><rect x="12.5" y="4.5" width="9" height="15" rx="1.5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  save: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
};

export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}

export function applyIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon));
  });
}
