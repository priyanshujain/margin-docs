// What a heading command does to one line of a block that holds several, read off the bytes the
// file would be written back as.
//
// The bug this pins: a paragraph pasted out of a chat window with a break between every message,
// or a hand wrapped paragraph out of any markdown file, is one block on the model's side and
// several lines on the user's. Heading 2 asked for on the first of those lines turned the whole
// block into a heading, and the file got a setext heading forty characters wide with the next
// paragraph inside it. src/editor/lines.ts cuts the line out first, and this is the proof that the
// cut lands where the words are and nowhere else.
//
// Driven through the handle and the chord, the same two doors the app has, rather than through the
// command on its own: the cut is a step in a chain that `change` judges as a whole, and a step that
// ran alone would prove nothing about what reaches the file.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { createCommands, createEditorProps } from "./Editor";
import { createEditorExtensions } from "./extensions";
import { parseMarkdown, serializeMarkdown } from "../markdown";

const PATH = "/notes/a.md";

const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "metaKey" : "ctrlKey";

function makeEditor(content: JSONContent): Editor {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: createEditorExtensions({ documentPath: () => PATH, onError: () => {} }),
    content,
  });
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

/** An editor holding this file, the handle over it, and the bytes it would be saved as. */
function open(source: string) {
  const parsed = parseMarkdown(source, PATH);
  const editor = makeEditor(parsed.doc.toJSON());
  return {
    editor,
    handle: createCommands(editor),
    written: () => serializeMarkdown(parsed, editor.state.doc),
  };
}

/** The document position of this text's first character. */
function positionOf(editor: Editor, text: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isText) {
      const at = (node.text ?? "").indexOf(text);
      if (at >= 0) found = pos + at;
    }
    return found === null;
  });
  if (found === null) throw new Error(`no "${text}" in the fixture`);
  return found;
}

function select(editor: Editor, from: string, to: string = from, toEnd = false): void {
  const a = positionOf(editor, from);
  const b = positionOf(editor, to) + (toEnd ? to.length : 0);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, a, b)));
}

/**
 * What ProseMirror puts a key to, with the screen taken out of it: the same object
 * src/editor/fits.test.ts builds, and for the same reason. `someProp` is EditorView's own, so the
 * binding that claims the chord here is the one that claims it in the app.
 */
function viewOf(editor: Editor): EditorView {
  return {
    get state() {
      return editor.state;
    },
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
    directPlugins: [],
    _props: createEditorProps({ editable: () => true, onOpenLink: () => {} }),
    someProp: EditorView.prototype.someProp,
    posAtCoords: () => ({ pos: editor.state.selection.from, inside: -1 }),
    focus: () => {},
    dom: null,
    composing: false,
    dragging: null,
    editable: true,
  } as unknown as EditorView;
}

