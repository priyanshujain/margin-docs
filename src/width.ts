// How wide the page a document sits on is. Three named steps and nothing in between, because a
// measure is a typographic decision and a slider over it is a way of getting it wrong slowly.
//
// The width is a `data-width` attribute on the root element and nothing else: sheet.css owns what
// each name is worth, so this file never mentions a length. It is written back under the key the
// boot script in index.html reads, so a relaunch opens at the width it closed at rather than
// flashing the default while React starts.

export type EditorWidth = "narrow" | "normal" | "wide";

const KEY = "margindocs-width";

export const WIDTHS: readonly EditorWidth[] = ["narrow", "normal", "wide"];

export function applyWidth(width: EditorWidth): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-width", width);
  try {
    localStorage.setItem(KEY, width);
  } catch {
    // A webview with storage denied still resizes, it just forgets between launches.
  }
}
