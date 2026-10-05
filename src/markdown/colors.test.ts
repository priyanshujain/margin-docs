// Colour, in and out.
//
// Markdown has no colour, so the two marks are the only thing in this bridge whose spelling this
// app invented rather than found in somebody's file. That makes the round trip the whole test: the
// parser reads exactly what the serializer writes and nothing that merely looks like it, and every
// shape it refuses has to come back out of the raw block byte for byte, which is the behaviour a
// file full of `<span>`s had before colour existed and has to keep having.
//
// The refusals are the interesting half and they are all the same argument. A spelling this app
// does not write is a spelling it cannot promise to write back, so reading it would mean handing
// the user a file with their own bytes rearranged on a save they made in another paragraph.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { HIGHLIGHT_COLORS, TEXT_COLORS, isDocumentColor } from "../model/colors";
import { schema } from "../model/schema";
import { corpusFile } from "./corpus/load";
import { parseMarkdown, serializeMarkdown } from "./index";

const n = schema.nodes;
const m = schema.marks;

const RED = "#c4453a";
const AMBER = "#977927";

function doc(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/colors.md").doc;
}

/** One save. */
function write(source: string): string {
  const document = parseMarkdown(source, "/colors.md");
  return serializeMarkdown(document, document.doc);
}

function writeDoc(node: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/colors.md" }, node);
}

/** The first block of a document, which is what nearly every case here is about. */
function first(source: string): ProseMirrorNode {
  return doc(source).child(0);
}

function colorsOn(node: ProseMirrorNode): string {
  return node.marks
    .filter((mark) => mark.type === m.textColor || mark.type === m.highlight)
    .map((mark) => `${mark.type.name}:${mark.attrs.color}`)
    .sort()
    .join("+");
}

/** Every run of text in a document with the colours on it, so a lost mark is visible. */
function colored(node: ProseMirrorNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  node.descendants((child) => {
    if (!child.isText) return true;
    out.push([child.text ?? "", colorsOn(child)]);
    return false;
  });
  return out;
}

/** Whether anything at all in a document carries one, which an image and a break do too. */
function anyColor(node: ProseMirrorNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (colorsOn(child)) found = true;
    return true;
  });
  return found;
}

const para = (...content: ProseMirrorNode[]) => n.paragraph.createChecked(null, content);
const only = (...blocks: ProseMirrorNode[]) => n.doc.createChecked(null, blocks);
const text = (value: string, ...marks: Array<{ name: string; color: string }>) =>
  schema.text(value, marks.map((mark) => m[mark.name].create({ color: mark.color })));

describe("the spelling", () => {
  it("writes a text colour as a span and a highlight as a mark", () => {
    expect(writeDoc(only(para(schema.text("a "), text("red", { name: "textColor", color: RED }))))).toBe(
      `a <span style="color: ${RED}">red</span>\n`,
    );
    expect(writeDoc(only(para(schema.text("a "), text("lit", { name: "highlight", color: AMBER }))))).toBe(
      `a <mark style="background-color: ${AMBER}">lit</mark>\n`,
    );
  });

  it("puts the highlight outside the text colour, which is the one nesting it writes", () => {
    const both = text("both", { name: "textColor", color: RED }, { name: "highlight", color: AMBER });
    expect(writeDoc(only(para(both)))).toBe(
      `<mark style="background-color: ${AMBER}"><span style="color: ${RED}">both</span></mark>\n`,
    );
  });

  it("reads back every colour in both palettes", () => {
    for (const color of TEXT_COLORS) {
      const source = `a <span style="color: ${color.hex}">word</span>\n`;
      expect(colored(first(source))).toEqual([["a ", ""], ["word", `textColor:${color.hex}`]]);
      expect(write(source)).toBe(source);
    }
    for (const color of HIGHLIGHT_COLORS) {
      const source = `a <mark style="background-color: ${color.hex}">word</mark>\n`;
      expect(colored(first(source))).toEqual([["a ", ""], ["word", `highlight:${color.hex}`]]);
      expect(write(source)).toBe(source);
    }
  });

  it("takes a colour the palette does not have, because the palette is not the promise", () => {
    // The spelling is what the round trip is made of. A file written by a later version of this app
    // with a ninth swatch in it has to keep that colour rather than lose it to a list in a module.
    const source = 'a <span style="color: #123abc">word</span>\n';
    expect(colored(first(source))).toEqual([["a ", ""], ["word", "textColor:#123abc"]]);
    expect(write(source)).toBe(source);
    expect(TEXT_COLORS.some((color) => color.hex === "#123abc")).toBe(false);
  });

  it("has one shape for a colour, and it is the one both halves of the bridge agree on", () => {
    for (const color of [...TEXT_COLORS, ...HIGHLIGHT_COLORS]) expect(isDocumentColor(color.hex)).toBe(true);
    for (const value of ["red", "#C4453A", "#c4453", "#c4453ab", "c4453a", "rgb(1,2,3)", "", null, 7]) {
      expect(isDocumentColor(value)).toBe(false);
    }
  });
});