/** A chord, offered the way prosemirror-view's own keydown handler offers one. */
function press(editor: Editor, chord: string): void {
  const parts = chord.split("-");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const event = {
    key,
    keyCode: key.toUpperCase().charCodeAt(0),
    ctrlKey: mods.includes("Ctrl") || (mods.includes("Mod") && MOD === "ctrlKey"),
    metaKey: mods.includes("Meta") || (mods.includes("Mod") && MOD === "metaKey"),
    altKey: mods.includes("Alt"),
    shiftKey: mods.includes("Shift"),
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
  const view = viewOf(editor);
  view.someProp("handleKeyDown", (f) => f(view, event));
}

const QUESTION = "Question: would you expect the tendency to be less overt?";

describe("a heading asked for on one line of a wrapped block", () => {
  it("takes the line and leaves the rest of the paragraph a paragraph", () => {
    const { editor, handle, written } = open(`Heasder\n${QUESTION}\n`);
    select(editor, "Heasder");
    handle.setHeading(2);
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });

  it("takes the line when the gap in front of the next one is two hard breaks", () => {
    // What a paste out of a chat window looks like: one paragraph, a blank line drawn as two
    // breaks, and both breaks are the gap rather than one of them staying as an empty first line.
    const { editor, handle, written } = open(`Heasder\\\n\\\n${QUESTION}\n`);
    select(editor, "Heasder");
    handle.setHeading(2);
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });

  it("takes a middle line out from between the two around it", () => {
    const { editor, handle, written } = open("one\ntwo\nthree\n");
    select(editor, "two");
    handle.setHeading(2);
    expect(written()).toBe("one\n\n## two\n\nthree\n");
  });

  it("takes the last line, which has a break before it and none after", () => {
    const { editor, handle, written } = open("one\ntwo\n");
    select(editor, "two");
    handle.setHeading(2);
    expect(written()).toBe("one\n\n## two\n");
  });

  it("takes every line a selection reaches into", () => {
    const { editor, handle, written } = open("one\ntwo\nthree\n");
    select(editor, "one", "two");
    handle.setHeading(1);
    expect(written()).toBe("one\ntwo\n===\n\nthree\n");
  });

  it("works with a caret as well as a selection", () => {
    const { editor, handle, written } = open(`Heasder\n${QUESTION}\n`);
    select(editor, "sder");
    handle.setHeading(3);
    expect(written()).toBe(`### Heasder\n\n${QUESTION}\n`);
  });

  it("makes a deep heading possible on a line of a block that could not hold one whole", () => {
    // A level 3 heading has no underlined spelling, so `change` refuses to turn a two line block
    // into one. One line of it is one line, and that is exactly what the cut is for.
    const { editor, handle, written } = open("one\ntwo\n");
    select(editor, "one");
    handle.setHeading(4);
    expect(written()).toBe("#### one\n\ntwo\n");
  });

  it("is the same through the chord", () => {
    const { editor, written } = open(`Heasder\n${QUESTION}\n`);
    select(editor, "Heasder");
    press(editor, "Mod-Alt-2");
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });

  it("leaves a paragraph that is one line to the command as it was", () => {
    const { editor, handle, written } = open(`Heasder\n\n${QUESTION}\n`);
    select(editor, "Heasder");
    handle.setHeading(2);
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });

  it("keeps the marks on the line it moves", () => {
    const { editor, handle, written } = open("a **bold** start\nand the rest\n");
    select(editor, "start");
    handle.setHeading(2);
    expect(written()).toBe("## a **bold** start\n\nand the rest\n");
  });

  it("cuts inside a list item without leaving the list", () => {
    const { editor, handle, written } = open("- one\n  two\n");
    select(editor, "two");
    handle.setHeading(2);
    expect(written()).toBe("- one\n  ## two\n");
  });
});

describe("the way back", () => {
  it("turns one line of a wrapped heading back into a paragraph and leaves the other a heading", () => {
    // The state the bug left people in, and the gesture they reach for to undo it.
    const { editor, handle, written } = open(`Heasder\n${QUESTION}\n-----\n`);
    select(editor, "Question");
    handle.setHeading(null);
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });

  it("does the same through the chord that toggles", () => {
    const { editor, written } = open(`Heasder\n${QUESTION}\n-----\n`);
    select(editor, "Question");
    press(editor, "Mod-Alt-2");
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });

  it("and through the chord for a paragraph", () => {
    const { editor, written } = open(`Heasder\n${QUESTION}\n-----\n`);
    select(editor, "Question");
    press(editor, "Mod-Alt-0");
    expect(written()).toBe(`## Heasder\n\n${QUESTION}\n`);
  });
});

describe("when there is nothing to cut", () => {
  it("asking a wrapped heading for the level it already is leaves it whole", () => {
    // Against the bytes the file would have been saved as before the gesture rather than against
    // the fixture, because the writer sets the underline to the width of the heading's own text.
    const { editor, handle, written } = open(`Heasder\n${QUESTION}\n-----\n`);
    const before = written();
    select(editor, "Question");
    handle.setHeading(2);
    expect(editor.state.doc.childCount).toBe(1);
    expect(written()).toBe(before);
  });

  it("asking a wrapped paragraph to be a paragraph leaves it whole", () => {
    const source = `Heasder\n${QUESTION}\n`;
    const { editor, handle, written } = open(source);
    select(editor, "Question");
    handle.setHeading(null);
    expect(written()).toBe(source);
  });

  it("a fence is still converted as one block, which is what its lines are", () => {
    const { editor, handle } = open("```js\nlet x = 1;\nlet y = 2;\n```\n");
    select(editor, "let y");
    handle.setHeading(2);
    const doc = editor.state.doc;
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe("heading");
    expect(doc.firstChild?.textContent).toBe("let x = 1;\nlet y = 2;");
  });
});
