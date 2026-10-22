// Platform differences the page needs to know about: shortcut labels, the
// names of system apps, and which handwriting fonts the system has.

export const IS_MAC = window.glance.platform === "darwin";

export const OS_NAME = IS_MAC ? "macOS" : "Windows";
export const FILE_MANAGER = IS_MAC ? "Finder" : "Explorer";

// [font-family, label]. Each list uses fonts that ship with that system.
export const HANDWRITING_FONTS = IS_MAC
  ? [
      ["Snell Roundhand", "Snell Roundhand"],
      ["Bradley Hand", "Bradley Hand"],
      ["Apple Chancery", "Apple Chancery"],
      ["Noteworthy", "Noteworthy"],
      ["Brush Script MT", "Brush Script"],
    ]
  : [
      ["Segoe Script", "Segoe Script"],
      ["Ink Free", "Ink Free"],
      ["Lucida Handwriting", "Lucida Handwriting"],
      ["Segoe Print", "Segoe Print"],
      ["Brush Script MT", "Brush Script"],
    ];

// Shortcuts whose Mac key isn't just Ctrl → ⌘.
const MAC_SPECIAL = { "Ctrl+Y": "⇧⌘Z", "Ctrl+Wheel": "Pinch or ⌘+scroll", F11: "⌃⌘F" };
const MAC_MODIFIERS = [["Alt", "⌥"], ["Shift", "⇧"], ["Ctrl", "⌘"]]; // Apple's order

function macCombo(combo) {
  const parts = combo.split("+");
  const key = parts.pop();
  return MAC_MODIFIERS.filter(([name]) => parts.includes(name)).map(([, symbol]) => symbol).join("") + key;
}

// "Export (Ctrl+Shift+S)" → "Export (⇧⌘S)" on a Mac; unchanged elsewhere.
export function keyLabel(text) {
  if (!IS_MAC) return text;
  return text.replace(/\b(?:(?:Ctrl|Alt|Shift)\+)+[^\s/,)]+|\bF11\b/g, (combo) => MAC_SPECIAL[combo] ?? macCombo(combo));
}

// Rewrites the shortcut hints in tooltips of the static page.
export function localizeShortcuts(root) {
  if (!IS_MAC) return;
  for (const el of root.querySelectorAll("[title]")) el.title = keyLabel(el.title);
}
