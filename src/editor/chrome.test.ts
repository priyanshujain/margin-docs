// Everything the editor draws that is not the document, and the one promise all of it has to keep.
//
// Two things were added to a page of prose at once: a prompt in every empty block, and a copy
// button in the corner of every fence. Neither is a node and neither may ever become one, because
// this editor writes real markdown bytes back to somebody's file and a document that grew a button
// in it is a document that saves one. So the first group here takes a file with all five callout
// kinds, a fence, a diagram, a list and a table in it, puts it through an editor with every one of
// these extensions installed and the decorations really computed, and asks for the bytes back.
//
// The second and third groups are about what the two mechanisms actually say, which no round trip
// can see. The placeholder is asserted through the decoration the plugin builds rather than through
// the option this file configured, because the interesting failure is a prompt that never reaches
// the block it was written for: `includeChildren` off is the whole reason an empty list item was
// silent, and reading the option back would have answered that it said the right thing all along.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Plugin } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import { createEditorExtensions } from "./extensions";
import { parseMarkdown, serializeMarkdown } from "../markdown";
import { CALLOUT_KINDS } from "../model/doc";

const PATH = "/notes/chrome.md";
const FENCE = "```";

const extensions = () => createEditorExtensions({ documentPath: () => PATH, onError: () => {} });

/**
 * An editor holding what the bridge made of `source`, with the extensions' plugins in its state.
 *
 * An unmounted editor's state carries no plugins at all, so without the second half of this every
 * assertion below would be about a document nothing was decorating. This is the same state TipTap
 * builds when it mounts a view; only the DOM is missing, and a decoration is computed without one.
 */
function editorFor(source: string): Editor {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: extensions(),
    content: parseMarkdown(source, PATH).doc.toJSON(),
  });
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

function pluginNamed(editor: Editor, name: string): Plugin {
  const found = editor.state.plugins.find((plugin: Plugin) =>
    String((plugin as unknown as { key: string }).key).startsWith(name),
  );
  if (!found) throw new Error(`no plugin called ${name} is in the state`);
  return found;
}

function decorationsOf(editor: Editor, name: string): Decoration[] {
  const set = pluginNamed(editor, name).getState(editor.state) as DecorationSet | undefined;
  return set ? set.find() : [];
}

/** Every widget the code lane put in the document, by the key only its chrome carries. */
function chrome(editor: Editor): Decoration[] {
  return decorationsOf(editor, "codeHighlighting").filter(
    (decoration) => decoration.spec.key === "code-copy",
  );
}

function blocksNamed(doc: ProseMirrorNode, name: string): Array<{ pos: number; node: ProseMirrorNode }> {
  const found: Array<{ pos: number; node: ProseMirrorNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== name) return true;
    found.push({ pos, node });
    return false;
  });
  return found;
}

/**
 * The prompt on the empty block at `pos`, as the plugin writes it into the DOM.
 *
 * The caret goes there first because the placeholder only ever decorates the block holding it, and
 * the decoration is recomputed on a selection change like any other transaction.
 */
function promptAt(editor: Editor, pos: number): string | null {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
  const found = decorationsOf(editor, "tiptap__placeholder").find(
    (decoration) => decoration.from <= pos && decoration.to >= pos,
  );
  const attrs = (found as unknown as { type?: { attrs?: Record<string, string> } } | undefined)?.type
    ?.attrs;
  return attrs && "data-placeholder" in attrs ? attrs["data-placeholder"] : null;
}

const CALLOUTS = CALLOUT_KINDS.map((kind) => `> [!${kind.toUpperCase()}]\n> A ${kind}.`).join("\n\n");

const SOURCE = [
  "# Chrome",
  "",
  CALLOUTS,
  "",
  `${FENCE}ts`,
  "const x = 1;",
  FENCE,
  "",
  `${FENCE}mermaid`,
  "graph TD;",
  FENCE,
  "",
  FENCE,
  "a bare fence",
  FENCE,
  "",
  "- an item",
  "- another",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
].join("\n");

describe("a document under the chrome", () => {
  it("is the file it was read from, byte for byte, with every decoration live", () => {
    const parsed = parseMarkdown(SOURCE, PATH);
    const editor = editorFor(SOURCE);

    // Asked for after the decorations have been built, and built again with the caret standing in
    // each block in turn, because a decoration that edited the document would do it on the way in
    // rather than on the way out.
    expect(chrome(editor).length).toBeGreaterThan(0);
    for (const { pos } of blocksNamed(editor.state.doc, "codeBlock")) promptAt(editor, pos + 1);

    expect(serializeMarkdown(parsed, editor.state.doc)).toBe(SOURCE);
    editor.destroy();
  });

  it("still holds all five callout kinds, each with its own", () => {
    const editor = editorFor(SOURCE);
    const kinds = blocksNamed(editor.state.doc, "callout").map(({ node }) => node.attrs.kind);

    expect(kinds).toEqual([...CALLOUT_KINDS]);
    editor.destroy();
  });
});

