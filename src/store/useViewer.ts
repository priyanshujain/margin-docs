// The file the editor pane is showing rather than editing: a picture, or a PDF.
//
// This is a store of its own and not three more fields on the document store, and the reason is the
// promise the whole app is built on. That store is a buffer with a dirty flag, a debounce and a
// save path behind it, and everything in it exists to get bytes back onto disk eventually. A file
// that can never be written has no business in it: there would be nothing to stop a later change to
// the save path from finding a document-shaped thing there and writing it, and "nothing currently
// calls that" is not a guarantee. Here there is no content, no timestamp, no dirty flag and no
// serializer, so the strongest thing that can be said about viewing a picture is true by
// construction rather than by review.
//
// What it does own is the other half of that promise: exactly one thing is on screen. Opening a
// file to look at closes the document, and src/document.ts closes this on its way to opening a
// document. Both directions are one line each and there is no third place either of them can be
// reached from.
//
// The bytes are deliberately not here. A blob url has to be revoked and a pdf.js document has to be
// destroyed, both of them when the thing showing them goes away, and the component that mounts and
// unmounts with the view is the only place that knows when that is. What the store holds is which
// file, which is what the shell and the sidebar need and all they need.

import { create } from "zustand";
import { viewerKindForPath, type ViewerKind } from "../model/doc";
import { useDocument } from "./useDocument";

interface ViewerState {
  path: string | null;
  kind: ViewerKind | null;

  /** Shows a file. A path this app has no viewer for is ignored rather than opened empty. */
  open: (path: string) => void;
  close: () => void;
}

export const useViewer = create<ViewerState>((set) => ({
  path: null,
  kind: null,

  open: (path) => {
    const kind = viewerKindForPath(path);
    if (kind === null) return;
    // The document goes before the picture arrives, and through `close` rather than by clearing the
    // fields, because an edit half a second old is still on the debounce and closing is what flushes
    // it. Looking at a photograph must not be the thing that loses somebody a sentence.
    useDocument.getState().close();
    set({ path, kind });
  },
  close: () => set((s) => (s.path === null ? {} : { path: null, kind: null })),
}));
