// Everything the open folders do outside memory: the native picker, the IPC that opens and walks a
// root, the watcher subscription, and the two lists in localStorage that make a relaunch look like
// the app was never closed.
//
// Nothing in here writes into a user's folder except through the file commands the tree UI asks
// for. Opening a folder reads it and nothing else.
//
// This module and src/store/useWorkspace.ts import each other, the same way src/document.ts and
// its store do: the store's actions delegate down here and the work lands back in the store.
// Nothing runs at import time, so the cycle resolves.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  fileCreate,
  fileDuplicate,
  fileFolderCreate,
  fileMove,
  fileRename,
  fileTrash,
} from "./api/files";
import { revealInFinder, rootClose, rootOpen, rootsList, treeRead } from "./api/roots";
import { watchStart, watchStop } from "./api/watch";
import { abandonDocument, documentChangedOnDisk, flushPendingSave } from "./document";
import { rewriteLinksForMove } from "./linkRewrite";
import {
  INDEX_PROGRESS_EVENT,
  WATCH_EVENT,
  isTauri,
  live,
  type FileNode,
  type IndexStatus,
  type WatchEvent,
} from "./ipc";
import { applyIndexStatus, useIndex } from "./store/useIndex";
import { useDocument } from "./store/useDocument";
import { useWorkspace, type TreeNode, type WorkspaceRoot } from "./store/useWorkspace";
import { notify } from "./store/useToast";

const RECENTS_KEY = "margindocs-recents";
const ROOTS_KEY = "margindocs-roots";
const RECENTS_LIMIT = 12;

/** Rust already debounces the watcher; this only stops one burst becoming several tree reads. */
const REFRESH_DELAY_MS = 150;