describe("what a colour may sit in", () => {
  const cases: Array<[string, string]> = [
    ["a paragraph", `A <span style="color: ${RED}">word</span> here.\n`],
    ["a heading", `# A <span style="color: ${RED}">word</span>\n`],
    ["a list item", `- A <span style="color: ${RED}">word</span>\n`],
    ["a task item", `- [x] A <span style="color: ${RED}">word</span>\n`],
    ["a quote", `> A <span style="color: ${RED}">word</span>\n`],
    ["a callout", `> [!NOTE]\n> A <span style="color: ${RED}">word</span>\n`],
    ["a table cell", `| a | b |\n| - | - |\n| <span style="color: ${RED}">c</span> | d |\n`],
    ["a link label", `[<span style="color: ${RED}">label</span>](./a.md)\n`],
    ["a strong inside it", `<span style="color: ${RED}">**bold**</span>\n`],
    ["an em inside it", `<span style="color: ${RED}">_slanted_</span>\n`],
    ["a strikethrough inside it", `<span style="color: ${RED}">~~struck~~</span>\n`],
    ["a code span inside it", `<span style="color: ${RED}">\`code\`</span>\n`],
    ["an image inside it", `<span style="color: ${RED}">![alt](./a.png)</span>\n`],
    ["a hard break inside it", `<span style="color: ${RED}">one\\\ntwo</span>\n`],
    ["a highlight around it", `<mark style="background-color: ${AMBER}"><span style="color: ${RED}">x</span></mark>\n`],
  ];

  for (const [where, source] of cases) {
    it(`keeps a colour in ${where}, byte for byte`, () => {
      expect(first(source).type.name).not.toBe("raw");
      expect(write(source)).toBe(source);
      expect(write(write(source))).toBe(source);
      expect(anyColor(doc(source))).toBe(true);
    });
  }
});

describe("a colour across a line the author wrapped", () => {
  // The one that cannot be got right by accident. mdast turns a soft line break in front of inline
  // html into a space, on purpose, because a tag at the start of a line reads back as a block. Both
  // tags here go out as `phrasingLiteral` instead, so the wrap the author typed is still the wrap
  // the file has. Without that, a colour whose closing tag lands at the start of a line would come
  // back with the user's line ending replaced by a space, on a paragraph they only pressed a swatch
  // in.
  it("keeps the wrap when the colour spans one", () => {
    const source = `<span style="color: ${RED}">over\ntwo lines</span> here.\n`;
    expect(write(source)).toBe(source);
    expect(first(source).textContent).toBe("over\ntwo lines here.");
  });

  it("keeps the wrap when the colour ends on one", () => {
    const source = `ends <span style="color: ${RED}">here\n</span>and on.\n`;
    expect(write(source)).toBe(source);
    expect(first(source).textContent).toBe("ends here\nand on.");
  });

  it("keeps the wrap when the colour starts after one", () => {
    const source = `starts\n<span style="color: ${RED}">here</span> and on.\n`;
    expect(write(source)).toBe(source);
    expect(first(source).textContent).toBe("starts\nhere and on.");
  });

  it("keeps a highlight around a whole wrapped sentence", () => {
    const source = `<mark style="background-color: ${AMBER}">one\ntwo\nthree</mark>\n`;
    expect(write(source)).toBe(source);
    expect(colored(first(source))).toEqual([["one\ntwo\nthree", `highlight:${AMBER}`]]);
  });
});

