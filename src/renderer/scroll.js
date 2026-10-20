// Scrolls only `container` (never the window) so the toolbars stay put.
// block: "start" | "center" | "nearest"
export function scrollWithin(container, el, block = "nearest") {
  const box = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const top = rect.top - box.top;
  let delta = 0;
  if (block === "start") delta = top - 16;
  else if (block === "center") delta = top + rect.height / 2 - container.clientHeight / 2;
  else if (top < 0) delta = top - 8;
  else if (top + rect.height > container.clientHeight) delta = top + rect.height - container.clientHeight + 8;
  container.scrollTop += delta;
}
