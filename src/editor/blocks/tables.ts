// Table behaviour: everything about editing a GFM table that is not its shape.
//
// The shape is already in src/model/schema.ts and generated into an extension by extensions.ts, so
// nothing here declares a node. What is missing is the behaviour prosemirror-tables carries: the
// cell selection, Tab between cells, and the row and column edits a toolbar asks for by name. That
// library ships inside @tiptap/pm/tables and reads the `tableRole` extensions.ts already puts on
// each spec, so it plugs in whole rather than being reimplemented. The one piece of it that does
// not plug in is moving up and down: its arrow handling assumes a cell holds paragraphs, and a cell
// here holds inline content, so the arrows and Enter between rows are this file's own. See
// caretCell below for what answered those keys before it did.
//
// Alignment is the one thing the library has no idea about, and it runs through everything below.
// `align` is a cell attribute the bridge reads back out of the GFM delimiter row, and that row is
// per column: markdown cannot say that one cell is centred and the rest of its column is not. So an
// align op writes the whole column, and a row added into a column has to be told what that column
// says, because prosemirror-tables builds its new cells from the attribute's default. The
// serializer reads the delimiter row off the table's first row, which makes a row added above the
// first one the worst case: left alone it would take the whole table's alignment off the next time
// the file was written.
//
// The other thing markdown cannot follow is the shape of the header. A GFM table has exactly one
// header row, it is the first one, and there is no spelling for a table without one, so the ops
// here keep the document to that shape rather than offering edits the file cannot hold. That is
// also why there is no header row toggle: both directions of it are a change the next open of the
// file silently takes back.
//
// One thing the library does that the file cannot follow either: dragging a column edge writes
// `colwidth` on to every cell in that column, and GFM has no column widths for the serializer to
// put them in. The drag is a real document change all the same, and src/document.ts is where it
// stops being one: a transaction that only moved something the markdown cannot spell does not mark
// the buffer dirty, so the drag never reaches the debounce and no save is scheduled behind it.
//
// The two bars at the end of the table are the one affordance on the table itself, and they are two
// rather than the row of per column grips every other editor draws. A grip that scopes insert
// before, insert after and delete to the column under it is the drag handle argument in
// docs/design.md wearing a different hat: it says the document is a set of objects to be
// rearranged, which is not the mental model of writing a markdown file. Growing something is not
// rearranging it. A bar that appends a row or a column is the same gesture as typing past the end
// of a paragraph, so it is on the right side of that line and a grip is not, and everything a grip
// would have offered is already in the pill's table popover where the whole set lives together.

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { Command, EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import {
  CellSelection,
  TableMap,
  addColumn,
  addColumnAfter,
  addColumnBefore,
  addRow,
  columnResizing,
  deleteCellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  nextCell,
  selectedRect,
  tableEditing,
} from "@tiptap/pm/tables";
import type { TableRect } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { ColumnAlign } from "../../model/doc";
import { overCells } from "../fits";
import type { TableOp } from "../index";

/**
 * The typing guard, named so that a test can find it in the plugin list and say where in that list
 * it sits. Being right about a rectangle of cells is worth nothing if something else is asked
 * first, which is the mistake this lane has already made once with a paste.
 */
export const typingKey = new PluginKey("tableTyping");

/** The focus ring's plugin, named for the same reason: a test finds the ring by asking this key. */
export const focusKey = new PluginKey("tableFocus");

/** The bars' plugin, so a test can read where the widget sits rather than guess at the position. */
export const barsKey = new PluginKey<DecorationSet>("tableBars");

/**
 * Column widths, in pixels, for prosemirror-tables' resizing plugin.
 *
 * COLUMN_MIN is what a column is worth before anybody has dragged it. The table node view the
 * plugin installs adds one of these per undragged column into the table's inline min-width, and
 * under the fixed layout in src/styles/prose.css that floor is what makes a wide table scroll inside
 * its box rather than squash its columns to nothing. Six of them fit the normal measure, which is
 * about the widest table anybody writes by hand. RESIZE_MIN is how narrow a drag may make one, and
 * it is less: a column of ticks or of single digits is a real thing to want.
 */
const COLUMN_MIN = 88;
const RESIZE_MIN = 44;

/** What each column says, read where the serializer reads it: the table's first row. */
function columnAlignments(table: ProseMirrorNode): ColumnAlign[] {
  const map = TableMap.get(table);
  return Array.from(
    { length: map.width },
    (_unused, column) => (table.nodeAt(map.map[column])?.attrs.align ?? null) as ColumnAlign,
  );
}

/** Every cell of every column made to agree with `alignment`, whatever the edit left behind. */
function restoreAlignments(tr: Transaction, tablePos: number, alignment: ColumnAlign[]): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table) return;
  const map = TableMap.get(table);
  const columns = Math.min(map.width, alignment.length);
  const done = new Set<number>();

  for (let row = 0; row < map.height; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const pos = map.map[row * map.width + column];
      if (done.has(pos)) continue;
      done.add(pos);
      const cell = table.nodeAt(pos);
      // Null for the type: a header cell that is centred is still a header cell, and setNodeMarkup
      // is the only way to change an attribute and keep both the type and the content.
      if (cell && cell.attrs.align !== alignment[column]) {
        tr.setNodeMarkup(tablePos + 1 + pos, null, { ...cell.attrs, align: alignment[column] });
      }
    }
  }
}

