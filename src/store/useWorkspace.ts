// The open folder and its tree. Reading the filesystem, writing into it and watching it for
// external changes are Rust's job (see docs/architecture.md), reached through src/workspace.ts,
// which these actions delegate to; what is left here is state and the setters that only rearrange
// what is already in memory.
//
// One folder at a time. Rust can hold several roots open and still can, but the window shows one
// project the way a code editor does, so opening a folder replaces whatever was open rather than
// stacking a second tree under the first.

import { create } from "zustand";
import {
  addRoot,
  createDocumentIn,
  createFolderIn,
  duplicatePath,
  forgetRecent,
  pickFolder,
  releaseRoot,
  renamePath,
  revealPath,
  trashPath,
} from "../workspace";

export type ScanPhase = "idle" | "scanning" | "error";

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  /** Markdown and .txt open in the editor; everything else is greyed out and opens in the
   * system's default app. */
  editable: boolean;
  children?: TreeNode[];
}

export interface WorkspaceRoot {
  /** The backend's id for this root, which is what `tree_read`, `root_close` and the watcher are
   * addressed by and what a `watch-event` names itself with. */
  id: string;
  path: string;
  name: string;
  tree: TreeNode[];
}

interface WorkspaceState {
  /** The one open folder, or nothing, which is the start screen. */
  root: WorkspaceRoot | null;
  expanded: Set<string>;
  selectedPath: string | null;
  showIgnored: boolean;
  recentFolders: string[];
  scanPhase: ScanPhase;
  scanError: string | null;

  /** Opens the native folder picker and opens the chosen folder, closing whatever was open. */
  openFolder: () => Promise<void>;
  /** Closes the open folder. Touches nothing on disk. */
  closeFolder: () => void;
  /** Drops a folder from the recents list without opening or touching it. */
  forgetFolder: (path: string) => void;
  /** Creates a markdown file called `name` inside `parentDir` and returns its path. */
  newDocument: (parentDir: string, name: string) => Promise<string>;
  /** Creates an empty folder inside `parentDir` and returns its path. */
  newFolder: (parentDir: string) => Promise<string>;
  renameEntry: (path: string, nextName: string) => Promise<void>;
  /** Copies a file or folder beside itself and returns the new path. */
  duplicateEntry: (path: string) => Promise<string>;
  /** Sends the file or folder to the system Trash. */
  deleteEntry: (path: string) => Promise<void>;
  revealInFinder: (path: string) => Promise<void>;
  select: (path: string | null) => void;
  toggleExpanded: (path: string) => void;
  setShowIgnored: (show: boolean) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  root: null,
  expanded: new Set(),
  selectedPath: null,
  showIgnored: false,
  recentFolders: [],
  scanPhase: "idle",
  scanError: null,

  openFolder: async () => {
    const path = await pickFolder();
    if (path === null) return;
    await addRoot(path);
  },
  closeFolder: () => {
    const root = get().root;
    if (root === null) return;
    set({ root: null, selectedPath: null });
    void releaseRoot(root.id, root.path);
  },
  forgetFolder: (path) => set({ recentFolders: forgetRecent(path) }),
  newDocument: async (parentDir, name) => createDocumentIn(parentDir, name),
  newFolder: async (parentDir) => createFolderIn(parentDir),
  renameEntry: async (path, nextName) => renamePath(path, nextName),
  duplicateEntry: async (path) => duplicatePath(path),
  deleteEntry: async (path) => trashPath(path),
  revealInFinder: async (path) => revealPath(path),
  select: (path) => set({ selectedPath: path }),
  toggleExpanded: (path) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setShowIgnored: (show) => set({ showIgnored: show }),
}));
