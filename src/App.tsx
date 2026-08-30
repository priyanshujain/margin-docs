// The window, and the only file that knows what the whole app looks like at once.
//
// Everything here is wiring: which surface is on screen, which of the backend's events the shell
// listens for, and what happens to an unsaved document when the window is asked to close. No
// business logic and no disk access. The stores hold state, their sibling modules do the work, and
// this file decides what is mounted.
//
// One document at a time and no tab bar, so there is exactly one editor in the tree and it is
// either the WYSIWYG surface or the plain text one, never both. A folder of documents can be open
// with nothing chosen out of it, which is why the empty pane is a state and not an error.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Backlinks } from "./components/Backlinks";
import { CommandPalette } from "./components/CommandPalette";
import { ConflictDialog } from "./components/ConflictDialog";
import { ExportPreview } from "./components/ExportPreview";
import { FindBar } from "./components/FindBar";
import { FindInFiles } from "./components/FindInFiles";
import { ProofPopover } from "./components/ProofPopover";
import { QuickOpen } from "./components/QuickOpen";
import { Recents } from "./components/Recents";
import { Settings } from "./components/Settings";
import { Shortcuts } from "./components/Shortcuts";
import { Sidebar } from "./components/Sidebar";
import { Titlebar } from "./components/Titlebar";
import { Toast } from "./components/Toast";
import { UpdateDialog } from "./components/UpdateDialog";
import { flushPendingSave, keepBuffer } from "./document";
import { DocumentEditor, PlainTextEditor, useDocumentFind } from "./editor";
import { Toolbar, type ToolbarSaveState } from "./editor/Toolbar";
import { MENU_ACTION_EVENT, isDesktop, isTauri } from "./ipc";
import { onCommand } from "./keys/commands";
import { useKeymap } from "./keys/keymap";
import { handleMenuAction } from "./keys/menu";
import { openLink } from "./links";
import { documentKindForPath } from "./model/doc";
import { useDocument } from "./store/useDocument";
import { useDocumentFonts } from "./store/useDocumentFonts";
import { notify } from "./store/useToast";
import { useWorkspace } from "./store/useWorkspace";
import { startUpdateChecks } from "./update";
import { useCompact, useTouch } from "./useMedia";
import { applyWidth } from "./width";
import { restoreSession, startWorkspaceEvents } from "./workspace";

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function App() {
  const roots = useWorkspace((s) => s.roots);
  const path = useDocument((s) => s.path);
  const openDocument = useDocument((s) => s.document);
  const savePhase = useDocument((s) => s.savePhase);
  const externalChange = useDocument((s) => s.externalChange);
  const setContent = useDocument((s) => s.setContent);
  const reloadFromDisk = useDocument((s) => s.reloadFromDisk);
  const find = useDocumentFind();

  const [resolving, setResolving] = useState(false);

  useKeymap();
  useCompact();
  useTouch();

  useEffect(() => {
    void restoreSession();
  }, []);

  // `watch-event` and `index-progress`, both of them landing in the stores that care. The routing
  // itself belongs to src/workspace.ts, which is the module that already knows which root a path
  // sits under and whether the open document was the file that moved.
  useEffect(() => startWorkspaceEvents(), []);

  // The native menu emits a command id, so this is a lookup and not a second dispatch table. A
  // phone has a menu bar to emit from too, hence isTauri rather than isDesktop.
  useEffect(() => {
    if (!isTauri) return;
    const pending = listen<string>(MENU_ACTION_EVENT, (event) => handleMenuAction(event.payload));
    return () => {
      void pending.then((stop) => stop()).catch(() => {});
    };
  }, []);

  // Quitting with an edit half a second old must not lose it. The debounce is cancelled and the
  // save run to completion before the window is allowed to go, and the close is only intercepted
  // when there is actually something to write.
  useEffect(() => {
    if (!isDesktop) return;
    const win = getCurrentWindow();
    const pending = win.onCloseRequested(async (event) => {
      if (!useDocument.getState().dirty) return;
      event.preventDefault();
      await flushPendingSave();
      void win.destroy();
    });
    return () => {
      void pending.then((stop) => stop()).catch(() => {});
    };
  }, []);

  // The face the page is set in belongs to the document rather than to the app, so it is applied
  // here, on the path, rather than restored once at boot the way the theme and the width are. A
  // closed document takes the app back to its default pair, which is what the empty pane behind it
  // is drawn in anyway.
  useEffect(() => {
    useDocumentFonts.getState().openFor(path);
  }, [path]);

  useEffect(() => {
    const stops = [
      onCommand("editor-width-narrow", () => applyWidth("narrow")),
      onCommand("editor-width-normal", () => applyWidth("normal")),
      onCommand("editor-width-wide", () => applyWidth("wide")),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

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
        {roots.length === 0 ? (
          <Recents />
        ) : (
          <>
            <Sidebar />
            <main className="editor-pane">
              {openDocument === null || kind === null ? (
                <p className="pane-empty">Choose a document from the sidebar.</p>
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
      <QuickOpen />
      <FindInFiles />
      <CommandPalette />
      <ExportPreview />
      <ProofPopover />
      <Shortcuts />
      <Settings />
      <UpdateDialog />
      <Toast />

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
