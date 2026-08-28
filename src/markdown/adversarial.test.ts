// Adversarial tests for the markdown bridge. Written to break it, not to confirm it.
//
// The bridge makes five promises: opening never writes, parse/serialize is byte stable from the
// second pass on, unmodellable constructs survive byte identical, editing one paragraph is a one
// paragraph diff, and frontmatter passes through untouched.
//
// Three of the tests below fail. They are the failures, not the harness: each is a minimal input
// where the file that comes back off a save is not the file that went in, in a way the "one time
// normalisation" allowance does not cover. Everything else here passed on the first run and is
// kept as a regression net, because a bridge this careful deserves tests that stay honest about
// what already works.
//
// Fixtures live in corpus/adversarial/ rather than corpus/hand/ on purpose: corpus/load.ts globs
// {real,hand}/*.md, and dropping deliberately non-round-tripping files into that glob would fail
// roundtrip.test.ts's "rewritten by the first save only where the house style says so" list, which
// this file is not allowed to edit. These fixtures are loaded directly instead.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { parseToMdast } from "./handlers";
import { parseMarkdown, serializeMarkdown } from "./index";

const fixtures = import.meta.glob("./corpus/adversarial/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function fixture(name: string): string {
  const source = fixtures[`./corpus/adversarial/${name}`];
  if (source === undefined) throw new Error(`no adversarial fixture named ${name}`);
  return source;
}

/** One save. */
function write(source: string): string {
  const document = parseMarkdown(source, "/adversarial.md");
  return serializeMarkdown(document, document.doc);
}

function doc(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/adversarial.md").doc;
}

/** Every link destination in a file, in document order, straight out of the parser. */
function destinations(source: string): string[] {
  const out: string[] = [];
  const walk = (node: { type?: string; url?: string; children?: unknown[] }) => {
    if (node.type === "link") out.push(String(node.url));
    for (const child of (node.children ?? []) as Array<Parameters<typeof walk>[0]>) walk(child);
  };
  walk(parseToMdast(source) as unknown as Parameters<typeof walk>[0]);
  return out;
}

/** Every block the bridge could not model, as the bytes it is holding. */
function rawBlocks(node: ProseMirrorNode): string[] {
  const out: string[] = [];
  node.descendants((child) => {
    if (child.type.name === "raw") out.push(child.textContent);
    return child.type.name !== "raw";
  });
  return out;
}

function retypeParagraph(node: ProseMirrorNode, from: string, to: string): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  let hits = 0;
  node.forEach((child) => {
    if (child.type.name === "paragraph" && child.textContent === from) {
      hits += 1;
      children.push(schema.nodes.paragraph.create(null, schema.text(to)));
      return;
    }
    children.push(child);
  });
  expect(hits, `expected exactly one paragraph reading ${JSON.stringify(from)}`).toBe(1);
  return schema.nodes.doc.create(null, children);
}

// ---------------------------------------------------------------------------------------------
// Data loss. Content the file had before the save and does not have after it.
// ---------------------------------------------------------------------------------------------