const DEFAULT_DOCUMENT_NAME = "Untitled.md";
const DEFAULT_FOLDER_NAME = "Untitled Folder";

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Guarded the way src/theme.ts is, because the store tests run in Node with no storage at all. */
function readList(key: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, value: readonly string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

function rememberRecent(path: string): string[] {
  const next = [path, ...readList(RECENTS_KEY).filter((p) => p !== path)].slice(0, RECENTS_LIMIT);
  writeList(RECENTS_KEY, next);
  return next;
}

function rememberOpenRoots(): void {
  writeList(
    ROOTS_KEY,
    useWorkspace.getState().roots.map((r) => r.path),
  );
}

/**
 * The tree the sidebar draws. `children` is undefined for a file and an array for a directory,
 * including an empty one: the whole tree arrives in a single read, so an empty folder is empty and
 * never unexplored.
 */
function toTree(node: FileNode): TreeNode {
  const isDir = node.kind === "dir";
  return {
    path: node.path,
    name: node.name,
    isDir,
    editable: node.editable,
    children: isDir ? node.children.map(toTree) : undefined,
  };
}

function rootOwning(path: string): WorkspaceRoot | undefined {
  return useWorkspace
    .getState()
    .roots.find((r) => path === r.path || path.startsWith(`${r.path}/`));
}

/** No native picker behind a browser tab, so the dev fixture is addressed by path instead. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) {
    if (typeof window === "undefined") return null;
    return window.prompt("Folder path") || null;
  }
  const picked = await openDialog({ directory: true, multiple: false, title: "Open Folder" });
  return typeof picked === "string" ? picked : null;
}

/** Opens a folder, reads its tree once and starts watching it. Re-opening a root refreshes it. */
export async function addRoot(path: string): Promise<void> {
  useWorkspace.setState({ scanPhase: "scanning", scanError: null });
  let root: WorkspaceRoot;
  try {
    const info = await rootOpen(path);
    const node = await treeRead(info.id);
    root = { id: info.id, path: info.path, name: info.name, tree: node.children.map(toTree) };
  } catch (e) {
    useWorkspace.setState({ scanPhase: "error", scanError: String(e) });
    throw e;
  }

  const recentFolders = rememberRecent(root.path);
  useWorkspace.setState((s) => ({
    roots: s.roots.some((r) => r.id === root.id)
      ? s.roots.map((r) => (r.id === root.id ? root : r))
      : [...s.roots, root],
    recentFolders,
    scanPhase: "idle",
    scanError: null,
  }));
  rememberOpenRoots();

  try {
    await watchStart(root.id);
  } catch (e) {
    notify(`${root.name} will not update on its own: ${String(e)}`);
  }
}

/**
 * The disk half of closing a folder. The store has already dropped it from memory by the time this
 * runs, which is why the id and path are passed in rather than looked up.
 */
export async function releaseRoot(rootId: string, rootPath: string): Promise<void> {
  const timer = refreshTimers.get(rootId);
  if (timer !== undefined) clearTimeout(timer);
  refreshTimers.delete(rootId);
  // The document came out of the folder that has just gone, so it goes with it. `close` flushes
  // first: the folder is only being let go of in memory and the file is still exactly where it was,
  // so an unsaved edit has to land on it rather than be dropped along with the tree.
  const open = useDocument.getState().path;
  if (open !== null && (open === rootPath || open.startsWith(`${rootPath}/`))) {
    useDocument.getState().close();
  }
  writeList(
    ROOTS_KEY,
    readList(ROOTS_KEY).filter((p) => p !== rootPath),
  );
  await watchStop(rootId).catch(() => {});
  await rootClose(rootId).catch(() => {});
}

/** Re-reads one root's tree. Every mutation and every watch event ends up here. */
export async function refreshRoot(rootId: string): Promise<void> {
  if (!useWorkspace.getState().roots.some((r) => r.id === rootId)) return;
  let tree: TreeNode[];
  try {
    tree = (await treeRead(rootId)).children.map(toTree);
  } catch (e) {
    useWorkspace.setState({ scanPhase: "error", scanError: String(e) });
    return;
  }
  useWorkspace.setState((s) => ({
    roots: s.roots.map((r) => (r.id === rootId ? { ...r, tree } : r)),
    scanPhase: "idle",
    scanError: null,
  }));
}

function scheduleRefresh(rootId: string): void {
  const pending = refreshTimers.get(rootId);
  if (pending !== undefined) clearTimeout(pending);
  refreshTimers.set(
    rootId,
    setTimeout(() => {
      refreshTimers.delete(rootId);
      void refreshRoot(rootId);
    }, REFRESH_DELAY_MS),
  );
}

async function refreshOwnerOf(path: string): Promise<void> {
  const root = rootOwning(path);
  if (root) await refreshRoot(root.id);
}

/** A folder that has just had something put in it is a folder the user wants to see the inside of. */
function reveal(parentDir: string): void {
  const state = useWorkspace.getState();
  if (!state.expanded.has(parentDir)) state.toggleExpanded(parentDir);
}

export async function createDocumentIn(parentDir: string): Promise<string> {
  const node = await fileCreate(parentDir, DEFAULT_DOCUMENT_NAME);
  await refreshOwnerOf(node.path);
  reveal(parentDir);
  return node.path;
}

export async function createFolderIn(parentDir: string): Promise<string> {
  const node = await fileFolderCreate(parentDir, DEFAULT_FOLDER_NAME);
  await refreshOwnerOf(node.path);
  reveal(parentDir);
  return node.path;
}

/**
 * Renames a file or folder. Renaming the document that is open follows it to its new name rather
 * than leaving a buffer pointed at a path that is no longer there; nothing goes the other way, and
 * no heading ever renames a file.
 */
export async function renamePath(path: string, name: string): Promise<void> {
  const open = useDocument.getState().path;
  const affected = open !== null && (open === path || open.startsWith(`${path}/`));
  if (affected) await flushPendingSave();
  const node = await fileRename(path, name);
  // Before the refresh and before the reopen, both deliberately. A relative link is written against
  // the file that holds it, so a rename breaks every link pointing at the old name and every link
  // inside the file if it moved folders; rewriting after the reopen would put the buffer's stale
  // links back on the next keystroke.
  await rewriteLinksForMove({ from: path, to: node.path });
  await refreshOwnerOf(node.path);
  if (useWorkspace.getState().selectedPath === path) {
    useWorkspace.getState().select(node.path);
  }
  // Still dirty means the flush conflicted, so the buffer is the only copy of that edit and
  // reopening at the new name would throw it away. It stays where it is and stays flagged.
  if (affected && open !== null && !useDocument.getState().dirty) {
    await useDocument.getState().open(node.path + open.slice(path.length));
  }
}

/**
 * Moves a file or folder into another folder, which is what a drag in the sidebar does.
 *
 * Same shape as `renamePath` and for the same reasons: the flush comes first, because a buffer that
 * has not landed is one the rewrite has to skip; the rewrite comes before the reopen, because the
 * reopen is what puts the new bytes in front of the user. Both folders are refreshed, since a move
 * empties one place and fills another.
 */
export async function movePath(path: string, destDir: string): Promise<string> {
  const open = useDocument.getState().path;
  const affected = open !== null && (open === path || open.startsWith(`${path}/`));
  if (affected) await flushPendingSave();
  const node = await fileMove(path, destDir);
  await rewriteLinksForMove({ from: path, to: node.path });
  await refreshOwnerOf(path);
  await refreshOwnerOf(node.path);
  if (useWorkspace.getState().selectedPath === path) {
    useWorkspace.getState().select(node.path);
  }
  if (affected && open !== null && !useDocument.getState().dirty) {
    await useDocument.getState().open(node.path + open.slice(path.length));
  }
  return node.path;
}

export async function duplicatePath(path: string): Promise<string> {
  const node = await fileDuplicate(path);
  await refreshOwnerOf(node.path);
  return node.path;
}

/** To the system Trash, and the open document goes with it if it was the thing that went. */
export async function trashPath(path: string): Promise<void> {
  await fileTrash(path);
  const open = useDocument.getState().path;
  if (open !== null && (open === path || open.startsWith(`${path}/`))) abandonDocument();
  const { selectedPath, select } = useWorkspace.getState();
  if (selectedPath !== null && (selectedPath === path || selectedPath.startsWith(`${path}/`))) {
    select(null);
  }
  await refreshOwnerOf(path);
}

export async function revealPath(path: string): Promise<void> {
  await revealInFinder(path);
}

function onWatchEvent(event: WatchEvent): void {
  scheduleRefresh(event.root);
  const open = useDocument.getState().path;
  if (open === null) return;
  if (event.path === open || event.oldPath === open) void documentChangedOnDisk(open);
}

/**
 * Subscribes to the two events the backend pushes. Returns the teardown, so the shell can mount
 * this from an effect and hand the cleanup straight back.
 */
export function startWorkspaceEvents(): () => void {
  if (!isTauri) return () => {};
  const pending: Promise<UnlistenFn>[] = [
    listen<WatchEvent>(WATCH_EVENT, (event) => onWatchEvent(event.payload)),
    listen<IndexStatus>(INDEX_PROGRESS_EVENT, (event) => applyIndexStatus(event.payload)),
  ];
  return () => {
    for (const p of pending) void p.then((stop) => stop()).catch(() => {});
    for (const timer of refreshTimers.values()) clearTimeout(timer);
    refreshTimers.clear();
  };
}

/**
 * Reopens last session's folders. The backend is asked what it already has open first, because in
 * a dev browser the fixture answers that question and there is nothing in localStorage to restore.
 */
export async function restoreSession(): Promise<void> {
  useWorkspace.setState({ recentFolders: readList(RECENTS_KEY) });
  if (!live()) return;
  const known = await rootsList().catch(() => []);
  const paths = known.map((r) => r.path);
  for (const path of readList(ROOTS_KEY)) if (!paths.includes(path)) paths.push(path);
  for (const path of paths) {
    try {
      await addRoot(path);
    } catch (e) {
      notify(`Could not open ${baseName(path)}: ${String(e)}`);
    }
  }
  // Not awaited: the index is derived state and the app is usable long before it is built.
  if (useWorkspace.getState().roots.length > 0) void useIndex.getState().start();
}
