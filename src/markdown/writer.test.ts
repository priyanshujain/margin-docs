// The five the writer got wrong, and the properties that say each of them is dead.
//
// All five were bytes: three of them changed a file the user had not edited, and two of those were
// changing files on this machine before this pass. None of them was reachable from the parser, so
// none of the round trip suites saw them: they are what the writer does with a document that came
// from an edit, or with a construct the reader hands back in a shape the writer cannot spell.
//
// The example in each group is the reproduction, kept because a bug is a story about one input.
// The property beside it is the claim: ten saves of a file nobody edited add no bytes and change
// no document, which is the promise the example broke and the only one worth testing.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createEditorExtensions } from "../editor/extensions";
import { schema } from "../model/schema";
import { corpus } from "./corpus/load";
import { parseMarkdown, serializeMarkdown } from "./index";

const n = schema.nodes;
const text = (value: string) => schema.text(value);
const doc = (...blocks: ProseMirrorNode[]) => n.doc.createChecked(null, blocks);
const paragraph = (...content: ProseMirrorNode[]) => n.paragraph.createChecked(null, content);
const item = (...content: ProseMirrorNode[]) => n.listItem.createChecked(null, content);

/** One save of a file. */
function write(source: string): string {
  const document = parseMarkdown(source, "/w.md");
  return serializeMarkdown(document, document.doc);
}

/** One save of a document the editor built, which is where four of the five came from. */
function writeDoc(node: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/w.md" }, node);
}

function parse(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/w.md").doc;
}

/**
 * Ten saves of a file nobody edited, which is an afternoon of autosaves.
 *
 * Every one of them has to produce the bytes the first one did and the document the first one read
 * back as. A file that moves on the second save moves on every save for the rest of its life,
 * because the thing that moved it is still there in what it wrote.
 */
function settles(source: string): void {
  const first = write(source);
  let current = first;
  for (let generation = 2; generation <= 10; generation += 1) {
    current = write(current);
    expect(current, `save ${generation} moved the file`).toBe(first);
    expect(parse(current).eq(parse(first)), `save ${generation} changed the document`).toBe(true);
  }
}

/** The types and the text of a document, which is what may never be lost however it is spelled. */
function contentOf(node: ProseMirrorNode): string {
  const out: string[] = [];
  node.descendants((child) => {
    out.push(child.isText ? `text:${child.text}` : child.type.name);
    return true;
  });
  return out.join("|");
}

// ------------------------------------------------------------------------------------------------
// An empty inline formula.
// ------------------------------------------------------------------------------------------------