describe("data loss: a bare url swallows the punctuation and the word after it", () => {
  // serialize.ts `literalAutolink` writes a link back as a bare url when it can prove GFM would
  // read the same link out of it. The proof is wrong at the right hand edge: it checks only the
  // FIRST character of the text that follows, allowing ' " . , : ; ! ?, on the theory that GFM
  // trims trailing punctuation off an autolink. GFM trims that punctuation only when it is
  // genuinely trailing. Followed by another word it is inside the url, and the destination the
  // reader clicks is not the destination the author wrote.

  it("does not turn <url>'s into a link to url's", () => {
    const source = "Read <https://example.com>'s docs\n";
    expect(destinations(source)).toEqual(["https://example.com"]);
    expect(destinations(write(source))).toEqual(["https://example.com"]);
  });

  it("does not turn <url>.Word into a link to url.Word", () => {
    const source = "See <https://example.com>.Next thing\n";
    expect(destinations(write(source))).toEqual(["https://example.com"]);
  });

  it("does not corrupt a resource link whose text is its own url", () => {
    const source = "Read [https://example.com](https://example.com)'s docs\n";
    expect(destinations(write(source))).toEqual(["https://example.com"]);
  });

  it("does not corrupt an email autolink followed by a dot and a word", () => {
    const source = "Mail <a@b.com>.Next\n";
    expect(destinations(write(source))).toEqual(["mailto:a@b.com"]);
  });

  it("corrupts every one of these separators", () => {
    const broken: string[] = [];
    for (const after of ["'s", '"q', ".Next", ",next", ":next", ";next", "!next", "?next"]) {
      const source = `See <https://example.com>${after}\n`;
      if (destinations(write(source))[0] !== "https://example.com") broken.push(after);
    }
    expect(broken).toEqual([]);
  });

  it("is right about the cases it does allow", () => {
    // Trailing punctuation followed by a space, an unmatched close paren, and balanced parens
    // inside the url are all genuinely safe, and the fixture keeps them honest.
    for (const source of [
      "See <https://example.com>. Next\n",
      "See <https://example.com>) done\n",
      "See (<https://example.com/a(b)>).\n",
    ]) {
      expect(destinations(write(source)), source).toEqual(destinations(source));
    }
  });

  it("shows up in a whole file", () => {
    const source = fixture("autolink-adjacency.md");
    expect(destinations(write(source))).toEqual(destinations(source));
  });
});

describe("data loss: a list under a leading thematic break is flattened into escaped text", () => {
  // remark-frontmatter is registered for yaml and toml. At the very start of a file its tokenizer
  // competes with the thematic break, and when it loses, the block after the break comes back as a
  // paragraph instead of a list or a blockquote. The bridge then writes that paragraph out with
  // the marker escaped, so `- a` becomes `\- a` and the list is gone from the file for good.
  //
  // The same document with any block in front of it parses correctly, which is what pins the cause
  // on the frontmatter extension rather than on CommonMark.

  it("keeps a list that follows a thematic break on line one", () => {
    const source = "---\n- a\n";
    expect(write(source)).toContain("- a");
    expect(write(source)).not.toContain("\\- a");
  });

  it("keeps a blockquote that follows a thematic break on line one", () => {
    const source = "---\n> q\n";
    expect(write(source)).toContain("> q");
    expect(write(source)).not.toContain("\\> q");
  });

  it("parses the same document correctly when anything precedes it", () => {
    const tree = parseToMdast("x\n\n---\n- a\n");
    expect(tree.children.map((child) => child.type)).toEqual(["paragraph", "thematicBreak", "list"]);
  });

  it("shows up in a whole file", () => {
    const source = fixture("leading-rule-list.md");
    const out = write(source);
    expect(out).toContain("- a list the frontmatter tokenizer eats");
    expect(out).not.toContain("\\- a list");
  });
});

describe("data loss: a lone carriage return inside content is turned into a line break", () => {
  // frontmatter.ts `normaliseSource` collapses CRLF to LF, which the module documents as a
  // deliberate one time rewrite of a CRLF file. The regex is /\r\n?/g, so it also rewrites a lone
  // CR, and the guard is `body.includes("\r")`, so a single stray CR anywhere in the file arms it
  // for the whole file. remark keeps that CR verbatim inside a fenced block; the bridge does not,
  // and a one line code sample comes back as two lines.

  it("keeps a carriage return that the parser itself keeps", () => {
    const source = "```\nline one\rstill line one\n```\n";
    const parsed = parseToMdast(source).children[0];
    expect(parsed.type).toBe("code");
    expect((parsed as { value: string }).value).toBe("line one\rstill line one");
    expect(write(source)).toBe(source);
  });

  it("shows up in a whole file", () => {
    expect(write(fixture("lone-carriage-return.md"))).toBe(fixture("lone-carriage-return.md"));
  });
});