describe("what the parser refuses", () => {
  // Every one of these describes a document the editor could hold and is not the spelling this app
  // writes, so the answer is the answer a `<span>` has always got here: the top level block keeps
  // its own bytes and becomes an editable monospace block.
  const refused: Array<[string, string]> = [
    ["an upper case hex", `<span style="color: #C4453A">x</span>\n`],
    ["no space after the colon", `<span style="color:${RED}">x</span>\n`],
    ["two spaces after the colon", `<span style="color:  ${RED}">x</span>\n`],
    ["a three digit hex", `<span style="color: #c43">x</span>\n`],
    ["a named colour", `<span style="color: red">x</span>\n`],
    ["a second property", `<span style="color: ${RED}; font-weight: bold">x</span>\n`],
    ["another attribute", `<span class="a" style="color: ${RED}">x</span>\n`],
    ["a bare span", "<span>x</span>\n"],
    ["a bare mark", "<mark>x</mark>\n"],
    ["a background on a span", `<span style="background-color: ${AMBER}">x</span>\n`],
    ["a colour on a mark", `<mark style="color: ${RED}">x</mark>\n`],
    ["an unclosed opening tag", `An unbalanced <span style="color: ${RED}">tag.\n`],
    ["a closing tag on its own", "A stray closing tag</span> here.\n"],
    ["a colour closed by the other tag", `<span style="color: ${RED}">x</mark>\n`],
    ["a colour inside a strong", `**<span style="color: ${RED}">x</span>**\n`],
    ["a colour inside an em", `_<span style="color: ${RED}">x</span>_\n`],
    ["a colour inside a strikethrough", `~~<span style="color: ${RED}">x</span>~~\n`],
    ["a text colour outside a highlight", `<span style="color: ${RED}"><mark style="background-color: ${AMBER}">x</mark></span>\n`],
    ["a colour nested inside itself", `<span style="color: ${RED}">a<span style="color: ${AMBER}">b</span>c</span>\n`],
    ["a colour crossing a strong boundary", `**a <span style="color: ${RED}">b** c</span>\n`],
    ["a colour around nothing at all", `x<span style="color: ${RED}"></span>y\n`],
  ];

  for (const [what, source] of refused) {
    it(`leaves ${what} as the bytes it was read as`, () => {
      const block = first(source);
      expect(block.type.name).toBe("raw");
      expect(block.textContent).toBe(source.trimEnd());
      expect(write(source)).toBe(source);
      expect(write(write(source))).toBe(source);
    });
  }

  it("keeps a colour around a single space, which is a run with something in it", () => {
    // Next to the empty run above, because the line between them is the one the parser actually
    // draws: a mark needs a leaf to sit on, and a space is a leaf. Nothing here trims it.
    const source = `a<span style="color: ${RED}"> </span>b\n`;
    expect(first(source).type.name).toBe("paragraph");
    expect(write(source)).toBe(source);
    expect(colored(first(source))).toEqual([["a", ""], [" ", `textColor:${RED}`], ["b", ""]]);
  });

  it("takes the whole top level block down with it, list and all", () => {
    const source = `- one\n- **<span style="color: ${RED}">two</span>**\n- three\n`;
    expect(first(source).type.name).toBe("raw");
    expect(write(source)).toBe(source);
  });

  it("does not let a refused block cost the colours in the block beside it", () => {
    const source = `<span>refused</span>\n\nA <span style="color: ${RED}">kept</span> one.\n`;
    const document = doc(source);
    expect(document.child(0).type.name).toBe("raw");
    expect(document.child(1).type.name).toBe("paragraph");
    expect(write(source)).toBe(source);
  });
});

