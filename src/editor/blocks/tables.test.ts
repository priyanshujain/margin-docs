// A table is the one block in this editor whose behaviour is a library's rather than this app's,
// which makes it the one block where "it works" is easy to assume and easy to be wrong about. Two
// things are asserted here that a passing prosemirror-tables would not give for free.
//
// The first is alignment, which is this file's own and not the library's. GFM keeps alignment in
// the delimiter row, one entry per column, so the test that matters is not what the attribute says
// but what the serializer writes: a column whose cells disagree is a table the file cannot hold.
//
// The second is the header row, for the same reason from the other end. GFM has exactly one and it
// is the first row, so an edit that leaves body cells in row zero is an edit whose result the file
// cannot spell, and the screen would go on showing it until the file was next opened.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorView } from "@tiptap/pm/view";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { createEditorExtensions } from "../extensions";
import { serializeMarkdown } from "../../markdown";
import { tableCommand, typingKey } from "./tables";

const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

function makeEditor(content: JSONContent = EMPTY): Editor {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: createEditorExtensions({ documentPath: () => "/notes/a.md", onError: () => {} }),
    content,
  });

  // TipTap only installs the extensions' ProseMirror plugins when it mounts a view, and there is no
  // DOM here to mount into. Swapping in a state built with them is what src/editor/Editor.tsx does
  // on every document it installs, so this is the same editor the app runs, minus the screen.
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

/**
 * One key, offered to the plugins in the order the view would offer it and stopping at the first
 * that claims it. Which plugin answered is the whole question in half these tests, so the walk is
 * the real one rather than a call into the binding this file happens to be about.
 */
function press(editor: Editor, key: string, shift = false): boolean {
  const event = {
    key,
    keyCode: key === "Tab" ? 9 : 8,
    shiftKey: shift,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
  const view = editor.view as unknown as EditorView;

  for (const plugin of editor.state.plugins) {
    const handler = plugin.props?.handleKeyDown;
    if (handler && handler.call(plugin, view, event)) return true;
  }
  return false;
}

/**
 * One printable character, offered to the plugins the way the view offers one and, when nobody
 * claims it, put in the way the view would put it. True when a plugin claimed it.
 *
 * `tr.insertText` with no range is `Selection.replace`, and over a cell selection that replaces
 * every range in the selection: the character goes into the last cell of the rectangle and the
 * rest are emptied. That fallback is the bug, so it is run here rather than described.
 */
function type(editor: Editor, character: string): boolean {
  const view = editor.view as unknown as EditorView;
  const { $from, $to } = editor.state.selection;
  const deflt = () => editor.state.tr.insertText(character).scrollIntoView();

  for (const plugin of editor.state.plugins) {
    const handler = plugin.props?.handleTextInput;
    if (handler && handler.call(plugin, view, $from.pos, $to.pos, character, deflt)) return true;
  }
  editor.view.dispatch(deflt());
  return false;
}

/** A table alone in a document. The first row is header cells, as every GFM table's is. */
function tableDoc(rows: string[][]): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "table",
        content: rows.map((cells, row) => ({
          type: "tableRow",
          content: cells.map((text) => ({
            type: row === 0 ? "tableHeader" : "tableCell",
            ...(text ? { content: [{ type: "text", text }] } : {}),
          })),
        })),
      },
    ],
  };
}

/** The document's first table and where it starts, wherever in the tree it happens to sit. */
function tableAt(editor: Editor): { node: ProseMirrorNode; pos: number } {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "table") found = { node, pos };
    return found === null;
  });
  if (found === null) throw new Error("this document has no table in it");
  return found;
}

const table = (editor: Editor) => tableAt(editor).node;

/** The document position just inside a cell. */
function inCell(editor: Editor, row: number, column: number): number {
  const { node, pos } = tableAt(editor);
  return pos + 1 + TableMap.get(node).positionAt(row, column, node) + 1;
}

function cursorIn(editor: Editor, row: number, column: number): void {
  editor.commands.setTextSelection(inCell(editor, row, column));
}

function selectCells(editor: Editor, from: [number, number], to: [number, number]): void {
  const anchor = inCell(editor, from[0], from[1]) - 1;
  const head = inCell(editor, to[0], to[1]) - 1;
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, anchor, head)),
  );
}

