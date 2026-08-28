// The editor layer's public surface, which is everything the shell is allowed to know about it.
// TipTap and ProseMirror live below this line and nothing above it imports them: the shell renders
// a document and drives a toolbar, and neither of those is a reason for an editor instance to leak
// into a component that draws a button.
//
// There is one editor and one document. No tab bar, nothing rendering two of these, and no
// component reaching in to push content at an editor that is already open.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CalloutKind, HeadingLevel, MarkdownDocument } from "../model/doc";
import type { MarkName } from "../model/schema";
import { useDocumentFind as useMarkdownFind } from "./Editor";
import { usePlainTextFind } from "./PlainTextEditor";
import type { SearchOptions } from "./search";

export type { SearchOptions };

/**
 * A block a toolbar button can turn the current one into. Headings and callouts are not here
 * because they carry a variant and have their own setters, and a table is an insert rather than a
 * conversion.
 */
export type BlockCommand =
  | "paragraph"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "toggle";

/**
 * The kind of block the cursor is in, named the way the schema names it. `raw` and `mathBlock` can
 * be reported but not asked for: the bridge produces them and no button does.
 */
export type BlockKind = BlockCommand | "heading" | "callout" | "table" | "mathBlock" | "raw";

/**
 * An edit to the table the cursor is in. The align ops set the GFM delimiter row's alignment for
 * the whole column the cursor is in, since markdown has no per cell alignment; `alignClear` puts
 * the column back to the delimiter row's default.
 *
 * There is no header row op. A GFM table has exactly one header row, it is the first one, and there
 * is no spelling for a table without one, so a toggle would be an edit the file cannot hold and the
 * next open of it would silently take back. src/editor/blocks/tables.ts keeps every other op to
 * that same shape instead.
 */
export type TableOp =
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "deleteTable"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignClear";

/**
 * What the toolbar draws its pressed states from. A new object on every selection or document
 * change, which is what keeps the pill live without it polling anything.
 */
export interface EditorActiveState {
  /** The marks under the cursor, or the marks covering the whole of a selection. */
  marks: readonly MarkName[];
  /** The innermost block the cursor is in. A cursor inside a list item reports the list itself,
   * since the list is what the button the user pressed produced. */
  block: BlockKind;
  /** Set only when `block` is "heading". */
  headingLevel: HeadingLevel | null;
  /** Set only when `block` is "callout". */
  callout: CalloutKind | null;
  /** Whether the cursor is anywhere inside a table, which is what the row and column controls are
   * enabled by. Not the same question as `block`: a table nested in a callout reports the table,
   * but the cell the cursor is in is several levels down from it. */
  inTable: boolean;
  /** Set only when `block` is "codeBlock". null is a fence with no language on it. */
  codeLanguage: string | null;
}

/**
 * What the sticky bottom toolbar drives. Deliberately not TipTap's `Editor`: handing the shell an
 * editor instance would make every button a place the editor's API leaks out, and the pill would
 * end up encoding the schema a second time.
 */
