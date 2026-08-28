// extensions.ts claims the editor's schema is the contract's schema, node for node. That claim is
// the reason a document the bridge parsed can be edited at all, and it is exactly the kind of
// thing that rots quietly when either side changes, so it is asserted here rather than believed.

import { describe, expect, it } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createEditorExtensions } from "./extensions";
import { schema as contract } from "../model/schema";
import { parseMarkdown, serializeMarkdown } from "../markdown";
import { corpus } from "../markdown/corpus/load";

const extensions = () =>
  createEditorExtensions({ documentPath: () => "/notes/a.md", onError: () => {} });

const built = getSchema(extensions());

function makeEditor(content: object = { type: "doc", content: [{ type: "paragraph" }] }): Editor {
  return new Editor({
    element: null,
    injectCSS: false,
    extensions: extensions(),
    content,
  });
}

function count(doc: ProseMirrorNode, name: string): number {
  let total = 0;
  doc.descendants((node) => {
    if (node.type.name === name) total += 1;
  });
  return total;
}

describe("the generated schema", () => {
  it("has the contract's nodes and marks, in the contract's order", () => {
    expect(Object.keys(built.nodes)).toEqual(Object.keys(contract.nodes));
    expect(Object.keys(built.marks)).toEqual(Object.keys(contract.marks));
    expect(built.topNodeType.name).toBe("doc");
  });

  it("carries every node spec field the contract sets", () => {
    for (const name of Object.keys(contract.nodes)) {
      const want = contract.nodes[name];
      const got = built.nodes[name];
      expect([name, got.spec.content]).toEqual([name, want.spec.content]);
      expect([name, got.spec.group]).toEqual([name, want.spec.group]);
      expect([name, got.spec.marks]).toEqual([name, want.spec.marks]);
      expect([name, got.isInline]).toEqual([name, want.isInline]);
      expect([name, got.isAtom]).toEqual([name, want.isAtom]);
      expect([name, got.spec.code]).toEqual([name, want.spec.code]);
      expect([name, got.spec.defining]).toEqual([name, want.spec.defining]);
      expect([name, got.spec.isolating]).toEqual([name, want.spec.isolating]);
      expect([name, got.spec.whitespace]).toEqual([name, want.spec.whitespace]);
      expect([name, got.spec.draggable]).toEqual([name, want.spec.draggable]);
      expect([name, got.spec.selectable]).toEqual([name, want.spec.selectable]);
      expect([name, got.spec.linebreakReplacement]).toEqual([
        name,
        want.spec.linebreakReplacement,
      ]);
      expect([name, got.spec.tableRole]).toEqual([name, want.spec.tableRole]);
      expect([name, Object.keys(got.spec.attrs ?? {})]).toEqual([
        name,
        Object.keys(want.spec.attrs ?? {}),
      ]);
      for (const attr of Object.keys(want.spec.attrs ?? {})) {
        expect([name, attr, got.spec.attrs?.[attr].default]).toEqual([
          name,
          attr,
          want.spec.attrs?.[attr].default,
        ]);
      }
    }
  });

  it("carries every mark spec field the contract sets", () => {
    for (const name of Object.keys(contract.marks)) {
      const want = contract.marks[name];
      const got = built.marks[name];
      expect([name, got.spec.inclusive]).toEqual([name, want.spec.inclusive]);
      expect([name, got.spec.excludes]).toEqual([name, want.spec.excludes]);
      expect([name, got.spec.group]).toEqual([name, want.spec.group]);
      expect([name, got.spec.spanning]).toEqual([name, want.spec.spanning]);
      expect([name, got.spec.code]).toEqual([name, want.spec.code]);
      expect([name, Object.keys(got.spec.attrs ?? {})]).toEqual([
        name,
        Object.keys(want.spec.attrs ?? {}),
      ]);
    }
  });

  // A newline inside a paragraph is the author's own line wrap, and the two libraries under this
  // editor both have to be told so. prosemirror-view reads this field to decide how to parse the
  // editor's own DOM back after a keystroke, and prosemirror-transform reads it before it joins two
  // textblocks; with it left at the default both of them take a newline for a line break and put a
  // `hardBreak` in its place, which is a backslash per wrap point written into a file whose author
  // changed one character. There is no DOM in this suite, so the keystroke half is proved in a
  // browser and the join half is proved below; what is here is the field itself, which is the thing
  // both halves turn on and the thing a tidy up would take back out.
  it("declares a paragraph preformatted, which is what keeps a hand wrap a hand wrap", () => {
    expect(built.nodes.paragraph.whitespace).toBe("pre");
    expect(built.nodes.paragraph.spec.whitespace).toBe("pre");

    // And says the opposite in its parse rule, because a rule's own answer outranks the node's and
    // the newlines in a `<p>` off somebody else's page are that html source's indentation. Without
    // this, pasting `<p>alpha\n   beta</p>` put the newline and the three spaces in the document.
    const rules = built.nodes.paragraph.spec.parseDOM ?? [];
    expect(rules.map((rule) => [rule.tag, rule.preserveWhitespace])).toEqual([["p", false]]);
  });

  it("holds a parsed document unchanged, callouts, tasks, tables and raw blocks included", () => {
    const source = [
      "# Title",
      "",
      "Some **bold** and `code` and ~~gone~~ and [a link](./other.md 'why').",
      "",
      "- [ ] a task",
      "- [x] a done task",
      "",
      "> [!WARNING]",
      "> careful",
      "",
      "```ts twoslash",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| - | -: |",
      "| 1 | 2 |",
      "",
      "<figure><img src='x.png'></figure>",
      "",
      "<details><summary>More</summary>",
      "",
      "hidden",
      "",
      "</details>",
      "",
    ].join("\n");

    const parsed = parseMarkdown(source, "/notes/a.md");
    const rebound = built.nodeFromJSON(parsed.doc.toJSON());
    rebound.check();
    expect(rebound.toJSON()).toEqual(parsed.doc.toJSON());

    // What the editor hands back to be saved is a node of its own schema, never the bridge's, so
    // the serializer has to read node names rather than node types. This is that, asserted.
    expect(serializeMarkdown(parsed, rebound)).toBe(serializeMarkdown(parsed, parsed.doc));
  });

  // The gate that was missing. Every other sweep reads a document the bridge built, and a document
  // the bridge built is not necessarily one the editor will accept: `check()` is what src/editor/
  // Editor.tsx asks before it installs the state, and a document that fails it is not partly
  // refused, it is replaced by an empty one and the whole file goes blank on screen. Nothing here
  // called it on a parsed document, so a paragraph holding "**`x`**" opened as nothing at all.
  it("holds every corpus file, checked the way the editor checks it", () => {
    const found: string[] = [];
    for (const file of corpus()) {
      const parsed = parseMarkdown(file.source, `/${file.name}`);
      try {
        built.nodeFromJSON(parsed.doc.toJSON()).check();
      } catch (error) {
        found.push(`${file.name}: ${String(error)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("holds a code span carrying every mark that can be wrapped around one", () => {
    for (const source of ["**`x`**\n", "_`x`_\n", "~~`x`~~\n", "[`x`](./y.md)\n"]) {
      const parsed = parseMarkdown(source, "/notes/a.md");
      const rebound = built.nodeFromJSON(parsed.doc.toJSON());
      expect(() => rebound.check(), source).not.toThrow();
      expect(serializeMarkdown(parsed, rebound), source).toBe(source);
    }

    // All of them on one span. The spelling moves, because marks are a set and MARK_ORDER decides
    // the nesting once for every document, so what is asserted is that it settles there and stays.
    const source = "**~~[`x`](./y.md)~~**\n";
    const parsed = parseMarkdown(source, "/notes/a.md");
    expect(() => built.nodeFromJSON(parsed.doc.toJSON()).check()).not.toThrow();
    const once = serializeMarkdown(parsed, parsed.doc);
    expect(once).toBe("[~~**`x`**~~](./y.md)\n");
    const again = parseMarkdown(once, "/notes/a.md");
    expect(serializeMarkdown(again, again.doc)).toBe(once);
  });
});

describe("the editor built from them", () => {
  it("constructs, with the nodes only this schema has", () => {
    const editor = makeEditor();
    expect(editor.schema.nodes.callout).toBeTruthy();
    expect(editor.schema.nodes.raw).toBeTruthy();
    expect(editor.schema.marks.strong).toBeTruthy();
    editor.destroy();
  });

  it("answers every command the toolbar handle is built from", () => {
    const editor = makeEditor();
    editor.commands.insertContent({ type: "text", text: "hello" });
    editor.commands.selectAll();

    expect(editor.commands.toggleMark("strong")).toBe(true);
    expect(editor.isActive("strong")).toBe(true);
    expect(editor.commands.setNode("heading", { level: 3 })).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.level).toBe(3);
    expect(editor.commands.setNode("paragraph")).toBe(true);
    expect(editor.commands.toggleList("taskList", "taskItem")).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
    expect(editor.commands.toggleList("taskList", "taskItem")).toBe(true);
    expect(editor.commands.toggleWrap("blockquote")).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote");
    expect(editor.commands.clearNodes()).toBe(true);
    expect(editor.commands.insertContent({ type: "horizontalRule" })).toBe(true);
    expect(
      editor.commands.insertContent({
        type: "table",
        content: [
          { type: "tableRow", content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
          { type: "tableRow", content: [{ type: "tableCell" }, { type: "tableCell" }] },
        ],
      }),
    ).toBe(true);
    editor.destroy();
  });

  it("splits, sinks and lifts the list items Enter and Tab name", () => {
    const editor = makeEditor();
    editor.commands.insertContent({ type: "text", text: "one" });

    expect(editor.commands.toggleList("bulletList", "listItem")).toBe(true);
    expect(editor.commands.splitListItem("listItem")).toBe(true);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.commands.sinkListItem("listItem")).toBe(true);
    expect(editor.commands.liftListItem("listItem")).toBe(true);
    editor.destroy();
  });

  // The join half of the paragraph's `whitespace` field, which is prosemirror-transform's own
  // reading of it and is reached by a Backspace at the start of a paragraph: the most ordinary edit
  // there is. Without the field, joining these two rewrote all four of their line wraps as hard
  // breaks, so one Backspace put a backslash at the end of four lines the user never touched.
  it("joins two hand wrapped paragraphs without rewriting their wraps as breaks", () => {
    const source = "one\ntwo\n\nthree\nfour\n";
    const parsed = parseMarkdown(source, "/notes/a.md");
    const editor = makeEditor(parsed.doc.toJSON());

    // The first position inside the second paragraph, which is where Backspace joins from.
    const second = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection(second);
    expect(editor.commands.joinBackward()).toBe(true);

    expect(count(editor.state.doc, "hardBreak")).toBe(0);
    expect(serializeMarkdown(parsed, editor.state.doc)).toBe("one\ntwothree\nfour\n");
    editor.destroy();
  });

  it("does not carry a ticked box into the item Enter makes after it", () => {
    const editor = makeEditor();
    editor.commands.insertContent({ type: "text", text: "task" });

    expect(editor.commands.toggleList("taskList", "taskItem")).toBe(true);
    editor.commands.updateAttributes("taskItem", { checked: true });
    expect(editor.commands.splitListItem("taskItem")).toBe(true);
    expect(editor.state.doc.firstChild?.lastChild?.attrs.checked).toBe(false);
    editor.destroy();
  });
});