/** The table as a grid of whatever `of` reads off a cell. */
function grid<T>(editor: Editor, of: (cell: ProseMirrorNode) => T): T[][] {
  const out: T[][] = [];
  table(editor).forEach((row) => {
    const cells: T[] = [];
    row.forEach((cell) => cells.push(of(cell)));
    out.push(cells);
  });
  return out;
}

const shape = (editor: Editor) => grid(editor, (cell) => cell.textContent);
const kinds = (editor: Editor) => grid(editor, (cell) => cell.type.name);
const aligns = (editor: Editor) => grid(editor, (cell) => cell.attrs.align as string | null);

/** A clipboard carrying one word of plain text, which is what a slice with something in it is. */
function textSlice(editor: Editor, text: string): Slice {
  return new Slice(Fragment.from(editor.schema.text(text)), 0, 0);
}

/** What the bridge would write for this document, in a file that holds nothing else. */
function written(editor: Editor): string {
  const doc = editor.state.doc;
  return serializeMarkdown({ frontmatter: null, doc, source: "", path: "/notes/a.md" }, doc);
}

const GRID = [
  ["a", "b", "c"],
  ["1", "2", "3"],
  ["4", "5", "6"],
];

describe("Tab in a table", () => {
  it("moves to the next cell and wraps on to the next row", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 0);

    expect(press(editor, "Tab")).toBe(true);
    expect(editor.state.selection.from).toBe(inCell(editor, 0, 1));
    expect(press(editor, "Tab")).toBe(true);
    expect(press(editor, "Tab")).toBe(true);
    expect(editor.state.selection.from).toBe(inCell(editor, 1, 0));
    editor.destroy();
  });

  it("moves back on Shift-Tab, and stops at the first cell", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 0);

    expect(press(editor, "Tab", true)).toBe(true);
    expect(editor.state.selection.from).toBe(inCell(editor, 0, 2));

    // Nowhere to go, so the binding declines and the key falls through untouched by it.
    cursorIn(editor, 0, 0);
    press(editor, "Tab", true);
    expect(shape(editor)).toEqual(GRID);
    expect(kinds(editor)[0]).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    editor.destroy();
  });

  // The precedence assertion. shortcuts.ts also binds Tab, for sinking a list item, and it is the
  // only other binding on the key: a fourth row here is proof that this lane's is asked first and
  // that the list one does not answer inside a table.
  it("grows the table out of the last cell, into a body row", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 2, 2);

    expect(press(editor, "Tab")).toBe(true);
    expect(shape(editor)).toEqual([...GRID, ["", "", ""]]);
    expect(kinds(editor)[3]).toEqual(["tableCell", "tableCell", "tableCell"]);
    expect(editor.state.selection.from).toBe(inCell(editor, 3, 0));
    editor.destroy();
  });

  it("grows a table that is nothing but its header row", () => {
    const editor = makeEditor(tableDoc([["a", "b"]]));
    cursorIn(editor, 0, 1);

    expect(press(editor, "Tab")).toBe(true);
    expect(kinds(editor)).toEqual([
      ["tableHeader", "tableHeader"],
      ["tableCell", "tableCell"],
    ]);
    editor.destroy();
  });

  it("leaves Tab alone outside a table", () => {
    const editor = makeEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
    });
    editor.commands.setTextSelection(2);

    expect(press(editor, "Tab")).toBe(false);
    expect(editor.state.doc.textContent).toBe("x");
    editor.destroy();
  });
});

describe("Backspace over a cell selection", () => {
  it("empties the cells and keeps the table the shape it was", () => {
    const editor = makeEditor(tableDoc(GRID));
    selectCells(editor, [1, 0], [2, 1]);

    expect(press(editor, "Backspace")).toBe(true);
    expect(shape(editor)).toEqual([
      ["a", "b", "c"],
      ["", "", "3"],
      ["", "", "6"],
    ]);
    editor.destroy();
  });
});

