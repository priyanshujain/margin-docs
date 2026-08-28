// The three constructs M2 taught the parser: GFM tables, `<details>` toggles and `$$` math.
//
// The serializer could already write all three and nothing on disk could produce one, so every
// path below was dead code until now and none of it had ever been round tripped. The parse is not
// the deliverable, the round trip is, and the four things asked of every construct are asked of
// each of them here: a file the editor did not edit comes back byte for byte, a file it did edit
// settles on the second save, ten saves add nothing, and editing one paragraph beside all three
// leaves all three alone.
//
// Where a claim can be made about generated input it is made that way rather than pinned to one
// string, because the interesting failure is the shape nobody thought to write down. The example
// tests that remain are the refusals: each one names a reason the bridge will not model something,
// and a reason has to be stated to be checked.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import type { ColumnAlign } from "../model/doc";
import { parseMarkdown, serializeMarkdown } from "./index";

const fixtures = import.meta.glob("./corpus/adversarial/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function fixture(name: string): string {
  const source = fixtures[`./corpus/adversarial/${name}`];
  if (source === undefined) throw new Error(`no adversarial fixture named ${name}`);
  return source;
}

/** One save of a file. */
function write(source: string): string {
  const document = parseMarkdown(source, "/m2.md");
  return serializeMarkdown(document, document.doc);
}

/** One save of a document the editor built, with no file behind it. */
function writeDoc(doc: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc, source: "", path: "/m2.md" }, doc);
}

function parse(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/m2.md").doc;
}

function first(source: string): ProseMirrorNode {
  return parse(source).child(0);
}

function saves(source: string, count: number): string[] {
  const out: string[] = [];
  let current = source;
  for (let generation = 0; generation < count; generation += 1) {
    current = write(current);
    out.push(current);
  }
  return out;
}

const n = schema.nodes;
const text = (value: string) => schema.text(value);
const doc = (...blocks: ProseMirrorNode[]) => n.doc.createChecked(null, blocks);
const para = (value: string) => n.paragraph.createChecked(null, value ? text(value) : null);

function cell(kind: "tableHeader" | "tableCell", value: string, align: ColumnAlign): ProseMirrorNode {
  return n[kind].createChecked({ align }, value ? text(value) : null);
}

function table(rows: string[][], align: ColumnAlign[]): ProseMirrorNode {
  const built = rows.map((row, index) => n.tableRow.createChecked(null, row.map((value, column) => cell(index === 0 ? "tableHeader" : "tableCell", value, align[column] ?? null))));
  return n.table.createChecked(null, built);
}

// ---------------------------------------------------------------------------------------------
// Tables.
// ---------------------------------------------------------------------------------------------

describe("a table on disk", () => {
  it("is a header row and then body rows", () => {
    const built = first("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n");
    expect(built.type.name).toBe("table");
    expect(built.childCount).toBe(3);
    expect(built.child(0).child(0).type.name).toBe("tableHeader");
    expect(built.child(0).child(1).type.name).toBe("tableHeader");
    expect(built.child(1).child(0).type.name).toBe("tableCell");
    expect(built.child(2).child(1).textContent).toBe("4");
  });

  it("carries the alignment of the delimiter row onto every cell in the column", () => {
    const built = first("| a | b | c | d |\n| :- | :-: | -: | - |\n| 1 | 2 | 3 | 4 |\n");
    const columns: Array<ColumnAlign[]> = [];
    built.forEach((row) => {
      const found: ColumnAlign[] = [];
      row.forEach((one) => found.push(one.attrs.align as ColumnAlign));
      columns.push(found);
    });
    expect(columns).toEqual([
      ["left", "center", "right", null],
      ["left", "center", "right", null],
    ]);
  });

  it("reads every spelling of the delimiter row the same way", () => {
    for (const delimiter of ["| :- | :-: | -: |", "| :--- | :---: | ---: |", "|:-|:-:|-:|", "| :------- | :--------------: | -----: |"]) {
      const built = first(`| a | b | c |\n${delimiter}\n| 1 | 2 | 3 |\n`);
      const found: ColumnAlign[] = [];
      built.child(0).forEach((one) => found.push(one.attrs.align as ColumnAlign));
      expect(found, delimiter).toEqual(["left", "center", "right"]);
    }
  });

  it("pads a row shorter than the header, which is what GFM already renders", () => {
    const built = first("| a | b | c |\n| - | - | - |\n| 1 |\n");
    expect(built.child(1).childCount).toBe(3);
    expect(built.child(1).child(2).textContent).toBe("");
    expect(write("| a | b | c |\n| - | - | - |\n| 1 |\n")).toBe("| a | b | c |\n| - | - | - |\n| 1 | | |\n");
  });

  it("holds a table with a header and no body at all", () => {
    const source = "| only | header |\n| - | - |\n";
    expect(first(source).type.name).toBe("table");
    expect(write(source)).toBe(source);
  });

  it("holds empty cells, including an empty header", () => {
    const built = first("|  |  |\n| - | - |\n| 1 | 2 |\n");
    expect(built.type.name).toBe("table");
    expect(built.child(0).child(0).textContent).toBe("");
  });
});

