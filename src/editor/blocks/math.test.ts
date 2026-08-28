// The math lane's tests, which stop at the edge of the DOM.
//
// vite.config.ts runs vitest in the node environment, so there is no document for a view to mount
// in and the node view in math.ts cannot be built from here. What a formula looks like on screen,
// and the field that opens on it when it is selected, belong to the Playwright suite. What belongs
// here is the half that touches the document, because that is the half that can cost somebody a
// file: the two ways a formula gets made, and the LaTeX already in the document surviving both of
// them character for character.
//
// The last group tests KaTeX rather than this app. It is here because the node view rests on two
// promises the library makes and could quietly stop keeping on an upgrade: that it does not throw
// under these options, and that what it hands back when it cannot parse something still contains
// the source it was given.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { EditorState, NodeSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import katex from "katex";
import { parseMarkdown, serializeMarkdown } from "../../markdown";
import { createEditorExtensions } from "../extensions";
import { insertMath } from "./math";

const extensions = () =>
  createEditorExtensions({ documentPath: () => "/notes/a.md", onError: () => {} });

function editorWith(content: JSONContent): Editor {
  return new Editor({ element: null, injectCSS: false, extensions: extensions(), content });
}

/**
 * The same editor with the extensions' ProseMirror plugins actually installed, which TipTap only
 * does when it mounts a view and there is no DOM here to mount into. src/editor/Editor.tsx swaps a
 * state built this way in for every document it opens, so this is what the app runs minus the
 * screen. Only the table tests need it, because a cell selection is prosemirror-tables' own.
 */