// A printable character over the same rectangle, which until this lane claimed it did what
// Backspace does and then wrote the character into the corner of the wreckage.
//
// Reported and reproduced in Chromium: a real mouse drag from (0,0) to (1,1) of a 2x2 body and the
// three keystrokes "zqx" took "| 1 | 2 |\n| 3 | 4 |" to four empty cells with "zqx" in the last
// one. Four cells of somebody's table for three letters, none of them the cell the drag started
// in. It is the destruction src/editor/paste.ts refuses for a Cmd+V that lands on the same
// selection, arriving by the one route with no guard on it.
describe("typing over a cell selection", () => {
  it("leaves every cell in the rectangle exactly as it was", () => {
    const editor = makeEditor(tableDoc(GRID));
    const before = written(editor);
    selectCells(editor, [1, 0], [2, 1]);

    expect(type(editor, "z")).toBe(true);

    expect(shape(editor)).toEqual(GRID);
    expect(written(editor)).toBe(before);
    // And the rectangle is still selected, so Backspace, the toolbar and a click into one cell are
    // all still where the user left them.
    expect(editor.state.selection instanceof CellSelection).toBe(true);
    editor.destroy();
  });

  // The other half, twice, because a guard that claimed every character everywhere would pass the
  // test above and would be an editor nobody can type in.
  it("still types into a single cell, and still types outside a table", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 0);

    expect(type(editor, "z")).toBe(false);
    expect(shape(editor)[1][0]).toBe("z1");
    editor.destroy();

    const prose = makeEditor();
    expect(type(prose, "z")).toBe(false);
    expect(prose.state.doc.textContent).toBe("z");
    prose.destroy();
  });

  // And the half this project keeps getting wrong: an answer nothing asks for is not an answer.
  // ProseMirror stops at the first plugin that claims a character, so a guard behind the plugin
  // that would have destroyed the cells is a guard the running editor never reaches. TipTap's own
  // input rules claim handleTextInput too, which is what this is measured against.
  it("is the first plugin in the list that claims a typed character", () => {
    const editor = makeEditor(tableDoc(GRID));
    const claimants = editor.state.plugins.flatMap((plugin, index) =>
      plugin.props?.handleTextInput ? [index] : [],
    );
    const guard = editor.state.plugins.findIndex((plugin) => plugin.spec.key === typingKey);

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(claimants[0]).toBe(guard);
    expect(claimants.length).toBeGreaterThan(1);
    editor.destroy();
  });
});

describe("the row and column ops", () => {
  it("adds and removes rows where the cursor is", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 0);

    expect(tableCommand(editor, "addRowAfter")).toBe(true);
    expect(shape(editor)).toEqual([["a", "b", "c"], ["1", "2", "3"], ["", "", ""], ["4", "5", "6"]]);

    cursorIn(editor, 2, 0);
    expect(tableCommand(editor, "deleteRow")).toBe(true);
    expect(shape(editor)).toEqual(GRID);

    cursorIn(editor, 1, 0);
    expect(tableCommand(editor, "addRowBefore")).toBe(true);
    expect(shape(editor)).toEqual([["a", "b", "c"], ["", "", ""], ["1", "2", "3"], ["4", "5", "6"]]);
    editor.destroy();
  });

  it("adds and removes columns where the cursor is", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 1);

    expect(tableCommand(editor, "addColumnAfter")).toBe(true);
    expect(shape(editor)[0]).toEqual(["a", "b", "", "c"]);
    expect(kinds(editor)[0]).toEqual(["tableHeader", "tableHeader", "tableHeader", "tableHeader"]);

    cursorIn(editor, 0, 2);
    expect(tableCommand(editor, "deleteColumn")).toBe(true);
    expect(shape(editor)).toEqual(GRID);

    cursorIn(editor, 0, 0);
    expect(tableCommand(editor, "addColumnBefore")).toBe(true);
    expect(shape(editor)[1]).toEqual(["", "1", "2", "3"]);
    editor.destroy();
  });

  it("takes the whole table out, leaving a document behind", () => {
    const editor = makeEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before" }] }, ...tableDoc(GRID).content!],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 4);

    expect(tableCommand(editor, "deleteTable")).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("before");
    editor.destroy();
  });

  it("takes a table that is the whole document out, leaving something behind", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 0);

    expect(tableCommand(editor, "deleteTable")).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("");
    editor.destroy();
  });

  // prosemirror-tables builds a new cell from the one it is standing beside, so all three of these
  // leave a table whose first row is not the row the serializer will write as the header. What is
  // on screen after the edit has to be what the file says, or the edit is taken back the next time
  // the document is opened.
  it("keeps the header first when a row goes in above it", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 0);

    expect(tableCommand(editor, "addRowBefore")).toBe(true);
    expect(kinds(editor)).toEqual([
      ["tableHeader", "tableHeader", "tableHeader"],
      ["tableCell", "tableCell", "tableCell"],
      ["tableCell", "tableCell", "tableCell"],
      ["tableCell", "tableCell", "tableCell"],
    ]);
    editor.destroy();
  });

  it("keeps the header first when a column goes in in front of it", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 0);

    expect(tableCommand(editor, "addColumnBefore")).toBe(true);
    expect(kinds(editor)[0]).toEqual(["tableHeader", "tableHeader", "tableHeader", "tableHeader"]);
    expect(kinds(editor)[1]).toEqual(["tableCell", "tableCell", "tableCell", "tableCell"]);
    editor.destroy();
  });

  // The last row and the last column decline rather than emptying the table out, which is
  // prosemirror-tables' own answer and the right one: a table with no rows is not something GFM can
  // write, and Delete table is the op that means what this would have meant.
  it("will not take the last row or the last column", () => {
    for (const op of ["deleteRow", "deleteColumn"] as const) {
      const editor = makeEditor(tableDoc([["a"]]));
      cursorIn(editor, 0, 0);
      const before = editor.state.doc.toJSON();

      expect([op, tableCommand(editor, op)]).toEqual([op, false]);
      expect([op, editor.state.doc.toJSON()]).toEqual([op, before]);
      editor.destroy();
    }
  });

  it("keeps a header row when the header row is the one deleted", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 0);

    expect(tableCommand(editor, "deleteRow")).toBe(true);
    expect(shape(editor)).toEqual([GRID[1], GRID[2]]);
    expect(kinds(editor)[0]).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(kinds(editor)[1]).toEqual(["tableCell", "tableCell", "tableCell"]);
    editor.destroy();
  });

  it("does nothing at all with the cursor outside a table", () => {
    const editor = makeEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
    });
    editor.commands.setTextSelection(2);
    const before = editor.state.doc.toJSON();

    for (const op of ["addRowAfter", "deleteRow", "addColumnAfter", "deleteColumn", "deleteTable", "alignCenter"] as const) {
      expect([op, tableCommand(editor, op)]).toEqual([op, false]);
    }
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });
});