/**
 * Row zero holding header cells and every other row holding body cells, whatever the edit left.
 *
 * GFM has one shape for a table: the first row is the header and the delimiter row under it is what
 * makes the block a table at all. serialize.ts writes the first row as the header whichever kind of
 * cell it is holding, so a table that says otherwise on screen is a table that comes back different
 * the next time the file is opened. prosemirror-tables copies the type of the cell it is building
 * beside, which is how a row added above the header, or a column added in front of it, leaves body
 * cells in row zero.
 */
function normaliseHeaderRow(tr: Transaction, tablePos: number): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table || table.type.name !== "table") return;
  const map = TableMap.get(table);
  const types = table.type.schema.nodes;
  const done = new Set<number>();

  for (let row = 0; row < map.height; row += 1) {
    const want = row === 0 ? types.tableHeader : types.tableCell;
    for (let column = 0; column < map.width; column += 1) {
      const pos = map.map[row * map.width + column];
      if (done.has(pos)) continue;
      done.add(pos);
      const cell = table.nodeAt(pos);
      // Both cell types hold inline content, so this changes the type and keeps the text and the
      // alignment that were in it.
      if (cell && cell.type !== want) tr.setNodeMarkup(tablePos + 1 + pos, want, cell.attrs);
    }
  }
}

/** Tab out of the last cell should land in the row it has just made, not stay where it was. */
function cursorIntoLastRow(tr: Transaction, tablePos: number): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table) return;
  const map = TableMap.get(table);
  const cell = tablePos + 1 + map.positionAt(map.height - 1, 0, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cell + 1))).scrollIntoView();
}

/**
 * And the same for a column, which lands in its header rather than in its first body cell.
 *
 * A column is named before it is filled: what the writer types first is the heading, and the header
 * is also the row the file writes the column's alignment off, so it is where the caret is useful.
 * The scroll is the other half of it, since a column appended to a table already wider than the
 * measure appears outside the wrapper's scroll box and would otherwise arrive invisibly.
 */
function cursorIntoLastColumn(tr: Transaction, tablePos: number): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table) return;
  const map = TableMap.get(table);
  const cell = tablePos + 1 + map.positionAt(0, map.width - 1, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cell + 1))).scrollIntoView();
}

/**
 * A row added where `at` says, with the alignments the table already had put back over it.
 *
 * One transaction rather than a command each, so that Tab out of the last cell is one Cmd+Z rather
 * than two, and so that the document is never momentarily a table whose column disagrees with its
 * own delimiter row.
 */
function insertRow(
  at: (rect: TableRect) => number,
  then?: (tr: Transaction, tablePos: number) => void,
): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (dispatch) {
      const rect = selectedRect(state);
      const alignment = columnAlignments(rect.table);
      const tr = addRow(state.tr, rect, at(rect));
      // tableStart is the position just inside the table, so one before it is the table itself,
      // and every row went in after that point rather than before it.
      const tablePos = rect.tableStart - 1;
      restoreAlignments(tr, tablePos, alignment);
      normaliseHeaderRow(tr, tablePos);
      if (then) then(tr, tablePos);
      dispatch(tr);
    }
    return true;
  };
}

const addRowAbove = insertRow((rect) => rect.top);
const addRowBelow = insertRow((rect) => rect.bottom);
const addRowAtEnd = insertRow((rect) => rect.map.height, cursorIntoLastRow);

/** Tab: the next cell along, or the row that has to be made first when there is no next cell. */
const nextCellOrNewRow: Command = (state, dispatch) =>
  goToNextCell(1)(state, dispatch) || addRowAtEnd(state, dispatch);

