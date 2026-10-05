// What the pill is allowed to draw live, and the way back into a document from the page under it.
//
// The four permissions in `EditorActiveState` are not new answers. Every one of them is a predicate
// out of src/editor/fits.ts that the running command already asks the moment a tool is pressed, and
// what changed is that the answer now reaches the screen instead of being spent on a button doing
// nothing. So this file is a second reading of the same matrix: the contexts below are the ones
// src/editor/fits.test.ts drives every entry point through, and the expectations are read off the
// outcomes it records there rather than worked out again here.
//
// Which makes the interesting cell the fence. A fence refuses every insert and every mark, and it
// does NOT refuse a conversion: turning one into a paragraph, a list or a quote is an edit markdown
// can spell and that file pins as one that happens. A pill that greyed the list tools out over a
// fence would be taking away something that works, which is the opposite failure to the one this is
// fixing and the harder one to notice.
//
// `focusEnd` is here for the other half of the same idea. It is the only method on the handle that
// nothing in the document invokes: the shell hands it a press on the blank page below the last
// block, so what it does has to be true wherever the caret happened to be, including nowhere useful
// at all. src/editor/fits.test.ts already asserts it writes no byte in any hostile context; what is
// left for here is where the caret ends up and how many paragraphs are behind it.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { parseMarkdown, serializeMarkdown } from "../markdown";
import { activeStateOf, createCommands } from "./Editor";
import { createEditorExtensions } from "./extensions";

function open(source: string) {
  const parsed = parseMarkdown(source, "/notes/a.md");
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: createEditorExtensions({ documentPath: () => "/notes/a.md", onError: () => {} }),
    content: parsed.doc.toJSON(),
  });
  // TipTap installs the extensions' plugins when it mounts a view and there is no DOM here, so the
  // state is swapped for one built with them, which is what src/editor/Editor.tsx does per document.
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return { editor, written: () => serializeMarkdown(parsed, editor.state.doc) };
}

function caretIn(editor: Editor, name: string, offset = 0): void {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === name) found = pos + 1;
    return found === null;
  });
  if (found === null) throw new Error(`no ${name} in the fixture`);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(found + offset))),
  );
}

/** The rectangle of whole cells a drag across a table makes. */
function dragCells(editor: Editor): void {
  const table = editor.state.doc.firstChild;
  if (!table) throw new Error("no table in the fixture");
  const map = TableMap.get(table);
  editor.view.dispatch(
    editor.state.tr.setSelection(
      CellSelection.create(
        editor.state.doc,
        1 + map.positionAt(0, 0, table),
        1 + map.positionAt(map.height - 1, map.width - 1, table),
      ),
    ),
  );
}

const TABLE = "| h1 | h2 |\n| -- | -- |\n| a  | b  |\n| c  | d  |\n";
const TOGGLE = "<details>\n<summary>My title</summary>\n\nhidden\n\n</details>\n";

interface Permissions {
  canMark: boolean;
  canPlace: boolean;
  canPlaceInline: boolean;
  canConvert: boolean;
}

interface Context {
  name: string;
  source: string;
  place: (editor: Editor) => void;
  allows: Permissions;
}

const CONTEXTS: Context[] = [
  {
    // A cell holds inline content, so a picture and an inline formula go in and no block does, and
    // there is no block in it for a conversion to act on either.
    name: "the caret in a table cell",
    source: TABLE,
    place: (editor) => caretIn(editor, "tableCell"),
    allows: { canMark: true, canPlace: false, canPlaceInline: true, canConvert: false },
  },
  {
    // The rectangle is a selection of containers rather than of text, so an insert over it does not
    // land anywhere: it replaces the content of every cell in it. Marks are the one thing that
    // still means what it looks like.
    name: "a dragged selection across table cells",
    source: TABLE,
    place: dragCells,
    allows: { canMark: true, canPlace: false, canPlaceInline: false, canConvert: false },
  },
  {
    name: "the caret inside a fenced code block",
    source: "```js\nlet x = 1;\nlet y = 2;\n```\n",
    place: (editor) => caretIn(editor, "codeBlock", 2),
    allows: { canMark: false, canPlace: false, canPlaceInline: false, canConvert: true },
  },
  {
    name: "the caret inside a mermaid block",
    source: "```mermaid\ngraph TD\nA-->B\n```\n",
    place: (editor) => caretIn(editor, "codeBlock", 2),
    allows: { canMark: false, canPlace: false, canPlaceInline: false, canConvert: true },
  },
  {
    // The one block that refuses everything, because its bytes are the file's own.
    name: "the caret inside a raw block",
    source: '<div class="x">\nkeep me\n</div>\n',
    place: (editor) => caretIn(editor, "raw", 2),
    allows: { canMark: false, canPlace: false, canPlaceInline: false, canConvert: false },
  },
  {
    name: "the caret inside a callout",
    source: "> [!NOTE]\n> a note\n",
    place: (editor) => caretIn(editor, "callout", 2),
    allows: { canMark: true, canPlace: true, canPlaceInline: true, canConvert: true },
  },
  {
    name: "the caret inside a toggle",
    source: TOGGLE,
    place: (editor) => caretIn(editor, "toggle", 2),
    allows: { canMark: true, canPlace: true, canPlaceInline: true, canConvert: true },
  },
  {
    name: "the caret in a nested list item",
    source: "- one\n  - two\n",
    place: (editor) => caretIn(editor, "bulletList", 6),
    allows: { canMark: true, canPlace: true, canPlaceInline: true, canConvert: true },
  },
  {
    name: "a selection spanning two block types",
    source: "# Title\n\nprose\n",
    place: (editor) =>
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, 2, editor.state.doc.content.size - 1),
        ),
      ),
    allows: { canMark: true, canPlace: true, canPlaceInline: true, canConvert: true },
  },
  {
    name: "an empty document",
    source: "",
    place: (editor) => caretIn(editor, "paragraph"),
    allows: { canMark: true, canPlace: true, canPlaceInline: true, canConvert: true },
  },
];