describe("alignment", () => {
  it("writes the whole column, header included, and nothing beside it", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 2, 1);

    expect(tableCommand(editor, "alignCenter")).toBe(true);
    expect(aligns(editor)).toEqual([
      [null, "center", null],
      [null, "center", null],
      [null, "center", null],
    ]);
    editor.destroy();
  });

  it("reaches the serializer's delimiter row, and comes back off it", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 0);
    tableCommand(editor, "alignRight");
    cursorIn(editor, 1, 2);
    tableCommand(editor, "alignCenter");

    expect(written(editor)).toBe(
      ["| a | b | c |", "| -: | - | :-: |", "| 1 | 2 | 3 |", "| 4 | 5 | 6 |", ""].join("\n"),
    );

    cursorIn(editor, 1, 0);
    expect(tableCommand(editor, "alignClear")).toBe(true);
    cursorIn(editor, 1, 2);
    expect(tableCommand(editor, "alignClear")).toBe(true);
    expect(written(editor)).toBe(
      ["| a | b | c |", "| - | - | - |", "| 1 | 2 | 3 |", "| 4 | 5 | 6 |", ""].join("\n"),
    );
    editor.destroy();
  });

  it("covers every column a cell selection touches", () => {
    const editor = makeEditor(tableDoc(GRID));
    selectCells(editor, [0, 0], [1, 1]);

    expect(tableCommand(editor, "alignLeft")).toBe(true);
    expect(aligns(editor)).toEqual([
      ["left", "left", null],
      ["left", "left", null],
      ["left", "left", null],
    ]);
    editor.destroy();
  });

  it("declines a column that already reads that way", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 0, 0);

    expect(tableCommand(editor, "alignLeft")).toBe(true);
    expect(tableCommand(editor, "alignLeft")).toBe(false);
    expect(tableCommand(editor, "alignClear")).toBe(true);
    expect(tableCommand(editor, "alignClear")).toBe(false);
    editor.destroy();
  });

  it("survives a row added above the header row", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 2);
    tableCommand(editor, "alignRight");
    cursorIn(editor, 0, 0);

    expect(tableCommand(editor, "addRowBefore")).toBe(true);
    expect(aligns(editor)).toEqual([
      [null, null, "right"],
      [null, null, "right"],
      [null, null, "right"],
      [null, null, "right"],
    ]);
    expect(written(editor).split("\n")[1]).toBe("| - | - | -: |");
    editor.destroy();
  });

  it("stays with its own column when a column beside it goes", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 2);
    tableCommand(editor, "alignCenter");
    cursorIn(editor, 1, 0);

    expect(tableCommand(editor, "deleteColumn")).toBe(true);
    expect(aligns(editor)[0]).toEqual([null, "center"]);
    expect(written(editor).split("\n")[1]).toBe("| - | :-: |");
    editor.destroy();
  });

  it("does not follow a new column in beside it", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 0);
    tableCommand(editor, "alignCenter");

    expect(tableCommand(editor, "addColumnAfter")).toBe(true);
    expect(aligns(editor)[0]).toEqual(["center", null, null, null]);
    editor.destroy();
  });

  // prosemirror-tables builds a new cell from the attribute's default, so every one of these would
  // leave a column disagreeing with itself. The delimiter row is written off the first row, which
  // makes the row added above it the one that would take the whole table's alignment off.
  it("survives a row added under it", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 1);
    tableCommand(editor, "alignCenter");
    cursorIn(editor, 2, 2);
    press(editor, "Tab");

    expect(aligns(editor)[3]).toEqual([null, "center", null]);
    editor.destroy();
  });
});