describe("a table the bridge will not model", () => {
  const refused: Array<[string, string]> = [
    ["a row with more cells than the header, whose extra cells GFM does not render", "| a | b |\n| - | - |\n| 1 | 2 | 3 |"],
    ["a cell holding inline html", "| a |\n| - |\n| <b>x</b> |"],
    ["a cell holding a link with no text", "| a |\n| - |\n| [](./nothing.md) |"],
    ["a cell holding a footnote reference", "| a |\n| - |\n| note[^n] |\n\n[^n]: The note."],
    ["a cell holding a link inside a link", "| a |\n| - |\n| [see <https://x.example> more](./y.md) |"],
    ["a carriage return, which the parser reads as a row ending and the writer would not put back", "| a |\n| - |\n| x\ry |"],
  ];

  for (const [why, source] of refused) {
    it(`stays raw source: ${why}`, () => {
      const block = first(`${source}\n`);
      expect(block.type.name).toBe("raw");
      expect(`${source}\n`).toContain(block.textContent);
      expect(write(`${source}\n`)).toBe(`${source}\n`);
    });
  }
});

/**
 * Every table the editor can build, written out and read back as the same table.
 *
 * The cell alphabet is the characters a cell cannot hold plainly: the pipe that ends it, the
 * backslash that escapes the pipe, the backtick and the asterisk that mean something else on the
 * way back in, and the empty cell that has nothing to hold at all. Alignment is fixed per column
 * because that is the only shape the delimiter row can carry, and both halves of the bridge agree
 * on it: a table whose columns disagreed with themselves is one the editor cannot make.
 */