/**
 * One of prosemirror-tables' own structural commands, with the header row put back over whatever it
 * produced, in the transaction the command built rather than a second one behind it.
 *
 * The library is asked with a dispatch that only catches the transaction, so a command that answers
 * false still leaves nothing behind, and a table this edit removed outright is a table
 * `normaliseHeaderRow` declines to find.
 */
function normalising(command: Command): Command {
  return (state, dispatch, view) => {
    if (!isInTable(state)) return false;
    if (!dispatch) return command(state, undefined, view);

    const tablePos = selectedRect(state).tableStart - 1;
    let caught: Transaction | null = null;
    const acted = command(
      state,
      (tr) => {
        caught = tr;
      },
      view,
    );
    if (!acted || caught === null) return acted;

    normaliseHeaderRow(caught, tablePos);
    dispatch(caught);
    return true;
  };
}

/**
 * The whole column the selection covers, header cell included.
 *
 * Setting only the cell under the cursor would show an alignment on screen that the next save
 * silently takes back off, and leaving the header out would lose the alignment outright, since the
 * first row is the one the delimiter row is written from.
 */
function alignColumn(align: ColumnAlign): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const { left, right, map, table, tableStart } = selectedRect(state);

    // Positions relative to the table, and a set because a cell that spans columns appears in the
    // map once per column it covers.
    const cells = new Set<number>();
    for (let row = 0; row < map.height; row += 1) {
      for (let column = left; column < right; column += 1) {
        const pos = map.map[row * map.width + column];
        if (table.nodeAt(pos)?.attrs.align !== align) cells.add(pos);
      }
    }
    if (cells.size === 0) return false;

    if (dispatch) {
      const tr = state.tr;
      for (const pos of cells) {
        const cell = table.nodeAt(pos);
        if (cell) tr.setNodeMarkup(tableStart + pos, null, { ...cell.attrs, align });
      }
      dispatch(tr);
    }
    return true;
  };
}

/**
 * The command, with the key claimed for as long as the cursor is in a table, whether or not the
 * command found anything to do with it.
 *
 * A binding that answers false hands the key on to whatever is bound behind it, and behind this
 * lane's Tab and Shift-Tab is shortcuts.ts's list pair, which reshapes the list around the table
 * rather than anything inside it. A table indented under a bullet is an ordinary thing to write,
 * and Shift-Tab in its first cell has nowhere to go: the answer to that is the cursor staying where
 * it is, not the item being lifted out and the list dissolved by a key pressed to move back a cell.
 */
function claimedInTable(command: Command): Command {
  return (state, dispatch, view) => {
    if (!isInTable(state)) return false;
    command(state, dispatch, view);
    return true;
  };
}

/**
 * Every op the handle can name, as the ProseMirror command that performs it.
 *
 * There is no header row op. GFM writes the first row of a table as its header and has no spelling
 * for a table without one or for a second one, so both directions of a toggle are an edit the
 * serializer cannot carry and the next open of the file does not show. An op the file cannot hold
 * is an op that is not offered.
 */
const TABLE_OPS: { [op in TableOp]: Command } = {
  addRowBefore: addRowAbove,
  addRowAfter: addRowBelow,
  deleteRow: normalising(deleteRow),
  addColumnBefore: normalising(addColumnBefore),
  addColumnAfter: normalising(addColumnAfter),
  deleteColumn: normalising(deleteColumn),
  deleteTable,
  alignLeft: alignColumn("left"),
  alignCenter: alignColumn("center"),
  alignRight: alignColumn("right"),
  alignClear: alignColumn(null),
};

/**
 * A printable character typed over a rectangle of dragged cells, which does nothing.
 *
 * ProseMirror offers a character to `handleTextInput` whenever the selection is not an ordinary one
 * inside a single textblock, and when nobody claims it the character goes in through
 * `tr.insertText`, which is `Selection.replace`. A cell selection replaces every range it holds:
 * the character lands in the LAST cell of the rectangle and the other cells are emptied. Measured,
 * in a browser, on the table this lane was reported against: a drag across a 2x2 body and the three
 * keystrokes "zqx" took "| 1 | 2 |\n| 3 | 4 |" to four empty cells with "zqx" sitting in the last
 * of them. Four cells of somebody's table for three characters, and none of them the cell the drag
 * started in.
 *
 * That is the destruction src/editor/paste.ts refuses for a Cmd+V arriving at the same selection,
 * and it arrived here by the one route with no guard on it at all.
 *
 * Emptying the cells is what Backspace over a rectangle does, in the keymap at the end of this
 * file, and that is right: delete is the verb that was pressed and the rows and the columns survive
 * it. A letter is not that verb. A rectangle is a selection of whole cells rather than of text, so
 * there is no text for a character to replace and no one cell it belongs in: putting it in the
 * first cell or the last one both throw away cells the user never aimed at, and neither is what
 * they asked for. So nothing happens, the key is claimed so that nothing else does it either, and
 * the rectangle stays selected, which leaves Backspace, the toolbar and a click into one cell all
 * exactly where they were.
 */