// Dragging a column edge is the one edit the file has nowhere to put. It is asserted rather than
// assumed because the failure is invisible: the markdown is identical, so a resize looks saved and
// is gone the next time the document is opened. See the note at the top of tables.ts.
describe("a resized column", () => {
  it("changes the document without changing a byte of the markdown", () => {
    const editor = makeEditor(tableDoc(GRID));
    const before = written(editor);

    const pos = inCell(editor, 0, 0) - 1;
    const cell = editor.state.doc.nodeAt(pos)!;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, null, { ...cell.attrs, colwidth: [180] }),
    );

    expect(table(editor).firstChild!.firstChild!.attrs.colwidth).toEqual([180]);
    expect(written(editor)).toBe(before);
    editor.destroy();
  });
});

// A table indented under a bullet, which is the one place a table has structure around it that
// another extension's keys will act on. Every key this lane binds is asked here, because what is
// behind each of them is a list command that reshapes the list rather than the table: a key that
// falls through from inside a cell can take the bullet out from under the table the cursor is in.
const NESTED: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "item" }] },
            ...tableDoc([["a", "b"], ["c", "d"]]).content!,
          ],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "next" }] }],
        },
      ],
    },
  ],
};

/** The node names from the document down to the cursor, which is what a lifted list item loses. */
function path(editor: Editor): string[] {
  const { $from } = editor.state.selection;
  const names: string[] = [];
  for (let depth = 1; depth <= $from.depth; depth += 1) names.push($from.node(depth).type.name);
  return names;
}