describe("every table the editor can build", () => {
  const CELLS = ["", "a", "a|b", "a \\ b", "x*y", "`tick", "one two", "-", "#"];
  const ALIGNS: ColumnAlign[] = [null, "left", "center", "right"];

  it("comes back as the same table, and writes the same bytes every time after", () => {
    const wrong: string[] = [];
    for (let columns = 1; columns <= 3; columns += 1) {
      for (let rows = 1; rows <= 3; rows += 1) {
        for (let shift = 0; shift < CELLS.length; shift += 1) {
          const align = Array.from({ length: columns }, (_, column) => ALIGNS[(shift + column) % ALIGNS.length]);
          const grid = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => CELLS[(shift + row * columns + column) % CELLS.length]));
          const before = doc(table(grid, align));
          const once = writeDoc(before);
          const name = JSON.stringify(grid);

          if (!parse(once).eq(before)) wrong.push(`${name} came back as a different table: ${JSON.stringify(once)}`);
          if (write(once) !== once) wrong.push(`${name} is not stable: ${JSON.stringify(once)} then ${JSON.stringify(write(once))}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps every character of every cell", () => {
    for (const value of CELLS) {
      const before = doc(table([["h"], [value]], [null]));
      const read = parse(writeDoc(before));
      expect(read.child(0).child(1).child(0).textContent, JSON.stringify(value)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Toggles.
// ---------------------------------------------------------------------------------------------

const TOGGLE = "<details>\n<summary>S</summary>\n\nBody.\n\n</details>\n";

describe("a details block on disk", () => {
  it("pairs its tags across the markdown between them", () => {
    const built = first(TOGGLE);
    expect(built.type.name).toBe("toggle");
    expect(built.attrs).toEqual({ summary: "S", open: false });
    expect(built.child(0).textContent).toBe("Body.");
  });

  it("reads a bare open attribute and nothing else", () => {
    expect(first("<details open>\n<summary>S</summary>\n\nBody.\n\n</details>\n").attrs.open).toBe(true);
    expect(first(TOGGLE).attrs.open).toBe(false);
  });

  it("undoes exactly the escaping the writer does, and refuses anything else", () => {
    expect(first("<details>\n<summary>a &amp; b</summary>\n\nx\n\n</details>\n").attrs.summary).toBe("a & b");
    expect(first("<details>\n<summary>&lt;b&gt;</summary>\n\nx\n\n</details>\n").attrs.summary).toBe("<b>");
    expect(first("<details>\n<summary>&amp;lt;</summary>\n\nx\n\n</details>\n").attrs.summary).toBe("&lt;");
  });

  it("holds a body of several blocks, and a body of none", () => {
    const many = first("<details>\n<summary>S</summary>\n\nOne.\n\n- a\n- b\n\n</details>\n");
    expect(many.childCount).toBe(2);
    const empty = first("<details>\n<summary>S</summary>\n\n</details>\n");
    expect(empty.type.name).toBe("toggle");
    expect(empty.childCount).toBe(1);
    expect(empty.child(0).textContent).toBe("");
  });
});

describe("a details block the bridge will not pair", () => {
  const refused: Array<[string, string]> = [
    ["an attribute the schema has no room for", '<details open class="x">\n<summary>S</summary>\n\nBody.\n\n</details>'],
    ["a summary carrying markup", "<details>\n<summary>A <b>bold</b> one</summary>\n\nBody.\n\n</details>"],
    ["an entity the writer would not put back", "<details>\n<summary>A &quot;quoted&quot; one</summary>\n\nBody.\n\n</details>"],
    ["a bare ampersand, which would come back escaped", "<details>\n<summary>A & B</summary>\n\nBody.\n\n</details>"],
    ["one inside another", "<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nBody.\n\n</details>\n\n</details>"],
    ["an opening tag with nothing closing it", "<details>\n<summary>S</summary>\n\nBody."],
    ["a closing tag with nothing opening it", "Body.\n\n</details>\n\n<details>\n<summary>S</summary>\n\nMore.\n\n</details>"],
    ["a body holding something the editor cannot model", "<details>\n<summary>S</summary>\n\n[^n]: A footnote definition.\n\n</details>"],
    ["the whole thing on one line, which is not markdown inside html at all", "<details>\n<summary>S</summary>\nBody.\n</details>"],
    ["an indented tag", "  <details>\n  <summary>S</summary>\n\nBody.\n\n  </details>"],
    ["a carriage return between the tags", "<details>\n<summary>S</summary>\n\nBo\rdy.\n\n</details>"],
  ];

  for (const [why, source] of refused) {
    it(`stays raw source: ${why}`, () => {
      const built = parse(`${source}\n`);
      let toggles = 0;
      built.descendants((node) => {
        if (node.type.name === "toggle") toggles += 1;
        return true;
      });
      expect(toggles, "nothing here may become a toggle").toBe(0);
      expect(write(`${source}\n`)).toBe(`${source}\n`);
    });
  }
});

/**
 * Every summary the editor can hold, written out and read back as itself.
 *
 * The escaping and its inverse are the whole of what makes a toggle survive, so the alphabet is
 * the characters that escaping touches, an entity that looks like one it already wrote, and the
 * line ending that would otherwise turn the opening tag into a block the parser stops recognising.
 */
describe("every summary the editor can hold", () => {
  const SUMMARIES = ["", "S", "a & b", "<b>", "&amp;", "&lt;", "&quot;", "a &amp;lt; b", ">>>", "a\nb", "  padded  ", "100% & <you>"];

  it("comes back as itself, once the writer has had it", () => {
    for (const summary of SUMMARIES) {
      const before = doc(n.toggle.createChecked({ summary, open: true }, para("Body.")));
      const once = writeDoc(before);
      const read = parse(once);
      expect(read.child(0).type.name, JSON.stringify(summary)).toBe("toggle");
      expect(read.child(0).attrs.summary, JSON.stringify(summary)).toBe(summary);
      expect(write(once), JSON.stringify(summary)).toBe(once);
    }
  });

  /**
   * The two that do not, which is the whole of the exception and is why the assertion above is an
   * identity rather than a collapse.
   *
   * The opening tag and the summary are one html block and an html block ends at a blank line, so a
   * summary carrying one is a toggle with nothing left to pair; a carriage return is a line ending
   * the reader turns into a newline before the parser sees it, so the same is true one step later.
   * Neither has a spelling, so the writer flattens them to the space they can hold and the round
   * trip settles there rather than growing. Every other line ending a summary can hold survives,
   * which it did not before: `"a\nb"` used to come back as `"a b"` and this describe used to say so.
   */
  it("flattens the two it has nowhere to put, and settles", () => {
    for (const summary of ["a\n\nb", "a\rb", "a\r\nb"]) {
      const before = doc(n.toggle.createChecked({ summary, open: true }, para("Body.")));
      const once = writeDoc(before);
      const read = parse(once);
      expect(read.child(0).type.name, JSON.stringify(summary)).toBe("toggle");
      expect(read.child(0).attrs.summary, JSON.stringify(summary)).toBe("a b");
      expect(write(once), JSON.stringify(summary)).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Math.
// ---------------------------------------------------------------------------------------------

describe("a math block on disk", () => {
  it("carries its latex through untouched", () => {
    const built = first("$$\n\\frac{a}{b} = \\sum_{i=0}^{n} x_i\n$$\n");
    expect(built.type.name).toBe("mathBlock");
    expect(built.attrs.latex).toBe("\\frac{a}{b} = \\sum_{i=0}^{n} x_i");
  });

  it("holds a fence grown to fit the dollars inside it", () => {
    expect(first("$$$\na $$ b\n$$$\n").attrs.latex).toBe("a $$ b");
    expect(first("$$\na $ b\n$$\n").attrs.latex).toBe("a $ b");
  });

  it("holds an empty block", () => {
    expect(first("$$\n$$\n").type.name).toBe("mathBlock");
    expect(first("$$\n$$\n").attrs.latex).toBe("");
  });

  it("is not what a sentence full of money is", () => {
    expect(first("Money is $5, $10 and $1,000.\n").type.name).toBe("paragraph");
  });
});

describe("a math block the bridge will not model", () => {
  const refused: Array<[string, string]> = [
    ["meta on the opening fence, which the writer has no field for", "$$ tag\nx\n$$"],
    ["a fence that is never closed, which the writer would close for the author", "$$\nx"],
    ["a carriage return inside it, which would come back as a newline", "$$\nx\ry\n$$"],
  ];

  for (const [why, source] of refused) {
    it(`stays raw source: ${why}`, () => {
      const block = first(`${source}\n`);
      expect(block.type.name).toBe("raw");
      expect(`${source}\n`).toContain(block.textContent);
      expect(write(`${source}\n`)).toBe(`${source}\n`);
    });
  }
});

/**
 * Every equation the editor can hold, written out and read back as itself.
 *
 * The alphabet is what the fence has to reckon with: runs of dollars that decide how long it has
 * to be, a line that is itself a fence, an empty equation, and the whitespace that would be lost
 * if anything on the way through decided to tidy the latex up. Nothing normalises latex; the
 * attribute is what round trips and KaTeX only ever gets a copy of it.
 */
describe("every equation the editor can hold", () => {
  const LATEX = ["", "x^2", "a $ b", "a $$ b", "$$$", "$", "\\text{a\\\\b}", "a\n$$\nb", "a\n\nb", "  spaced  ", "\\frac{1}{2}"];

  it("comes back as itself, once the writer has had it", () => {
    const wrong: string[] = [];
    for (const latex of LATEX) {
      const before = doc(n.mathBlock.createChecked({ latex }));
      const once = writeDoc(before);
      const read = parse(once);
      if (!read.eq(before)) wrong.push(`${JSON.stringify(latex)} came back as ${JSON.stringify(once)}`);
      if (write(once) !== once) wrong.push(`${JSON.stringify(latex)} is not stable: ${JSON.stringify(write(once))}`);
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The round trip, which is the deliverable.
// ---------------------------------------------------------------------------------------------

/** The fixtures added for M2, and what the first save is allowed to do to each of them. */
const M2_FIXTURES = ["table-torture.md", "table-refused.md", "math-torture.md", "toggle-pairs.md", "toggle-refused.md", "m2-locality.md"];

/** The one M2 fixture the first save rewrites, because its tables are not in the house style. */
const REWRITTEN_ON_FIRST_SAVE = ["table-torture.md"];

describe("the round trip", () => {
  for (const name of M2_FIXTURES) {
    it(`is byte identical on a file the editor did not edit: ${name}`, () => {
      const source = fixture(name);
      const once = write(source);
      if (REWRITTEN_ON_FIRST_SAVE.includes(name)) expect(once, "the house style should have something to say here").not.toBe(source);
      else expect(once).toBe(source);
    });

    it(`is byte stable from the second save on: ${name}`, () => {
      const generations = saves(fixture(name), 3);
      expect(generations[1]).toBe(generations[0]);
      expect(generations[2]).toBe(generations[0]);
    });

    it(`adds nothing over ten saves: ${name}`, () => {
      const generations = saves(fixture(name), 10);
      expect(new Set(generations.slice(1)).size, "the file never settled").toBe(1);
      expect(generations[9].length).toBe(generations[1].length);
    });
  }

  it("keeps every table, toggle and equation the fixtures hold, as source slices", () => {
    for (const name of M2_FIXTURES) {
      const out = write(fixture(name));
      for (const fragment of ["| `a \\| b` |", "<summary>A &quot;quoted&quot; one</summary>", "$$ tag", "| 1 | 2 | 3 |"]) {
        if (fixture(name).includes(fragment)) expect(out, `${name}: ${fragment}`).toContain(fragment);
      }
    }
  });
});

/**
 * The three constructs where a container holds them.
 *
 * A blockquote, a callout and a toggle all take blocks, so all three can hold a table or an
 * equation, and the markers a container puts down the left of every line are what a construct
 * rebuilt from its parts has to be written back through. The list is the one that says no: an item
 * whose fence is indented has offsets that no longer start at the construct, so the equation in it
 * is left as source rather than written back a column to the left of where the author put it.
 */
describe("inside a container", () => {
  const nested: Array<[string, string, string]> = [
    ["a table in a blockquote", "> | a |\n> | - |\n> | 1 |\n", "blockquote"],
    ["an equation in a blockquote", "> $$\n> x\n> $$\n", "blockquote"],
    ["a table in a callout", "> [!NOTE]\n>\n> | a |\n> | - |\n> | 1 |\n", "callout"],
    ["a table in a list item", "- a\n  | a |\n  | - |\n  | 1 |\n", "bulletList"],
    ["a table and an equation in a toggle", "<details>\n<summary>S</summary>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n</details>\n", "toggle"],
    ["an indented equation in a list item, which stays source", "- $$\n  x\n  $$\n", "raw"],
  ];

  for (const [what, source, block] of nested) {
    it(`comes back byte identical: ${what}`, () => {
      expect(first(source).type.name).toBe(block);
      expect(write(source)).toBe(source);
      expect(write(write(source))).toBe(source);
    });
  }
});

/**
 * A paragraph retyped in a document holding all three constructs at once.
 *
 * This is the promise that matters most on a file living in somebody else's git history: a save
 * after an edit is a diff of the edit and nothing else. A table reflowed, a toggle reindented or a
 * fence regrown beside an edit the user did make is a diff they have to explain to a reviewer.
 */
describe("edit locality", () => {
  const EDITED = "The paragraph this test retypes.";

  function retype(source: string): string {
    const document = parseMarkdown(source, "/m2-locality.md");
    const blocks: ProseMirrorNode[] = [];
    let hits = 0;
    document.doc.forEach((block) => {
      if (block.type.name === "paragraph" && block.textContent === "EDITME") {
        hits += 1;
        blocks.push(para(EDITED));
        return;
      }
      blocks.push(block);
    });
    expect(hits).toBe(1);
    return serializeMarkdown(document, n.doc.createChecked(null, blocks));
  }

  it("changes the edited paragraph and nothing else", () => {
    const source = fixture("m2-locality.md");
    expect(write(source), "the fixture has to be byte stable first, or the diff is just the first save").toBe(source);
    expect(retype(source)).toBe(source.replace("EDITME", EDITED));
  });

  it("leaves the table, the toggle and the math block byte identical", () => {
    const out = retype(fixture("m2-locality.md"));
    for (const construct of ["| Column A | Column B |\n| - | -: |\n| one | two |", "<details>\n<summary>A toggle beside it</summary>", "$$\n\\frac{a}{b}\n$$", "[^note]: The footnote definition, which must not move."]) {
      expect(out, construct).toContain(construct);
    }
  });
});

/**
 * The three constructs beside every other block the bridge knows, in both orders.
 *
 * A construct is only as safe as its neighbours make it. A table that writes itself correctly on
 * its own and swallows the heading under it, or a toggle whose closing tag is read as part of the
 * list before it, is a bug that only a pair finds, and the pair sweeps in the adversarial passes
 * are what found several of M1's.
 */
describe("beside every other block", () => {
  const NEIGHBOURS: Record<string, string> = {
    para: "Plain paragraph text.",
    head: "## A heading",
    hr: "---",
    fence: "```js\nconst x = 1;\n```",
    ul: "- one\n- two",
    quote: "> quoted",
    callout: "> [!NOTE]\n> body",
    html: '<div class="x">\n  <span>y</span>\n</div>',
    footnote: "[^n]: A footnote definition.",
    table: "| a | b |\n| - | - |\n| 1 | 2 |",
    toggle: "<details>\n<summary>S</summary>\n\nbody\n\n</details>",
    math: "$$\nx^2\n$$",
    aligned: "| a  |  b |\n| :- | -: |\n| 1  |  2 |",
  };
  const KEYS = Object.keys(NEIGHBOURS);

  it("settles on the second save for every ordered pair, at three separations", () => {
    const unstable: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        for (const gap of ["\n\n", "\n\n\n", "\n"]) {
          const source = `${NEIGHBOURS[a]}${gap}${NEIGHBOURS[b]}\n`;
          const once = write(source);
          if (write(once) !== once) unstable.push(`${a}${gap.length}${b}: ${JSON.stringify(once)} then ${JSON.stringify(write(once))}`);
        }
      }
    }
    expect(unstable).toEqual([]);
  });

  it("means the same document after a save as before it, for every ordered pair", () => {
    const changed: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${NEIGHBOURS[a]}\n\n${NEIGHBOURS[b]}\n`;
        const before = parse(write(source));
        if (!parse(write(write(source))).eq(before)) changed.push(`${a}|${b}`);
      }
    }
    expect(changed).toEqual([]);
  });

  it("adds nothing over ten saves, for every ordered pair", () => {
    const growing: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const generations = saves(`${NEIGHBOURS[a]}\n\n${NEIGHBOURS[b]}\n`, 10);
        if (new Set(generations.slice(1)).size !== 1) growing.push(`${a}|${b} never settled: ${generations.map((one) => one.length).join(",")}`);
      }
    }
    expect(growing).toEqual([]);
  }, 30000);
});

