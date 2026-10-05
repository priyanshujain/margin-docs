// Everything the open folder does outside memory: the native picker, the IPC that opens and walks
// a root, the watcher subscription, and the list of recently opened folders in localStorage that
// the start screen is drawn from.
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
import {
  abandonDocument,
  documentChangedOnDisk,
  documentMovedTo,
  flushPendingSave,
} from "./document";
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
import { viewerKindForPath } from "./model/doc";
import { applyIndexStatus, useIndex } from "./store/useIndex";
import { useDocument } from "./store/useDocument";
import { useViewer } from "./store/useViewer";
import { useWorkspace, type TreeNode, type WorkspaceRoot } from "./store/useWorkspace";
import { notify } from "./store/useToast";

const RECENTS_KEY = "margindocs-recents";
const RECENTS_LIMIT = 12;

/** Rust already debounces the watcher; this only stops one burst becoming several tree reads. */
const REFRESH_DELAY_MS = 150;

const DEFAULT_DOCUMENT_NAME = "Untitled.md";
const DEFAULT_FOLDER_NAME = "Untitled Folder";

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

/** Takes a folder off the start screen. The folder itself is not touched in any way. */
export function forgetRecent(path: string): string[] {
  const next = readList(RECENTS_KEY).filter((p) => p !== path);
  writeList(RECENTS_KEY, next);
  return next;
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

function owns(root: WorkspaceRoot | null, path: string): root is WorkspaceRoot {
  return root !== null && (path === root.path || path.startsWith(`${root.path}/`));
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

/**
 * Opens a folder, reads its tree once and starts watching it, in place of whatever was open.
 *
 * The new folder is read before the old one is let go of, so a folder that has been deleted or
 * that will not answer leaves the user where they were rather than on an empty window. Re-opening
 * the folder that is already open is a refresh and releases nothing.
 */
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

  const previous = useWorkspace.getState().root;
  const recentFolders = rememberRecent(root.path);
  useWorkspace.setState((s) => ({
    root,
    // A folder somebody just opened should show what is in it, which is a different question from
    // whether the folders inside it are open and is why this is not left to the remembered set.
    expanded: new Set(s.expanded).add(root.path),
    selectedPath: s.selectedPath !== null && owns(root, s.selectedPath) ? s.selectedPath : null,
    recentFolders,
    scanPhase: "idle",
    scanError: null,
  }));
  if (previous !== null && previous.id !== root.id) await releaseRoot(previous.id, previous.path);

  try {
    await watchStart(root.id);
  } catch (e) {
    notify(`${root.name} will not update on its own: ${String(e)}`);
  }
  // Not awaited: the index is derived state and the folder is usable long before it is built.
  void useIndex.getState().start();
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
  // Nothing is open any more, so the index has nothing left to answer about. Asked of the store
  // rather than assumed, because this same function is what lets go of the folder being replaced
  // during a swap, and there the new folder's own pass has already started.
  if (useWorkspace.getState().root === null) useIndex.getState().reset();
  await watchStop(rootId).catch(() => {});
  await rootClose(rootId).catch(() => {});
}

/** Re-reads one root's tree. Every mutation and every watch event ends up here. */
export async function refreshRoot(rootId: string): Promise<void> {
  if (useWorkspace.getState().root?.id !== rootId) return;
  let tree: TreeNode[];
  try {
    tree = (await treeRead(rootId)).children.map(toTree);
  } catch (e) {
    useWorkspace.setState({ scanPhase: "error", scanError: String(e) });
    return;
  }
  useWorkspace.setState((s) =>
    s.root?.id === rootId
      ? { root: { ...s.root, tree }, scanPhase: "idle", scanError: null }
      : {},
  );
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
  const root = useWorkspace.getState().root;
  if (owns(root, path)) await refreshRoot(root.id);
}

/** A folder that has just had something put in it is a folder the user wants to see the inside of. */
function reveal(parentDir: string): void {
  const state = useWorkspace.getState();
  if (!state.expanded.has(parentDir)) state.toggleExpanded(parentDir);
}

export async function createDocumentIn(parentDir: string, name: string): Promise<string> {
  const node = await fileCreate(parentDir, name.trim() || DEFAULT_DOCUMENT_NAME);
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
  await followTheFile(open, affected, path, node.path);
  followTheView(path, node.path);
}

/**
 * Points the open document at where its file went, either way round.
 *
 * A clean buffer is reopened, which is what puts the rewritten links in front of the user. A dirty
 * one is not, because the flush at the top of the caller conflicted or the user typed while the
 * sweep was running, and either way the buffer is the only copy of that edit and a reopen is a
 * read that would throw it away. What it is not allowed to be is left where it was: a sweep can
 * read and write five thousand documents, which is a long time to be holding a buffer over a path
 * this app has already moved the file off, and the save on the other end of that would have put a
 * second copy of the document back at the old path. `documentMovedTo` is the whole of the fix and
 * it says why there.
 */
async function followTheFile(
  open: string | null,
  affected: boolean,
  from: string,
  to: string,
): Promise<void> {
  if (!affected || open === null) return;
  const moved = to + open.slice(from.length);
  if (useDocument.getState().dirty) documentMovedTo(moved);
  else await useDocument.getState().open(moved);
}

/**
 * The same for a picture or a PDF, which is a much shorter question than the document's.
 *
 * There is no buffer here and so no unsaved edit to weigh, which is why this is not folded into the
 * function above: that one is entirely an argument about which copy of somebody's writing wins, and
 * a view that cannot hold an edit would read as a case it had considered. A rename that takes the
 * file out of the set this app can draw, `.png` to `.bin`, closes the view rather than reopening it
 * on something with no viewer, since a pane left showing the old picture is a pane lying about
 * which file is on screen.
 */
function followTheView(from: string, to: string): void {
  const viewed = useViewer.getState().path;
  if (viewed === null || !(viewed === from || viewed.startsWith(`${from}/`))) return;
  const moved = to + viewed.slice(from.length);
  if (viewerKindForPath(moved) === null) useViewer.getState().close();
  else useViewer.getState().open(moved);
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
  await followTheFile(open, affected, path, node.path);
  followTheView(path, node.path);
  return node.path;
}

export async function duplicatePath(path: string): Promise<string> {
  const node = await fileDuplicate(path);
  await refreshOwnerOf(node.path);
  return node.path;
}

/** To the system Trash, and whatever the pane was showing of it goes with it. */
export async function trashPath(path: string): Promise<void> {
  await fileTrash(path);
  const open = useDocument.getState().path;
  if (open !== null && (open === path || open.startsWith(`${path}/`))) abandonDocument();
  const viewed = useViewer.getState().path;
  if (viewed !== null && (viewed === path || viewed.startsWith(`${path}/`))) {
    useViewer.getState().close();
  }
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
 * What a launch restores, which is the recents list and nothing else.
 *
 * Reopening last session's folder was the old behaviour and it is gone on purpose: a window that
 * comes back holding a project you had finished with is a window you have to close something in
 * before you can start, so the app opens on the list of folders instead and waits to be told which
 * one. src/components/Recents.tsx is that screen.
 *
 * The backend outlives the window's idea of what is open, though. `roots_list` reads a list Rust
 * persists in the app data directory, so a folder from last session is still a live watcher and a
 * live set of index rows on that side. Nothing on screen would mention it, so it is let go of here
 * rather than left running behind the start screen.
 */
export async function restoreSession(): Promise<void> {
  // Before the list goes on screen, not after. A row that can be clicked while the release is
  // still running is a folder the user opens and this function then closes underneath them.
  if (live()) {
    for (const stale of await rootsList().catch(() => [])) {
      await releaseRoot(stale.id, stale.path);
    }
  }
  useWorkspace.setState({ recentFolders: readList(RECENTS_KEY) });
}