describe("a table nested in a list item", () => {
  it("stays where it is when Shift-Tab is pressed in the first cell", () => {
    const editor = makeEditor(NESTED);
    cursorIn(editor, 0, 0);
    const before = editor.state.doc.toJSON();
    const at = editor.state.selection.from;

    expect(path(editor)).toEqual(["bulletList", "listItem", "table", "tableRow", "tableHeader"]);
    press(editor, "Tab", true);

    // Nowhere to go, so nothing moves. What must not happen is the key reaching the list command
    // behind this lane's binding, which lifts the item and dissolves the list around the table.
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(editor.state.selection.from).toBe(at);
    expect(path(editor)).toEqual(["bulletList", "listItem", "table", "tableRow", "tableHeader"]);
    editor.destroy();
  });

  it("keeps its list when Backspace is pressed at the start of the first cell", () => {
    const editor = makeEditor(NESTED);
    cursorIn(editor, 0, 0);
    const before = editor.state.doc.toJSON();

    press(editor, "Backspace");

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it("keeps its list when Delete is pressed at the end of the last cell", () => {
    const editor = makeEditor(NESTED);
    const map = TableMap.get(table(editor));
    const row = map.height - 1;
    const column = map.width - 1;
    const cell = table(editor).nodeAt(map.map[row * map.width + column])!;
    editor.commands.setTextSelection(inCell(editor, row, column) + cell.content.size);
    const before = editor.state.doc.toJSON();

    press(editor, "Delete");

    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });
});

// A paste is not this lane's feature and prosemirror-tables claims one, which is exactly why the
// assertion is here: this file installs that plugin, so what it does with a paste is this file's
// answer to give. Over a rectangle of dragged cells the library replaces the content of every cell
// in the rectangle with the slice, whatever the slice is. One word replaced six cells. An image on
// the clipboard carries no HTML and no text, so the slice ProseMirror hands along is the empty one
// and six cells were emptied by a paste that put nothing anywhere.
//
// Both were reproduced against the plugin order this file used to run: pasting the word `z` over
// a two by three rectangle gave [["z","z","z"],["z","z","z"],["4","5","6"]], and Slice.empty over
// the same rectangle gave [["","",""],["","",""],["4","5","6"]]. The app's clipboard plugin now
// sits in front of the library's and refuses both, and stands aside for the one paste the library
// does better, which is cells over cells.
//
// The walk below is EditorView.prototype.someProp rather than a loop over `editor.state.plugins`
// written here. They agree today, and the point is that this asks the question the running editor
// asks instead of a modelled one: the props the component puts on the view come first, then the
// direct plugins, then the state's, and a guard written in the wrong one of those three answers
// nothing. Four guards in this project have been shipped and never reached, and every test that
// missed one was a test that called the handler itself.
describe("a paste over a dragged rectangle of cells", () => {
  const paste = (editor: Editor, slice: Slice): boolean => {
    const event = { preventDefault: () => {} } as unknown as ClipboardEvent;
    const view = {
      get state() {
        return editor.state;
      },
      dispatch: (tr: Transaction) => editor.view.dispatch(tr),
      directPlugins: [],
      _props: {},
      someProp: EditorView.prototype.someProp,
      focus: () => {},
      dom: null,
      composing: false,
      dragging: null,
      editable: true,
    } as unknown as EditorView;
    return view.someProp("handlePaste", (f) => f(view, event, slice)) === true;
  };

  /** The clipboard a real copy out of a table puts there, which is the one shape to stand aside for. */
  const cellSlice = (editor: Editor, from: [number, number], to: [number, number]): Slice => {
    selectCells(editor, from, to);
    return editor.state.selection.content();
  };

  it("leaves every cell alone when the clipboard carried nothing", () => {
    const editor = makeEditor(tableDoc(GRID));
    const before = written(editor);
    selectCells(editor, [0, 0], [1, 2]);

    expect(paste(editor, Slice.empty)).toBe(true);

    expect(shape(editor)).toEqual(GRID);
    expect(written(editor)).toBe(before);
    editor.destroy();
  });

  it("leaves every cell alone when the clipboard carried a word", () => {
    const editor = makeEditor(tableDoc(GRID));
    const before = written(editor);
    selectCells(editor, [0, 0], [1, 2]);

    expect(paste(editor, textSlice(editor, "z"))).toBe(true);

    // Six cells for one word is not a paste anybody meant, and it is not undoable in the file: the
    // save lands half a second later whether or not the user has noticed yet.
    expect(shape(editor)).toEqual(GRID);
    expect(written(editor)).toBe(before);
    editor.destroy();
  });

  it("still lays out a rectangle of cells copied out of a table", () => {
    const editor = makeEditor(tableDoc(GRID));
    const copied = cellSlice(editor, [1, 0], [1, 1]);
    selectCells(editor, [2, 0], [2, 1]);

    expect(paste(editor, copied)).toBe(true);

    // The library's own edit, kept because it is better than anything this app would do with it: it
    // lays the cells out over the rectangle and keeps every boundary the user copied. Refusing this
    // would be the guard destroying a paste in order to guard it.
    expect(shape(editor)).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["1", "2", "6"],
    ]);
    editor.destroy();
  });

  it("puts a word into the one cell the caret is in", () => {
    const editor = makeEditor(tableDoc(GRID));
    cursorIn(editor, 1, 1);
    editor.commands.setTextSelection(inCell(editor, 1, 1) + 1);

    // Nobody claims it, so ProseMirror's own handler runs and does the ordinary thing. Refusing a
    // paste at a caret in a cell would have been this guard overreaching in the other direction.
    expect(paste(editor, textSlice(editor, "z"))).toBe(false);
    editor.destroy();
  });
});
