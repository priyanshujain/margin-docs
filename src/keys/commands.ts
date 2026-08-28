// Every action the app can be asked to perform, in one table.
//
// A key, a menu item and a palette row all end up here, which is the point: the native menu emits
// an id and that id is a command, not a second code path. The label lives on the command rather
// than on the binding so the shortcut sheet, the palette and the menu cannot describe the same
// thing in three different ways.
//
// A command whose result is a panel on screen (quick open, find, find in files, the command
// palette, settings, the shortcuts sheet) does not own a visibility flag here: nothing in this
// module renders anything. Whichever component ends up drawing that panel subscribes with
// `onCommand`, so the panel existing is not a precondition for this table to compile and dispatch
// correctly.

import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useDocument } from "../store/useDocument";
import { useProofing } from "../store/useProofing";
import { useTheme } from "../store/useTheme";
import { notify } from "../store/useToast";
import { useWorkspace, type TreeNode } from "../store/useWorkspace";

const ISSUES_URL = "https://github.com/priyanshujain/margin-docs/issues";

export type CommandId =
  | "open-folder"
  | "new-doc"
  | "new-folder"
  | "close-folder"
  | "save"
  | "rename-file"
  | "duplicate-file"
  | "delete-file"
  | "reveal-in-finder"
  | "quick-open"
  | "find"
  | "find-in-files"
  | "command-palette"
  | "toggle-sidebar"
  | "toggle-theme"
  | "previous-document"
  | "next-document"
  | "editor-width-narrow"
  | "editor-width-normal"
  | "editor-width-wide"
  | "toggle-spelling"
  | "correct-spelling"
  | "shortcuts"
  | "settings"
  | "check-updates"
  | "report-issue";

export interface Command {
  id: CommandId;
  /** The words the shortcut sheet, the palette and any tooltip all use. */
  label: string;
  /** Whether the palette lists it. An action that needs a target the palette cannot show, or one
   * fine-grained enough that fuzzy search would only add noise, is a key or a menu row instead. */
  palette: boolean;
  run: () => void;
}

const workspace = () => useWorkspace.getState();
const doc = () => useDocument.getState();