describe("an empty inline formula", () => {
  it("is not written as the four dollars the reader hands back as text", () => {
    const before = doc(paragraph(text("cost "), n.mathInline.createChecked({ latex: "" }), text(" ok")));
    const once = writeDoc(before);

    // `$$$$` reparses as literal text, so the node is gone after one save and the file has gained
    // four characters; the save after that escapes them and it gains two more.
    expect(once).not.toContain("$");
    expect(write(once)).toBe(once);
    expect(parse(once).textContent).toBe("cost  ok");
  });

  it("takes nothing else with it when it goes", () => {
    const before = doc(paragraph(text("see "), n.mathInline.createChecked({ latex: "" }), text(" and more")), n.paragraph.createChecked(null, n.mathInline.createChecked({ latex: "" })), paragraph(text("after")));
    const once = writeDoc(before);

    // The paragraph that held nothing else writes nothing, which is what an empty paragraph has
    // always written, and the two around it are untouched.
    expect(once).toBe("see  and more\n\nafter\n");
    settles(once);
  });

  it("is the only equation the writer will not write", () => {
    // The sweep m2 runs against `$$` blocks, run against the inline form, which is where the empty
    // one went wrong. Anything holding a line ending is the wrapped formula's problem, below.
    const LATEX = [" ", "x^2", "a $ b", "a $$ b", "$$$", "$", "\\text{a\\\\b}", "  spaced  ", "\\frac{1}{2}", "$x$"];
    const wrong: string[] = [];

    for (const latex of LATEX) {
      const before = doc(paragraph(text("q "), n.mathInline.createChecked({ latex }), text(" r")));
      const once = writeDoc(before);
      if (!parse(once).eq(before)) wrong.push(`${JSON.stringify(latex)} came back as ${JSON.stringify(once)}`);
      if (write(once) !== once) wrong.push(`${JSON.stringify(latex)} is not stable: ${JSON.stringify(write(once))}`);
    }
    expect(wrong).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// A url the user typed as text.
// ------------------------------------------------------------------------------------------------

/** The escapes mdast writes over a url, which this reader ignores, and which cost a byte each. */
const AUTOLINK_ESCAPE = /\\[.:@]/;

describe("a url the user typed as text", () => {
  it("is written with the characters the user typed", () => {
    const before = doc(paragraph(text("See https://example.com now")));
    const once = writeDoc(before);

    // The old spelling was `https\://example.com`, which this reader autolinks anyway, so the
    // backslash prevented nothing and came straight back out on the second save.
    expect(once).toBe("See https://example.com now\n");
    settles(once);
  });

  it("keeps every character of the paragraph, whatever the url and whatever is beside it", () => {
    const URLS = ["https://example.com", "http://example.com/a", "www.example.com", "bob@example.com", "https://example.com/a_b", "https://example.com/x?a=1&b=2"];
    const PREFIXES = ["", "See ", "a ", "(", "**bold** "];
    const SUFFIXES = ["", " now", ".", ")", "!", " and more"];
    const wrong: string[] = [];

    for (const url of URLS) {
      for (const prefix of PREFIXES) {
        for (const suffix of SUFFIXES) {
          const value = `${prefix}${url}${suffix}`;
          const once = writeDoc(doc(paragraph(text(value))));
          if (AUTOLINK_ESCAPE.test(once)) wrong.push(`${JSON.stringify(value)} was escaped into ${JSON.stringify(once)}`);
          if (parse(once).textContent !== value) wrong.push(`${JSON.stringify(value)} reads back as ${JSON.stringify(parse(once).textContent)}`);
          if (write(once) !== once) wrong.push(`${JSON.stringify(value)} is not stable: ${JSON.stringify(once)} then ${JSON.stringify(write(once))}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("settles on the first save for a paragraph of them", () => {
    const value = "Mail bob@example.com or see https://example.com and www.example.org today.";
    const once = writeDoc(doc(paragraph(text(value))));

    expect(once).toBe(`${value}\n`);
    settles(once);
  });

  it("leaves the escapes mdast writes for its own reasons alone", () => {
    // The claim is about three characters in one context, not about escaping in general: a
    // paragraph opening with something that would start a block still gets its backslash.
    const once = writeDoc(doc(paragraph(text("# not a heading and * not a bullet"))));
    expect(once).toBe("\\# not a heading and \\* not a bullet\n");
    settles(once);
  });
});

// ------------------------------------------------------------------------------------------------
// A list written tight.
// ------------------------------------------------------------------------------------------------

const FENCED = n.codeBlock.createChecked(null, text("x"));
const NESTED = n.bulletList.createChecked({ tight: true }, [item(paragraph(text("b"))), item(paragraph(text("c")))]);
const TABLE = n.table.createChecked(null, [n.tableRow.createChecked(null, [n.tableHeader.createChecked(null, text("h"))]), n.tableRow.createChecked(null, [n.tableCell.createChecked(null, text("c"))])]);

describe("a list written tight", () => {
  it("is byte identical on the file that was moving", () => {
    const source = "1. a\n   - b\n   - c\n2. d\n   ```\n   x\n   ```\n   e\n";

    // The item holding a paragraph, a fence and a paragraph was counted as two paragraphs and made
    // the whole list loose, so the first save spread the list and the second spread it further.
    expect(write(source)).toBe(source);
    expect(parse(write(source)).eq(parse(source))).toBe(true);
    settles(source);
  });

  it("stays tight around every pair of blocks that can be written a line apart", () => {
    const tight: Array<[string, ProseMirrorNode[]]> = [
      ["a nested list", [paragraph(text("a")), NESTED]],
      ["a fence", [paragraph(text("a")), FENCED]],
      ["a fence with a paragraph under it", [paragraph(text("a")), FENCED, paragraph(text("e"))]],
      ["a heading", [paragraph(text("a")), n.heading.createChecked({ level: 2 }, text("h"))]],
      ["a heading with a paragraph under it", [paragraph(text("a")), n.heading.createChecked({ level: 2 }, text("h")), paragraph(text("e"))]],
      ["a table", [paragraph(text("a")), TABLE]],
      ["an equation", [paragraph(text("a")), n.mathBlock.createChecked({ latex: "y" })]],
      ["a quote", [paragraph(text("a")), n.blockquote.createChecked(null, paragraph(text("q")))]],
      ["a rule, which is written as the spelling that interrupts a paragraph", [paragraph(text("a")), n.horizontalRule.createChecked()]],
    ];

    for (const [what, content] of tight) {
      const before = doc(n.bulletList.createChecked({ tight: true }, [item(...content), item(paragraph(text("z")))]));
      const once = writeDoc(before);
      expect(once, `${what} should not have moved the items apart`).not.toContain("\n\n");
      expect(parse(once).eq(before), `${what} did not come back as itself: ${JSON.stringify(once)}`).toBe(true);
      settles(once);
    }
  });

  it("writes an item loose when its blocks would run into each other", () => {
    const loose: Array<[string, ProseMirrorNode[]]> = [
      ["two paragraphs run together into one", [paragraph(text("a")), paragraph(text("b"))]],
      ["a paragraph under a nested list is a lazy continuation of it", [paragraph(text("a")), NESTED, paragraph(text("e"))]],
      ["a paragraph under a quote is a lazy continuation of it", [paragraph(text("a")), n.blockquote.createChecked(null, paragraph(text("q"))), paragraph(text("e"))]],
      ["a paragraph under a table is another row of it", [paragraph(text("a")), TABLE, paragraph(text("e"))]],
    ];

    for (const [why, content] of loose) {
      const before = doc(n.bulletList.createChecked({ tight: true }, [item(...content), item(paragraph(text("z")))]));
      const once = writeDoc(before);
      expect(contentOf(parse(once)), `${why}: ${JSON.stringify(once)}`).toBe(contentOf(before));
      settles(once);
    }
  });

  it("never loses a block or moves twice, for every pair and triple an item can hold", () => {
    const BLOCKS: Array<[string, () => ProseMirrorNode]> = [
      ["paragraph", () => paragraph(text("p"))],
      ["fence", () => FENCED],
      ["heading", () => n.heading.createChecked({ level: 3 }, text("h"))],
      ["quote", () => n.blockquote.createChecked(null, paragraph(text("q")))],
      ["list", () => NESTED],
      ["ordered", () => n.orderedList.createChecked({ tight: true, start: 3 }, [item(paragraph(text("o")))])],
      ["table", () => TABLE],
      ["math", () => n.mathBlock.createChecked({ latex: "y" })],
      ["rule", () => n.horizontalRule.createChecked()],
    ];
    const wrong: string[] = [];

    for (const [leftName, left] of BLOCKS) {
      for (const [rightName, right] of BLOCKS) {
        for (const tail of [[], [paragraph(text("t"))]]) {
          const content = [paragraph(text("a")), left(), right(), ...tail];
          const before = doc(n.bulletList.createChecked({ tight: true }, [item(...content), item(paragraph(text("z")))]));
          const once = writeDoc(before);
          const back = parse(once);
          const what = `${leftName} then ${rightName}${tail.length ? " then a paragraph" : ""}`;

          if (contentOf(back) !== contentOf(before)) wrong.push(`${what} lost something: ${JSON.stringify(once)}`);
          else if (write(once) !== once) wrong.push(`${what} is not stable: ${JSON.stringify(once)} then ${JSON.stringify(write(once))}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// A span the file wrapped across two lines.
// ------------------------------------------------------------------------------------------------

/**
 * The continuation lines mdast will not write a line ending in front of.
 *
 * Its handlers cannot escape inside a code span or an equation, so they swap the line ending for a
 * space rather than risk the next line being read as a block. Most of these are not blocks at all:
 * `#two` is not a heading, `| y` is not a table, and the four characters mdast is afraid of are
 * the file's own. The ones that really would open a block are in the list too, and the writer has
 * to fall back to the collapse for those, which is what `spelled` sorts out below.
 */
const CONTINUATIONS = ["#two", "# two", "=two", "==", "--two", "---", "```two", "~~~", "|two", " -two", "-two", "+two", "*two", "1. two", "> two", "plain", "  two"];

/** The spans in a document that still carry the line ending the file gave them. */
function wrappedSpans(node: ProseMirrorNode): string[] {
  const out: string[] = [];
  node.descendants((child) => {
    if (child.isText && child.marks.some((mark) => mark.type.name === "code") && child.text?.includes("\n")) out.push(child.text);
    if (child.type.name === "mathInline" && String(child.attrs.latex).includes("\n")) out.push(String(child.attrs.latex));
    return true;
  });
  return out;
}

/**
 * A file whose span really is wrapped keeps the wrap and the document, and one whose continuation
 * would open a block never had the span in the first place: the block parser had that line before
 * any of this did, so there is nothing for the writer to keep.
 *
 * The bytes are allowed to move once, because a wrap inside a quote or a list item is a lazy
 * continuation on disk and the house style writes the marker or the indent the line is missing.
 * What may not move is the document, and what may not move at all is the second save.
 */
function keepsTheWrap(sources: string[]): string[] {
  const wrong: string[] = [];
  let wrapped = 0;

  for (const source of sources) {
    const before = parse(source);
    const spans = wrappedSpans(before);
    if (spans.length === 0) continue;
    wrapped += 1;
    const once = write(source);
    if (!parse(once).eq(before)) wrong.push(`${JSON.stringify(source)} came back as ${JSON.stringify(once)}`);
    if (wrappedSpans(parse(once)).join("|") !== spans.join("|")) wrong.push(`${JSON.stringify(source)} lost the wrap: ${JSON.stringify(once)}`);
    if (write(once) !== once) wrong.push(`${JSON.stringify(source)} is not stable: ${JSON.stringify(write(once))}`);
  }
  if (wrapped === 0) wrong.push("no continuation produced a wrapped span at all, so nothing was tested");
  return wrong;
}

describe("a code span the file wrapped across two lines", () => {
  it("keeps the line ending rather than joining the two lines", () => {
    const source = "text `one\n#two` end\n";

    // The old writer wrote `one #two`, which is a different code span in a file the user had not
    // touched: eleven files on this machine hit it.
    expect(write(source)).toBe(source);
    expect(parse(write(source)).eq(parse(source))).toBe(true);
    settles(source);
  });

  it("keeps it for every continuation there is, or never had the span to keep", () => {
    expect(keepsTheWrap(CONTINUATIONS.map((line) => `text \`one\n${line}\` end\n`))).toEqual([]);
  });

  it("keeps it inside a heading, a quote and a list item too", () => {
    const wrapped = ["## `one\n#two` heading\n", "> quote `one\n|two` end\n", "- item `one\n--two` end\n", "text `one\n#two` and `three\n|four` end\n"];
    expect(keepsTheWrap(wrapped)).toEqual([]);
  });

  it("collapses one a cell cannot hold, because a row is one line", () => {
    // No file can put a wrapped span in a cell, since a row ends at the line ending, so this is a
    // paste into a table in the editor. A row that gains a second line is not a wide row, it is
    // the end of the table and a paragraph where the rest of it used to be.
    const code = schema.text("one\n#two", [schema.marks.code.create()]);
    const before = doc(n.table.createChecked(null, [n.tableRow.createChecked(null, [n.tableHeader.createChecked(null, code)]), n.tableRow.createChecked(null, [n.tableCell.createChecked(null, text("c"))])]));
    const once = writeDoc(before);

    expect(once).toContain("`one #two`");
    expect(parse(once).child(0).type.name).toBe("table");
    settles(once);
  });
});

describe("an inline formula the file wrapped across two lines", () => {
  it("keeps the line ending rather than joining the two lines", () => {
    const source = "A $$x\n| y$$ more.\n";

    expect(write(source)).toBe(source);
    expect(parse(write(source)).eq(parse(source))).toBe(true);
    settles(source);
  });

  it("keeps it for every continuation there is, or never had the formula to keep", () => {
    expect(keepsTheWrap(CONTINUATIONS.map((line) => `A $$x\n${line}$$ more.\n`))).toEqual([]);
  });

  it("keeps it beside a code span that is wrapped as well", () => {
    expect(keepsTheWrap(["A $$x\n| y$$ and `one\n#two` end.\n"])).toEqual([]);
  });

  it("keeps it beside a url that has a spelling to prove of its own", () => {
    // The two decisions are made in the one order they can be: the wrap is settled with the links
    // spelled out, and the urls are then proved against a block that has the wrap in it.
    const sources = ["See https://example.com and `one\n#two` end.\n", "See https://example.com and $$x\n| y$$ end.\n", "See <https://example.com> and `one\n--two` end.\n"];
    expect(keepsTheWrap(sources)).toEqual([]);

    // The first two are already in the house style. The third is not, because the ladder writes
    // the shortest spelling it can prove and this url does not need its brackets, so that one is
    // allowed the one move every file is allowed and no more.
    expect(write(sources[0])).toBe(sources[0]);
    expect(write(sources[1])).toBe(sources[1]);
    for (const source of sources) settles(source);
  });
});

// ------------------------------------------------------------------------------------------------
// A block that does not read back as itself.
// ------------------------------------------------------------------------------------------------

/**
 * The five below are one bug, and the ladder walking past them is the bug.
 *
 * Every rung above this line proves a named property: the wrap survived, the url is spelled the
 * same, the escape bought nothing. None of them asks the question underneath all three, which is
 * whether the block the writer produced is the block the reader hands back, and each of the five
 * walked straight through the gap. A heading lost its own marker. A raw block ate the list beside
 * it. A code span holding a blank line was written as markdown nobody can read. A `<summary>` on
 * two lines gained a space. An angle autolink was rewritten for want of a rung it could reach.
 *
 * So the property here is not about any of them: a block that holds a line ending markdown has
 * nowhere to put, or bytes mdast did not choose, is written, opened again and compared against the
 * document itself. What each example below tests is the same claim in a different corner.
 */

/** One save, opened again, against the document that was saved. Bytes may move once; this may not. */
function survives(source: string): void {
  const before = parse(source);
  const once = write(source);
  expect(parse(once).eq(before), `${JSON.stringify(source)} came back as ${JSON.stringify(once)}`).toBe(true);
  settles(once);
}

describe("a hard wrapped code span in a loose list", () => {
  it("keeps the wrap the same list kept when it was tight", () => {
    const source = "- a `tar x\n  --strip-components=1` b\n\n- c\n";

    // Writing `spread` on every item made the built tree and the parsed tree differ on a field the
    // parser reads off blank lines, so the wrap rung condemned every loose list in existence and
    // the newline inside the user's command became a space.
    expect(write(source)).toBe(source);
    survives(source);
  });

  it("keeps it for every shape of list there is", () => {
    const lists = [
      "- a `one\n  #two` b\n\n- c\n",
      "- a `one\n  #two` b\n- c\n",
      "1. a `one\n   #two` b\n\n2. c\n",
      "- [ ] a `one\n  #two` b\n\n- [x] c\n",
      "- a\n\n- b `one\n  #two` c\n\n  d\n",
      "- a $$x\n  | y$$ b\n\n- c\n",
      "> - a `one\n>   #two` b\n>\n> - c\n",
    ];
    expect(keepsTheWrap(lists)).toEqual([]);
  });
});

describe("a heading whose text holds a line ending", () => {
  it("keeps its marker rather than being written as a paragraph", () => {
    const source = "## paths and baseUrl&#xA;\n";

    // mdast forces the setext form on any heading holding a line break and then sizes the
    // underline from the last line, which here is empty: no underline, no heading, and the save
    // after that dropped the blank line the missing underline left behind.
    expect(write(source)).toBe(source);
    survives(source);
  });

  it("keeps it at every level and wherever the line ending falls", () => {
    const headings = ["# a&#xA;\n", "## a&#xA;\n", "### a&#xA;\n", "###### a&#xA;\n", "## &#xA;a\n", "## a&#xA;b\n", "## a&#xD;&#xA;b\n", "# a&#xD;&#xA;\n", "## `x&#xA;y` z\n"];
    for (const source of headings) survives(source);
  });
});

describe("a raw block that opens with a list marker", () => {
  it("does not swallow the list beside it", () => {
    const source = "* a\n - <b>c</b>\n";
    const once = write(source);

    // mdast alternates the bullet between two adjacent lists and a raw block is not a list node,
    // so the preserved source sat down next to the list and the two were one list on the next
    // open, with the user's own first item inside a block that is no longer a list at all.
    expect(contentOf(parse(once)), JSON.stringify(once)).toBe(contentOf(parse(source)));
    survives(source);
  });

  it("stays apart in either order and beside either kind of list", () => {
    // The list carrying a bare url is the one whose node the writer rebuilds on the way out, so a
    // seam proved apart against one node is written by another unless the two are told the same.
    const seams = ["* a\n - <b>c</b>\n", "<b>c</b>\n\n- a\n", "1. a\n\n[^n]: note\n", "[^n]: note\n\n1. a\n", "* a\n * b\n - <b>c</b>\n", "- [ ] a\n\n<b>c</b>\n\n- [x] d\n", "* a https://example.com\n - <b>c</b>\n"];
    for (const source of seams) {
      const once = write(source);
      expect(contentOf(parse(once)), JSON.stringify(once)).toBe(contentOf(parse(source)));
      survives(source);
    }
  });
});

describe("a code span holding a blank line", () => {
  it("is not written as markdown that closes the paragraph under it", () => {
    const code = schema.text("a\n\nb", [schema.marks.code.create()]);
    const before = doc(paragraph(text("q "), code, text(" r")));
    const once = writeDoc(before);

    // The wrapped handler wrote the blank line out and mdast's own handler, which the fallback
    // rung hands the block to, only swaps a line ending in front of a block character. Either way
    // the span was gone on reopen and the file gained two backslashes on the save after.
    expect(once).toBe("q `a b` r\n");
    expect(parse(once).textContent).toBe("q a b r");
    settles(once);
  });

  it("is not written that way as an equation either", () => {
    const before = doc(paragraph(text("q "), n.mathInline.createChecked({ latex: "a\n\nb" }), text(" r")));
    const once = writeDoc(before);

    expect(once).toBe("q $$a b$$ r\n");
    expect(parse(once).child(0).child(1).attrs.latex).toBe("a b");
    settles(once);
  });
});

describe("an autolink the user wrote in angle brackets", () => {
  it("keeps its brackets whatever its scheme is", () => {
    // The angle rung was unreachable for anything but http, https, www and mailto, because a
    // candidate with no bare spelling was never made a candidate at all, so a file saying
    // `<ftp://x>` was rewritten into `[ftp://x](ftp://x)` on the first save.
    for (const url of ["ftp://example.com/x", "irc://example.com/y", "tel:+15551234", "x-custom:abc", "ssh://host/path"]) {
      const source = `<${url}>\n`;
      expect(write(source), url).toBe(source);
      survives(source);
    }
  });

  it("keeps them beside one another and beside a url that needs none", () => {
    const source = "see <ftp://x/y> and <irc://z> and https://example.com end\n";
    expect(write(source)).toBe(source);
    survives(source);
  });
});

describe("a summary written across two lines", () => {
  it("does not gain the space that collapsing it would put there", () => {
    const source = "<details>\n<summary>\n</summary>\n\nbody\n\n</details>\n";

    // The summary was written on one line whether it was on one line or not, so an empty summary
    // on two of them came back as a summary of one space: a byte in the file and a different
    // document, on a file nobody had edited.
    expect(write(source)).toBe(source);
    survives(source);
  });

  it("keeps a summary with words either side of the line ending too", () => {
    const source = "<details open>\n<summary>a\nb</summary>\n\nbody\n\n</details>\n";
    expect(write(source)).toBe(source);
    survives(source);
  });

  it("flattens the one an html block cannot hold, and only that one", () => {
    // A blank line ends the html block, so the closing tag would fall outside it and there would
    // be no toggle left to pair. That summary has no spelling and the space is what is left.
    const before = doc(n.toggle.createChecked({ summary: "a\n\nb", open: false }, paragraph(text("body"))));
    const once = writeDoc(before);

    expect(once).toContain("<summary>a b</summary>");
    expect(parse(once).child(0).type.name).toBe("toggle");
    settles(once);
  });
});

describe("a toggle inside a quote", () => {
  it("keeps its bytes as the raw source it is read as", () => {
    // `<details>` is paired among top level html blocks and nowhere else, so a toggle written
    // inside a callout is one raw block holding the whole callout. That is the bargain the bridge
    // makes everywhere: a construct it cannot model keeps its bytes instead of being reshaped.
    const sources = ["> [!NOTE]\n> <details>\n> <summary>s</summary>\n>\n> body\n>\n> </details>\n", "> <details>\n> <summary>s</summary>\n>\n> body\n>\n> </details>\n", "- <details>\n  <summary>s</summary>\n\n  body\n\n  </details>\n"];

    for (const source of sources) {
      expect(write(source), JSON.stringify(source)).toBe(source);
      survives(source);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// A property of the whole file rather than of any block in it.
// ------------------------------------------------------------------------------------------------

/**
 * Where the body starts, which is the question no per block check is in a position to ask.
 *
 * Every check above this line is asked of one block, or of the seam between one block and the next,
 * and both of those are the right shape for almost everything that can go wrong. Frontmatter is not
 * either of them. It is a property of the file: three characters on the first line and everything
 * down to the next three is not markdown at all, and the same block two lines further down is
 * perfectly safe. `---` is what the house style writes a rule as, so a document that opens with a
 * rule wrote its own opening delimiter, and the next open handed the comment and the first task
 * back as frontmatter and the editor showed neither. The bytes were stable, so it never came back.
 *
 * There are two more of the same shape and they are tested here rather than being taken on trust: a
 * paragraph the user typed as `+++`, which mdast escapes no part of, and the end of the file, which
 * is `a $$ block that is never closed` in m2.test.ts. The seam between two blocks is the third, and
 * it is the section above.
 */

describe("a document that starts with a frontmatter delimiter", () => {
  it("keeps everything under the rule it opens with", () => {
    const source = "-----\n\n<!-- c -->\n\n- [ ] one\n\n-----\n\n- [ ] two\n\n-----\n";
    const once = write(source);

    expect(parseMarkdown(once, "/w.md").frontmatter, once).toBe(null);
    expect(contentOf(parse(once)), once).toBe(contentOf(parse(source)));
    survives(source);
  });

  it("spells that one rule the other way and leaves the rest of them alone", () => {
    // The one deviation from the house style in the file, and it is the smallest one available:
    // the rule that cannot be dashes is asterisks, and every other rule under it is dashes still.
    expect(write("-----\n\na\n\n-----\n")).toBe("***\n\na\n\n---\n");
  });

  it("leaves a leading rule alone when the reader would not have taken it for a delimiter", () => {
    // One rule and nothing under it that could close a delimiter is a rule, so nothing moves.
    expect(write("-----\n\na\n")).toBe("---\n\na\n");
  });

  it("does the same for a paragraph the user typed as a delimiter", () => {
    // mdast escapes a leading `---` in a paragraph and does not escape `+++`, and a paragraph has
    // no other spelling to fall to, so this one is pushed off the first byte instead.
    const before = doc(paragraph(text("+++")), paragraph(text("body")), paragraph(text("+++")));
    const once = writeDoc(before);

    expect(parseMarkdown(once, "/w.md").frontmatter, once).toBe(null);
    expect(parse(once).eq(before), once).toBe(true);
    settles(once);
  });

  // The defence above is for the first byte of a file, and a body under frontmatter is not at the
  // first byte of anything. Run there it did the damage it exists to prevent: the blank line it
  // pushes the body down by is handed back by the reader as part of the frontmatter, so the two
  // paragraphs below were swallowed on the first save and the file then grew a byte on every save
  // after it. Measured before the fix: 28, 29, 30, 31, 32 bytes, and no `+++` left in any of them.
  it("leaves a body alone when there is frontmatter in front of it", () => {
    const source = "---\ntitle: t\n---\n\n+++\n\nbody\n\n+++\n";
    const once = write(source);

    expect(once, "nothing may be pushed off the top of a body that is not at the top of the file").toBe(source);
    expect(parseMarkdown(once, "/w.md").frontmatter, once).toBe("---\ntitle: t\n---\n\n");
    expect(contentOf(parse(once)), once).toBe(contentOf(parse(source)));
    settles(source);
  });
});

// ------------------------------------------------------------------------------------------------
// A list beside preserved source that is indented rather than marked.
// ------------------------------------------------------------------------------------------------

/**
 * The seam check with somewhere to go when its one lever does not help.
 *
 * `separate` proved this pair wrong and then wrote it anyway. The other bullet is the lever mdast
 * has for two lists and it is the wrong lever here: what pulls `  </td>` into the list above it is
 * the two space indent, not the marker, and no marker this writer can choose changes that. So the
 * list went out as `- a`, its content column was two, the preserved source was indented two, and
 * the next open handed back one raw block holding both with the user's list inside it.
 *
 * The second lever is how far the marker pushes the item's content from the margin, which is the
 * one other thing about a list this writer gets to choose. Four columns is as far as a marker goes
 * and it is far enough: a raw block cut from a file can be indented three columns at the most,
 * because the fourth is an indented code block and the bridge models one of those.
 */

describe("a list beside preserved source that is indented", () => {
  it("keeps the list a list", () => {
    const source = "  * a\n  </td>";
    const once = write(source);

    expect(contentOf(parse(once)), JSON.stringify(once)).toBe(contentOf(parse(source)));
    expect(parse(once).child(0).type.name, JSON.stringify(once)).toBe("bulletList");
    survives(source);
  });

  it("keeps it at every indent, for every kind of list and on either side", () => {
    const seams = [
      "  * a\n  </td>\n",
      " * a\n </td>\n",
      "   * a\n   </td>\n",
      "  1. a\n   </td>\n",
      "  - [ ] a\n  </td>\n",
      "  * a\n  </td>\n\n  * b\n",
      "  </td>\n\n  * a\n",
      "  * a\n  [^n]: note\n",
      "  * a https://example.com\n  </td>\n",
    ];

    for (const source of seams) {
      const once = write(source);
      expect(contentOf(parse(once)), JSON.stringify(once)).toBe(contentOf(parse(source)));
      survives(source);
    }
  });

  it("does not indent a list that had nothing to keep away from", () => {
    // The wide spelling is a rung, not a style: a seam that was never in doubt is written the house
    // way, and so is a seam the plain spelling already keeps apart.
    expect(write("* a\n\n</td>\n")).toBe("- a\n\n</td>\n");
    expect(write("* a\n* b\n")).toBe("- a\n- b\n");
  });
});

// ------------------------------------------------------------------------------------------------
// A block of preserved source that runs to the last byte of the file.
// ------------------------------------------------------------------------------------------------

/**
 * The one construct whose bytes are whitespace, read by the one rule that says which of it is the
 * file's.
 *
 * An unclosed `<pre>` or `$$` has no fence to stop at, so the parser hands it back running to the
 * final byte, blank lines and all, and the block is holding the line ending the writer is about to
 * put there anyway. Taking that one off is right and it is where this stops. Taking off everything a
 * line ending starts is a blank line deleted out of the middle of somebody's html, and inside a
 * `<pre>` a blank line is content. These files were byte identical before the wider trim was written
 * and are byte identical again.
 */
describe("preserved source that runs to the end of the file", () => {
  it("keeps the blank lines inside it", () => {
    expect(write("<pre>\nkeep\n\n\n")).toBe("<pre>\nkeep\n\n\n");
    expect(write("<pre>\nkeep\n   \n")).toBe("<pre>\nkeep\n   \n");
    expect(write("$$\nkeep\n\n\n")).toBe("$$\nkeep\n\n\n");
  });

  it("gains the file's own last line ending and never a second one", () => {
    const endings = ["<pre>\nkeep", "<pre>\nkeep\n", "<pre>\nkeep\n\n", "<pre>\nkeep  ", "<pre>\nkeep  \n", "$$ x", "$$ x\n", "$$ x\n\n", "$$ x   \n", "$$ x\n \n"];
    const wrong: string[] = [];

    for (const source of endings) {
      const once = write(source);
      // One line ending is the whole of the house style here, so a file that has one is untouched
      // and a file that has none gains exactly one.
      if (once !== (source.endsWith("\n") ? source : `${source}\n`)) wrong.push(`${JSON.stringify(source)} was written ${JSON.stringify(once)}`);
      if (!parse(once).eq(parse(write(once)))) wrong.push(`${JSON.stringify(source)} did not come back as itself`);
      settles(source);
    }
    expect(wrong).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// A tight list written next to another block inside a quote.
// ------------------------------------------------------------------------------------------------

/**
 * The list whose blank line belongs to the block under it.
 *
 * A list is loose when its items are a blank line apart or when one item holds two blocks that far
 * apart, and a blank line after the last item is neither. remark counts it anyway wherever a
 * container carries the line: inside a quote it is `>` rather than empty and the list token runs
 * over it. So the writer separated the list from the quote under it, the reader called the list
 * loose, and the next save put a blank line between every item as well. Two saves, two different
 * files, and a document that changed on the first of them.
 */
describe("a tight list beside another block inside a quote", () => {
  it("is still tight after the save that separates it", () => {
    const source = "> - one\n> - two\n> > nested\n";
    const once = write(source);

    expect(once).toBe("> - one\n> - two\n>\n> > nested\n");
    expect(parse(once).eq(parse(source)), once).toBe(true);
    settles(source);
  });

  it("holds for every block that can follow a list in a quote, and for the loose list it is not", () => {
    const followers = ["> nested", "> > deeper", "> [!NOTE]\n> body", "1. one\n2. two", "- one\n- two", "```\nx\n```", "# h", "| a |\n| - |\n| b |", "para"];
    const wrong: string[] = [];

    for (const follower of followers) {
      for (const list of ["- one\n- two", "1. one\n2. two", "- [ ] one\n- [x] two", "- one\n\n- two"]) {
        const source = `${[...list.split("\n"), ...follower.split("\n")].map((line) => (line ? `> ${line}` : ">")).join("\n")}\n`;
        const once = write(source);
        if (!parse(once).eq(parse(source))) wrong.push(`${JSON.stringify(source)} came back as ${JSON.stringify(once)}`);
        if (write(once) !== once) wrong.push(`${JSON.stringify(source)} moved on its second save: ${JSON.stringify(write(once))}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("still reads a list the blank lines really are inside as loose", () => {
    // The other half of the decision, which is the half remark gets right and which this must not
    // have thrown away with it.
    expect(parse("> - one\n>\n> - two\n").child(0).child(0).attrs.tight).toBe(false);
    expect(parse("- one\n\n- two\n").child(0).attrs.tight).toBe(false);
    expect(parse("- one\n\n  more\n- two\n").child(0).attrs.tight).toBe(false);
    expect(parse("> - one\n> - two\n").child(0).child(0).attrs.tight).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// A paragraph that ends on a hard break.
// ------------------------------------------------------------------------------------------------

/**
 * The break with no line under it to start.
 *
 * mdast writes a hard break as a backslash and a line ending wherever it finds one, and at the end
 * of a block the line ending is the block's own. What is left on the line is a backslash, which the
 * reader hands back as a literal backslash: the break is gone on the next open, the paragraph has
 * gained a character, and the save after that escapes it into two. The editor lane is guarding the
 * keystroke that makes one of these; this is the writer refusing to spell it either way.
 */
describe("a paragraph that ends on a hard break", () => {
  it("writes the break as nothing rather than as a backslash", () => {
    const before = doc(paragraph(text("text"), n.hardBreak.createChecked()));
    const once = writeDoc(before);

    expect(once).toBe("text\n");
    expect(parse(once).textContent).toBe("text");
    settles(once);
  });

  it("keeps a break that has a line under it, and drops a run of them at the end", () => {
    const kept = doc(paragraph(text("one"), n.hardBreak.createChecked(), text("two")));
    expect(writeDoc(kept)).toBe("one\\\ntwo\n");
    expect(parse(writeDoc(kept)).eq(kept)).toBe(true);

    const trailing = doc(paragraph(text("one"), n.hardBreak.createChecked(), n.hardBreak.createChecked()), paragraph(text("after")));
    expect(writeDoc(trailing)).toBe("one\n\nafter\n");

    const heading = doc(n.heading.createChecked({ level: 2 }, [text("h"), n.hardBreak.createChecked()]));
    expect(writeDoc(heading)).toBe("## h\n");
    settles(writeDoc(heading));
  });
});

// ------------------------------------------------------------------------------------------------
// The document the app actually hands to a save.
// ------------------------------------------------------------------------------------------------

/**
 * Every test above this line saves a document the bridge parsed or this file built, and the app
 * saves neither of those.
 *
 * src/editor/Editor.tsx binds every document it opens to TipTap's own schema, which
 * src/editor/extensions.ts generates from the same specs the bridge parses against. Two `Schema`
 * instances over one set of specs, so every `NodeType` in one is a different object from its twin
 * in the other, and `Node.eq` compares those objects. `readsBack` was the whole of the ladder in
 * `verifiedBlock` and it ended in an `eq` across that boundary, so it answered no to every block it
 * was ever asked about in the running app: every block that needed proof was written at the last
 * fidelity, whether it needed to be or not. The three below are the three the sections above
 * already cover from the bridge side, and all three changed a file nobody had typed into.
 *
 * So the harness is the editor rather than the schema, and the property is that the two paths write
 * the same bytes. A guard that the app does not reach is not a guard, and the only way to know
 * which of those it is, is to go through the thing the app goes through.
 */

/** One editor holding one file: the app's extension set, the app's plugins, no screen. */
function liveEditor(source: string): Editor {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: createEditorExtensions({ documentPath: () => "/w.md", onError: () => {} }),
    content: parseMarkdown(source, "/w.md").doc.toJSON(),
  });

  // TipTap only installs the extensions' plugins when it mounts a view and there is no DOM here,
  // so the state is rebuilt with them exactly as src/editor/Editor.tsx does on every open.
  editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }));
  return editor;
}

/** One document as the editor holds it. */
function liveDoc(source: string): ProseMirrorNode {
  const editor = liveEditor(source);
  const built = editor.state.doc;
  editor.destroy();
  return built;
}

/** The same, after a keystroke has landed at the head of the first raw block on screen. */
function typedIntoRaw(source: string, typed: string): ProseMirrorNode {
  const editor = liveEditor(source);
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === "raw") at = pos + 1;
    return at < 0;
  });
  expect(at, "no raw block to type into").toBeGreaterThan(0);

  editor.view.dispatch(editor.state.tr.insertText(typed, at));
  const built = editor.state.doc;
  editor.destroy();
  return built;
}

/** One save of a file, from the tree the editor would have been holding when it happened. */
function writeLive(source: string): string {
  return serializeMarkdown(parseMarkdown(source, "/w.md"), liveDoc(source));
}

describe("a save from the editor rather than from the bridge", () => {
  it("is handed a document that is equal to the parsed one and is not `eq` to it", () => {
    // The reason this whole section exists, stated as the thing it is: the same document, and a
    // comparison that says otherwise, which is what every rung of the ladder was hanging on.
    const parsed = parseMarkdown("# h\n\npara\n", "/w.md").doc;
    const live = liveDoc("# h\n\npara\n");

    expect(JSON.stringify(live.toJSON())).toBe(JSON.stringify(parsed.toJSON()));
    expect(live.eq(parsed)).toBe(false);
  });

  it("keeps the line endings the bridge keeps", () => {
    const sources = ["q `a\nb` r\n", "q $$a\nb$$ r\n", "<details>\n<summary>\n</summary>\n\nbody\n\n</details>\n", "## paths and baseUrl&#xA;\n", "- a `tar x\n  --strip-components=1` b\n\n- c\n"];

    for (const source of sources) {
      expect(writeLive(source), JSON.stringify(source)).toBe(source);
    }
  });

  it("keeps the seams and the first line the bridge keeps", () => {
    const sources = ["  * a\n  </td>\n", "* a\n - <b>c</b>\n", "-----\n\n<!-- c -->\n\n- [ ] one\n\n-----\n\n- [ ] two\n\n-----\n", "$$ x"];

    for (const source of sources) {
      expect(writeLive(source), JSON.stringify(source)).toBe(write(source));
      expect(parse(writeLive(source)).eq(parse(source)), JSON.stringify(source)).toBe(true);
    }
  });

  it("writes every file in the corpus the way the bridge writes it", () => {
    const wrong: string[] = [];
    for (const file of corpus()) {
      const live = serializeMarkdown(parseMarkdown(file.source, `/${file.name}`), liveDoc(file.source));
      if (live !== write(file.source)) wrong.push(file.name);
    }
    expect(wrong).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// A raw block the user has typed into.
// ------------------------------------------------------------------------------------------------

/**
 * The one raw block that is not the file's own bytes any more.
 *
 * Everything the seam check does rests on where a raw block can start. A block cut from a file is
 * indented three columns at the most, because the fourth is an indented code block and the bridge
 * models one of those, and the widest a list can push its own content is four. A block somebody has
 * typed four spaces into is past the end of that ladder, and there is no other one: nothing this
 * writer can say about the list beside it changes what `    <div>` means, and nothing it can say
 * about the block itself either, because those bytes are not its to respell.
 *
 * Measured before the fix, on the file below: the first save wrote the pair, the next open handed
 * back one raw block with the user's list inside it and no list left on screen, and the save after
 * that put blank lines through the middle of the html. Two saves to lose a list and corrupt a block
 * whose bytes are an absolute guarantee.
 *
 * So an edit to a raw block is written only when the file can hold it, which is asked as the promise
 * the whole bridge is built on: write the block, read it back, write it again, and get the same
 * bytes. An edit that fails that is not saved and the file's own bytes stay. src/editor/ owns
 * whether the user is allowed to make the edit at all; this is only the writer refusing to be the
 * thing that corrupts the file.
 */
describe("a raw block the user has typed into", () => {
  it("does not take the list beside it down with it", () => {
    const source = "- one\n- two\n\n<div>\nraw\n</div>\n\nafter\n";
    const edited = typedIntoRaw(source, "    ");
    const once = serializeMarkdown(parseMarkdown(source, "/w.md"), edited);

    // The keystroke really did land in the document the save was handed.
    expect(edited.child(1).textContent).toBe("    <div>\nraw\n</div>");

    expect(once, "an edit that cannot be saved must not move the file").toBe(source);
    expect(parse(once).child(0).type.name, once).toBe("bulletList");
    expect(write(once)).toBe(once);
    settles(once);
  });

  it("writes the edits the file can hold", () => {
    const source = "- one\n- two\n\n<div>\nraw\n</div>\n\nafter\n";
    const wrong: string[] = [];

    for (const typed of [" ", "  ", "   ", "<!-- c -->\n", "x "]) {
      const edited = typedIntoRaw(source, typed);
      const once = serializeMarkdown(parseMarkdown(source, "/w.md"), edited);
      if (!once.includes(`${typed}<div>`)) wrong.push(`${JSON.stringify(typed)} was not written: ${JSON.stringify(once)}`);
      if (parse(once).child(0).type.name !== "bulletList") wrong.push(`${JSON.stringify(typed)} lost the list: ${JSON.stringify(once)}`);
      if (write(once) !== once) wrong.push(`${JSON.stringify(typed)} did not settle: ${JSON.stringify(write(once))}`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives the edit up to the list and to nothing else", () => {
    // The seam is what is refused, not the keystroke. The same four spaces in a document with no
    // list beside the block are four spaces the file can hold, and typing into a raw block is an
    // edit like any other everywhere the pair is not the problem.
    const wrong: string[] = [];
    const beside = ["- one\n- two\n\n<div>\nraw\n</div>\n\nafter\n", "1. one\n2. two\n\n<div>\nraw\n</div>\n", "- [ ] one\n\n<div>\nraw\n</div>\n"];
    const alone = ["<div>\nraw\n</div>\n\nafter\n", "para\n\n<div>\nraw\n</div>\n", "# h\n\n<div>\nraw\n</div>\n"];

    for (const typed of ["    ", "\t", "        "]) {
      for (const source of beside) {
        const once = serializeMarkdown(parseMarkdown(source, "/w.md"), typedIntoRaw(source, typed));
        if (once !== source) wrong.push(`${JSON.stringify(typed)} beside a list in ${JSON.stringify(source)} was written ${JSON.stringify(once)}`);
      }
      for (const source of alone) {
        const once = serializeMarkdown(parseMarkdown(source, "/w.md"), typedIntoRaw(source, typed));
        if (!once.includes(`${typed}<div>`)) wrong.push(`${JSON.stringify(typed)} alone in ${JSON.stringify(source)} was not written: ${JSON.stringify(once)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
