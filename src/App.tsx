// The window, and the only file that knows what the whole app looks like at once.
//
// Everything here is wiring: which surface is on screen, which of the backend's events the shell
// listens for, and what happens to an unsaved document when the window is asked to close. No
// business logic and no disk access. The stores hold state, their sibling modules do the work, and
// this file decides what is mounted.
//
// One document at a time and no tab bar, so there is exactly one surface in the tree: the WYSIWYG
// editor, the plain text one, or the read only viewer a picture and a PDF open in, and never two of
// them. Which one is a question about the path, and the two stores behind them cannot both be
// holding something at once, which is argued out in src/store/useViewer.ts. A folder of documents
// can be open with nothing chosen out of it, which is why the empty pane is a state and not an
// error.
//
// One folder at a time too, and no folder at all until the user picks one, so the window's two
// halves are the start screen and the workspace and never both. A window opened for one Markdown
// file on its own is the third shape: the document with no sidebar and no folder behind it.

import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Backlinks } from "./components/Backlinks";
import { CommandPalette } from "./components/CommandPalette";
import { ConflictDialog } from "./components/ConflictDialog";
import { DocumentSetup } from "./components/DocumentSetup";
import { ExportPreview } from "./components/ExportPreview";
import { FileViewer } from "./components/FileViewer";
import { FindBar } from "./components/FindBar";
import { FindInFiles } from "./components/FindInFiles";
import { Outline } from "./components/Outline";
import { ProofPopover } from "./components/ProofPopover";
import { QuickOpen } from "./components/QuickOpen";
import { Recents } from "./components/Recents";
import { Settings } from "./components/Settings";
import { Shortcuts } from "./components/Shortcuts";
import { Sidebar } from "./components/Sidebar";
import { Titlebar } from "./components/Titlebar";
import { Toast } from "./components/Toast";
import { UpdateDialog } from "./components/UpdateDialog";
import { keepBuffer } from "./document";
import { DocumentEditor, PlainTextEditor, useDocumentFind, useEditorHandle } from "./editor";
import { Toolbar, type ToolbarSaveState } from "./editor/Toolbar";
import { MENU_ACTION_EVENT, isDesktop, isTauri } from "./ipc";
import { onCommand, targetDir } from "./keys/commands";
import { useKeymap } from "./keys/keymap";
import { handleMenuAction } from "./keys/menu";
import { openLink } from "./links";
import { documentKindForPath } from "./model/doc";
import { useDocument } from "./store/useDocument";
import { useDocumentFonts } from "./store/useDocumentFonts";
import { useViewer } from "./store/useViewer";
import { notify } from "./store/useToast";
import { useWindow } from "./store/useWindow";
import { useWorkspace } from "./store/useWorkspace";
import { startUpdateChecks } from "./update";
import { useCompact, useTouch } from "./useMedia";
import { startWidthCommands } from "./width";
import { guardClose, startWindow } from "./windows";
import { startWorkspaceEvents } from "./workspace";

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The blank paper under the document, and the way back into it.
 *
 * A sheet grows to fill the pane whether or not the document does, so a short file is a few lines
 * of prose over several hundred pixels of empty page. None of that is the editable: it is the
 * article the editor is mounted in, so a press on it landed on a plain div, moved no caret, and
 * took the focus out of the document. Clicking the page put the writer out of their own file, and
 * the only way back was to find a line and click on that.
 *
 * So the space is claimed, and what it does with a press is what every editor with a page under it
 * does: put the caret at the end, making a paragraph to hold it when the last block cannot. That is
 * also the general way out of a table, a rule, a diagram or a fence that ends a document, which the
 * table and code lanes each answer for their own block and their own key; this one needs no key and
 * does not care which block it is.
 *
 * mousedown rather than click, and prevented. The blur happens on the press, so by the time a click
 * arrives the editor has already lost the selection this is trying to move, and preventing the
 * default is what stops the browser taking focus to a div in the first place.
 *
 * A component of its own so that the subscription is one: `useEditorHandle` publishes a new object
 * on every change the pill draws from, and a shell that re-rendered the sidebar, the title bar and
 * every panel on each of them would be paying the whole window for a click target.
 */
function AppendZone() {
  const editor = useEditorHandle();
  return (
    <div
      className="append-zone"
      onMouseDown={(event) => {
        event.preventDefault();
        editor?.focusEnd();
      }}
    />
  );
}