function findNode(nodes: readonly TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * A folder to create into: the selection itself if it is one, its parent if it is a file, the one
 * open root if nothing is selected and there is only one to guess at.
 */
function targetDir(): string | null {
  const { roots, selectedPath } = workspace();
  if (selectedPath) {
    for (const root of roots) {
      const node = findNode(root.tree, selectedPath);
      if (node) return node.isDir ? node.path : node.path.slice(0, node.path.lastIndexOf("/"));
    }
  }
  return roots.length === 1 ? roots[0].path : null;
}

function requireSelection(): string | null {
  const { selectedPath } = workspace();
  if (!selectedPath) {
    notify("Select a file or folder first");
    return null;
  }
  return selectedPath;
}

async function openFolder(): Promise<void> {
  try {
    await workspace().openFolder();
  } catch (e) {
    notify(`Could not open folder: ${String(e)}`);
  }
}

async function createDocument(): Promise<void> {
  const dir = targetDir();
  if (!dir) {
    notify("Open a folder first");
    return;
  }
  try {
    const path = await workspace().newDocument(dir);
    await doc().open(path);
  } catch (e) {
    notify(`Could not create the document: ${String(e)}`);
  }
}

async function createFolder(): Promise<void> {
  const dir = targetDir();
  if (!dir) {
    notify("Open a folder first");
    return;
  }
  try {
    await workspace().newFolder(dir);
  } catch (e) {
    notify(`Could not create the folder: ${String(e)}`);
  }
}

function closeActiveFolder(): void {
  const { roots, selectedPath } = workspace();
  if (roots.length === 0) {
    notify("No folder is open");
    return;
  }
  const owner = selectedPath
    ? roots.find((r) => selectedPath === r.path || selectedPath.startsWith(`${r.path}/`))
    : undefined;
  const target = owner?.path ?? (roots.length === 1 ? roots[0].path : null);
  if (!target) {
    notify("Select which folder to close");
    return;
  }
  workspace().closeFolder(target);
}

async function saveDocument(): Promise<void> {
  try {
    await doc().save();
  } catch (e) {
    notify(`Could not save: ${String(e)}`);
  }
}

async function renameSelected(): Promise<void> {
  const path = requireSelection();
  if (!path) return;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const next = window.prompt("Rename to", name);
  if (!next || next === name) return;
  try {
    await workspace().renameEntry(path, next);
  } catch (e) {
    notify(`Could not rename: ${String(e)}`);
  }
}

async function duplicateSelected(): Promise<void> {
  const path = requireSelection();
  if (!path) return;
  try {
    await workspace().duplicateEntry(path);
  } catch (e) {
    notify(`Could not duplicate: ${String(e)}`);
  }
}

async function deleteSelected(): Promise<void> {
  const path = requireSelection();
  if (!path) return;
  try {
    await workspace().deleteEntry(path);
  } catch (e) {
    notify(`Could not delete: ${String(e)}`);
  }
}

async function revealSelected(): Promise<void> {
  const path = requireSelection();
  if (!path) return;
  try {
    await workspace().revealInFinder(path);
  } catch (e) {
    notify(`Could not reveal in Finder: ${String(e)}`);
  }
}

async function goBack(): Promise<void> {
  try {
    await doc().back();
  } catch (e) {
    notify(`Could not go back: ${String(e)}`);
  }
}

async function goForward(): Promise<void> {
  try {
    await doc().forward();
  } catch (e) {
    notify(`Could not go forward: ${String(e)}`);
  }
}

let checkingForUpdates = false;

async function checkForUpdates(): Promise<void> {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  try {
    const update = await check();
    if (!update) {
      notify("Margin Docs is up to date");
      return;
    }
    notify(`Installing ${update.version}…`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    notify(`Could not check for updates: ${String(e)}`);
  } finally {
    checkingForUpdates = false;
  }
}

const listeners = new Map<CommandId, Set<() => void>>();

/**
 * Lets a not-yet-built panel react to its own command without this module owning that panel's
 * visibility. The quick open palette, for instance, calls `onCommand("quick-open", () =>
 * setOpen(true))` once, on mount, rather than this table reaching into a store it does not own.
 */
export function onCommand(id: CommandId, listener: () => void): () => void {
  const set = listeners.get(id) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
  };
}

function dispatch(id: CommandId): void {
  listeners.get(id)?.forEach((listener) => listener());
}

const TABLE: Record<CommandId, Omit<Command, "id">> = {
  "open-folder": { label: "Open Folder…", palette: true, run: () => void openFolder() },
  "new-doc": { label: "New Document", palette: true, run: () => void createDocument() },
  "new-folder": { label: "New Folder", palette: true, run: () => void createFolder() },
  "close-folder": { label: "Close Folder", palette: false, run: closeActiveFolder },
  save: { label: "Save", palette: true, run: () => void saveDocument() },
  "rename-file": { label: "Rename", palette: false, run: () => void renameSelected() },
  "duplicate-file": { label: "Duplicate", palette: false, run: () => void duplicateSelected() },
  "delete-file": { label: "Delete", palette: false, run: () => void deleteSelected() },
  "reveal-in-finder": {
    label: "Reveal in Finder",
    palette: false,
    run: () => void revealSelected(),
  },

  "quick-open": { label: "Quick Open…", palette: true, run: () => dispatch("quick-open") },
  find: { label: "Find…", palette: true, run: () => dispatch("find") },
  "find-in-files": {
    label: "Find in Files…",
    palette: true,
    run: () => dispatch("find-in-files"),
  },
  "command-palette": {
    label: "Command Palette…",
    palette: false,
    run: () => dispatch("command-palette"),
  },

  "toggle-sidebar": {
    label: "Toggle Sidebar",
    palette: true,
    run: () => dispatch("toggle-sidebar"),
  },
  "toggle-theme": { label: "Toggle Theme", palette: true, run: () => useTheme.getState().toggle() },

  "previous-document": { label: "Previous Document", palette: false, run: () => void goBack() },
  "next-document": { label: "Next Document", palette: false, run: () => void goForward() },

  "editor-width-narrow": {
    label: "Narrow Editor Width",
    palette: true,
    run: () => dispatch("editor-width-narrow"),
  },
  "editor-width-normal": {
    label: "Normal Editor Width",
    palette: true,
    run: () => dispatch("editor-width-normal"),
  },
  "editor-width-wide": {
    label: "Wide Editor Width",
    palette: true,
    run: () => dispatch("editor-width-wide"),
  },

  // Not dispatched: there is no panel to open and no component that has to be listening, so this
  // one turns the setting over directly and the editor's decoration plugin reads it from there.
  "toggle-spelling": {
    label: "Check Spelling While Typing",
    palette: true,
    run: () => useProofing.getState().toggle(),
  },

  // Dispatched, unlike the one above it, because its whole result is the correction menu on screen
  // and the component that draws that menu is the only thing here that knows where the caret is.
  //
  // Not in the palette either. What it acts on is the misspelling beside the caret, which is a
  // target the palette cannot show a row for, and by the time a command name has been typed at a
  // field the caret is no longer the one the user meant.
  "correct-spelling": {
    label: "Correct Spelling",
    palette: false,
    run: () => dispatch("correct-spelling"),
  },

  shortcuts: { label: "Keyboard Shortcuts", palette: true, run: () => dispatch("shortcuts") },
  settings: { label: "Settings…", palette: true, run: () => dispatch("settings") },
  "check-updates": {
    label: "Check for Updates…",
    palette: true,
    run: () => void checkForUpdates(),
  },
  "report-issue": {
    label: "Report an Issue…",
    palette: true,
    run: () => {
      openUrl(ISSUES_URL).catch(() => notify("Could not open the browser"));
    },
  },
};

/** Declaration order, which is the order the palette lists them in. */
export const COMMANDS: readonly Command[] = (Object.keys(TABLE) as CommandId[]).map((id) => ({
  id,
  ...TABLE[id],
}));

export const commandLabel = (id: CommandId): string => TABLE[id].label;

export function runCommand(id: CommandId): void {
  TABLE[id].run();
}

/** Case-insensitive subsequence, so `qo` finds "Quick Open…" and `sidebar` finds "Toggle Sidebar". */
export function commandMatches(label: string, query: string): boolean {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return true;
  const hay = label.toLowerCase();
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}