const typing = new Plugin({
  key: typingKey,
  props: {
    handleTextInput: (view) => overCells(view.state),
    handleDOMEvents: {
      compositionstart: collapseRectangle,
      // The same DOM level insert arriving without a composition behind it. macOS's Replace menu
      // and its autocorrect send `insertReplacementText`, dictation sends `insertText`, and neither
      // of them goes anywhere near `handleTextInput`. A printable character over a rectangle never
      // reaches here, because prosemirror-view's keypress handler calls preventDefault for any
      // selection that is not one text range inside one textblock, and nor does Backspace, which
      // the keymap at the end of this file claims first.
      beforeinput: (view, event) =>
        event.inputType.startsWith("insert") ? collapseRectangle(view) : false,
    },
  },
});

/**
 * The same rule for a composition, which is the one gesture a handler cannot refuse.
 *
 * `handleTextInput` above is offered a character the browser was about to insert. An IME never
 * produces one: the browser fires compositionstart, writes the composition into the DOM itself, and
 * prosemirror-view reads the result back out afterwards. So the guard above is not bypassed by a
 * mistake in it, it is simply not on the route, and neither is anything else that answers true or
 * false.
 *
 * Claiming the event does not help and it makes things worse. compositionstart is not cancelable,
 * so preventDefault does nothing and the IME composes whatever a handler returns. What returning
 * true DOES do is stop prosemirror-view's own compositionstart from running, which leaves
 * `view.composing` false while a real composition is in progress, and every DOM write the IME makes
 * then reads back as an ordinary edit.
 *
 * What is decidable is where the composition lands, and that is decided before it starts. Left
 * alone, prosemirror-view's compositionstart replaces the rectangle with whatever
 * `selectionFromDOM` makes of a DOM range spanning cells, which is a text selection, because
 * prosemirror-tables only hands back a cell selection while a mouse drag is still down.
 * prosemirror-tables then either collapses that on to the whole content of one cell, and the
 * composition replaces it, or leaves it spanning cell boundaries, and prosemirror-view replaces
 * across them and joins the cells and the rows away. Both are the rectangle destroyed by a key
 * pressed to type one word, and the second one never reaches `handleTextInput` at all: a change
 * that crosses a textblock is dispatched without the offer ever being made.
 *
 * So the rectangle is collapsed first, to a caret at the end of the cell the drag started in, and
 * the composition lands there. Nothing is replaced and no boundary is crossed, which is the promise
 * the guard above makes for an ordinary character: the rows and the columns survive it. False is
 * returned rather than true, so prosemirror-view's own compositionstart still runs, against the
 * caret this left it. The dispatch is synchronous for the same reason: the DOM selection has to be
 * the caret before the browser applies the first composed character, and a microtask is already
 * too late.
 *
 * `instanceof` rather than `overCells`, which asks this exact question in src/editor/fits.ts and is
 * what the guard above uses. What is needed here is not the boolean but the narrowing that comes
 * with it, since `$anchorCell` only exists on the cell selection.
 */
function collapseRectangle(view: EditorView): false {
  const { selection } = view.state;
  if (!(selection instanceof CellSelection)) return false;
  const cell = selection.$anchorCell.nodeAfter;
  if (!cell) return false;
  // The end of the anchor cell's content, so the composition appends rather than replacing. A cell
  // holds inline content in src/model/schema.ts and no blocks at all, which is what makes that
  // position a caret already: `near` takes it as it stands rather than searching forward out of the
  // cell for one, which is where it would have to go if a paragraph closed in front of it.
  const at = selection.$anchorCell.pos + 1 + cell.content.size;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
  return false;
}

/**
 * The cell the caret is in, resolved at the cell so that `nextCell` can be asked about it, or null
 * for a caret anywhere else and for every selection that is not a caret or a range inside one cell.
 *
 * `$head.parent` rather than a walk upward: a cell holds inline content in src/model/schema.ts, so
 * the caret's parent is the cell itself. That is also why prosemirror-tables' own arrow handling
 * never fires in this editor, and the reason the two arrows and Enter below exist at all. Its
 * `atEndOfCell` starts looking one level above the caret's parent, which in the library's own
 * schema is the paragraph inside a cell and in this one is the row, and it finds no cell from
 * there. What answered the keys instead was the gap cursor plugin, which is glad to stand between
 * two cells or two rows, and a gap cursor is a `<div>` widget: between two `<td>`s the browser
 * draws it as a cell of its own, and the row's columns shove sideways until the caret leaves.
 * Measured in Chromium: ArrowDown out of the last row of a table with a paragraph under it put the
 * caret between the first two cells of that row, and ArrowUp out of the header did the same at its
 * front.
 */
