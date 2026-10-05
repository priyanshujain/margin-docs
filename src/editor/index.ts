// The editor layer's public surface, which is everything the shell is allowed to know about it.
// TipTap and ProseMirror live below this line and nothing above it imports them: the shell renders
// a document and drives a toolbar, and neither of those is a reason for an editor instance to leak
// into a component that draws a button.
//
// There is one editor and one document. No tab bar, nothing rendering two of these, and no
// component reaching in to push content at an editor that is already open.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CalloutKind, HeadingLevel, MarkdownDocument } from "../model/doc";
import type { OutlineEntry } from "../model/outline";
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

  // The four below are src/editor/fits.ts's own answers, published so that the pill can draw them.
  // Every one of them was already being asked at the moment a button was pressed, and answered by
  // the command doing nothing at all: sixteen of the eighteen tools sat lit over a fence, a raw
  // block or a table cell that refuses them, and a person who pressed one got silence. A tool that
  // cannot run is a tool drawn dark, which is the same sentence the conflict state already says.
  //
  // Drawn dark rather than taken away, which is where this parts company with the editors that hide
  // a toolbar item instead. The pill is a fixed surface at a fixed place, so a tool that vanishes
  // under the pointer moves every tool beside it, and the layout is the one thing about this bar
  // that never moves.

  /** Whether a mark can exist over the selection, which a fence and a raw block both refuse: they
   * declare `marks: ""`, so bold, italic, strikethrough, inline code, colour and a link have
   * nowhere to live there. One answer covers all six because those two nodes are the only ones in
   * the frozen schema that name their marks. */
  canMark: boolean;
  /** Whether a block node can go where the selection is: false in a fence, in a raw block, in a
   * table cell and over a dragged rectangle of cells. One answer covers the rule, the table, the
   * display formula and the mermaid fence, since every block in this schema is in the one group and
   * every container either takes that group or takes none of it. */
  canPlace: boolean;
  /** And the same question for an inline node, which is a different answer in exactly one place: a
   * table cell holds inline content, so a picture or an inline formula goes into one perfectly
   * happily while a block does not.
   *
   * The same question `canInsertImage` answers, published rather than called because the pill draws
   * itself from this snapshot and a live call would only be right on the renders the snapshot
   * happened to cause. A drag across a rectangle of cells is the one that proves it: nothing else
   * on this object moves, and the answer here goes from yes to no. */
  canPlaceInline: boolean;
  /** Whether a block conversion may run here at all. False in a raw block, whose bytes are the
   * file's own, and false anywhere in a table, where a cell holds inline content and there is no
   * block for a conversion to act on.
   *
   * A fence is not in that list and that is deliberate: turning one into a paragraph, a list or a
   * quote is an edit markdown can spell and src/editor/fits.test.ts pins it as one that happens.
   * The heading levels below the two with an underlined spelling are the one thing a fence of more
   * than one line still refuses, and that is a question about the block's content rather than about
   * where the caret is, so it is not one a tool can be drawn dark for. */
  canConvert: boolean;
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
  /**
   * Puts the cursor at the end of the document, in a paragraph, making one first if the last block
   * is not already an empty one.
   *
   * The way back in from the paper under the page. A document is shorter than the pane far more
   * often than it is longer, so most of what is on screen below the last line is blank sheet, and a
   * press there used to land on a div that is not the editable: the caret did not move and the
   * editor lost the focus it had. Clicking the page put the writer out of their own document.
   *
   * It is also the general answer to a document whose last block has nowhere after it to type. The
   * table lane and the code lane each grew one of these for their own block and their own key, and
   * both are still the right thing for the caret already inside those blocks; this is the one that
   * does not need the caret to be anywhere in particular, which is what makes it the way out of a
   * rule, a picture, a diagram or a formula that ends the file.
   *
   * The paragraph it makes when it has to is nothing to the serializer, so the document is dirtied
   * and the file gains no byte, which is the same trade the two lanes above already make.
   */
  focusEnd: () => void;
  toggleMark: (mark: MarkName) => void;
  /**
   * The colour of the text, and the colour behind it. null takes the mark off.
   *
   * Set rather than toggled, which is the difference between a swatch and the four buttons beside
   * it: pressing Red over red text means red, and the way back out is the None swatch. A caret
   * inside a coloured run recolours the whole run, since a colour is a property of a phrase and
   * splitting one in half was never the gesture.
   */
  setTextColor: (color: string | null) => void;
  setHighlight: (color: string | null) => void;
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

/**
 * The document's headings and the way to one of them, for the outline rail beside the page.
 *
 * The third handle this editor publishes, beside the toolbar's and the find bar's, and the one that
 * never writes: `reveal` moves the caret to a heading and scrolls the page so the heading is at the
 * top, and that is the whole of what it can do to a document. The entries are read from the live
 * tree on every change, so a row is never a heading the file used to have.
 */
export interface DocumentOutline {
  /** A new array whenever a heading appears, goes, moves or is renamed, and the same one otherwise. */
  entries: readonly OutlineEntry[];
  /** The index in `entries` of the heading the reader is in, measured against the pane rather
   * than taken from the caret: the last one that has scrolled into the top third, or the last of
   * all once the pane is at its end. Null while the pane is above the first heading. A new
   * snapshot on every scroll that changes the answer. */
  current: number | null;
  /** Takes an entry's `pos`. A position that no longer starts a heading, which an edit a keystroke
   * ago can make of one, is declined rather than guessed at. */
  reveal: (pos: number) => void;
}

export type { OutlineEntry };

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

/**
 * The outline of the document on screen, or null when there is no markdown document on screen. A
 * .txt has no headings and a picture has no document, so unlike find there is no second surface to
 * fold in here, and null is the sidebar's cue to draw nothing.
 */
export { useDocumentOutline } from "./Editor";

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
