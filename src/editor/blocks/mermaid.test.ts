// What can be asserted about a mermaid block without a browser, which is most of what matters.
//
// The node view itself needs a DOM and a real ProseMirror view, and this suite runs in node, so the
// drawing is not what is tested here. What is tested is everything the drawing is not allowed to
// disturb: that the extension adds nothing to the schema, that a ```mermaid fence is still an
// ordinary code block that round trips byte for byte through the editor, that exactly one plugin in
// the whole build claims the code block node view, and that the decoration telling a block the caret
// is inside it lands on the right blocks and only those.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Plugin } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { createEditorExtensions } from "../extensions";
import { parseMarkdown, serializeMarkdown } from "../../markdown";
import { MermaidRendering, insertMermaid } from "./mermaid";

const PATH = "/notes/diagrams.md";
const FENCE = "```";

const extensions = () => createEditorExtensions({ documentPath: () => PATH, onError: () => {} });

function makeEditor(content?: object): Editor {
  return new Editor({
    element: null,
    injectCSS: false,
    extensions: extensions(),
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  });
}

/** An editor holding what the bridge made of `source`, which is how a document really arrives. */
function editorFor(source: string): Editor {
  return makeEditor(parseMarkdown(source, PATH).doc.toJSON());
}

function blockAt(editor: Editor, index: number): { node: ProseMirrorNode; pos: number } {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return { node: doc.child(index), pos };
}

/**
 * The one plugin that draws diagrams, found the way the view finds it: by what it offers.
 *
 * The plugins are asked of the extensions rather than of the state, because TipTap only installs
 * them when it mounts a view and there is no DOM here to mount one in.
 */
function nodeViewPlugins(editor: Editor): Plugin[] {
  return editor.extensionManager.plugins.filter(
    (plugin) => plugin.props.nodeViews?.codeBlock !== undefined,
  );
}

function cursorDecorations(editor: Editor): DecorationSet | null {
  const [plugin] = nodeViewPlugins(editor);
  // `this` matters: ProseMirror calls a props function with the plugin as its receiver.
  const found = plugin.props.decorations?.call(plugin, editor.state);
  return (found as DecorationSet | null | undefined) ?? null;
}

function decoratedRanges(editor: Editor): Array<[number, number]> {
  const set = cursorDecorations(editor);
  if (!set) return [];
  return set.find().map((decoration) => [decoration.from, decoration.to]);
}

const DIAGRAM = [
  "# Diagrams",
  "",
  `${FENCE}mermaid`,
  "graph TD;",
  "  A-->B;",
  FENCE,
  "",
  `${FENCE}ts`,
  "const x = 1;",
  FENCE,
  "",
  "After.",
  "",
].join("\n");

