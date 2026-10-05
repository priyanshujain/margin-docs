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
    keys: ["cmd+E"],
    command: "export-pdf",
    context: "document",
    group: "File",
    allowInInput: true,
  },

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

  // Google Docs' key for a link, and the one chord a person moving off it reaches for first. It is
  // a document binding rather than a global one because what it opens is the pill's link popover,
  // which is about the selection: with the palette or settings on screen there is no selection to
  // put an address on, and the overlay context is what says so.
  //
  // Deliberately not on a native menu row. macOS fires a row's key equivalent itself, before the
  // webview sees anything and without knowing what is on screen, so a Cmd+K on a menu would open
  // the link popover behind an open palette and this row's whole point would be gone. Every
  // accelerator in src-tauri/src/lib.rs belongs to a command that is true in every context, and
  // this one is not one of those.
  {
    keys: ["cmd+k"],
    command: "insert-link",
    context: "document",
    group: "Editing",
    allowInInput: true,
  },

  // Taken in order to refuse it. What happens to a key nobody binds inside a contenteditable is
  // not nothing, and src/keys/commands.ts says what this one would otherwise do to the file.
  {
    keys: ["cmd+u"],
    command: "underline-unsupported",
    context: "document",
    group: "Editing",
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

  // Writing Tools' two chords. Like every accelerator this app puts on a native menu item, macOS
  // fires the menu row before the webview sees a keydown, so in practice these are dispatched
  // through src/keys/menu.ts rather than by the listener in keymap.ts. They are rows here for the
  // same reason Cmd+O is: the sheet is generated from this table, and a key the app answers to
  // that is missing from it would be the one thing this table exists to prevent.
  //
  // They are on this app's own Edit rows rather than on Apple's, so that they pass the selection
  // guard in src/editor/writing.ts. src-tauri/src/writingtools.rs says what that is protecting.
  {
    keys: ["alt+F"],
    command: "writing-proofread",
    context: "document",
    group: "Editing",
    allowInInput: true,
  },
  {
    keys: ["alt+R"],
    command: "writing-rewrite",
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
  // Cmd+Shift+\, which arrives as `|` because shift is baked into the key, and which sits on the
  // sidebar's chord on purpose: the outline is a section of the sidebar, and a person who has
  // learned one is a shift away from the other.
  {
    keys: ["cmd+|"],
    command: "toggle-outline",
    context: "document",
    group: "View",
    allowInInput: true,
  },

  // The palette is the one thing an overlay may not shadow: it is how you get anywhere from
  // inside anything else. It sits on VS Code's chord rather than on the Cmd+K it used to hold,
  // because Cmd+K is a link everywhere a person writes prose and there is nowhere else to put
  // that; Cmd+Shift+P was free, and Cmd+P stays quick open, so the pair reads the way an editor
  // user already expects it to.
  {
    keys: ["cmd+P"],
    command: "command-palette",
    context: "global",
    group: "App",
    allowInInput: true,
  },
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
