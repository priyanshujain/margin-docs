// This window among the others. Rust decides which window owns which document, so a document is
// only opened here once the backend agrees nobody else has it, and anything this window should not
// open in place is handed back to be opened in a window of its own.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  documentClaim,
  documentOpen,
  documentSet,
  windowCloseRefused,
  windowCreate,
  windowInit,
} from "./api/windows";
import { flushPendingSave } from "./document";
import { WINDOW_REQUEST_EVENT, isTauri, type WindowRequest } from "./ipc";
import { handleMenuAction } from "./keys/menu";
import { useDocument } from "./store/useDocument";
import { notify } from "./store/useToast";
import { useWindow } from "./store/useWindow";
import { useWorkspace } from "./store/useWorkspace";
import { addRoot, pickFolder, restoreSession } from "./workspace";

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function syncDocument(): void {
  if (isTauri) void documentSet(useDocument.getState().path).catch(() => {});
}

/**
 * Saves the open document before the window shows something else. False when that save failed,
 * which leaves the edit where it is and the document on screen.
 */
export async function leaveDocument(next: string): Promise<boolean> {
  const { path } = useDocument.getState();
  if (path === null || path === next) return true;
  await flushPendingSave();
  if (!useDocument.getState().dirty) return true;
  notify(`${baseName(path)} could not be saved, so it is still open.`);
  return false;
}

/** False when another window already has `path` open; that window has been brought forward. */
export async function claimDocument(path: string): Promise<boolean> {
  if (!isTauri) return true;
  return documentClaim(path).catch(() => true);
}

/** Opens a document in this window, unless another window has it or this one cannot let go. */
export async function openDocumentHere(path: string): Promise<void> {
  if (!(await leaveDocument(path))) return;
  if (!(await claimDocument(path))) return;
  try {
    await useDocument.getState().open(path);
  } finally {
    syncDocument();
  }
}

/**
 * A Markdown file reached through a link. One inside this window's folder opens here like a row in
 * the sidebar would; anything else, which is every link out of a standalone document, opens in a
 * window of its own or brings forward the window that has it.
 */
export async function followDocument(path: string): Promise<void> {
  const root = useWorkspace.getState().root;
  if (isTauri && (root === null || !path.startsWith(`${root.path}/`))) {
    await documentOpen(path);
    return;
  }
  await openDocumentHere(path);
}

/** Open Folder from a standalone document, which leaves that document where it is. */
export async function openFolderInNewWindow(): Promise<void> {
  const path = await pickFolder();
  if (path !== null) await windowCreate(path);
}

async function apply(request: WindowRequest | null): Promise<void> {
  if (request === null) return;
  if (request.document) {
    const path = request.document;
    useWindow.setState({ standalone: true });
    await useDocument
      .getState()
      .open(path)
      .catch((e) => notify(`Could not open ${baseName(path)}: ${String(e)}`));
  }
  if (request.folder) {
    await addRoot(request.folder).catch((e) => notify(`Could not open folder: ${String(e)}`));
  }
  if (request.action) handleMenuAction(request.action);
}

/** Asked once per page load, however many times React mounts the shell. */
let initial: Promise<WindowRequest | null> | null = null;

/**
 * Starts the window: the start screen's list, whatever the window was opened to show, requests
 * that arrive while it is open, and keeping the backend told which document is on screen.
 */
export function startWindow(): () => void {
  let stopped = false;
  const stopSync = useDocument.subscribe((state, previous) => {
    if (state.path !== previous.path) syncDocument();
  });
  const listening = isTauri
    ? getCurrentWebviewWindow().listen<WindowRequest>(WINDOW_REQUEST_EVENT, (event) => {
        void apply(event.payload);
      })
    : null;

  initial ??= restoreSession().then(() => (isTauri ? windowInit().catch(() => null) : null));
  void initial.then((request) => {
    if (!stopped) void apply(request);
  });

  return () => {
    stopped = true;
    stopSync();
    void listening?.then((stop) => stop()).catch(() => {});
  };
}

/**
 * Lets the window close once its document is on disk. A save that fails keeps the window open,
 * says so, and calls off a quit that was waiting on it.
 */
export function guardClose(): () => void {
  const win = getCurrentWebviewWindow();
  const pending = win.onCloseRequested(async (event) => {
    if (!useDocument.getState().dirty) return;
    event.preventDefault();
    await flushPendingSave();
    const { dirty, path } = useDocument.getState();
    if (dirty) {
      notify(`${path === null ? "The document" : baseName(path)} could not be saved, so this window stays open.`);
      void windowCloseRefused().catch(() => {});
      return;
    }
    void win.destroy();
  });
  return () => {
    void pending.then((stop) => stop()).catch(() => {});
  };
}
