// The open folders and their trees. Reading the filesystem, writing into it and watching it for
// external changes are Rust's job (see docs/architecture.md), reached through src/workspace.ts,
// which these actions delegate to; what is left here is state and the setters that only rearrange
// what is already in memory.

import { create } from "zustand";
import {
  addRoot,
  createDocumentIn,
  createFolderIn,
  duplicatePath,
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
  roots: WorkspaceRoot[];
  expanded: Set<string>;
  selectedPath: string | null;
  showIgnored: boolean;
  recentFolders: string[];
  scanPhase: ScanPhase;
  scanError: string | null;

  /** Opens the native folder picker and adds the chosen folder as a root. */
  openFolder: () => Promise<void>;
  /** Drops a root from memory. Touches nothing on disk. */
  closeFolder: (rootPath: string) => void;
  /** Creates an empty markdown file inside `parentDir` and returns its path. */
  newDocument: (parentDir: string) => Promise<string>;
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
  roots: [],
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
    set((s) => {
      const next = new Set(s.expanded);
      next.add(path);
      return { expanded: next };
    });
  },
  closeFolder: (rootPath) => {
    const root = get().roots.find((r) => r.path === rootPath);
    if (root) void releaseRoot(root.id, root.path);
    set((s) => ({
      roots: s.roots.filter((r) => r.path !== rootPath),
      selectedPath:
        s.selectedPath !== null &&
        (s.selectedPath === rootPath || s.selectedPath.startsWith(`${rootPath}/`))
          ? null
          : s.selectedPath,
    }));
  },
  newDocument: async (parentDir) => createDocumentIn(parentDir),
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