function caretCell(state: EditorState): ResolvedPos | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $anchor, $head } = selection;
  if (!$anchor.sameParent($head)) return null;
  const role = $head.parent.type.spec.tableRole;
  if (role !== "cell" && role !== "header_cell") return null;
  return state.doc.resolve($head.before());
}

/**
 * The caret into the row `dir` says, same column, or out of the table when there is no such row.
 *
 * Out means the block beside the table, and when nothing is beside it, a paragraph made there to
 * be beside it. That paragraph is the one edit in this file a navigation key makes, and it is made
 * rather than declined because the alternative is the gap cursor: a hairline after the table that
 * takes typing but that nobody recognises as a place to type. An empty paragraph is nothing to the
 * serializer, so the file does not change for it, only the buffer. False is answered when the
 * table's parent cannot hold a paragraph at that point, which no container in the schema refuses.
 */
function toRow(dir: -1 | 1, tr: Transaction, $cell: ResolvedPos): boolean {
  const $next = nextCell($cell, "vert", dir);
  if ($next) {
    tr.setSelection(Selection.near($next, 1));
    return true;
  }
  // The cell is resolved inside its row, so one level up from its parent is the table itself.
  const $edge = tr.doc.resolve(dir > 0 ? $cell.after(-1) : $cell.before(-1));
  if (dir > 0 ? $edge.nodeAfter : $edge.nodeBefore) {
    tr.setSelection(Selection.near($edge, dir));
    return true;
  }
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const index = $edge.index();
  if (!$edge.parent.canReplaceWith(index, index, paragraph)) return false;
  tr.insert($edge.pos, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, $edge.pos + 1));
  return true;
}

/**
 * Into the table beside the caret from the block over it or under it: the header row from above,
 * the last row from below, first column either way.
 *
 * The arrows out of a table land on the block beside it, and a key that goes one way has to come
 * back the other. Left alone, ArrowUp from under a table is the gap cursor plugin's turn, and it
 * answers with its hairline after the table, which is where the caret then sits until a click.
 * A gap cursor is also where a click under a table that ends the document puts the caret, so the
 * caret is allowed to be between blocks already rather than in one, and is taken from there.
 */
function intoTable(dir: -1 | 1, tr: Transaction, view: EditorView): boolean {
  const { selection } = tr;
  if (!selection.empty) return false;
  const { $head } = selection;
  let $edge = $head;
  if ($head.parent.isTextblock) {
    if (!view.endOfTextblock(dir > 0 ? "down" : "up")) return false;
    $edge = tr.doc.resolve(dir > 0 ? $head.after() : $head.before());
  }
  const table = dir > 0 ? $edge.nodeAfter : $edge.nodeBefore;
  if (!table || table.type.spec.tableRole !== "table") return false;
  const tablePos = dir > 0 ? $edge.pos : $edge.pos - table.nodeSize;
  const map = TableMap.get(table);
  const cell = tablePos + 1 + map.positionAt(dir > 0 ? 0 : map.height - 1, 0, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(cell + 1)));
  return true;
}

/**
 * Up or down off the line the caret is on, when that line is the last one in that direction: to
 * the row beside it inside a table, out of the table under its last row or over its first, and
 * into a table from the block beside it. Anywhere else the key is left alone and the browser moves
 * the caret a line, which is the one part of this it does well. The measurement is the view's,
 * since which line a caret is on is a question about wrapped text and not about the document.
 */
