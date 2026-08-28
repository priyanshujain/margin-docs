// The single open document: what is on disk, what is in the editor, and whether the two still
// agree. Reading, writing, the debounce and the reconciliation against an external change all live
// in src/document.ts, which these async actions delegate to; what is left here is state, the
// setters a keystroke can settle on its own, and the navigation history.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { create } from "zustand";
import {
  differsFromDisk,
  flushPendingSave,
  loadDocument,
  reloadDocument,
  saveNow,
} from "../document";
import type { MarkdownDocument } from "../model/doc";

/**
 * The bridge's document, re-exported so a component can name what the store holds without knowing
 * where the bridge lives.
 */
export type { MarkdownDocument };

export type SavePhase = "idle" | "saving" | "error";

/** Whether the file on disk still matches what this document last read or wrote. */
export type ExternalChangeState = "synced" | "changed-on-disk";

interface DocumentState {
  path: string | null;
  /** The document as it was parsed: the frontmatter to put back, the source it came from, and the
   * tree the editor was handed. A new identity means a different file or a reload, never a
   * keystroke, which is what keeps the editor from remounting under the cursor. */
  document: MarkdownDocument | null;
  /** The tree as the editor has it now, which is what a save serializes. `document.doc` is the
   * tree as it was opened, so serializing that would write the file back as it was found. */
  content: ProseMirrorNode | null;
  /** The modification time the read came back with, handed to `file_write` so a file something
   * else has touched since comes back as a conflict instead of being overwritten. */
  modifiedMs: number | null;
  dirty: boolean;
  savePhase: SavePhase;
  saveError: string | null;
  /** The leading metadata block exactly as it was on disk, delimiters included, or null. Never
   * parsed: it is carried opaque and written back in front of the body untouched. */
  frontmatter: string | null;
  externalChange: ExternalChangeState;
  /** Paths visited, oldest first. `historyIndex` is where `path` currently sits in it; a fresh
   * `open` cuts the branch after that point, `back`/`forward` only move the pointer along it. */
  history: string[];
  historyIndex: number;

  open: (path: string) => Promise<void>;
  close: () => void;
  setContent: (content: ProseMirrorNode) => void;
  save: () => Promise<void>;
  markChangedOnDisk: () => void;
  reloadFromDisk: () => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
}

export const useDocument = create<DocumentState>((set, get) => ({
  path: null,
  document: null,
  content: null,
  modifiedMs: null,
  dirty: false,
  savePhase: "idle",
  saveError: null,
  frontmatter: null,
  externalChange: "synced",
  history: [],
  historyIndex: -1,

  open: async (path) => {
    if (get().path === path) return;
    await flushPendingSave();
    await loadDocument(path);
    set((s) => {
      const history = [...s.history.slice(0, s.historyIndex + 1), path];
      return { history, historyIndex: history.length - 1 };
    });
  },
  close: () => {
    void flushPendingSave();
    set({
      path: null,
      document: null,
      content: null,
      modifiedMs: null,
      dirty: false,
      savePhase: "idle",
      saveError: null,
      frontmatter: null,
      externalChange: "synced",
    });
  },
  // Dirty means the buffer and the file disagree, so it is asked of the file, and of the file as it
  // was read rather than of the tree a keystroke ago. Both halves of that matter, because what
  // comes off the debounce for a file the editor has never written is its whole house style
  // rewrite. Dragging a table column edge writes a width on to every cell in it and GFM has no
  // column widths, so the document changed and the bytes did not; typing two characters and
  // undoing them is two transactions that leave the buffer holding the document that was opened,
  // and a flag carried forward from the first would have the file rewritten for the pair.
  setContent: (content) =>
    set((s) => (s.document ? { content, dirty: differsFromDisk(content) } : {})),
  save: async () => {
    await saveNow();
  },
  markChangedOnDisk: () => set({ externalChange: "changed-on-disk" }),
  reloadFromDisk: async () => {
    await reloadDocument();
  },
  back: async () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    await flushPendingSave();
    await loadDocument(history[historyIndex - 1]);
    set({ historyIndex: historyIndex - 1 });
  },
  forward: async () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    await flushPendingSave();
    await loadDocument(history[historyIndex + 1]);
    set({ historyIndex: historyIndex + 1 });
  },
}));
