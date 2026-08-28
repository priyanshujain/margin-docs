// The keymap, declared once. `keymap.ts` dispatches from this table and the shortcuts sheet
// renders the `?` sheet from it, so a binding that exists but is undocumented is not something you
// can write: the sheet is generated, never maintained.
//
// A combo is canonical: modifiers in `cmd+ctrl+alt` order, then `KeyboardEvent.key` verbatim.
// `cmd` means the platform's primary modifier, Command on macOS and Control everywhere else, which
// is what the native menu's `CmdOrCtrl` accelerators mean too. Shift is not a modifier here: it is
// already baked into the key, so `H` is the shifted `h` and reads that way in the table. That
// still holds once another modifier is in play: `cmd+F` is Cmd+Shift+F, not a typo of `cmd+f`, and
// the case is significant precisely because it is the only thing telling the two apart.
//
// Nothing is chorded and nothing is modal. Two keys never combine into a third meaning.

import type { CommandId } from "./commands";

/**
 * Which frame of the context stack a binding belongs to. `overlay` carries no bindings of its own:
 * pushing it is how quick open, find in files, the command palette, settings or the shortcuts
 * sheet shadow the whole document keymap while leaving `global` reachable.
 */
export type KeyContext = "global" | "document" | "overlay";

export type BindingGroup = "File" | "Navigation" | "Search" | "Editing" | "View" | "App";

interface BindingBase {
  /** Every combo that runs it. The sheet shows them all; the dispatcher accepts any. */
  keys: readonly string[];
  context: KeyContext;
  group: BindingGroup;
  /** Off by default: a key must never be stolen from an input. On for anything that is purely a
   * modifier chord, since the main editing surface is contenteditable essentially all the time and
   * a chord can never insert a character by accident the way a bare key can. */
  allowInInput?: boolean;
}

export interface CommandBinding extends BindingBase {
  command: CommandId;
}

/** A key the keymap deliberately does not own, documented so the sheet is not a half-truth. */
export interface NoteBinding extends BindingBase {
  command: null;
  label: string;
}

export type Binding = CommandBinding | NoteBinding;

export const BINDINGS: readonly Binding[] = [
  { keys: ["cmd+o"], command: "open-folder", context: "document", group: "File", allowInInput: true },
  { keys: ["cmd+n"], command: "new-doc", context: "document", group: "File", allowInInput: true },
  { keys: ["cmd+s"], command: "save", context: "document", group: "File", allowInInput: true },

  {
    keys: ["cmd+p"],
    command: "quick-open",
    context: "document",
    group: "Navigation",
    allowInInput: true,
  },
  {
    keys: ["cmd+["],
    command: "previous-document",
    context: "document",
    group: "Navigation",
    allowInInput: true,
  },
  {
    keys: ["cmd+]"],
    command: "next-document",
    context: "document",
    group: "Navigation",
    allowInInput: true,
  },

  { keys: ["cmd+f"], command: "find", context: "document", group: "Search", allowInInput: true },
  {
    keys: ["cmd+F"],
    command: "find-in-files",
    context: "document",
    group: "Search",
    allowInInput: true,
  },

  // The Mac's own key for this. AppKit gives every NSTextView Cmd+; for "Check Spelling", so it is
  // the one chord a user is liable to try before reading anything, and it is free: nothing else in
  // this table binds it and neither does any extension in src/editor, whose chords are all Mod with
  // a letter, a digit or an editing key (src/editor/fits.test.ts enumerates them). Marked for input
  // because the caret is in the contenteditable document every time this is pressed.
  {
    keys: ["cmd+;"],
    command: "correct-spelling",
    context: "document",
    group: "Editing",
    allowInInput: true,
  },

  {
    keys: ["cmd+\\"],
    command: "toggle-sidebar",
    context: "document",
    group: "View",
    allowInInput: true,
  },

  // The palette is the one thing an overlay may not shadow: it is how you get anywhere from
  // inside anything else.
  { keys: ["cmd+k"], command: "command-palette", context: "global", group: "App", allowInInput: true },
  { keys: ["cmd+,"], command: "settings", context: "document", group: "App", allowInInput: true },
  { keys: ["?", "cmd+/"], command: "shortcuts", context: "document", group: "App" },
  // Escape unwinds the layer stack in `src/escape.ts`, which knows about nested confirmations.
  {
    keys: ["Escape"],
    command: null,
    label: "Dismiss whatever is open",
    context: "global",
    group: "App",
  },
];

export const GROUPS: readonly BindingGroup[] = [
  "File",
  "Navigation",
  "Search",
  "Editing",
  "View",
  "App",
];

const isMac =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.userAgent ?? "");

/** The primary modifier as the platform names it. */
export const PRIMARY_LABEL = isMac ? "⌘" : "Ctrl+";

/** True when the event holds the platform's primary modifier, whatever the hardware calls it. */
export const primaryHeld = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  isMac ? e.metaKey : e.ctrlKey;

export const secondaryHeld = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  isMac ? e.ctrlKey : e.metaKey;

/**
 * `Cmd+K` and `cmd+k` are the same binding; the table may be written either way. The key itself
 * keeps its case, though: that is how `cmd+F` stays distinct from `cmd+f` once a modifier is
 * already in the combo and cannot be recovered by re-deriving it from a lowercase string.
 */
export function normalizeCombo(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const prefix = ["cmd", "ctrl", "alt"].filter((m) => mods.has(m)).join("+");
  return prefix ? `${prefix}+${key}` : key;
}

const NAMED: Record<string, string> = {
  Enter: "↩",
  Escape: "⎋",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Tab: "⇥",
  " ": "Space",
};

/** `cmd+k` becomes ⌘K, `H` becomes ⇧H, `cmd+F` becomes ⌘⇧F. What the sheet and the palette both print. */
export function keyLabel(combo: string): string {
  const parts = normalizeCombo(combo).split("+");
  const key = parts.pop() ?? "";
  const mods = parts
    .map((m) => (m === "cmd" ? PRIMARY_LABEL : m === "ctrl" ? "⌃" : "⌥"))
    .join("");
  const shifted = /^[A-Z]$/.test(key);
  const named = NAMED[key];
  if (named) return `${mods}${named}`;
  if (mods) return `${mods}${shifted ? "⇧" : ""}${key.toUpperCase()}`;
  return shifted ? `⇧${key}` : key;
}

export const bindingLabel = (binding: Binding, labelOf: (id: CommandId) => string): string =>
  binding.command === null ? binding.label : labelOf(binding.command);

/** The combos a command answers to, for a palette row or a button's title attribute. */
export function keysFor(id: CommandId): readonly string[] {
  return BINDINGS.find((b) => b.command === id)?.keys ?? [];
}