describe("what the pill may draw live", () => {
  it.each(CONTEXTS)("$name", (context) => {
    const { editor } = open(context.source);
    context.place(editor);

    const { canMark, canPlace, canPlaceInline, canConvert } = activeStateOf(editor);
    expect({ canMark, canPlace, canPlaceInline, canConvert }).toEqual(context.allows);

    editor.destroy();
  });

  // The snapshot is only as live as the comparison that decides whether to publish it, and one of
  // these four moves with no other field moving at all: a drag across a rectangle of cells is
  // refused every insert while the block, the heading and the language stay exactly as they were.
  // Left out of that comparison, the pill would have gone on drawing the inserts live over the one
  // selection that has already cost this project six cells of somebody's table.
  it("republishes when a drag across cells takes the inserts away", () => {
    const { editor } = open(TABLE);
    caretIn(editor, "tableCell");
    const before = activeStateOf(editor);

    dragCells(editor);
    const after = activeStateOf(editor);

    expect([before.block, before.inTable]).toEqual([after.block, after.inTable]);
    expect([before.canPlaceInline, after.canPlaceInline]).toEqual([true, false]);
  });
});

/** Where the caret is, said as a block name and whether it is the last block in the document. */
function caretAt(editor: Editor): { block: string; last: boolean; empty: boolean } {
  const { $from } = editor.state.selection;
  return {
    block: $from.parent.type.name,
    last: $from.index(0) === editor.state.doc.childCount - 1,
    empty: $from.parent.content.size === 0,
  };
}

describe("the way back in from the page under the document", () => {
  // The common case, and the one that must not leave anything behind: a press on the blank sheet
  // below a document that already ends in an empty paragraph is a caret move and nothing else. A
  // markdown file cannot spell one of those, so it is made by the first press, which is also the
  // shape somebody holding the pointer down on the page is in.
  it("lands in an empty last paragraph rather than adding another", () => {
    const { editor, written } = open("hello\n");
    const handle = createCommands(editor);

    handle.focusEnd();
    const after = editor.state.doc.childCount;
    // Back into the prose, so the second press is finding that paragraph rather than sitting in it.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));
    handle.focusEnd();
    handle.focusEnd();

    expect(editor.state.doc.childCount).toBe(after);
    expect(caretAt(editor)).toEqual({ block: "paragraph", last: true, empty: true });
    expect(written()).toBe("hello\n");
    editor.destroy();
  });

  // And the case it exists for. Each of these ends the document with a block that has nowhere after
  // it for a caret to go, which is the state somebody is stuck in when the last thing they did was
  // insert one from the toolbar.
  it.each([
    ["a table", TABLE],
    ["a fence", "```js\nlet x = 1;\n```\n"],
    ["a rule", "prose\n\n---\n"],
    ["a raw block", '<div class="x">\nkeep me\n</div>\n'],
    ["a toggle", TOGGLE],
  ])("makes a paragraph under %s that ends the document", (_name, source) => {
    const { editor, written } = open(source);
    const before = { children: editor.state.doc.childCount, bytes: written() };

    createCommands(editor).focusEnd();

    expect(editor.state.doc.childCount).toBe(before.children + 1);
    expect(caretAt(editor)).toEqual({ block: "paragraph", last: true, empty: true });
    // The paragraph is nothing to the serializer, so the document is dirtied and the file is not.
    // That trade is the whole reason this is allowed to write to the document at all, and it is the
    // same one src/editor/blocks/tables.ts and src/editor/blocks/code.ts make for their own keys.
    expect(written()).toBe(before.bytes);
    editor.destroy();
  });

  // From inside the block rather than from a caret that was already outside it, which is the shape
  // the user is actually in: they typed in the last cell of a table, ran out of table, and pressed
  // the page under it.
  it("reaches the end from a caret in the last cell of a table", () => {
    const { editor } = open(TABLE);
    caretIn(editor, "tableCell");

    createCommands(editor).focusEnd();

    expect(caretAt(editor)).toEqual({ block: "paragraph", last: true, empty: true });
    editor.destroy();
  });
});
