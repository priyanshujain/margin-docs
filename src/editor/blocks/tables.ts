// Table behaviour: everything about editing a GFM table that is not its shape.
//
// The shape is already in src/model/schema.ts and generated into an extension by extensions.ts, so
// nothing here declares a node. What is missing is the behaviour prosemirror-tables carries: the
// cell selection, Tab between cells, and the row and column edits a toolbar asks for by name. That
// library ships inside @tiptap/pm/tables and reads the `tableRole` extensions.ts already puts on
// each spec, so it plugs in whole rather than being reimplemented.
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

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Command, Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  TableMap,
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
  selectedRect,
  tableEditing,
} from "@tiptap/pm/tables";
import type { TableRect } from "@tiptap/pm/tables";
import type { ColumnAlign } from "../../model/doc";
import { overCells } from "../fits";
import type { TableOp } from "../index";

/**
 * The typing guard, named so that a test can find it in the plugin list and say where in that list
 * it sits. Being right about a rectangle of cells is worth nothing if something else is asked
 * first, which is the mistake this lane has already made once with a paste.
 */
export const typingKey = new PluginKey("tableTyping");

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
      // columnResizing before tableEditing, which takes mousedown for the cell selection drag: a
      // press on a column edge is a resize, and the plugin that decides that has to be asked first.
      columnResizing(),
      tableEditing(),
    ];
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