function App() {
  const root = useWorkspace((s) => s.root);
  const standalone = useWindow((s) => s.standalone);
  const path = useDocument((s) => s.path);
  const openDocument = useDocument((s) => s.document);
  const savePhase = useDocument((s) => s.savePhase);
  const externalChange = useDocument((s) => s.externalChange);
  const setContent = useDocument((s) => s.setContent);
  const reloadFromDisk = useDocument((s) => s.reloadFromDisk);
  const viewedPath = useViewer((s) => s.path);
  const viewedKind = useViewer((s) => s.kind);
  const find = useDocumentFind();

  const [resolving, setResolving] = useState(false);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);

  useKeymap();
  useCompact();
  useTouch();

  // The recents list, and whatever this window was opened to show: a file from Finder, a folder
  // from another window's Open Folder, or nothing.
  useEffect(() => startWindow(), []);

  // `watch-event` and `index-progress`, both of them landing in the stores that care. The routing
  // itself belongs to src/workspace.ts, which is the module that already knows which root a path
  // sits under and whether the open document was the file that moved.
  useEffect(() => startWorkspaceEvents(), []);

  // The native menu emits a command id, so this is a lookup and not a second dispatch table. A
  // phone has a menu bar to emit from too, hence isTauri rather than isDesktop. The backend sends it
  // to the window it was chosen in, and only a listener on this window keeps the others out of it.
  useEffect(() => {
    if (!isTauri) return;
    const pending = getCurrentWebviewWindow().listen<string>(MENU_ACTION_EVENT, (event) =>
      handleMenuAction(event.payload),
    );
    return () => {
      void pending.then((stop) => stop()).catch(() => {});
    };
  }, []);

  // Closing or quitting with an edit half a second old must not lose it. The save runs to
  // completion before the window is allowed to go, and one that fails keeps it open.
  useEffect(() => {
    if (!isDesktop) return;
    return guardClose();
  }, []);

  // The face the page is set in belongs to the document rather than to the app, so it is applied
  // here, on the path, rather than restored once at boot the way the theme and the width are. A
  // closed document takes the app back to its default pair, which is what the empty pane behind it
  // is drawn in anyway.
  useEffect(() => {
    useDocumentFonts.getState().openFor(path);
  }, [path]);

  // A viewer holds a path out of the folder that was open when it was clicked, so a folder that
  // closes or is swapped for another takes it with it. The document store has this done for it in
  // src/workspace.ts, where the folder is actually let go of, but a picture is not that module's
  // business and the shell is what decides what is mounted. Without it, opening a second folder
  // draws the first folder's picture over it and then fails to read it, since the backend's root
  // guard is the next thing that would notice.
  useEffect(() => {
    const viewed = useViewer.getState().path;
    if (viewed === null) return;
    if (root === null || !(viewed === root.path || viewed.startsWith(`${root.path}/`))) {
      useViewer.getState().close();
    }
  }, [root]);

  // New Document is a panel before it is a file: the name and the faces are chosen first and
  // nothing is written until Save. The folder it lands in is the same one the command guarded on,
  // asked again here rather than carried through the dispatch, which has no payload by design.
  useEffect(
    () =>
      onCommand("new-doc", () => {
        const dir = targetDir();
        if (dir !== null) setCreatingIn(dir);
      }),
    [],
  );

  useEffect(() => startWidthCommands(), []);

  // The check the app makes on its own, which is off unless the setting says otherwise and silent
  // unless it finds something. Pressing Check for Updates goes through the command table instead
  // and answers either way, because somebody who asked is owed a sentence.
  useEffect(() => startUpdateChecks(), []);

  const conflict = externalChange === "changed-on-disk";

  // Asked once, when the conflict appears. Dismissing it leaves the warning in the toolbar to
  // reopen rather than asking again on the next keystroke.
  useEffect(() => {
    if (conflict) setResolving(true);
  }, [conflict]);

  const kind = path === null ? null : documentKindForPath(path);
  const saveState: ToolbarSaveState = conflict
    ? "conflict"
    : savePhase === "saving"
      ? "saving"
      : "idle";

  return (
    <div className="app">
      <Titlebar />

      <div className="stage">
        {root === null && !standalone ? (
          <Recents />
        ) : (
          <>
            {root !== null && <Sidebar />}
            <main className="editor-pane">
              {viewedPath !== null && viewedKind !== null ? (
                // Keyed by the path, so a second picture is a second component rather than the same
                // one handed new bytes. Every blob url and every pdf.js document it holds is
                // released by the cleanup that unmount runs, which is the whole of its lifetime
                // management and is much harder to get wrong than a reset effect would be.
                <FileViewer key={viewedPath} path={viewedPath} kind={viewedKind} />
              ) : openDocument === null || kind === null ? (
                <p className="pane-empty">
                  {standalone ? "No document is open." : "Choose a document from the sidebar."}
                </p>
              ) : kind === "markdown" ? (
                <>
                  <article className="sheet">
                    <DocumentEditor
                      document={openDocument}
                      onChange={setContent}
                      onOpenLink={openLink}
                      editable={!resolving}
                    />
                    <Backlinks />
                    {/* Under the backlinks rather than over them, which is the one thing about
                        this that is not obvious. The section is silent for most documents, so the
                        two orders are the same page nearly always; where it is not silent, a zone
                        that grows above it pushes "Linked from" to the bottom of the window, a
                        screen away from the document it is about, and leaves it with the toolbar
                        floating over its last row. */}
                    <AppendZone />
                  </article>
                  <Toolbar
                    document={openDocument}
                    saveState={saveState}
                    onResolveConflict={() => setResolving(true)}
                  />
                </>
              ) : (
                <article className="sheet">
                  <PlainTextEditor
                    document={openDocument}
                    onChange={setContent}
                    editable={!resolving}
                  />
                </article>
              )}
            </main>
          </>
        )}
      </div>

      <FindBar find={find} />
      <Outline />
      <QuickOpen />
      <FindInFiles />
      <CommandPalette />
      <ExportPreview />
      <ProofPopover />
      <Shortcuts />
      <Settings />
      <UpdateDialog />
      <Toast />

      {creatingIn !== null && (
        <DocumentSetup createIn={creatingIn} onClose={() => setCreatingIn(null)} />
      )}

      {resolving && conflict && path !== null && (
        <ConflictDialog
          name={baseName(path)}
          onReload={() => {
            setResolving(false);
            reloadFromDisk().catch((e) => notify(`Could not reload: ${String(e)}`));
          }}
          onKeep={() => {
            setResolving(false);
            keepBuffer();
          }}
          onDismiss={() => setResolving(false)}
        />
      )}
    </div>
  );
}

export default App;