export interface EditorHandle {
  active: EditorActiveState;
  /** Puts the cursor back where it was. Every button calls this, because clicking one takes focus
   * out of the document and a formatting command without a selection has nothing to act on. */
  focus: () => void;
  toggleMark: (mark: MarkName) => void;
  /** null clears the link across the selection. */
  setLink: (href: string | null, title?: string | null) => void;
  /** Turns the block the cursor is in into this one. Asking for the block it already is turns it
   * back into a paragraph, which is what a second press of the same button means. */
  setBlock: (block: BlockCommand) => void;
  /** null turns a heading back into a paragraph. */
  setHeading: (level: HeadingLevel | null) => void;
  /** null turns a callout back into the ordinary blockquote it is on disk. */
  setCallout: (kind: CalloutKind | null) => void;
  insertRule: () => void;
  /** Whether an image could go where the cursor is, asked before any bytes are written to disk.
   * The Insert image tool has to write the picture into the user's assets folder before it has a
   * path to insert, so a refusal after the write is a file sitting beside their document that
   * nothing refers to and nobody was told about. */
  canInsertImage: () => boolean;
  /** `src` is written into the file as it stands, so it is a path relative to the document. */
  insertImage: (src: string, alt?: string | null) => void;
  insertTable: (rows: number, columns: number) => void;
  /** Edits the table the cursor is in. Does nothing when it is not in one, so the caller can ask
   * without checking `active.inTable` first. */
  tableCommand: (op: TableOp) => void;
  /** `display` inserts a mathBlock rather than an inline formula. Both start with a placeholder
   * formula in them, selected, so the first keystroke replaces it. Neither starts empty: an empty
   * formula is `$$$$` on disk, which is not a formula when the file is read back, so a box the
   * editor draws and the file cannot hold is a box that disappears on the next save. */
  insertMath: (display: boolean) => void;
  /** A mermaid diagram is a fenced code block, so this inserts an empty ```mermaid fence. */
  insertMermaid: () => void;
  /** The language on the fence the cursor is in. null leaves a bare fence. Whatever the fence
   * carried after its language is untouched, since the editor has no model for it. */
  setCodeLanguage: (language: string | null) => void;
}

/** Zero based, so a bar showing "3 of 12" draws `current + 1` of `count`. */
export interface FindState {
  count: number;
  current: number;
}

/**
 * Find and replace across the open document, whichever surface it is open in. Highlighting is
 * whatever the surface can show without touching the file (a ProseMirror decoration in the
 * markdown editor, the browser's own selection in the plain text one) and replacing is an ordinary
 * edit, so a search can never write anything by itself.
 *
 * Structurally the `DocumentFind` that src/components/FindBar.tsx declares it needs, so the bar
 * takes what `useDocumentFind` returns with nothing in between adapting one shape to the other, and
 * nothing in it about which editor produced it.
 */
export interface DocumentFind {
  /** A new object whenever the count or the position in it changes. */
  state: FindState;
  setQuery: (query: string, options: SearchOptions) => void;
  clear: () => void;
  next: () => void;
  prev: () => void;
  replaceCurrent: (text: string) => void;
  replaceAll: (text: string) => void;
  /** Puts the cursor back in the document, which every replace has to do to be worth anything. */
  focus: () => void;
}

export interface EditorProps {
  /** The document to edit, already parsed by the bridge. A new object identity means a different
   * file or a reload from disk, never a keystroke: while a document is open the editor owns its
   * tree and nothing outside pushes changes into it. */
  document: MarkdownDocument;
  /** Every change to the tree, as it happens. The shell turns this into a dirty flag and a
   * debounced save. The editor never writes to disk itself, and never renames anything, whatever
   * the first heading now says. */
  onChange: (doc: ProseMirrorNode) => void;
  /** A click on a link inside the document. Resolving it belongs to the shell: a relative link to
   * another markdown file is a navigation, and anything else goes to the system. */
  onOpenLink: (href: string) => void;
  /** False while a conflict is being resolved, so the buffer cannot drift further from what is on
   * disk while the user decides which copy wins. Defaults to true. */
  editable?: boolean;
}

/** The same pair, for the .txt surface, which has no links to open and no toolbar to drive. */
export type PlainTextProps = Omit<EditorProps, "onOpenLink">;

/** The document surface itself. */
export { DocumentEditor, useEditorHandle } from "./Editor";

/** The .txt surface. Which of the two to render comes from `documentKindForPath`. */
export { PlainTextEditor } from "./PlainTextEditor";

/**
 * Find and replace for whichever surface is on screen. There is one editor and one document, so
 * exactly one of the markdown handle and the plain text handle is ever non-null at a time; this is
 * only the seam that spares FindBar.tsx from asking `documentKindForPath` to find out which one.
 *
 * Both hooks are called on every render, unconditionally: `??` on the values they return, not on
 * the calls themselves, because a hook skipped on some renders and not others is a Rules of Hooks
 * violation the moment the document kind changes.
 */
export function useDocumentFind(): DocumentFind | null {
  const markdown = useMarkdownFind();
  const plain = usePlainTextFind();
  return markdown ?? plain;
}