function verticalArrow(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const tr = state.tr;
    const $cell = caretCell(state);
    const moved = $cell
      ? view.endOfTextblock(dir > 0 ? "down" : "up") && toRow(dir, tr, $cell)
      : intoTable(dir, tr, view);
    if (!moved) return false;
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Enter: the cell below, and out of the table under the last row.
 *
 * A cell holds one line of GFM, so there is no block to split and nothing for Enter to make inside
 * one; what the key means in a grid is the next row, and at the bottom of the grid the paragraph
 * under it, made if it is not there. Not a new row: Tab out of the last cell is that gesture, and a
 * key pressed to leave the table should not grow it, since an empty row is a line of empty cells in
 * the file the next time it is saved.
 */
const enterInCell: Command = (state, dispatch) => {
  const $cell = caretCell(state);
  if (!$cell) return false;
  const tr = state.tr;
  if (!toRow(1, tr, $cell)) return false;
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
};

/**
 * A ring around the cell the caret is in, the way a spreadsheet shows which cell is taking the keys.
 *
 * A decoration rather than a class written from a selection listener, so it is derived from the
 * state on every draw and can never be left behind on a cell the caret has moved out of. It is on
 * the cell's own node, and only for a caret or a range inside one cell: a rectangle of cells has the
 * selection wash and a table selected whole has no one cell to point at. src/styles/prose.css draws
 * it, and only while the document holds the keyboard.
 */
const focusedCell = new Plugin({
  key: focusKey,
  props: {
    decorations(state) {
      const $cell = caretCell(state);
      const cell = $cell?.nodeAfter;
      if (!$cell || !cell) return null;
      return DecorationSet.create(state.doc, [
        Decoration.node($cell.pos, $cell.pos + cell.nodeSize, { class: "cell-focus" }),
      ]);
    },
  },
});

/** Which way one of the two bars grows the table it hangs off. */
export type BarKind = "row" | "column";

const SVG = "http://www.w3.org/2000/svg";

/** Feather's plus, which is the whole of what a bar has to say. */
const PLUS_D = "M12 5v14 M5 12h14";

/**
 * A row appended under the last one, or a column appended after the last, at a table named by
 * position rather than by where the cursor happens to be.
 *
 * Every other op in this file starts from `selectedRect`, which reads the table out of the
 * selection, and a bar cannot: it is pressed with the pointer, on a table the caret may be nowhere
 * near, and the press must not first drag the caret across the document to make the command legal.
 * So the table is the argument and the selection is left alone until the row exists to put it in.
 *
 * The alignments and the header row are put back exactly as the toolbar's own ops put them back,
 * for the same two reasons: prosemirror-tables builds a new cell from the attribute's default, and
 * it copies the type of the cell it is building beside. Neither is what GFM can spell.
 */
function growBy(kind: BarKind, tablePos: number): Command {
  return (state, dispatch) => {
    const table = state.doc.nodeAt(tablePos);
    if (!table || table.type.spec.tableRole !== "table") return false;
    if (dispatch) {
      const map = TableMap.get(table);
      // The whole table as a rect, because `addRow` and `addColumn` want one and only read the map,
      // the node and where its content starts off it.
      const rect: TableRect = {
        map,
        table,
        tableStart: tablePos + 1,
        left: 0,
        top: 0,
        right: map.width,
        bottom: map.height,
      };
      const alignment = columnAlignments(table);
      const tr =
        kind === "row" ? addRow(state.tr, rect, map.height) : addColumn(state.tr, rect, map.width);
      restoreAlignments(tr, tablePos, alignment);
      normaliseHeaderRow(tr, tablePos);
      if (kind === "row") cursorIntoLastRow(tr, tablePos);
      else cursorIntoLastColumn(tr, tablePos);
      dispatch(tr);
    }
    return true;
  };
}

/**
 * A press on one of the bars, which is where the widget's position becomes a table.
 *
 * The widget sits inside its own table, after the last row, so the node it resolves into is the
 * table itself and the position before that node is what the command needs. Reading it back at the
 * moment of the press rather than closing over it is what lets the element outlive every edit made
 * to the document around it.
 *
 * The focus is the last step rather than the first. A press on chrome inside the document does not
 * move the caret on its own, since the mousedown that would have moved it is cancelled, so a bar
 * pressed in a document nobody was typing in would otherwise grow a table and leave the keyboard
 * wherever it was.
 */
export function growTable(view: EditorView, barPos: number, kind: BarKind): boolean {
  const $bar = view.state.doc.resolve(barPos);
  if ($bar.parent.type.spec.tableRole !== "table") return false;
  if (!growBy(kind, $bar.before())(view.state, view.dispatch)) return false;
  view.focus();
  return true;
}

/** One bar: a button with a plus on it and nothing else, since it has one thing to do. */
function bar(owner: Document, kind: BarKind, press: () => void): HTMLButtonElement {
  const button = owner.createElement("button");
  button.className = kind === "row" ? "table-add-row" : "table-add-col";
  button.type = "button";
  button.title = kind === "row" ? "Add a row" : "Add a column";
  button.setAttribute("aria-label", kind === "row" ? "Add a row" : "Add a column");

  const glyph = owner.createElementNS(SVG, "svg");
  glyph.setAttribute("viewBox", "0 0 24 24");
  glyph.setAttribute("fill", "none");
  glyph.setAttribute("stroke", "currentColor");
  glyph.setAttribute("stroke-width", "1.6");
  glyph.setAttribute("stroke-linecap", "round");
  glyph.setAttribute("stroke-linejoin", "round");
  const stroke = owner.createElementNS(SVG, "path");
  stroke.setAttribute("d", PLUS_D);
  glyph.appendChild(stroke);
  button.appendChild(glyph);

  // The press is a gesture aimed at chrome, and the browser would answer a mousedown inside a
  // contenteditable by putting the caret under it first.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    press();
  });
  return button;
}

