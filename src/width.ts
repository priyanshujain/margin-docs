// How wide the page a document sits on is. Five named steps and nothing in between, because a
// measure is a typographic decision and a slider over it is a way of getting it wrong slowly.
//
// Four of the five are measures, from a tight column of about 47 characters out to a wide one that
// exists for documents that are mostly tables and fenced blocks. Full is the odd one and is named
// for what it does: it stops being a page and takes the pane, with a ceiling on it so a line of
// prose on a large display is still a line somebody can read the end of.
//
// The width is a `data-width` attribute on the root element and nothing else: sheet.css owns what
// each name is worth, so this file never mentions a length. It is written back under the key the
// boot script in index.html reads, so a relaunch opens at the width it closed at rather than
// flashing the default while React starts.

import { onCommand, type CommandId } from "./keys/commands";

export type EditorWidth = "tight" | "narrow" | "normal" | "wide" | "full";

const KEY = "margindocs-width";

/** Narrowest first, which is the order the menu lists them in and the palette offers them. */
export const WIDTHS: readonly EditorWidth[] = ["tight", "narrow", "normal", "wide", "full"];

/**
 * One command per width, checked by the compiler rather than by a list kept beside this one: the
 * template literal is only assignable to `CommandId` while the table in src/keys/commands.ts has a
 * row for every name above, so adding a sixth width without adding its command fails the build.
 */
const commandFor = (width: EditorWidth): CommandId => `editor-width-${width}`;

export function applyWidth(width: EditorWidth): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-width", width);
  try {
    localStorage.setItem(KEY, width);
  } catch {
    // A webview with storage denied still resizes, it just forgets between launches.
  }
}

/**
 * Subscribes every width command to the width it names, and hands back the teardown for all of
 * them. Same shape as `startWorkspaceEvents` in src/workspace.ts, and here for the same reason:
 * the alternative is one `onCommand` line per width written out in src/App.tsx, which is a list
 * that has to be edited every time this one is, in a file that has no other business knowing how
 * many widths there are.
 */
export function startWidthCommands(): () => void {
  const stops = WIDTHS.map((width) => onCommand(commandFor(width), () => applyWidth(width)));
  return () => {
    for (const stop of stops) stop();
  };
}
