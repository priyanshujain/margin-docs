// Second adversarial pass over the markdown bridge, written after the three data loss bugs in
// adversarial.test.ts were fixed. Same rules as that file: this is here to break the bridge, not
// to congratulate it.
//
// The file is in two halves.
//
// "still fixed" is the regression net. Every test in it passes, and every one of them attacks a
// fixed bug from an angle the first pass did not try: the autolink boundary from both sides and in
// every inline container, the leading thematic break in all six CommonMark spellings against every
// kind of block that can follow it, and the lone carriage return everywhere a carriage return can
// legally sit.
//
// "found" is the result. Every test in it FAILS, and each failure is a minimal input where the
// file that comes back off a save is not the file that went in. Two of them are unbounded: the
// file grows on every save and never converges, which is the "serializing is stable" promise
// broken outright rather than bent. One of them is a regression: it is the direct consequence of
// the carriage return fix, and the pre-fix code handled it correctly.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { parseToMdast } from "./handlers";
import { parseMarkdown, serializeMarkdown } from "./index";

/** One save. */
function write(source: string): string {
  const document = parseMarkdown(source, "/adversarial2.md");
  return serializeMarkdown(document, document.doc);
}

function doc(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/adversarial2.md").doc;
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

function rawBlocks(node: ProseMirrorNode): string[] {
  const out: string[] = [];
  node.descendants((child) => {
    if (child.type.name === "raw") out.push(child.textContent);
    return child.type.name !== "raw";
  });
  return out;
}

const n = schema.nodes;
const linked = (text: string, href: string) => schema.text(text, [schema.marks.link.create({ href, title: null })]);
const cell = (...content: ProseMirrorNode[]) => n.tableCell.create({ colspan: 1, rowspan: 1, colwidth: null, align: null }, content.length > 0 ? content : null);
const row = (...cells: ProseMirrorNode[]) => n.tableRow.create(null, cells);

function writeDoc(node: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/adversarial2.md" }, node);
}

// =============================================================================================
// Still fixed. These pass.
// =============================================================================================

describe("still fixed: the bare url boundary", () => {
  it("holds for a matrix of prefixes, urls and suffixes", () => {
    // The suffixes are the whole reason the fix exists: GFM forgives trailing punctuation only
    // when it is genuinely trailing, so every one of these has to come back as the same link.
    const urls = ["https://example.com", "https://example.com/a(b)", "https://example.com/p?q=1&r=2", "https://example.com/#frag", "https://example.com/x&"];
    const prefixes = ["", "See ", "(", "((", "*", "_", "~", "x", "[", "text\n"];
    const suffixes = ["", ".", "..", "?!.", ",", ":", "!", "?", "'s", '"q', ".Next", ",next", ":next", ";next", "!next", "?next", ". Next", " Next", "\nnext", ")", "))", ").", "&x", "|x", "*b*", "`c`", "$", "-", "/", "…"];

    const broken: string[] = [];
    for (const url of urls) {
      for (const prefix of prefixes) {
        for (const suffix of suffixes) {
          const source = `${prefix}<${url}>${suffix}\n`;
          const once = write(source);
          if (JSON.stringify(destinations(once)) !== JSON.stringify(destinations(source))) broken.push(`${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
          else if (write(once) !== once) broken.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("holds with no trailing newline, so the end of the input is the end of the run", () => {
    for (const source of ["See <https://example.com>.", "See <https://example.com>", "See <https://example.com>!?", "See <https://example.com>)"]) {
      expect(destinations(write(source)), source).toEqual(["https://example.com"]);
    }
  });

  it("falls back rather than run a bare url into the inline node after it", () => {
    // A following image, code span, math span or hard break is not text, so the punctuation
    // between cannot be proved trailing and the angle form has to win.
    const cases: Array<[string, ProseMirrorNode]> = [
      ["image", n.doc.create(null, [n.paragraph.create(null, [linked("https://example.com", "https://example.com"), schema.text("."), n.image.create({ src: "i.png", alt: null, title: null })])])],
      ["hard break", n.doc.create(null, [n.paragraph.create(null, [linked("https://example.com", "https://example.com"), n.hardBreak.create(), schema.text("next")])])],
      ["inline math", n.doc.create(null, [n.paragraph.create(null, [linked("https://example.com", "https://example.com"), schema.text("."), n.mathInline.create({ latex: "x" })])])],
    ];
    for (const [name, node] of cases) {
      const out = writeDoc(node);
      expect(destinations(out), `${name}: ${JSON.stringify(out)}`).toEqual(["https://example.com"]);
      expect(write(out), name).toBe(out);
    }
  });

  it("keeps the destination through emphasis, strong and strikethrough", () => {
    for (const source of ["*<https://example.com>*\n", "*<https://example.com>*.Next\n", "**<https://example.com>**\n", "_a <https://example.com>_ b\n", "~~<https://example.com>~~ x\n", "**a <https://example.com>.Next**\n"]) {
      const once = write(source);
      expect(destinations(once), source).toEqual(destinations(source));
      expect(write(once), source).toBe(once);
    }
  });

  it("does not rewrite a url the file keeps inside a raw block", () => {
    // Footnote definitions and html are raw source slices, so the autolink logic must never see
    // them and the bytes must come back exactly.
    for (const source of ["<div>\n  <https://example.com>.Next\n</div>\n", "[^n]: <https://example.com>.Next\n\nuse[^n]\n", "```\n<https://example.com>.Next\n```\n"]) {
      expect(write(source), source).toBe(source);
    }
  });

  it("does not rewrite a url in a table cell, which M2 hands to the inline writer", () => {
    // A table cell is no longer a slice of somebody else's bytes: it is modelled, so its text goes
    // through the same inline serializer as a paragraph's and meets the bare url boundary rule the
    // rest of this file is about. The cell is written a space either side, which is the house
    // style, and the destination inside it has to come out character for character all the same.
    const source = "| a |\n| --- |\n| <https://example.com>.Next |\n";
    const once = write(source);

    expect(once).toBe("| a |\n| - |\n| <https://example.com>.Next |\n");
    expect(destinations(once)).toEqual(destinations(source));
    expect(write(once)).toBe(once);
  });

  it("keeps a bare url in a heading, a quote, a list item and a callout", () => {
    for (const source of ["# See <https://example.com>.Next\n", "> See <https://example.com>.Next\n", "- See <https://example.com>.Next\n", "> [!NOTE]\n> See <https://example.com>.Next\n"]) {
      const once = write(source);
      expect(destinations(once), source).toEqual(destinations(source));
      expect(write(once), source).toBe(once);
    }
  });

  it("balances parens the way GFM does when it re-reads them", () => {
    for (const source of ["(<https://example.com>)\n", "((<https://example.com>))\n", "(<https://example.com/a(b)>)\n", "((<https://example.com/a(b)>))\n", "(<https://example.com/a(b)>\n", "<https://example.com/a(b)>)\n", "See <https://example.com/a)b> here\n", "See <https://example.com/a(b> here\n"]) {
      const once = write(source);
      expect(destinations(once), `${source} -> ${once}`).toEqual(destinations(source));
      expect(write(once), source).toBe(once);
    }
  });

  it("keeps brackets out of a bare url entirely", () => {
    for (const source of ["See <https://example.com/a[b]> here\n", "See <https://example.com/a]b> here\n", "[<https://example.com>]\n"]) {
      const once = write(source);
      expect(destinations(once), `${source} -> ${once}`).toEqual(destinations(source));
    }
  });
});

describe("still fixed: a leading thematic break", () => {
  it("keeps the block under it, for every spelling of the rule and every kind of block", () => {
    const rules = ["---", "***", "___", "- - -", "* * *", "_ _ _", "   ---", "--- ", "---\t", "-------", "+++"];
    const bodies = ["- a\n- b\n", "> q\n", "# h\n", "```\nx\n```\n", "| a |\n| - |\n| 1 |\n", "<div>x</div>\n", "[^n]: x\n\nuse[^n]\n", "1. one\n", "- [ ] task\n", "Para\n", "***\n\n- a\n"];
    const bad: string[] = [];
    for (const rule of rules) {
      for (const body of bodies) {
        const source = `${rule}\n${body}`;
        const once = write(source);
        if (write(once) !== once) bad.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
        if (/\\[-*_>#|[]/.test(once)) bad.push(`escaped ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("still tells real frontmatter from a rule, at every shape of the delimiter", () => {
    const frontmatter: string[] = ["---\na: 1\n---\n\np\n", "---\na: 1\n---", "---\na: 1\n--- ", "---\na: 1\n---\t\n\np\n", "---\n---\n", "---\n\n---\n\np\n", "---\nbody: |\n  ---\nb: 2\n---\n\np\n", "+++\na = 1\n+++\n\np\n", "+++\n+++\n", "﻿---\na: 1\n---\n\np\n", "---\na: 1\n---\n- b\n", "---\na: 1\n---\n> q\n"];
    for (const source of frontmatter) {
      expect(parseMarkdown(source, "/x.md").frontmatter, source).not.toBe(null);
      expect(write(source), source).toBe(source);
    }

    const notFrontmatter: string[] = ["---", "---\n", "----\n", "----\na: 1\n----\n\np\n", "---\na: 1\n----\n\np\n", "--- \n", "---   \nbody\n", "---\na: 1\n---x\n\np\n", " ---\na: 1\n---\n\np\n", "   ---\na: 1\n---\n\np\n", "    ---\na: 1\n---\n\np\n", "---\na: 1\n ---\n\np\n", "+++\n- a\n"];
    for (const source of notFrontmatter) {
      expect(parseMarkdown(source, "/x.md").frontmatter, source).toBe(null);
    }

    // A mark and nothing else still occupies the slot, because it is leading bytes either way.
    expect(parseMarkdown("﻿---\n- a\n", "/x.md").frontmatter).toBe("﻿");
    expect(write("﻿---\n- a\n")).toBe("﻿---\n\n- a\n");
  });

  it("does not eat the body when the frontmatter delimiter is the last thing in the file", () => {
    for (const source of ["---\na: 1\n---", "+++\na = 1\n+++", "---\n---", "---\na: 1\n--- "]) {
      expect(write(source), source).toBe(source);
      expect(parseMarkdown(source, "/x.md").frontmatter, source).toBe(source);
    }
  });
});

describe("still fixed: a lone carriage return", () => {
  it("survives everywhere the parser keeps it, and does not change what the document means", () => {
    const cases = ["para\rmore\n", "a\rb\rc", "```\nline one\rstill line one\n```\n", "```\na\rb\n```\n", "`a\rb`\n", "<div>\ra\r</div>\n", "| a |\n| - |\n| x\ry |\n", "[^n]: note\rmore\n\na[^n]\n", "- item\rtwo\n", "> q\rmore\n", "a\r*b*\n", "---\na: 1\rb: 2\n---\n\np\n", "---\ra: 1\r---\n\np\n"];
    for (const source of cases) {
      const once = write(source);
      expect(once, `${JSON.stringify(source)} lost its carriage return`).toContain("\r");
      expect(doc(once).eq(doc(source)), `${JSON.stringify(source)} -> ${JSON.stringify(once)} changed meaning`).toBe(true);
      expect(write(once), source).toBe(once);
    }
  });

  it("collapses CRLF and only CRLF, once", () => {
    for (const [source, expected] of [
      ["# H\r\n\r\npara\r\n", "# H\n\npara\n"],
      ["one\rtwo\r\nthree\n", "one\rtwo\nthree\n"],
      ["text\r\n\r\nmore\r\n", "text\n\nmore\n"],
      ["```\na\r\n```\n", "```\na\n```\n"],
    ] as Array<[string, string]>) {
      const once = write(source);
      expect(once, source).toBe(expected);
      expect(write(once), source).toBe(once);
    }
  });

  it("handles a carriage return at the end of the file and a file that is only one", () => {
    expect(write("para\r")).toBe("para\n");
    expect(write("para\r\n")).toBe("para\n");
    expect(write("\r")).toBe("");
    expect(write("\r\n")).toBe("");
    expect(write("---\na: 1\n---\r")).toBe("---\na: 1\n---\r");
  });
});

describe("still fixed: the sweeps the fix could have broken", () => {
  const SNIPPETS: Record<string, string> = {
    para: "Plain paragraph text.",
    hr: "---",
    fence: "```js\nconst x = 1;\n```",
    ul: "- one\n- two",
    quote: "> quoted",
    callout: "> [!NOTE]\n> body",
    table: "| a | b |\n| --- | --: |\n| 1 | 2 |",
    html: '<div class="x">\n  <span>y</span>\n</div>',
    footnote: "[^n]: A footnote definition.",
    defn: '[ref]: https://example.com "Title"',
    autolink: "See <https://example.com>. Next",
    autolink2: "See <https://example.com>.Next",
    bareurl: "Go to https://example.com/a for more",
    email: "Mail <a@b.com> now",
    cr: "one\rtwo",
    crfence: "```\na\rb\n```",
    math: "$$\nx^2\n$$",
    img: '![alt](i.png "t")',
    emph: "Some **bold** and _em_ and ~~del~~.",
  };
  const KEYS = Object.keys(SNIPPETS);
  const PREFIXES = ["", "---\ntitle: T\n---\n\n", '+++\ntitle = "T"\n+++\n\n', "﻿"];

  it("is idempotent for every ordered pair, at three separations, under four prefixes", () => {
    const unstable: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        for (const separator of ["\n\n", "\n\n\n", "\n"]) {
          for (const prefix of PREFIXES) {
            const source = `${prefix}${SNIPPETS[a]}${separator}${SNIPPETS[b]}\n`;
            const once = write(source);
            if (write(once) !== once) unstable.push(`${JSON.stringify(prefix)} ${a}+${b}: ${JSON.stringify(once)} -> ${JSON.stringify(write(once))}`);
          }
        }
      }
    }
    expect(unstable).toEqual([]);
  }, 30000);

  it("does not change the meaning of a document, for every ordered pair", () => {
    const changed: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n`;
        if (!doc(write(source)).eq(doc(source))) changed.push(`${a}+${b}: ${JSON.stringify(write(source))}`);
      }
    }
    expect(changed).toEqual([]);
  });

  it("writes every raw block back as the bytes it cut, for every ordered pair", () => {
    const lost: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n`;
        const document = parseMarkdown(source, "/pair.md");
        const out = serializeMarkdown(document, document.doc);
        for (const raw of rawBlocks(document.doc)) {
          if (!source.replace(/\r\n/g, "\n").includes(raw)) lost.push(`${a}+${b} not a source slice: ${JSON.stringify(raw)}`);
          else if (!out.includes(raw)) lost.push(`${a}+${b} not in the output: ${JSON.stringify(raw)}`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  it("keeps frontmatter byte identical in front of every snippet", () => {
    for (const prefix of PREFIXES.slice(1)) {
      for (const key of KEYS) {
        const out = write(`${prefix}${SNIPPETS[key]}\n`);
        expect(out.startsWith(prefix), `${key}: ${JSON.stringify(out.slice(0, prefix.length + 16))}`).toBe(true);
      }
    }
  });
});

// =============================================================================================
// Found. These fail. Each one is a save that loses or corrupts something.
// =============================================================================================

describe("found: the file grows on every save and never converges", () => {
  it("does not add a bracket pair to an email autolink whose domain has an underscore", () => {
    // `<a@b_c.com>` is not an angle autolink to CommonMark (an underscore is not legal in a
    // domain label there) but IS an email to the GFM literal autolink extension, so the tree is
    // text "<", link, text ">". The serializer refuses the bare form because the character in
    // front is "<" (correctly: a bare url may not start there), and mdast's fallback for a link
    // whose text is its own destination is the angle form. So the "<" that was already there
    // gains another, and the next save gains another, without limit.
    let current = "Mail <a@b_c.com> here\n";
    const generations: string[] = [];
    for (let generation = 0; generation < 4; generation += 1) {
      current = write(current);
      generations.push(current);
    }
    expect(generations[1], `grew: ${JSON.stringify(generations)}`).toBe(generations[0]);
  });

  it("does not double a backslash inside an autolink destination on every save", () => {
    // Backslash escapes do not apply inside `<...>`, so the destination genuinely contains a
    // backslash. mdast writes the autolink back with the backslash escaped, the parser reads the
    // escape as two characters, and the run doubles: 1, 2, 4, 8, 16 backslashes.
    const source = "See <https://example.com/a\\_b> here\n";
    const once = write(source);
    expect(destinations(once), `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).toEqual(destinations(source));
    expect(write(once), "second save must not move the file again").toBe(once);
  });
});

describe("found: a link destination changes or disappears on the first save", () => {
  it("keeps a link whose domain GFM will not autolink", () => {
    // GFM will not read a bare url back as a link when either of the last two domain labels
    // contains an underscore. `LITERAL_URL` does not know that rule, writes the url bare anyway,
    // and the link is gone from the file: not redirected, gone. The save after that escapes the
    // leftovers, so the file moves twice as well.
    const source = "See <https://exa_mple.com/a> here\n";
    const once = write(source);
    expect(destinations(once), `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).toEqual(["https://exa_mple.com/a"]);
    expect(write(once), "second save must not move the file again").toBe(once);
  });

  it("keeps a relative destination that happens to start with www.", () => {
    // `href === text` is the test for "writing this bare is the same link", and it is true here,
    // but only for a url with a scheme. A bare `www.` url is read back with `http://` bolted on,
    // so a relative link to a file called `www.example.com` becomes a link to the internet.
    for (const source of ["[www.example.com](www.example.com)\n", "See [www.a.b/c](www.a.b/c) here\n", "[www.example.com/a_b](www.example.com/a_b)\n"]) {
      const once = write(source);
      expect(destinations(once), `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).toEqual(destinations(source));
      expect(doc(once).eq(doc(source)), source).toBe(true);
    }
  });

  it("does not let a following semicolon eat the tail of the url as an entity", () => {
    // `endsWhereItSaysItDoes` counts ";" as ordinary trailing punctuation. GFM does not: a ";" at
    // the end of a bare url makes it look backwards for an "&" and drop the whole entity-shaped
    // tail, which is more than the semicolon.
    const source = "See <https://example.com/a&amp>; here\n";
    const once = write(source);
    expect(destinations(once), `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).toEqual(["https://example.com/a&amp"]);
  });

  it("keeps an email address GFM's literal autolink grammar does not accept", () => {
    // `LITERAL_EMAIL` is much looser than the grammar that has to read the result back, so the
    // bare form starts somewhere else in the address, or is not a link at all.
    for (const source of ["[a:b@c.com](mailto:a:b@c.com)\n", "[a(b@c.com](mailto:a\\(b@c.com)\n", "[a@b.com-](mailto:a@b.com-)\n", "[a@b.com_](mailto:a@b.com_)\n"]) {
      const once = write(source);
      expect(destinations(once), `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).toEqual(destinations(source));
    }
  });

  it("keeps a url that is inside the text of another link", () => {
    // Two links, one destination out. A link is a mark and marks do not nest, so the inner
    // destination has nowhere to live; writing the inner one bare then hides the loss behind a
    // file that looks fine. Losing it quietly is the thing this bridge exists not to do: the
    // outer link should fail to model and the paragraph should be kept as raw source.
    for (const source of ["[see <https://example.com> more](http://y.com)\n", "[<https://example.com>](http://y.com)\n"]) {
      const once = write(source);
      expect(destinations(once), `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).toEqual(destinations(source));
    }
  });

  it("escapes a pipe in a bare url written into a table cell", () => {
    // The bare url goes out as an inline html node, and html is written with no escaping at all.
    // Inside a table cell that is a column separator: the row gains a column and the destination
    // is truncated at the pipe. Every other inline node in a cell has its pipes escaped.
    const node = n.doc.create(null, [n.table.create(null, [row(cell(schema.text("a"))), row(cell(linked("https://example.com/a|b", "https://example.com/a|b")))])]);
    const out = writeDoc(node);
    expect(destinations(out), out).toEqual(["https://example.com/a|b"]);
  });
});

describe("found: a lone carriage return after the frontmatter welds the file together", () => {
  // A regression, and the clearest one in the file. `normaliseSource` now leaves a lone carriage
  // return alone, and the parser treats it as a line ending, so the frontmatter node ends at a
  // "\r" that `splitFrontmatter` does not recognise: it scans for "\n" to swallow the blank lines
  // after the delimiter, finds the wrong one or none at all, and stops before the line ending.
  // The frontmatter string it hands back therefore does not end a line, and the body is
  // concatenated straight onto the closing delimiter.
  //
  // The old CRLF-and-lone-CR normalisation made this impossible, so the fix caused it.

  it("keeps the closing delimiter and the body on separate lines", () => {
    const source = "---\na: 1\n---\rp\n";
    const once = write(source);
    expect(once, "the body was welded onto the closing delimiter").not.toContain("---p");
    expect(parseMarkdown(once, "/x.md").frontmatter, "the frontmatter did not survive the save").not.toBe(null);
    expect(write(once), "second save must not move the file again").toBe(once);
  });

  it("holds for toml, for a byte order mark, and for a run of carriage returns", () => {
    for (const source of ["+++\na = 1\n+++\rp\n", "﻿---\na: 1\n---\rp\n", "---\na: 1\n---\r\rp\n", "---\na: 1\n---\r\r\np\n"]) {
      const once = write(source);
      expect(parseMarkdown(once, "/x.md").frontmatter, `${JSON.stringify(source)} -> ${JSON.stringify(once)}`).not.toBe(null);
      expect(write(once), source).toBe(once);
    }
  });
});

describe("found: the preservation sweep normalises differently from the code it tests", () => {
  it("would misfire on a raw block holding a lone carriage return", () => {
    // adversarial.test.ts checks that a raw block is a slice of `source.replace(/\r\n?/g, "\n")`.
    // That was the right normalisation before the fix and is the wrong one now: `normaliseSource`
    // keeps a lone carriage return, so the raw block keeps it too and the assertion fails on a
    // block the bridge preserved perfectly. It has not fired only because no fixture in
    // corpus/adversarial/ has a carriage return inside an unmodellable block yet, and that folder
    // is a glob: the day one lands there the sweep goes red for the wrong reason.
    const source = "<div>\ra\r</div>\n";
    const document = parseMarkdown(source, "/x.md");
    const raws = rawBlocks(document.doc);

    expect(raws).toEqual(["<div>\ra\r</div>"]);
    expect(write(source), "the bridge itself preserves it exactly").toBe(source);
    for (const raw of raws) expect(source.replace(/\r\n/g, "\n"), "the sweep's own normalisation").toContain(raw);
  });
});