/**
 * The pair, built once per table and reused for as long as that table is on screen.
 *
 * They hang off a wrapper that draws nothing and is positioned over the table's own box rather than
 * the wrapper prosemirror-tables puts around it, because that wrapper is the scroll box and the
 * table is what scrolls inside it: measured against the box, a bar for a table wider than the
 * measure would sit at the edge of the window while the column it appends after was somewhere off
 * to the right. src/styles/prose.css draws all three.
 */
function barsControl(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const owner = view.dom.ownerDocument;
  const bars = owner.createElement("div");
  bars.className = "table-bars";

  const press = (kind: BarKind) => () => {
    const pos = getPos();
    if (pos !== undefined) growTable(view, pos, kind);
  };
  bars.appendChild(bar(owner, "row", press("row")));
  bars.appendChild(bar(owner, "column", press("column")));
  return bars;
}

/**
 * The widget's spec, declared once so that a rebuilt decoration set hands the view the same element
 * back rather than a new pair of buttons under the pointer.
 *
 * prosemirror-view compares two widgets by their `toDOM` and by their spec, and it compares the
 * spec by identity first, so a literal written inside the loop below would be a different object on
 * every rebuild and the bars would be torn down and remade on every keystroke in the document.
 *
 * Every event inside the bars is stopped, which is what keeps a press on one from also being a
 * press in the document: prosemirror-view walks up from the event's target looking for a view
 * description that claims it, and finding this one it hands the event to nobody, so neither the
 * cell selection drag nor the column resize watcher sees a pointer that was never aimed at the
 * text.
 */
const BAR_SPEC = { key: "table-bars", side: 1, stopEvent: () => true };

/**
 * One pair of bars per table, at the end of that table's content.
 *
 * A widget rather than a node view, and that is forced rather than chosen: prosemirror-tables'
 * column resizing plugin claims the node view for `table` in order to write the colgroup the fixed
 * layout is built on, ProseMirror resolves a node view first plugin wins by node name, and a second
 * claim would either lose to it or take the column widths away from it. A widget needs no claim,
 * and it is the safer half of the trade as well: the view's own parseRule for a widget is
 * `{ ignore: true }`, so two buttons drawn inside a `<tbody>` are invisible to everything that
 * reads the DOM back into the tree, and the table on disk is the table the bridge parsed.
 *
 * Rebuilt on a change to the document rather than mapped through it. The walk stops at every
 * textblock and at every table, so it costs one pass over the block structure and never touches
 * text, and rebuilding means a row inserted at exactly the position the widget stands at cannot
 * leave the bars drawn above the row they just made.
 */