describe("the mermaid extension", () => {
  it("is the one the registry names", () => {
    expect(MermaidRendering.name).toBe("mermaidRendering");
  });

  it("adds no node and no mark, so the bridge and the editor still agree", () => {
    const plain = new Editor({
      element: null,
      injectCSS: false,
      extensions: extensions().filter((extension) => extension.name !== "mermaidRendering"),
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    const withMermaid = makeEditor();

    expect(Object.keys(withMermaid.schema.nodes)).toEqual(Object.keys(plain.schema.nodes));
    expect(Object.keys(withMermaid.schema.marks)).toEqual(Object.keys(plain.schema.marks));

    plain.destroy();
    withMermaid.destroy();
  });

  it("is the only plugin in the build that claims the code block node view", () => {
    const editor = makeEditor();
    // Two plugins offering a node view for one node is a silent bug: ProseMirror takes the first
    // one asked and the other never runs. The code lane leaves this to mermaid on purpose.
    expect(nodeViewPlugins(editor)).toHaveLength(1);
    editor.destroy();
  });
});

describe("a ```mermaid fence in a document", () => {
  it("is an ordinary code block carrying its own language", () => {
    const editor = editorFor(DIAGRAM);
    const { node } = blockAt(editor, 1);

    expect(node.type.name).toBe("codeBlock");
    expect(node.attrs.language).toBe("mermaid");
    expect(node.textContent).toBe("graph TD;\n  A-->B;");
    editor.destroy();
  });

  it("round trips byte for byte through the editor", () => {
    const parsed = parseMarkdown(DIAGRAM, PATH);
    const editor = makeEditor(parsed.doc.toJSON());

    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(DIAGRAM);
    editor.destroy();
  });

  it("keeps its indentation, its blank lines and its meta on the way back", () => {
    const source = [
      `${FENCE}mermaid theme=forest`,
      "sequenceDiagram",
      "    Alice->>John: Hello",
      "",
      "    John-->>Alice: Hi",
      FENCE,
      "",
    ].join("\n");

    const parsed = parseMarkdown(source, PATH);
    const editor = makeEditor(parsed.doc.toJSON());
    const { node } = blockAt(editor, 0);

    expect(node.attrs.meta).toBe("theme=forest");
    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(source);
    editor.destroy();
  });
});

describe("the decoration that says the caret is inside", () => {
  it("is absent while the cursor is somewhere else", () => {
    const editor = editorFor(DIAGRAM);
    editor.commands.setTextSelection(1);

    expect(decoratedRanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("covers the block the cursor is in, and nothing else", () => {
    const editor = editorFor(DIAGRAM);
    const { node, pos } = blockAt(editor, 1);
    editor.commands.setTextSelection(pos + 1);

    expect(decoratedRanges(editor)).toEqual([[pos, pos + node.nodeSize]]);
    editor.destroy();
  });

  it("ignores a code block that is not a diagram", () => {
    const editor = editorFor(DIAGRAM);
    const { pos } = blockAt(editor, 2);
    editor.commands.setTextSelection(pos + 1);

    expect(decoratedRanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("does not fire on the paragraph that follows the fence", () => {
    const editor = editorFor(DIAGRAM);
    const { pos } = blockAt(editor, 3);
    editor.commands.setTextSelection(pos + 1);

    expect(decoratedRanges(editor)).toEqual([]);
    editor.destroy();
  });

  it("covers the block when it is selected whole rather than typed in", () => {
    const editor = editorFor(DIAGRAM);
    const { node, pos } = blockAt(editor, 1);
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)),
    );

    expect(decoratedRanges(editor)).toEqual([[pos, pos + node.nodeSize]]);
    editor.destroy();
  });

  it("covers every diagram a whole document selection touches", () => {
    const source = [
      `${FENCE}mermaid`,
      "graph TD;",
      FENCE,
      "",
      "Between.",
      "",
      `${FENCE}mermaid`,
      "graph LR;",
      FENCE,
      "",
    ].join("\n");
    const editor = editorFor(source);
    editor.commands.selectAll();

    expect(decoratedRanges(editor)).toHaveLength(2);
    editor.destroy();
  });

  it("leaves a fence whose language only looks like mermaid alone", () => {
    // The code lane leaves this block plain too, so a capitalised info string is neither drawn nor
    // coloured. It stays the text the user wrote, which is the safe way for the two to disagree.
    const source = [`${FENCE}Mermaid`, "graph TD;", FENCE, ""].join("\n");
    const editor = editorFor(source);
    editor.commands.setTextSelection(1);

    expect(blockAt(editor, 0).node.attrs.language).toBe("Mermaid");
    expect(decoratedRanges(editor)).toEqual([]);
    editor.destroy();
  });
});

describe("insertMermaid", () => {
  it("turns the empty paragraph the cursor is on into an empty fence", () => {
    const editor = makeEditor();

    expect(insertMermaid(editor)).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);

    const { node } = blockAt(editor, 0);
    expect(node.type.name).toBe("codeBlock");
    expect(node.attrs.language).toBe("mermaid");
    expect(node.attrs.meta).toBe(null);
    expect(node.textContent).toBe("");
    editor.destroy();
  });

  it("writes a ```mermaid fence and nothing else", () => {
    const parsed = parseMarkdown("", PATH);
    const editor = makeEditor(parsed.doc.toJSON());
    insertMermaid(editor);

    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(`${FENCE}mermaid\n${FENCE}\n`);
    editor.destroy();
  });

  it("splits the paragraph it was called from without losing a character of it", () => {
    // The same thing the toolbar's rule and table buttons have always done with a caret in the
    // middle of a line. What matters is that the words are all still there, on both sides of it.
    const editor = editorFor("Some prose.\n");
    editor.commands.setTextSelection(3);

    expect(insertMermaid(editor)).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).textContent).toBe("So");
    expect(editor.state.doc.child(1).attrs.language).toBe("mermaid");
    expect(editor.state.doc.child(2).textContent).toBe("me prose.");
    editor.destroy();
  });

  it("writes something the bridge can read back, even inside a list", () => {
    const parsed = parseMarkdown("- one\n- two\n", PATH);
    const editor = makeEditor(parsed.doc.toJSON());
    editor.commands.setTextSelection(4);
    insertMermaid(editor);

    const written = serializeMarkdown(parsed, editor.state.doc);
    const reread = parseMarkdown(written, PATH);
    expect(written).toContain(`${FENCE}mermaid`);
    expect(serializeMarkdown(reread, reread.doc)).toBe(written);
    editor.destroy();
  });

  it("does nothing, and says so, in a table cell", () => {
    // Left to itself ProseMirror would split the table in two around the block and leave a row with
    // no cells in it, which is a table the serializer has nothing to write.
    const editor = editorFor("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(editor.state.doc.child(0).type.name).toBe("table");

    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
    );
    const before = editor.state.doc;

    expect(insertMermaid(editor)).toBe(false);
    expect(editor.state.doc).toBe(before);
    editor.destroy();
  });

  it("does nothing, and says so, inside another fence", () => {
    const editor = editorFor(`${FENCE}ts\nconst x = 1;\n${FENCE}\n`);
    editor.commands.setTextSelection(3);
    const before = editor.state.doc;

    expect(insertMermaid(editor)).toBe(false);
    expect(editor.state.doc).toBe(before);
    editor.destroy();
  });

  it("does nothing, and says so, inside a raw block", () => {
    const editor = editorFor("<figure><img src='x.png'></figure>\n");
    expect(editor.state.doc.child(0).type.name).toBe("raw");
    editor.commands.setTextSelection(3);
    const before = editor.state.doc;

    expect(insertMermaid(editor)).toBe(false);
    expect(editor.state.doc).toBe(before);
    editor.destroy();
  });
});