// ---------------------------------------------------------------------------------------------
// A `$$` block that is never closed.
// ---------------------------------------------------------------------------------------------

/**
 * The one construct whose source slice runs past its own last character.
 *
 * Every other block ends at the byte it ends at, and the line ending after it is the file's rather
 * than the block's. An unclosed `$$` has no fence to stop at, so the parser hands back a block that
 * runs to the final byte of the file, blank lines and all. The writer puts exactly one line ending
 * after the last block whatever that block says, so a file that ended without one came back a byte
 * longer, that byte landed inside the raw block, and the document the save produced was not the
 * document the save was given. It is a real shape: a paper converted out of a PDF opened `$$` and
 * never closed it, and the rest of that file, sixty five thousand characters of it, was the one
 * raw block whose bytes moved on every open.
 */
describe("a `$$` block that is never closed", () => {
  it("holds the same bytes whether or not the file ends with a line ending", () => {
    const ended = first("$$ x = 1\n");
    const bare = first("$$ x = 1");

    expect(bare.type.name).toBe("raw");
    expect(bare.textContent).toBe(ended.textContent);
  });

  it("comes back as the document it was saved from", () => {
    const wrong: string[] = [];
    const sources = ["$$ x", "$$ x\n", "$$ x\n\n", "$$ x   \n", "$$\nx\ny", "a\n\n$$ x", "- a\n\n$$ x", "$$ x\n\n\n"];

    for (const source of sources) {
      const before = parse(source);
      const once = write(source);
      if (!parse(once).eq(before)) wrong.push(`${JSON.stringify(source)} came back as ${JSON.stringify(once)}`);
      if (write(once) !== once) wrong.push(`${JSON.stringify(source)} is not stable: ${JSON.stringify(write(once))}`);
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the trailing spaces on its last line, which are the author's", () => {
    // Only what a line ending starts is the file's rather than the block's, so a last line ending
    // in two spaces keeps them: they are bytes inside the construct and nothing else put them there.
    expect(first("$$ x  ").textContent).toBe("$$ x  ");
    expect(write("$$ x  ")).toBe("$$ x  \n");
  });
});
