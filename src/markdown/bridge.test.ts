// What the bridge models, what it refuses to model, and what it writes for each. The two lists
// below are the inventory: adding a handler means moving a case from one to the other, and the
// milestone that gives tables and footnotes real nodes should have to edit this file to do it.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { parseMarkdown, parsePlainText, serializeMarkdown, serializePlainText } from "./index";
import { HOUSE_STYLE } from "./handlers";

const n = schema.nodes;

function parse(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/x.md").doc;
}

function shape(source: string): string[] {
  const out: string[] = [];
  parse(source).forEach((child) => out.push(child.type.name));
  return out;
}

function first(source: string): ProseMirrorNode {
  const child = parse(source).firstChild;
  if (!child) throw new Error("no content");
  return child;
}

function write(doc: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc, source: "", path: "/x.md" }, doc);
}

function roundTrip(source: string): string {
  const document = parseMarkdown(source, "/x.md");
  return serializeMarkdown(document, document.doc);
}

describe("the modelled inventory", () => {
  it("maps headings by level", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const heading = first(`${"#".repeat(level)} Title\n`);
      expect(heading.type.name).toBe("heading");
      expect(heading.attrs.level).toBe(level);
    }
  });

  it("maps the inline marks", () => {
    const paragraph = first("_em_ *also em* **strong** ~~gone~~ `code` [text](./a.md \"T\").\n");
    const marks = new Set<string>();
    paragraph.forEach((child) => child.marks.forEach((mark) => marks.add(mark.type.name)));
    expect([...marks].sort()).toEqual(["code", "em", "link", "strikethrough", "strong"]);

    const link = paragraph.child(paragraph.childCount - 2);
    expect(link.marks[0].attrs).toEqual({ href: "./a.md", title: "T" });
  });

  it("maps images, hard breaks and inline math", () => {
    const paragraph = first("![alt](./a.png \"T\") and $$x^2$$ then a\\\nbreak\n");
    const kinds = new Set<string>();
    paragraph.forEach((child) => kinds.add(child.type.name));
    expect(kinds.has("image")).toBe(true);
    expect(kinds.has("mathInline")).toBe(true);
    expect(kinds.has("hardBreak")).toBe(true);
    expect(paragraph.child(0).attrs).toEqual({ src: "./a.png", alt: "alt", title: "T" });
  });

  it("keeps a soft wrap where the author put it", () => {
    expect(first("one\ntwo\nthree\n").textContent).toBe("one\ntwo\nthree");
    expect(roundTrip("one\ntwo\nthree\n")).toBe("one\ntwo\nthree\n");
  });

  it("maps lists, tightness, start and task state", () => {
    expect(shape("- a\n- b\n")).toEqual(["bulletList"]);
    expect(first("- a\n- b\n").attrs.tight).toBe(true);
    expect(first("- a\n\n- b\n").attrs.tight).toBe(false);

    const ordered = first("5. five\n6. six\n");
    expect(ordered.type.name).toBe("orderedList");
    expect(ordered.attrs.start).toBe(5);

    const tasks = first("- [ ] no\n- [x] yes\n");
    expect(tasks.type.name).toBe("taskList");
    expect(tasks.child(0).attrs.checked).toBe(false);
    expect(tasks.child(1).attrs.checked).toBe(true);

    const mixed = first("- [ ] task\n- plain\n");
    expect(mixed.type.name).toBe("bulletList");
    expect([mixed.child(0).type.name, mixed.child(1).type.name]).toEqual(["taskItem", "listItem"]);

    const orderedTasks = first("1. [ ] first\n2. [x] second\n");
    expect(orderedTasks.type.name).toBe("orderedList");
    expect(orderedTasks.child(0).type.name).toBe("taskItem");
  });

  it("maps code blocks with their language and meta", () => {
    const code = first("```ts twoslash\nconst a = 1;\n```\n");
    expect(code.type.name).toBe("codeBlock");
    expect(code.attrs).toEqual({ language: "ts", meta: "twoslash" });
    expect(code.textContent).toBe("const a = 1;");
  });

  it("maps blockquotes, rules and callouts", () => {
    expect(shape("> quoted\n")).toEqual(["blockquote"]);
    expect(shape("---\n")).toEqual(["horizontalRule"]);

    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      const callout = first(`> [!${kind.toUpperCase()}]\n> Body.\n`);
      expect(callout.type.name).toBe("callout");
      expect(callout.attrs.kind).toBe(kind);
      expect(callout.textContent).toBe("Body.");
    }

    expect(first("> [!NOTE]\n> One.\n>\n> Two.\n").childCount).toBe(2);
    expect(roundTrip("> [!NOTE]\n> Body.\n")).toBe("> [!NOTE]\n> Body.\n");
    expect(roundTrip("> [!NOTE]\n> One.\n>\n> Two.\n")).toBe("> [!NOTE]\n> One.\n>\n> Two.\n");
    expect(roundTrip("> [!WARNING]\n> **Bold** start.\n")).toBe("> [!WARNING]\n> **Bold** start.\n");
    expect(roundTrip("> [!TIP]\n>\n> - a\n> - b\n")).toBe("> [!TIP]\n>\n> - a\n> - b\n");
  });
});

