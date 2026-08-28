// The native macOS menu emits `menu-action` with the item id it was built with. Those ids are
// command ids themselves, so this is a guard and a lookup rather than a second dispatch table: a
// menu item and a keystroke run the same function or the build fails.
//
// The Tauri listener itself is mounted at the top of the tree; this is what it calls.

import { runCommand, type CommandId } from "./commands";

/** Exactly the ids `src-tauri/src/lib.rs` emits. */
export const MENU_IDS: readonly CommandId[] = [
  "open-folder",
  "new-doc",
  "new-folder",
  "save",
  "export-pdf",
  "close-folder",
  "settings",
  "find",
  "find-in-files",
  "quick-open",
  "command-palette",
  "toggle-sidebar",
  "check-updates",
  "report-issue",
  "writing-proofread",
  "writing-rewrite",
];

const known = new Set<string>(MENU_IDS);

export function handleMenuAction(id: string): void {
  if (known.has(id)) runCommand(id as CommandId);
}