// ---------------------------------------------------------------------------------------------
// Cosmetic. The file changes on the first save and never again. Allowed by the house style, but
// pinned here so that a change to the list is a change somebody has to justify.
// ---------------------------------------------------------------------------------------------

describe("cosmetic: the first save rewrites these and the second does not", () => {
  const cases: Array<[string, string, string]> = [
    ["setext heading becomes atx", "Title\n=====\n\nbody\n", "# Title\n\nbody\n"],
    ["closing hashes are dropped", "# Title #\n", "# Title\n"],
    ["two space hard break becomes a backslash", "a  \nb\n", "a\\\nb\n"],
    ["ordered markers are renumbered", "1. a\n1. b\n1. c\n", "1. a\n2. b\n3. c\n"],
    ["gappy ordered markers are made sequential", "3. a\n5. b\n7. c\n", "3. a\n4. b\n5. c\n"],
    ["tilde fences become backtick fences", "~~~\nx\n~~~\n", "```\nx\n```\n"],
    ["indented code becomes fenced", "    code\n", "```\ncode\n```\n"],
    // Unified on to `---` everywhere except the first line of a file, where `---` is not a rule at
    // all. This row used to expect "---\n\n---\n", and that file reads back as frontmatter of
    // "---\n\n---\n" over a single empty paragraph: both rules gone, the whole document with them.
    // The second save was byte identical, which is how the row stayed green, because an empty
    // document written twice does not move. So the house style keeps its one spelling and the
    // leading rule is respelled with the other character markdown has for it, once, and only when
    // the reader says it would have eaten the body.
    ["thematic breaks are unified", "***\n\n___\n", "***\n\n---\n"],
    ["entities are decoded", "&amp; &copy; &#65;\n", "& © A\n"],
    ["an ambiguous entity is re-escaped instead", "&amp;copy;\n", "\\&copy;\n"],
    ["intraword underscores are escaped", "snake_case here\n", "snake\\_case here\n"],
    ["intraword asterisks become character references", "a*b*c\n", "&#x61;_&#x62;_&#x63;\n"],
    ["mark nesting order is fixed", "_**x**_\n", "**_x_**\n"],
    ["a link inside emphasis is turned inside out", "*[a](b)*\n", "[_a_](b)\n"],
    ["a bold autolink becomes a resource link", "**https://example.com** x\n", "[**https://example.com**](https://example.com) x\n"],
    ["single tilde strikethrough is doubled", "~x~\n", "~~x~~\n"],
    ["an empty link title is dropped", '[a](b "")\n', "[a](b)\n"],
    ["markup inside image alt text is flattened", "![*a* `b`](x.png)\n", "![a b](x.png)\n"],
    ["a callout label is upper cased", "> [!note]\n> text\n", "> [!NOTE]\n> text\n"],
    ["a blank quote line under a callout label is dropped", "> [!NOTE]\n>\n> text\n", "> [!NOTE]\n> text\n"],
    ["a blank quote line is added under a label above a non paragraph", "> [!NOTE]\n> # H\n", "> [!NOTE]\n>\n> # H\n"],
    ["a lazy blockquote continuation gains its marker", "> a\nb\n", "> a\n> b\n"],
    ["tabs after a list marker become a space", "-\tfoo\n", "- foo\n"],
    ["a tab indented paragraph continuation is unindented", "foo\n\tbar\n", "foo\nbar\n"],
    ["a partly loose list is made wholly loose", "- a\n\n- b\n- c\n", "- a\n\n- b\n\n- c\n"],
    ["a missing final newline is added", "hello", "hello\n"],
    ["extra blank lines between blocks collapse", "a\n\n\nb\n", "a\n\nb\n"],
    ["trailing blank lines are dropped", "a\n\n\n", "a\n"],
    ["a whitespace only file becomes empty", "   \n\n  \n", ""],
    ["a paragraph and the html block under it gain a blank line", "para\n<div>x</div>\n", "para\n\n<div>x</div>\n"],
    ["a blank line inside an empty fence is dropped", "```\n\n```\n", "```\n```\n"],
    ["a double quoted link title is requoted and escaped", "[a](b 'ti\"tle')\n", '[a](b "ti\\"tle")\n'],
    ["an angle bracketed destination is escaped instead", "[a](<b(c>)\n", "[a](b\\(c)\n"],
    ["parens in a destination are escaped", "[a](http://x.com/a_(b))\n", "[a](http://x.com/a_\\(b\\))\n"],
    ["an angle autolink becomes a bare url", "Angle <https://example.com> here.\n", "Angle https://example.com here.\n"],
    ["an uppercase task marker is lowercased", "- [X] done\n", "- [x] done\n"],
    ["trailing spaces on a paragraph line are dropped", "a   \n\nb\n", "a\n\nb\n"],
    ["leading spaces on a paragraph are dropped", "   a\n", "a\n"],
    ["crlf becomes lf", "# H\r\n\r\npara\r\n", "# H\n\npara\n"],
    // A table is a modelled node in M2, so it is written from the node in the one house style
    // rather than sliced out of the source, and the house style gives a cell one space either side
    // however wide the column is. Every cell here comes through as the bytes it went in as, escaped
    // pipes included; the only thing that moves is the spaces around them and the length of the
    // delimiter run.
    [
      "a padded table loses its padding",
      "| pipe     |   code |\n| -------- | -----: |\n| `a \\| b` | \\| raw |\n",
      "| pipe | code |\n| - | -: |\n| `a \\| b` | \\| raw |\n",
    ],
    ["frontmatter loses its carriage returns too", "---\na: 1\r\n---\r\n\r\np\r\n", "---\na: 1\n---\n\np\n"],
  ];

  for (const [name, source, expected] of cases) {
    it(name, () => {
      const once = write(source);
      expect(once).toBe(expected);
      expect(write(once), "second save must not move the file again").toBe(once);
    });
  }

  // The row above says what the bytes are. This says what they mean, which is the assertion the row
  // never made and the reason it could sit green over a document that had been destroyed.
  it("keeps both rules readable after the save that unified them", () => {
    const once = write("***\n\n___\n");
    const reopened = parseMarkdown(once, "/adversarial.md");
    expect(reopened.frontmatter, once).toBe(null);
    expect(reopened.doc.childCount, once).toBe(2);
    expect(reopened.doc.child(0).type.name).toBe("horizontalRule");
    expect(reopened.doc.child(1).type.name).toBe("horizontalRule");
  });

  it("normalises a whole CRLF file exactly once", () => {
    const source = fixture("crlf-throughout.md");
    const once = write(source);
    expect(once).not.toBe(source);
    expect(once).not.toContain("\r");
    expect(write(once)).toBe(once);
    expect(once.startsWith("---\ntitle: CRLF\n---\n\n")).toBe(true);
  });

  it("adds the missing final newline exactly once", () => {
    const source = fixture("no-final-newline.md");
    const once = write(source);
    expect(once).toBe(source + "\n");
    expect(write(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------------------------
// Promise 1: opening a file never writes it.
// ---------------------------------------------------------------------------------------------

describe("opening a file", () => {
  it("hands back the exact bytes it was given, for every fixture", () => {
    for (const [name, source] of Object.entries(fixtures)) {
      const before = source;
      const document = parseMarkdown(source, name);
      expect(document.source, name).toBe(before);
      expect(source, name).toBe(before);
    }
  });

  it("is pure: parsing the same bytes twice gives equal documents and touches nothing", () => {
    for (const [name, source] of Object.entries(fixtures)) {
      expect(parseMarkdown(source, name).doc.eq(parseMarkdown(source, name).doc), name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Promise 2: byte stable from the second pass onward.
// ---------------------------------------------------------------------------------------------

const SNIPPETS: Record<string, string> = {
  para: "Plain paragraph text.",
  head: "## A heading",
  hr: "---",
  fence: "```js\nconst x = 1;\n```",
  fence4: "````\n```\nx\n```\n````",
  ul: "- one\n- two",
  ol: "3. three\n4. four",
  task: "- [ ] a\n- [x] b",
  loose: "- one\n\n- two",
  quote: "> quoted",
  quote2: "> > deep\n> >\n> > more",
  callout: "> [!NOTE]\n> body",
  calloutEmpty: "> [!WARNING]",
  table: "| a | b |\n| --- | --: |\n| 1 | 2 |",
  html: '<div class="x">\n  <span>y</span>\n</div>',
  comment: "<!-- a comment -->",
  details: "<details>\n<summary>S</summary>\n\nbody\n\n</details>",
  footnote: "[^n]: A footnote definition.",
  footref: "Text with a ref[^n].",
  defn: '[ref]: https://example.com "Title"',
  refuse: "See [the ref][ref] here.",
  math: "$$\nx^2\n$$",
  img: '![alt](i.png "t")',
  link: "A [link](http://x.com) here.",
  emph: "Some **bold** and _em_ and ~~del~~.",
  code: "Some `inline code` here.",
  nestlist: "- a\n  - b\n    - c",
  listcode: "- a\n  ```js\n  x\n  ```",
  listtable: "- a\n\n  | a |\n  | - |\n  | 1 |",
  hardbreak: "line one\\\nline two",
  unicode: "café \u{1F469}\u200D\u{1F4BB} e\u0301",
  mdx: "<Chart data={points} />",
  emptyfence: "```\n```",
};

const KEYS = Object.keys(SNIPPETS);

describe("idempotence", () => {
  it("holds for every adversarial fixture", () => {
    for (const [name, source] of Object.entries(fixtures)) {
      const once = write(source);
      expect(write(once), name).toBe(once);
      expect(write(write(once)), name).toBe(once);
    }
  });

  it("holds for every ordered pair of blocks, at three separations", () => {
    const unstable: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        for (const sep of ["\n\n", "\n\n\n", "\n"]) {
          const source = `${SNIPPETS[a]}${sep}${SNIPPETS[b]}\n`;
          const once = write(source);
          if (write(once) !== once) unstable.push(`${a} + ${b} (${sep.length} newlines): ${JSON.stringify(once)} -> ${JSON.stringify(write(once))}`);
        }
      }
    }
    expect(unstable).toEqual([]);
  });

  it("holds for a sample of ordered triples, with and without frontmatter", () => {
    const unstable: string[] = [];
    let seen = 0;
    for (const a of KEYS) {
      for (const b of KEYS) {
        for (const c of KEYS) {
          if (seen++ % 23 !== 0) continue;
          for (const prefix of ["", "---\ntitle: T\ntags:\n  - a\n---\n\n", "+++\ntitle = \"T\"\n+++\n\n", "\uFEFF"]) {
            const source = `${prefix}${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n\n${SNIPPETS[c]}\n`;
            const once = write(source);
            if (write(once) !== once) unstable.push(`${JSON.stringify(prefix)} ${a}|${b}|${c}`);
          }
        }
      }
    }
    expect(unstable).toEqual([]);
  }, 20000);

  it("does not change the meaning of a document, for every pair", () => {
    const changed: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n`;
        if (!doc(write(source)).eq(doc(source))) changed.push(`${a} + ${b}`);
      }
    }
    expect(changed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Promise 3: anything the editor cannot model is preserved byte identical.
// ---------------------------------------------------------------------------------------------

describe("preservation", () => {
  it("cuts every raw block out of the source and writes it back unchanged, for every fixture", () => {
    for (const [name, source] of Object.entries(fixtures)) {
      const document = parseMarkdown(source, name);
      const out = serializeMarkdown(document, document.doc);
      for (const raw of rawBlocks(document.doc)) {
        expect(raw, name).not.toBe("");
        expect(source.replace(/\r\n/g, "\n"), `${name}: raw block is not a slice of the source`).toContain(raw);
        expect(out, `${name}: raw block did not survive the save`).toContain(raw);
      }
    }
  });

  it("cuts every raw block out of the source and writes it back unchanged, for every pair", () => {
    const lost: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        for (const sep of ["\n\n", "\n\n\n", "\n"]) {
          const source = `${SNIPPETS[a]}${sep}${SNIPPETS[b]}\n`;
          const document = parseMarkdown(source, "/pair.md");
          const out = serializeMarkdown(document, document.doc);
          for (const raw of rawBlocks(document.doc)) {
            if (!source.includes(raw)) lost.push(`${a}|${b} not a source slice: ${JSON.stringify(raw)}`);
            else if (!out.includes(raw)) lost.push(`${a}|${b} not in output: ${JSON.stringify(raw)}`);
          }
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it("keeps the constructs the schema has no node for", () => {
    // A table is not on this list any more: M2 models one, so it is written from the node rather
    // than kept as the bytes it was written as. The two below stay because their table is already
    // spelled the way the house style spells one, so modelling it changed nothing.
    const cases: Array<[string, string]> = [
      ["footnote definition", "a[^n]\n\n[^n]: A note\n    that continues.\n"],
      ["link reference definition", '[ref]: https://example.com "Title"\n\nuse [ref]\n'],
      ["link reference definition with a wrapped title", '[ref]: /x\n  "Title"\n\nuse [ref]\n'],
      ["reference style link", "See [one][a] and [two][b].\n\n[a]: http://a.com\n[b]: http://b.com\n"],
      ["html comment", "<!-- hi -->\n"],
      ["conditional comment", "<!--[if IE]>x<![endif]-->\n"],
      ["details with attributes", '<details open class="x">\n<summary>S</summary>\n\nbody\n\n</details>\n'],
      ["mdx style jsx", "<Chart data={points} title=\"Sales\" />\n"],
      ["a quote whose label is not a callout kind", "> [!WEIRD]\n> text\n"],
      ["a callout label with text on the same line", "> [!NOTE] inline text\n"],
      ["a table inside a list item", "- a\n\n  | a |\n  | - |\n  | 1 |\n"],
      ["a table inside a blockquote", "> | a |\n> | - |\n> | 1 |\n"],
      ["inline html inside a paragraph", "para <span>x</span> more\n"],
      ["a heading containing a footnote reference", "## Heading[^n]\n\n[^n]: note\n"],
    ];
    for (const [name, source] of cases) {
      expect(write(source), name).toBe(source);
    }
  });

  it("keeps every fence shape it cannot improve on", () => {
    const source = fixture("fence-and-table-torture.md");
    const out = write(source);
    // The table fragment is written a space either side of each cell, which is the house style;
    // what is being asked of it here is that the escaped pipes inside it survive being modelled and
    // written back.
    for (const fragment of ["| `a \\| b` | \\| raw |", "````md\n```js\nconst x = 1;\n```\n````", "```{r setup, echo=FALSE}"]) {
      expect(out, fragment).toContain(fragment);
    }
  });

  it("keeps callouts, quotes and html side by side", () => {
    expect(write(fixture("callout-and-html-torture.md"))).toBe(fixture("callout-and-html-torture.md"));
  });

  it("keeps every unicode oddity byte for byte", () => {
    expect(write(fixture("unicode-torture.md"))).toBe(fixture("unicode-torture.md"));
  });
});

// ---------------------------------------------------------------------------------------------
// Promise 4: editing one paragraph leaves every other construct alone.
// ---------------------------------------------------------------------------------------------

describe("edit locality", () => {
  it("is a one paragraph diff on a file full of things the editor cannot model", () => {
    // From the house style form of the fixture, not its bytes. Its delimiter row is spelled `---`
    // and the house style writes the shortest one that carries the alignment, so the save that
    // settles the file shortens it, which is roundtrip.test.ts's business; the question here is
    // whether anything moves after that. This is the same baseline the pair sweep below already
    // takes.
    const source = write(fixture("locality-edit.md"));
    expect(write(source), "the baseline must be byte stable, or the diff is just the first save").toBe(source);

    const document = parseMarkdown(source, "/locality-edit.md");
    const out = serializeMarkdown(document, retypeParagraph(document.doc, "EDITME", "EDITED"));
    expect(out).toBe(source.replace("EDITME", "EDITED"));
  });

  it("is a one paragraph diff for every pair of neighbouring constructs", () => {
    const bad: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const base = write(`${SNIPPETS[a]}\n\nEDITME\n\n${SNIPPETS[b]}\n`);
        if (write(base) !== base) continue;
        const document = parseMarkdown(base, "/pair.md");
        let edited: ProseMirrorNode;
        try {
          edited = retypeParagraph(document.doc, "EDITME", "EDITED");
        } catch {
          continue; // "EDITME" between two thematic breaks is a setext heading, not a paragraph
        }
        const out = serializeMarkdown(document, edited);
        if (out !== base.replace("EDITME", "EDITED")) bad.push(`${a}|${b}\n  want ${JSON.stringify(base.replace("EDITME", "EDITED"))}\n  got  ${JSON.stringify(out)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("does not touch a raw block the user did not edit", () => {
    const source = write(fixture("locality-edit.md"));
    const document = parseMarkdown(source, "/locality-edit.md");
    const out = serializeMarkdown(document, retypeParagraph(document.doc, "EDITME", "EDITED"));
    for (const raw of rawBlocks(document.doc)) expect(out, raw).toContain(raw);
  });
});

// ---------------------------------------------------------------------------------------------
// Promise 5: frontmatter, YAML or TOML, survives byte identical.
// ---------------------------------------------------------------------------------------------

describe("frontmatter", () => {
  const blocks: Array<[string, string]> = [
    ["yaml", "---\ntitle: T\ntags:\n  - a\n  - b\n---\n\n"],
    ["yaml with no blank line after", "---\ntitle: T\n---\n"],
    ["yaml with a blank line inside", "---\na: 1\n\nb: 2\n---\n\n"],
    ["yaml holding its own delimiter", '---\na: "---"\nb: "+++"\n---\n\n'],
    ["yaml with comments and odd quoting", "---\n# a comment\na: 'single'\nb: |\n  block\n  scalar\n---\n\n"],
    ["yaml with trailing spaces on the delimiters", "---   \na: 1\n---   \n\n"],
    ["yaml that is empty", "---\n---\n\n"],
    ["toml", '+++\ntitle = "T"\nlist = [ 1, 2 ]\n+++\n\n'],
    ["toml holding its own delimiter", '+++\na = "+++"\n+++\n\n'],
    ["a bom and yaml", '\uFEFF---\na: 1\n---\n\n'],
    ["a bom alone", "\uFEFF"],
    ["two blank lines after the delimiter", "---\na: 1\n---\n\n\n"],
  ];

  for (const [name, prefix] of blocks) {
    it(`survives byte identical: ${name}`, () => {
      for (const key of KEYS) {
        const out = write(`${prefix}${SNIPPETS[key]}\n`);
        expect(out.startsWith(prefix), `${name} + ${key}: got ${JSON.stringify(out.slice(0, prefix.length + 20))}`).toBe(true);
      }
    });
  }

  it("survives a file that is nothing but frontmatter", () => {
    for (const source of ["---\na: 1\n---\n", "---\na: 1\n---", "+++\na = 1\n+++\n", "---\na: 1\n---\n\n   \n"]) {
      expect(write(source), source).toBe(source);
    }
  });

  it("survives an edit to the body", () => {
    const source = fixture("frontmatter-toml-torture.md");
    expect(write(source)).toBe(source);
    const document = parseMarkdown(source, "/toml.md");
    const heading: ProseMirrorNode[] = [];
    document.doc.forEach((child) => heading.push(child));
    const out = serializeMarkdown(document, schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("replaced")), ...heading.slice(1)]));
    expect(out.startsWith('+++\ntitle = "TOML"\nnested = "+++"\nlist = [ 1, 2 ]\n# a comment\n+++\n\n')).toBe(true);
  });

  it("survives a bom in front of yaml, and a bom in the middle of the body", () => {
    const source = fixture("frontmatter-bom-yaml.md");
    expect(write(source)).toBe(source);
    expect(write(source).startsWith("\uFEFF---\n")).toBe(true);
    expect(write(source)).toContain("a\uFEFFb");
  });

  it("does not invent frontmatter out of a leading thematic break", () => {
    // Not frontmatter: no closing delimiter. The bytes must come back as a rule and a paragraph.
    const out = write("---\na: 1\n...\n\np\n");
    expect(parseMarkdown(out, "/x.md").frontmatter).toBe(null);
    expect(out).toContain("a: 1\n...");
  });
});

// ---------------------------------------------------------------------------------------------
// Nodes only the editor can build. The parser never produces a table, a toggle or a math block, so
// nothing above exercises the serializer for them, and the second save of a document containing
// one is the first save that has to be stable.
// ---------------------------------------------------------------------------------------------

describe("editor authored nodes", () => {
  const n = schema.nodes;
  const cell = (text: string) => n.tableCell.create({ colspan: 1, rowspan: 1, colwidth: null, align: null }, text ? schema.text(text) : null);
  const row = (...cells: ProseMirrorNode[]) => n.tableRow.create(null, cells);
  const build = (...blocks: ProseMirrorNode[]) => n.doc.create(null, blocks);

  const cases: Array<[string, ProseMirrorNode]> = [
    ["a table", build(n.table.create(null, [row(cell("a"), cell("b")), row(cell("1"), cell("2"))]))],
    ["a table with a pipe in a cell", build(n.table.create(null, [row(cell("a|b")), row(cell("c"))]))],
    ["a table with a trailing backslash in a cell", build(n.table.create(null, [row(cell("a\\")), row(cell("b"))]))],
    ["a table with empty cells", build(n.table.create(null, [row(cell("a"), cell("")), row(cell(""), cell("d"))]))],
    ["a toggle with markup in its summary", build(n.toggle.create({ summary: "S & <b>", open: true }, [n.paragraph.create(null, schema.text("body"))]))],
    ["a toggle with an empty body", build(n.toggle.create({ summary: "S" }, [n.paragraph.create()]))],
    ["a math block containing dollars", build(n.mathBlock.create({ latex: "a $$ b" }))],
    ["inline math", build(n.paragraph.create(null, [schema.text("a "), n.mathInline.create({ latex: "y" }), schema.text(" b")]))],
    ["an empty callout", build(n.callout.create({ kind: "tip" }, n.paragraph.create()))],
    ["a callout inside a callout", build(n.callout.create({ kind: "note" }, [n.callout.create({ kind: "tip" }, n.paragraph.create(null, schema.text("in")))]))],
    ["an edited raw block", build(n.raw.create({ source: "<div>a</div>" }, schema.text("<div>b</div>")))],
  ];

  for (const [name, node] of cases) {
    it(`writes bytes that come straight back: ${name}`, () => {
      const once = serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/x.md" }, node);
      expect(write(once), `${name}: ${JSON.stringify(once)}`).toBe(once);
    });
  }

  it("writes an edited raw block instead of the source it was cut from", () => {
    const node = n.doc.create(null, [n.raw.create({ source: "<div>a</div>" }, schema.text("<div>b</div>"))]);
    const out = serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/x.md" }, node);
    expect(out).toBe("<div>b</div>\n");
  });
});