// The four cases M2 moved out of the raw inventory below. They are the milestone: a table and a
// math block are nodes now, at any depth, so the assertion that used to read "this comes back as
// raw" reads "this comes back as itself" instead. The byte for byte round trip is the half that did
// not change, and it is the half that matters, so it is still asserted here.
describe("the inventory M2 moved", () => {
  const nowModelled: Array<[string, string, string]> = [
    ["a GFM table", "table", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ["a math block", "mathBlock", "$$\n\\alpha\n$$"],
    ["a blockquote holding a table", "blockquote", "> | a |\n> | - |\n> | 1 |"],
    ["a list holding a table", "bulletList", "- item\n\n  | a |\n  | - |\n  | 1 |"],
  ];

  for (const [what, kind, source] of nowModelled) {
    it(`models ${what} and still writes it back byte for byte`, () => {
      const block = first(`${source}\n`);
      expect(block.type.name).toBe(kind);
      expect(block.attrs.source).toBeUndefined();
      expect(roundTrip(`${source}\n`)).toBe(`${source}\n`);
    });
  }
});

describe("the raw inventory", () => {
  const unmodellable: Array<[string, string]> = [
    ["a footnote definition", "[^1]: The note."],
    ["a link definition", "[spec]: https://example.com \"T\""],
    ["an html block", "<div class=\"x\">\n  <p>hi</p>\n</div>"],
    ["an html comment", "<!-- a comment -->"],
    ["a details block", "<details>\n<summary>S</summary>\n</details>"],
    ["jsx", "<Chart data={points} />"],
    ["a paragraph holding inline html", "Text with <span>markup</span> in it."],
    ["a paragraph holding an empty link", "An empty link [](./nothing.md) here."],
    ["a list item that opens with a fence", "- ```js\n  const a = 1;\n  ```"],
    ["an alert that is not one of the five", "> [!BOGUS]\n> Body."],
    ["a quote that only looks like an alert", "> [!NOTE] and then more text."],
  ];

  for (const [what, source] of unmodellable) {
    it(`preserves ${what} verbatim`, () => {
      const block = first(`${source}\n`);
      expect(block.type.name).toBe("raw");
      expect(block.textContent).toBe(source);
      expect(block.attrs.source).toBe(source);
      expect(roundTrip(`${source}\n`)).toBe(`${source}\n`);
    });
  }

  // A reference only exists as one when its definition does, so these two need the whole document.
  const referencing: Array<[string, string]> = [
    ["a footnote reference", "Text with a note[^1] in it.\n\n[^1]: The note.\n"],
    ["a link reference", "Text with [a reference][spec] in it.\n\n[spec]: https://example.com\n"],
  ];

  for (const [what, source] of referencing) {
    it(`preserves a paragraph holding ${what} verbatim`, () => {
      expect(shape(source)).toEqual(["raw"]);
      expect(roundTrip(source)).toBe(source);
    });
  }

  it("joins a run of neighbouring raw blocks into one", () => {
    const source = "[^1]: one\n[^2]: two\n";
    expect(shape(source)).toEqual(["raw"]);
    expect(first(source).textContent).toBe("[^1]: one\n[^2]: two");
    expect(roundTrip(source)).toBe(source);
  });

  it("writes an edited raw block as whatever the user typed", () => {
    const doc = n.doc.create(null, [n.raw.create({ source: "<div>old</div>" }, schema.text("<div>new</div>"))]);
    expect(write(doc)).toBe("<div>new</div>\n");
  });

  it("writes nothing for a raw block the user emptied", () => {
    const doc = n.doc.create(null, [n.paragraph.create(null, schema.text("a")), n.raw.create({ source: "<div>old</div>" })]);
    expect(write(doc)).toBe("a\n");
  });
});

describe("blocks only the editor can make", () => {
  it("writes a table", () => {
    const cell = (text: string, align: string | null) => n.tableCell.create({ align }, schema.text(text));
    const doc = n.doc.create(null, [
      n.table.create(null, [
        n.tableRow.create(null, [n.tableHeader.create({ align: null }, schema.text("A")), n.tableHeader.create({ align: "center" }, schema.text("B"))]),
        n.tableRow.create(null, [cell("1", null), cell("2", "center")]),
      ]),
    ]);
    expect(write(doc)).toBe("| A | B |\n| - | :-: |\n| 1 | 2 |\n");
  });

  it("writes a toggle as a details block", () => {
    const doc = n.doc.create(null, [n.toggle.create({ summary: "More", open: true }, n.paragraph.create(null, schema.text("Body.")))]);
    expect(write(doc)).toBe("<details open>\n<summary>More</summary>\n\nBody.\n\n</details>\n");
  });

  it("writes a math block", () => {
    const doc = n.doc.create(null, [n.mathBlock.create({ latex: "\\alpha" })]);
    expect(write(doc)).toBe("$$\n\\alpha\n$$\n");
  });
});

describe("the house style", () => {
  it("is declared in exactly one place", () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const declaring = Object.entries(sources).filter(([name, text]) => !name.endsWith(".test.ts") && text.includes("bullet:"));
    expect(declaring.map(([name]) => name)).toEqual(["./handlers.ts"]);
  });

  it("is the one the serializer writes", () => {
    expect(HOUSE_STYLE.bullet).toBe("-");
    expect(HOUSE_STYLE.emphasis).toBe("_");
    expect(HOUSE_STYLE.strong).toBe("*");
    expect(HOUSE_STYLE.rule).toBe("-");
    expect(HOUSE_STYLE.fences).toBe(true);
    expect(HOUSE_STYLE.listItemIndent).toBe("one");

    expect(roundTrip("* star\n")).toBe("- star\n");
    expect(roundTrip("*emphasis*\n")).toBe("_emphasis_\n");
    expect(roundTrip("__strong__\n")).toBe("**strong**\n");
    expect(roundTrip("***\n")).toBe("---\n");
  });

  it("nests overlapping marks in one fixed order", () => {
    expect(roundTrip("**_both_**\n")).toBe("**_both_**\n");
    expect(roundTrip("_**both**_\n")).toBe("**_both_**\n");
  });
});

describe("plain text", () => {
  const cases = ["", "\n", "one line", "one line\n", "a\nb\nc", "a\nb\nc\n", "trailing spaces   \n", "\n\n\n", "# not a heading\n- not a list\n", "tabs\tand  spaces\n", "unicode 🎉 é\n"];

  for (const source of cases) {
    it(`is byte identical: ${JSON.stringify(source)}`, () => {
      const document = parsePlainText(source, "/x.txt");
      expect(document.frontmatter).toBe(null);
      expect(serializePlainText(document, document.doc)).toBe(source);
    });
  }

  it("is never read as markdown", () => {
    const document = parsePlainText("# heading\n", "/x.txt");
    expect(document.doc.firstChild?.type.name).toBe("paragraph");
    expect(document.doc.firstChild?.textContent).toBe("# heading");
  });
});
