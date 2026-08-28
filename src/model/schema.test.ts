import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { CALLOUT_KINDS, isRawUnchanged, rawNode } from "./doc";
import { HEADING_LEVELS, schema } from "./schema";
import type { MarkName, NodeName } from "./schema";

// The lists are typed against the name unions, so a rename that misses one end fails to compile
// before it fails to run.
const EXPECTED_NODES: NodeName[] = [
  "doc",
  "paragraph",
  "heading",
  "text",
  "hardBreak",
  "image",
  "mathInline",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "callout",
  "toggle",
  "mathBlock",
  "raw",
];

const EXPECTED_MARKS: MarkName[] = ["link", "strong", "em", "strikethrough", "code"];

const n = schema.nodes;
const m = schema.marks;

function kitchenSink(): ProseMirrorNode {
  return n.doc.createChecked(null, [
    n.heading.createChecked({ level: 2 }, schema.text("Title")),
    n.paragraph.createChecked(null, [
      schema.text("bold", [m.strong.create()]),
      schema.text(" plain "),
      schema.text("struck", [m.strikethrough.create()]),
      schema.text("span", [m.code.create()]),
      schema.text("link", [m.link.create({ href: "./other.md", title: "Other" })]),
      schema.text("slanted", [m.em.create()]),
      n.hardBreak.createChecked(),
      n.image.createChecked({ src: "assets/shot.png", alt: "A shot", title: null }),
      n.mathInline.createChecked({ latex: "x^2" }),
    ]),
    n.blockquote.createChecked(null, n.paragraph.createChecked(null, schema.text("quoted"))),
    n.bulletList.createChecked({ tight: false }, [
      n.listItem.createChecked(null, n.paragraph.createChecked(null, schema.text("plain item"))),
      n.taskItem.createChecked({ checked: true }, n.paragraph.createChecked(null, schema.text("mixed in"))),
    ]),
    n.orderedList.createChecked(
      { start: 3 },
      n.listItem.createChecked(null, n.paragraph.createChecked(null, schema.text("third"))),
    ),
    n.taskList.createChecked(
      null,
      n.taskItem.createChecked({ checked: false }, n.paragraph.createChecked(null, schema.text("todo"))),
    ),
    n.codeBlock.createChecked({ language: "rust", meta: "ignore" }, schema.text("fn main() {}\n")),
    n.horizontalRule.createChecked(),
    n.table.createChecked(null, [
      n.tableRow.createChecked(null, [
        n.tableHeader.createChecked({ align: "center" }, schema.text("head")),
        n.tableHeader.createChecked({ align: "right" }, schema.text("count")),
      ]),
      n.tableRow.createChecked(null, [
        n.tableCell.createChecked({ align: "center" }, schema.text("body")),
        n.tableCell.createChecked({ align: "right" }, schema.text("2")),
      ]),
    ]),
    n.callout.createChecked({ kind: "warning" }, n.paragraph.createChecked(null, schema.text("careful"))),
    n.toggle.createChecked(
      { summary: "Show more", open: true },
      n.paragraph.createChecked(null, schema.text("hidden")),
    ),
    n.mathBlock.createChecked({ latex: "\\int_0^1 x" }),
    rawNode("<figure>\n  <img src=x>\n</figure>"),
  ]);
}

describe("schema", () => {
  it("is a prosemirror schema whose top node is doc", () => {
    expect(schema).toBeInstanceOf(Schema);
    expect(schema.topNodeType.name).toBe("doc");
    expect(n.doc.spec.content).toBe("block+");
  });

  it("declares exactly the required nodes", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([...EXPECTED_NODES].sort());
  });

  it("declares exactly the required marks", () => {
    expect(Object.keys(schema.marks).sort()).toEqual([...EXPECTED_MARKS].sort());
  });

  it("fills an empty document with a paragraph", () => {
    const doc = n.doc.createAndFill();
    expect(doc?.childCount).toBe(1);
    expect(doc?.firstChild?.type.name).toBe("paragraph");
  });

  it("round trips a document using every node and mark", () => {
    const doc = kitchenSink();
    doc.check();
    const json = doc.toJSON();
    const back = schema.nodeFromJSON(json);
    expect(back.toJSON()).toEqual(json);
    expect(back.eq(doc)).toBe(true);
  });
});

describe("heading", () => {
  it("accepts all six levels", () => {
    for (const level of HEADING_LEVELS) {
      const heading = n.heading.createChecked({ level }, schema.text(`level ${level}`));
      expect(heading.attrs.level).toBe(level);
      expect(schema.nodeFromJSON(heading.toJSON()).attrs.level).toBe(level);
    }
  });

  it("rejects a level that is not a number", () => {
    expect(() => schema.nodeFromJSON({ type: "heading", attrs: { level: "2" } })).toThrow();
  });
});