describe("a document built by hand and put through a save", () => {
  // The other direction, and the one the toolbar will produce: a document that was never a file,
  // written and read back, compared as a document rather than as bytes. Byte comparison cannot ask
  // this question, because there is nothing to compare the first save against.
  const cell = (...content: ProseMirrorNode[]) => n.tableCell.createChecked(null, content);
  const header = (...content: ProseMirrorNode[]) => n.tableHeader.createChecked(null, content);
  const row = (...cells: ProseMirrorNode[]) => n.tableRow.createChecked(null, cells);

  const containers: Array<[string, (inline: ProseMirrorNode[]) => ProseMirrorNode]> = [
    ["paragraph", (i) => para(...i)],
    ["heading", (i) => n.heading.createChecked({ level: 3 }, i)],
    ["blockquote", (i) => n.blockquote.createChecked(null, [para(...i)])],
    ["callout", (i) => n.callout.createChecked({ kind: "warning" }, [para(...i)])],
    ["bulletList", (i) => n.bulletList.createChecked({ tight: true }, [n.listItem.createChecked(null, [para(...i)])])],
    ["orderedList", (i) => n.orderedList.createChecked({ tight: true, start: 1 }, [n.listItem.createChecked(null, [para(...i)])])],
    ["taskList", (i) => n.taskList.createChecked({ tight: true }, [n.taskItem.createChecked({ checked: true }, [para(...i)])])],
    ["looseList", (i) => n.bulletList.createChecked({ tight: false }, [n.listItem.createChecked(null, [para(...i)])])],
    ["listInQuote", (i) => n.blockquote.createChecked(null, [n.bulletList.createChecked({ tight: true }, [n.listItem.createChecked(null, [para(...i)])])])],
    ["tableCell", (i) => n.table.createChecked(null, [row(header(schema.text("h")), header(schema.text("k"))), row(cell(...i), cell(schema.text("z")))])],
  ];

  /** A colour, and the mark this run is being nested with, in the order MARK_ORDER writes them. */
  const inner: Array<[string, () => ProseMirrorNode[]]> = [
    ["nothing", () => [text("word", { name: "textColor", color: RED })]],
    ["a highlight outside it", () => [text("word", { name: "textColor", color: RED }, { name: "highlight", color: AMBER })]],
    ["a strong", () => [schema.text("word", [m.strong.create(), m.textColor.create({ color: RED })])]],
    ["an em", () => [schema.text("word", [m.em.create(), m.textColor.create({ color: RED })])]],
    ["a strikethrough", () => [schema.text("word", [m.strikethrough.create(), m.textColor.create({ color: RED })])]],
    ["a code span", () => [schema.text("word", [m.code.create(), m.textColor.create({ color: RED })])]],
    ["a link", () => [schema.text("word", [m.link.create({ href: "./a.md" }), m.textColor.create({ color: RED })])]],
    ["plain text either side", () => [schema.text("a "), text("word", { name: "highlight", color: AMBER }), schema.text(" b")]],
    ["another colour beside it", () => [text("one", { name: "textColor", color: RED }), text("two", { name: "textColor", color: "#4079c0" })]],
    ["a highlight beside a colour", () => [text("one", { name: "textColor", color: RED }), text("two", { name: "highlight", color: AMBER })]],
  ];

  for (const [where, build] of containers) {
    for (const [what, content] of inner) {
      it(`keeps a colour with ${what} in a ${where}`, () => {
        const before = only(build(content()));
        const source = writeDoc(before);
        const after = doc(source);
        expect(colored(after), source).toEqual(colored(before));
        // And the file settles: the second save of what the first one wrote is the same bytes.
        expect(write(source)).toBe(source);
      });
    }
  }
});

describe("a colour mark with nothing to say", () => {
  it("is written as nothing rather than as a tag holding null", () => {
    // Unreachable from the toolbar, which only ever passes a hex out of the palette, and worth
    // pinning anyway: a tag carrying `null` is bytes the reader hands back as text, so the mark
    // would be gone after one save and the file would have gained the characters.
    const bare = schema.text("x", [m.textColor.create()]);
    expect(writeDoc(only(para(bare)))).toBe("x\n");
    const bareHighlight = schema.text("y", [m.highlight.create({ color: "not a colour" })]);
    expect(writeDoc(only(para(bareHighlight)))).toBe("y\n");
  });
});

describe("the corpus fixtures colour added", () => {
  // Named one by one rather than swept, because roundtrip.test.ts already sweeps the whole corpus
  // and what is worth saying here is which files were added for this and what each of them is for.
  const fixtures: Array<[string, string[]]> = [
    ["hand/colors.md", ["heading", "paragraph", "paragraph", "paragraph", "heading", "bulletList", "table", "callout"]],
    ["adversarial/color-torture.md", ["heading", "paragraph", "paragraph", "bulletList", "table", "paragraph", "raw"]],
  ];

  for (const [name, blocks] of fixtures) {
    it(`is written back byte for byte: ${name}`, () => {
      const file = corpusFile(name);
      expect(write(file.source)).toBe(file.source);
      expect(write(write(file.source))).toBe(file.source);
    });

    it(`is modelled where it should be and raw where it should not: ${name}`, () => {
      const out: string[] = [];
      doc(corpusFile(name).source).forEach((child) => out.push(child.type.name));
      expect(out).toEqual(blocks);
    });
  }

  it("keeps every colour in the hand written fixture", () => {
    const marks = new Set<string>();
    doc(corpusFile("hand/colors.md").source).descendants((node) => {
      for (const mark of node.marks) if (mark.type === m.textColor || mark.type === m.highlight) marks.add(String(mark.attrs.color));
      return true;
    });
    expect(marks.size).toBeGreaterThanOrEqual(8);
    for (const color of marks) expect(isDocumentColor(color)).toBe(true);
  });

  it("keeps the refused half of the adversarial fixture in one raw block, byte for byte", () => {
    const file = corpusFile("adversarial/color-torture.md");
    const raw = doc(file.source).lastChild;
    expect(raw?.type.name).toBe("raw");
    expect(file.source).toContain(raw?.textContent ?? "");
    // The shapes it is there to refuse are all inside those bytes rather than quietly dropped.
    for (const fragment of ['**<span style="color: #c4453a">', "#C4453A", 'class="colour"', "<mark>a mark with no colour"]) {
      expect(raw?.textContent).toContain(fragment);
    }
  });
});
