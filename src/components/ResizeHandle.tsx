// The sidebar's drag edge. The width it writes is the `--pane-sidebar` token itself, set on the
// root element, so the stylesheet keeps owning the layout and this only moves a number.

import { useLayoutEffect, type PointerEvent } from "react";

const VAR = "--pane-sidebar";
const KEY = "margindocs-pane-sidebar";
const DEFAULT = 248;
const MIN = 200;
const MAX = 460;

const clamp = (px: number): number => Math.round(Math.min(MAX, Math.max(MIN, px)));

function currentWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(VAR);
  const px = parseInt(raw, 10);
  return Number.isFinite(px) && px > 0 ? px : DEFAULT;
}

function applyWidth(px: number): void {
  const width = clamp(px);
  document.documentElement.style.setProperty(VAR, `${width}px`);
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // A webview with storage denied still gets a working drag, just not a remembered one.
  }
}

function resetWidth(): void {
  document.documentElement.style.removeProperty(VAR);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // See above.
  }
}

export function ResizeHandle() {
  useLayoutEffect(() => {
    try {
      const saved = parseInt(localStorage.getItem(KEY) ?? "", 10);
      if (Number.isFinite(saved) && saved > 0)
        document.documentElement.style.setProperty(VAR, `${clamp(saved)}px`);
    } catch {
      // See above.
    }
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = currentWidth();
    handle.setPointerCapture(e.pointerId);
    document.documentElement.setAttribute("data-resizing", "");

    const onMove = (ev: globalThis.PointerEvent) => applyWidth(startWidth + (ev.clientX - startX));
    const onUp = () => {
      document.documentElement.removeAttribute("data-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={resetWidth}
      title="Drag to resize, double click to reset"
    />
  );
}