describe("raw", () => {
  const source = "| a | b |\n|:-:|--:|\n<!-- kept -->\r\n\t\\| escaped |\n$$ not math $$\n";

  it("is an editable code block that disallows marks", () => {
    expect(n.raw.isBlock).toBe(true);
    expect(n.raw.isAtom).toBe(false);
    expect(n.raw.spec.code).toBe(true);
    expect(n.raw.spec.marks).toBe("");
    expect(n.raw.allowsMarkType(m.strong)).toBe(false);
    expect(n.raw.allowsMarkType(m.code)).toBe(false);
  });

  it("preserves an arbitrary source string through toJSON and nodeFromJSON", () => {
    const node = rawNode(source);
    expect(node.attrs.source).toBe(source);
    expect(node.textContent).toBe(source);

    const back = schema.nodeFromJSON(node.toJSON());
    expect(back.attrs.source).toBe(source);
    expect(back.textContent).toBe(source);
    expect(back.eq(node)).toBe(true);
  });

  it("holds an empty source without an empty text node", () => {
    const node = rawNode("");
    expect(node.childCount).toBe(0);
    expect(node.attrs.source).toBe("");
    expect(isRawUnchanged(node)).toBe(true);
  });

  it("reports an edited block as changed while the original source stays put", () => {
    const edited = n.raw.createChecked({ source }, schema.text("typed over"));
    expect(isRawUnchanged(edited)).toBe(false);
    expect(edited.attrs.source).toBe(source);
  });
});

describe("code block", () => {
  it("holds plain text only", () => {
    expect(n.codeBlock.spec.code).toBe(true);
    expect(n.codeBlock.allowsMarkType(m.strong)).toBe(false);
    expect(n.codeBlock.create().attrs).toEqual({ language: null, meta: null });
  });
});

describe("lists", () => {
  it("lets a plain list carry task items, because GFM lets one list mix them", () => {
    expect(n.bulletList.contentMatch.matchType(n.taskItem)).toBeTruthy();
    expect(n.bulletList.contentMatch.matchType(n.listItem)).toBeTruthy();
    expect(n.orderedList.contentMatch.matchType(n.taskItem)).toBeTruthy();
    expect(n.taskList.contentMatch.matchType(n.listItem)).toBeNull();
  });

  it("defaults to a tight list starting at one", () => {
    expect(n.bulletList.create().attrs).toEqual({ tight: true });
    expect(n.orderedList.create().attrs).toEqual({ start: 1, tight: true });
    expect(n.taskItem.create().attrs).toEqual({ checked: false });
  });
});

describe("tables", () => {
  it("carries the roles prosemirror-tables reads", () => {
    expect(n.table.spec.tableRole).toBe("table");
    expect(n.tableRow.spec.tableRole).toBe("row");
    expect(n.tableHeader.spec.tableRole).toBe("header_cell");
    expect(n.tableCell.spec.tableRole).toBe("cell");
  });

  it("gives cells the span, width and alignment attributes", () => {
    expect(n.tableCell.create().attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null, align: null });
    expect(n.tableHeader.create().attrs).toEqual({ colspan: 1, rowspan: 1, colwidth: null, align: null });
    const sized = n.tableCell.createChecked({ colwidth: [120, 80] });
    expect(schema.nodeFromJSON(sized.toJSON()).attrs.colwidth).toEqual([120, 80]);
  });

  it("keeps cells to inline content, which is all GFM can write", () => {
    expect(n.tableCell.contentMatch.matchType(n.paragraph)).toBeNull();
    expect(n.tableCell.contentMatch.matchType(n.text)).toBeTruthy();
  });
});

describe("callout and toggle", () => {
  it("round trips every alert kind", () => {
    for (const kind of CALLOUT_KINDS) {
      const node = n.callout.createChecked({ kind }, n.paragraph.createChecked(null, schema.text(kind)));
      expect(schema.nodeFromJSON(node.toJSON()).attrs.kind).toBe(kind);
    }
    expect(n.callout.create().attrs).toEqual({ kind: "note" });
  });

  it("keeps the toggle summary and open state as attributes", () => {
    expect(n.toggle.create().attrs).toEqual({ summary: "", open: false });
    const node = n.toggle.createChecked(
      { summary: "Details", open: true },
      n.paragraph.createChecked(null, schema.text("body")),
    );
    expect(schema.nodeFromJSON(node.toJSON()).attrs).toEqual({ summary: "Details", open: true });
  });
});

describe("inline", () => {
  it("keeps image and link attributes", () => {
    expect(n.image.create().attrs).toEqual({ src: "", alt: null, title: null });
    // `run` is the third one, and it is 0 here because it is 0 on every link that does not sit
    // next to another link to the same place. It is what makes two of those two marks instead of
    // one, and src/markdown/parse.ts is where it gets a value other than this.
    expect(m.link.create().attrs).toEqual({ href: null, title: null, run: 0 });
    const link = m.link.create({ href: "./a.md", title: "A" });
    expect(link.toJSON()).toEqual({ type: "link", attrs: { href: "./a.md", title: "A", run: 0 } });
  });

  it("lets a code span sit inside a link and inside emphasis", () => {
    const code = m.code.create();
    expect(code.isInSet(m.link.create({ href: "./a.md" }).addToSet([code]))).toBeTruthy();
    for (const outer of [m.strong, m.em, m.strikethrough]) {
      const set = outer.create().addToSet([code]);
      expect([outer.name, set.map((mark) => mark.type.name)]).toEqual([outer.name, [outer.name, "code"]]);
    }
  });

  it("treats math and images as inline atoms", () => {
    expect(n.mathInline.isInline).toBe(true);
    expect(n.mathInline.isAtom).toBe(true);
    expect(n.image.isInline).toBe(true);
    expect(n.mathBlock.isBlock).toBe(true);
    expect(schema.nodeFromJSON(n.mathInline.create({ latex: "a_b" }).toJSON()).attrs.latex).toBe("a_b");
  });
});