function editorWithPlugins(content: JSONContent): Editor {
  const editor = editorWith(content);
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

/** A file, opened, with the bytes it would be written back as. */
function open(source: string) {
  const parsed = parseMarkdown(source, "/notes/a.md");
  const editor = editorWithPlugins(parsed.doc.toJSON());
  return { editor, written: () => serializeMarkdown(parsed, editor.state.doc) };
}

/** The document position just inside a cell, for a table that is the document's first block. */
function inCell(editor: Editor, row: number, column: number): number {
  const table = editor.state.doc.firstChild!;
  return 1 + TableMap.get(table).positionAt(row, column, table) + 1;
}

/**
 * Enter, through the keymap the extension really installs rather than through a function this file
 * reached into. A headless editor has no view to take a key event, so the plugins' own handlers are
 * called in the order ProseMirror would call them, with the proxy view TipTap answers with and the
 * two things prosemirror-keymap reads off an event: the key name, and the four modifier flags.
 */
function pressEnter(editor: Editor): void {
  const event = {
    key: "Enter",
    keyCode: 13,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  } as unknown as KeyboardEvent;

  for (const plugin of editor.extensionManager.plugins) {
    // Called through the plugin, which is the "this" ProseMirror types the prop as wanting.
    if (plugin.props.handleKeyDown?.call(plugin, editor.view, event)) return;
  }
}

const CODE = {
  type: "doc",
  content: [
    {
      type: "codeBlock",
      attrs: { language: "ts", meta: null },
      content: [{ type: "text", text: "const x = 1;" }],
    },
  ],
};

const RAW = {
  type: "doc",
  content: [
    {
      type: "raw",
      attrs: { source: "<figure><img src='x.png'></figure>" },
      content: [{ type: "text", text: "<figure><img src='x.png'></figure>" }],
    },
  ],
};

describe("insertMath", () => {
  it("puts an empty display equation in and selects it", () => {
    const editor = editorWith({ type: "doc", content: [{ type: "paragraph" }] });

    expect(insertMath(editor, true)).toBe(true);
    const block = editor.state.doc.firstChild;
    expect(block?.type.name).toBe("mathBlock");
    // Not empty. This assertion used to read "" and that was the bug: an empty formula is a box on
    // screen the file has no way to spell, and inline it went out as $$$$ and came back as text, so
    // the first autosave took it away without telling anybody. A new formula is made with the
    // placeholder in it, which is a formula that survives being written.
    expect(block?.attrs.latex).toBe("\\square");
    // Selected is what opens the field on it, so it is the half of the command that matters.
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("mathBlock");
    editor.destroy();
  });

  // The caret mid paragraph is the case the first version of this got wrong. A display formula
  // dropped there splits the paragraph and lands between the halves, so the position the insert was
  // asked for is not the position the formula ends up at, and selecting the wrong one means a
  // formula on screen with no way into its field. The end of a paragraph is the one place the two
  // answers agree, which is why the test above did not catch it.
  it("selects the display equation even when the caret was in the middle of a paragraph", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before after" }] }],
    });
    editor.commands.setTextSelection(8);

    expect(insertMath(editor, true)).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe("before ");
    expect(editor.state.doc.child(1).type.name).toBe("mathBlock");
    expect(editor.state.doc.child(2).textContent).toBe("after");
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("mathBlock");
    editor.destroy();
  });

  it("puts an inline formula in without disturbing the text around it", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "ab" }] }],
    });
    editor.commands.setTextSelection(2);

    expect(insertMath(editor, false)).toBe(true);
    const paragraph = editor.state.doc.firstChild;
    expect(paragraph?.type.name).toBe("paragraph");
    expect([...Array(paragraph?.childCount ?? 0)].map((_, i) => paragraph?.child(i).type.name)).toEqual([
      "text",
      "mathInline",
      "text",
    ]);
    expect(paragraph?.textContent).toBe("ab");
    editor.destroy();
  });

  it("refuses inside a code block, and leaves the fence exactly as it was", () => {
    const editor = editorWith(CODE);
    const before = editor.state.doc.toJSON();

    expect(insertMath(editor, false)).toBe(false);
    expect(insertMath(editor, true)).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  it("refuses inside a raw block, which is somebody's bytes and not a place for a formula", () => {
    const editor = editorWith(RAW);
    const before = editor.state.doc.toJSON();

    expect(insertMath(editor, false)).toBe(false);
    expect(insertMath(editor, true)).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });

  // The three below are one bug each, reproduced from the bytes they cost. All three were live in a
  // build whose table, rule and diagram inserts were already guarded: this command had a private
  // copy of the guard that had never been given the isolating rule, and a private guard is a guard
  // that is only as good as the last person who remembered it existed. It is gone, and this command
  // now asks the one in src/editor/fits.ts that every other insert asks.

  it("refuses with the caret in a table cell, and leaves the file byte identical", () => {
    const source = "| h1 | h2 |\n| - | - |\n| a | b |\n";
    const { editor, written } = open(source);
    editor.commands.setTextSelection(inCell(editor, 1, 0));

    // What this used to do: split the table around the formula, leave the body row empty and the
    // moved cells in a second table with no header, and hand the autosave
    // "| h1 | h2 |\n| - | - |\n| | |\n\n$$\n$$\n\n| a | b |\n| - | - |\n" half a second later.
    expect(insertMath(editor, true)).toBe(false);
    expect(written()).toBe(source);
    editor.destroy();
  });

  it("refuses over a dragged cell selection, and every cell keeps its text", () => {
    const source = "| h1 | h2 |\n| - | - |\n| a | b |\n| c | d |\n";
    const { editor, written } = open(source);
    const map = TableMap.get(editor.state.doc.firstChild!);
    const table = editor.state.doc.firstChild!;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, 1 + map.positionAt(0, 0, table), 1 + map.positionAt(2, 1, table)),
      ),
    );

    // An inline formula fits in a cell perfectly well, which is why the position rule alone let
    // this through: over a rectangle of cells the insert does not go in a cell, it replaces the
    // content of all six of them at once. Six cells of somebody's text for one empty formula.
    expect(insertMath(editor, false)).toBe(false);
    expect(insertMath(editor, true)).toBe(false);
    expect(written()).toBe(source);
    editor.destroy();
  });

  it("makes a formula the save can keep, which an empty one is not", () => {
    const { editor, written } = open("hello\n");
    editor.commands.setTextSelection(6);

    expect(insertMath(editor, false)).toBe(true);
    const file = written();
    expect(file).toBe("hello$$\\square$$\n");

    // The whole point of the placeholder, asserted the only way that means anything: the file goes
    // back through the parser and there is still a formula in it. An empty one wrote "hello$$$$",
    // which comes back as four dollar signs of literal text, and the box the user was looking at
    // was gone with nobody told.
    const reopened = parseMarkdown(file, "/notes/a.md");
    const found: string[] = [];
    reopened.doc.descendants((node) => {
      if (node.type.name === "mathInline") found.push(node.attrs.latex as string);
    });
    expect(found).toEqual(["\\square"]);
    editor.destroy();
  });
});