function barsFor(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    if (node.type.spec.tableRole !== "table") return true;
    decorations.push(Decoration.widget(pos + node.nodeSize - 1, barsControl, BAR_SPEC));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

const tableBars = new Plugin<DecorationSet>({
  key: barsKey,
  state: {
    init: (_config, state) => barsFor(state.doc),
    apply: (tr, value) => (tr.docChanged ? barsFor(tr.doc) : value),
  },
  props: {
    decorations: (state) => barsKey.getState(state) ?? DecorationSet.empty,
  },
});

export const Tables = Extension.create({
  name: "tables",

  addProseMirrorPlugins() {
    // There was a third plugin in front of these two once, and it answered one paste: an empty
    // slice over a rectangle of cells, which is what a clipboard holding only an image looks like
    // by the time it reaches a handler. `tableEditing` takes that empty slice and empties every
    // cell in the rectangle, so a PNG pasted over a dragged table deleted the table's text.
    //
    // It was here because src/editor/paste.ts already refused exactly that and was never asked:
    // these plugins came ninth in the list and that one came fifteenth. The guard sitting in front
    // of the plugin it guards was the right instinct and the wrong fix, because it only covered
    // the empty slice, and the same ordering handed the library every non-empty paste over a cell
    // selection too. One word pasted over four dragged cells replaced all four.
    //
    // So the paste ordering is fixed instead: paste.ts asks for the highest priority in the editor,
    // is asked first for every paste, and stands aside only for cells pasted into a table, which is
    // the one paste those two are better at. `typing` below is not a second copy of that question,
    // it is a different event: nothing in this editor claimed a typed character, and a typed
    // character over a rectangle is the same destruction arriving by the one route nobody guarded.
    return [
      typing,
      focusedCell,
      tableBars,
      // columnResizing before tableEditing, which takes mousedown for the cell selection drag: a
      // press on a column edge is a resize, and the plugin that decides that has to be asked first.
      columnResizing({ cellMinWidth: RESIZE_MIN, defaultCellMinWidth: COLUMN_MIN }),
      tableEditing(),
    ];
  },

  /**
   * No gap cursor between two cells or between two rows.
   *
   * prosemirror-gapcursor will stand anywhere both neighbours are closed and the parent's default
   * child is a textblock, which is true between two isolating cells in a row that would take a
   * third, and the cursor it draws there is a `<div>` between two `<td>`s: a phantom cell, and the
   * row's columns jump sideways for as long as it is there. See caretCell above for how a caret
   * got sent there. Before and after the table the gap cursor is still allowed, since a table can
   * end a document and a click under it has to land somewhere; the arrows and Enter simply never
   * send a caret there, they make a paragraph instead.
   *
   * TipTap's own gap cursor extension writes this same field on every node from the node's config,
   * so which of the two answers is a matter of extension order. src/editor/blocks/tables.test.ts
   * reads the built schema rather than trusting that order.
   */
  extendNodeSchema(extension) {
    return extension.name === "table" || extension.name === "tableRow"
      ? { allowGapCursor: false }
      : {};
  },

  addKeyboardShortcuts() {
    const editor = this.editor;

    // ProseMirror's own calling convention rather than editor.commands.command, which dispatches
    // its transaction whatever the command answered. These four are asked on every Tab and every
    // Backspace in the document, and a key pressed outside a table has to leave nothing behind.
    const run = (command: Command) => () =>
      command(editor.state, editor.view.dispatch, editor.view);

    return {
      // Tab out of the last cell grows the table, which is the only way to add a row without
      // reaching for the toolbar. Shift-Tab has no matching gesture: there is no row before the
      // first one to make, so in the first cell it moves nothing and answers for the key anyway.
      // Both are claimed the same way so that neither can be handed on to a list command; see
      // claimedInTable above for what that costs the document when it is.
      Tab: run(claimedInTable(nextCellOrNewRow)),
      "Shift-Tab": run(claimedInTable(goToNextCell(-1))),

      // The row below, and the paragraph under the table after the last row. Claimed for the whole
      // table, a rectangle of cells included, because what is behind it is the core keymap's
      // split, which has nothing right to do inside a cell.
      Enter: run(claimedInTable(enterInCell)),

      // Not claimed: a caret on a middle line of a wrapped cell answers false and the browser
      // moves it a line, which is what the key means there. Bound here rather than left to
      // prosemirror-tables' own arrow handling, which never fires against a cell holding inline
      // content; see caretCell above.
      ArrowUp: run(verticalArrow(-1)),
      ArrowDown: run(verticalArrow(1)),

      // Said here rather than left to tableEditing's own binding further down the plugin list.
      // A cell selection has to be emptied and not removed: deleting it as a selection would take
      // the rows and columns the cells were in along with the text that was in them.
      //
      // Not claimed the way the two above are: with a plain cursor in a cell there is nothing to
      // empty, and a Backspace that stopped here would be a Backspace that never deletes a
      // character. What is behind these is StarterKit's list keymap, which reads the cursor's
      // parent as its list item and finds a table row instead, so it declines from inside a cell
      // and the key reaches the editing it was pressed for. src/editor/blocks/tables.test.ts holds
      // that assertion, since it is the library's behaviour rather than this file's.
      Backspace: run(deleteCellSelection),
      Delete: run(deleteCellSelection),
    };
  },
});

/** False when the cursor is not in a table, or the op has nothing to act on where it is. */
export function tableCommand(editor: Editor, op: TableOp): boolean {
  const command = TABLE_OPS[op];
  // Read out of the chain rather than off the chain's own result, because focus is in the chain too
  // and answers a different question, with a false of its own whenever there is no view to focus.
  let acted = false;
  editor
    .chain()
    .focus()
    .command(({ state, dispatch }) => {
      acted = command(state, dispatch);
      return acted;
    })
    .run();
  return acted;
}