describe("the copy control", () => {
  it("is one widget at the first character of every fence, diagrams included", () => {
    const editor = editorFor(SOURCE);
    const fences = blocksNamed(editor.state.doc, "codeBlock");
    expect(fences).toHaveLength(3);

    expect(chrome(editor).map((decoration) => decoration.from)).toEqual(
      fences.map(({ pos }) => pos + 1),
    );
    editor.destroy();
  });

  it("has no width, so it is over none of the document's characters", () => {
    const editor = editorFor(SOURCE);
    for (const decoration of chrome(editor)) expect(decoration.from).toBe(decoration.to);
    editor.destroy();
  });

  it("is the same widget after the fence is typed into, so the element it built survives", () => {
    const editor = editorFor(SOURCE);
    const [fence] = blocksNamed(editor.state.doc, "codeBlock");
    const before = chrome(editor)[0];

    editor.view.dispatch(editor.state.tr.insertText("2", fence.pos + 1));
    const after = chrome(editor)[0];

    // What ProseMirror asks before it decides whether to keep a widget's DOM. A false here is a
    // button rebuilt on every keystroke, which is the tick vanishing a moment after it appears.
    // Reached through a cast because the widget's own type is the view's private business.
    const kind = (decoration: Decoration) =>
      (decoration as unknown as { type: { eq(other: unknown): boolean } }).type;
    expect(kind(after).eq(kind(before))).toBe(true);
    editor.destroy();
  });

  it("is on no block but a fence", () => {
    const editor = editorFor(SOURCE);
    const fences = blocksNamed(editor.state.doc, "codeBlock");

    for (const decoration of chrome(editor)) {
      const inside = fences.some(
        ({ pos, node }) => decoration.from > pos && decoration.from < pos + node.nodeSize,
      );
      expect(inside).toBe(true);
    }
    editor.destroy();
  });
});

describe("the prompt in an empty block", () => {
  /** `source`, opened, with the caret put in the first block of `name` in it. */
  function promptIn(source: string, name: string): string | null {
    const editor = editorFor(source);
    const [block] = blocksNamed(editor.state.doc, name);
    if (!block) throw new Error(`no ${name} in the document`);
    const answer = promptAt(editor, block.pos + 1);
    editor.destroy();
    return answer;
  }

  it("names the level of an empty heading", () => {
    expect(promptIn("## \n", "heading")).toBe("Heading 2");
    expect(promptIn("##### \n", "heading")).toBe("Heading 5");
  });

  it("reaches an empty paragraph that is not the document's own child", () => {
    // The gap includeChildren was hiding. The caret is in a paragraph two levels down, and before
    // this the plugin never looked past the callout.
    expect(promptIn("> [!NOTE]\n> \n", "paragraph")).toBe("Start writing…");
  });

  // The attribute carries the general answer and prose.css overrides the words to "List item" off
  // the `li` around it, because the callback is handed a node with no parent and the ancestry is
  // exactly what decides. What is asserted here is that the decoration arrives at all; what it ends
  // up saying is a stylesheet's, and tests/blocks.spec.ts reads it off the pseudo element.
  it("reaches the paragraph inside an empty list item", () => {
    expect(promptIn("- \n", "paragraph")).toBe("Start writing…");
  });

  it("gives an empty diagram the first line of a diagram", () => {
    expect(promptIn(`${FENCE}mermaid\n${FENCE}\n`, "codeBlock")).toBe("graph TD");
  });

  it("gives an empty fence the same words as a paragraph", () => {
    expect(promptIn(`${FENCE}ts\n${FENCE}\n`, "codeBlock")).toBe("Start writing…");
  });

  it("says nothing in a block whose bytes this editor cannot model", () => {
    const editor = editorFor(SOURCE);
    const empty = editor.state.schema.nodes.raw.create({ source: "" });
    editor.view.dispatch(editor.state.tr.insert(0, empty));
    expect(promptAt(editor, 1)).toBe("");
    editor.destroy();
  });

  it("puts no class on the block, since no stylesheet reads one", () => {
    const editor = editorFor("# Chrome\n");
    editor.view.dispatch(editor.state.tr.insert(0, editor.state.schema.nodes.paragraph.create()));
    promptAt(editor, 1);

    const decorated = decorationsOf(editor, "tiptap__placeholder").map(
      (decoration) =>
        (decoration as unknown as { type: { attrs: Record<string, string> } }).type.attrs.class,
    );
    for (const value of decorated) expect(value).toBe("");
    editor.destroy();
  });
});