describe("the fence rule", () => {
  it("turns a paragraph holding just $$ into a math block, selected", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "$$" }] }],
    });
    editor.commands.setTextSelection(3);

    pressEnter(editor);

    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("mathBlock");
    // The placeholder here too, for the reason on the insertMath test above: a formula made by
    // typing a fence has the same claim to still being there after a save as one made by a button.
    expect(editor.state.doc.firstChild?.attrs.latex).toBe("\\square");
    expect(editor.state.selection instanceof NodeSelection).toBe(true);
    editor.destroy();
  });

  it("leaves a paragraph that says anything else alone", () => {
    for (const text of ["$$x", "a $$", "$", "$5 and $10"]) {
      const editor = editorWith({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      });
      editor.commands.setTextSelection(text.length + 1);

      pressEnter(editor);

      // Enter still splits the paragraph, which is the base keymap's business and not this lane's.
      // What is asserted is only that no formula was made out of somebody's prose.
      let found = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "mathBlock" || node.type.name === "mathInline") found = true;
      });
      expect([text, found]).toEqual([text, false]);
      editor.destroy();
    }
  });
});

describe("the LaTeX already in the document", () => {
  const source = [
    "Before.",
    "",
    "$$",
    "\\frac{a}{b} = \\sum_{i=0}^{n} x_i",
    "$$",
    "",
    "After $$x^2$$ here.",
    "",
  ].join("\n");

  it("comes back byte for byte after a formula is inserted somewhere else", () => {
    const parsed = parseMarkdown(source, "/notes/a.md");
    const editor = editorWith(parsed.doc.toJSON());
    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(source);

    // Into the first paragraph, which is the one place in the file this is allowed to change.
    editor.commands.setTextSelection(4);
    expect(insertMath(editor, false)).toBe(true);

    const written = serializeMarkdown(parsed, editor.state.doc);
    expect(written).toContain("$$\n\\frac{a}{b} = \\sum_{i=0}^{n} x_i\n$$");
    expect(written).toContain("After $$x^2$$ here.");
    editor.destroy();
  });
});

describe("KaTeX under the options this lane renders with", () => {
  // The same object math.ts builds its render call from. Repeated rather than exported, because
  // what is being pinned here is the library's behaviour under them and not their spelling.
  const options = {
    throwOnError: false,
    strict: false,
    trust: false,
    errorColor: "var(--danger)",
  } as const;

  it("draws a formula, with the source it was given still in the markup", () => {
    const markup = katex.renderToString("\\frac{a}{b}", options);
    expect(markup).toContain("katex");
    expect(markup).toContain("\\frac{a}{b}");
  });

  it("does not throw on LaTeX it cannot parse, and shows the source in the error colour", () => {
    // Two shapes, both of them the source and the colour. LaTeX KaTeX cannot get through the
    // parser at all comes back as one .katex-error span holding the whole expression; a command it
    // parses and has never heard of is drawn as the text of the command, in the same colour.
    for (const broken of ["\\frac{", "\\notacommand", "^", "\\begin{matrix}", "\\sqrt{}}{"]) {
      const markup = katex.renderToString(broken, options);
      expect([broken, markup.includes(broken)]).toEqual([broken, true]);
      expect([broken, markup.includes("var(--danger)")]).toEqual([broken, true]);
    }
  });

  it("writes the error colour through as the custom property it was handed", () => {
    // KaTeX puts the colour in an attribute on the element it draws, where a stylesheet cannot
    // reach it, so the token has to survive the trip out through the markup exactly as written.
    expect(katex.renderToString("\\frac{", options)).toContain("var(--danger)");
  });
});
