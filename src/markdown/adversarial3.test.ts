// Third adversarial pass over the markdown bridge, written after the serializer was reworked to
// stop reproducing GFM's literal autolink grammar by hand and start proving the bare form instead:
// write the block with every url bare, read it back with the parser the bridge opens files with,
// and keep the bare form only when what comes back is the same block. Same rules as the two files
// before it. This is here to break the bridge, not to sign it off.
//
// The file is in two halves, the same way adversarial2.test.ts is.
//
// "still fixed" is the regression net. Every test in it passes. The six autolink losses and the
// frontmatter regression from the first two passes are pinned byte for byte rather than by
// destination, because "the destination survived" is a weaker promise than the one the bridge
// makes, and the new machinery is attacked where it is new: the fallback spelling, which is now
// load bearing and had never been attacked; blocks holding several candidates at once; and the
// question of whether a block verified on its own is still right once it is written into a file.
//
// "found" is the result. Every test in it FAILS. There is no data loss in it: no destination
// changes, nothing is dropped, nothing grows, and every input in this file still means the same
// document after a save as before it. What is left is a first save that rewrites documents nobody
// asked it to rewrite, and a save that goes quadratic on a document made of links.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { corpus } from "./corpus/load";
import { parseToMdast, stringifyMdast } from "./handlers";
import { parseMarkdown, serializeMarkdown } from "./index";

const fixtures = import.meta.glob("./corpus/adversarial/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function fixture(name: string): string {
  const source = fixtures[`./corpus/adversarial/${name}`];
  if (source === undefined) throw new Error(`no adversarial fixture named ${name}`);
  return source;
}

/** One save. */
function write(source: string): string {
  const document = parseMarkdown(source, "/adversarial3.md");
  return serializeMarkdown(document, document.doc);
}

function doc(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/adversarial3.md").doc;
}

function writeDoc(node: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/adversarial3.md" }, node);
}

/**
 * Every link and image in a file, in document order, as destination, title and text.
 *
 * The destination alone is what the first two passes checked. It is not enough for the fallback:
 * `[text](href)` writes the text out as markdown too, so a spelling that keeps the destination and
 * mangles the text is still a save that changed the file's content.
 */
function linksIn(source: string): string[] {
  const out: string[] = [];
  const text = (node: { value?: string; children?: unknown[] }): string => (node.value !== undefined ? String(node.value) : ((node.children ?? []) as Array<Parameters<typeof text>[0]>).map(text).join(""));
  const walk = (node: { type?: string; url?: string; title?: string | null; children?: unknown[] }) => {
    if (node.type === "link" || node.type === "image") out.push(`${node.type} ${node.url} ${node.title ?? ""} ${JSON.stringify(text(node))}`);
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

const n = schema.nodes;
const linked = (text: string, href: string, title: string | null = null) => schema.text(text, [schema.marks.link.create({ href, title })]);
const marked = (text: string, href: string, ...names: string[]) => schema.text(text, [schema.marks.link.create({ href, title: null }), ...names.map((name) => schema.marks[name].create())]);
const para = (...content: ProseMirrorNode[]) => n.paragraph.create(null, content);
const cell = (...content: ProseMirrorNode[]) => n.tableCell.create({ colspan: 1, rowspan: 1, colwidth: null, align: null }, content.length > 0 ? content : null);
const row = (...cells: ProseMirrorNode[]) => n.tableRow.create(null, cells);

// =============================================================================================
// Still fixed. These pass.
// =============================================================================================

describe("still fixed: the six autolink losses, byte for byte", () => {
  // Each of these cost a destination or grew the file without limit in one of the first two
  // passes. They are pinned as exact bytes rather than as surviving destinations, so that a
  // future spelling change has to be looked at rather than absorbed.
  const cases: Array<[string, string, string]> = [
    ["an email whose domain has an underscore does not gain a bracket", "Mail <a@b_c.com> here\n", "Mail <a@b_c.com> here\n"],
    ["a backslash in a destination does not double", "See <https://example.com/a\\_b> here\n", "See https://example.com/a\\_b here\n"],
    ["a domain GFM will not autolink keeps its angle brackets", "See <https://exa_mple.com/a> here\n", "See <https://exa_mple.com/a> here\n"],
    ["a relative destination starting www. stays relative", "[www.example.com](www.example.com)\n", "[www.example.com](www.example.com)\n"],
    ["a following semicolon cannot eat an entity shaped tail", "See <https://example.com/a&amp>; here\n", "See <https://example.com/a&amp>; here\n"],
    ["an address the literal grammar rejects is spelled out", "[a:b@c.com](mailto:a:b@c.com)\n", "[a:b@c.com](mailto:a:b@c.com)\n"],
    ["an address with a paren is spelled out", "[a(b@c.com](mailto:a\\(b@c.com)\n", "[a(b@c.com](mailto:a\\(b@c.com)\n"],
    ["an address ending in a dash is spelled out", "[a@b.com-](mailto:a@b.com-)\n", "[a@b.com-](mailto:a@b.com-)\n"],
    ["a url inside another link's text keeps the paragraph as source", "[see <https://example.com> more](http://y.com)\n", "[see <https://example.com> more](http://y.com)\n"],
    ["so does a url that is the whole of another link's text", "[<https://example.com>](http://y.com)\n", "[<https://example.com>](http://y.com)\n"],
    ["an apostrophe after a url is not swallowed", "Read <https://example.com>'s docs\n", "Read <https://example.com>'s docs\n"],
    ["nor is a full stop and the word after it", "See <https://example.com>.Next thing\n", "See <https://example.com>.Next thing\n"],
    ["a url that can be written bare still is", "Angle <https://example.com> here.\n", "Angle https://example.com here.\n"],
    ["so is an address that can be", "Mail <a@b.com> now\n", "Mail a@b.com now\n"],
    ["and a www url that was already bare", "www.example.com\n", "www.example.com\n"],
    ["and a url in the middle of a sentence", "Go to https://example.com/a for more\n", "Go to https://example.com/a for more\n"],
  ];

  for (const [name, source, expected] of cases) {
    it(name, () => {
      const once = write(source);
      expect(once).toBe(expected);
      expect(write(once), "second save must not move the file again").toBe(once);
      expect(linksIn(once), "the links must be the same links").toEqual(linksIn(source));
      expect(doc(once).eq(doc(source)), "and the same document").toBe(true);
    });
  }

  it("escapes a pipe in a bare url written into a table cell, without splitting the cell", () => {
    const node = n.doc.create(null, [n.table.create(null, [row(cell(schema.text("a"))), row(cell(linked("https://example.com/a|b", "https://example.com/a|b")))])]);
    const out = writeDoc(node);
    expect(linksIn(out)).toEqual(['link https://example.com/a|b  "https://example.com/a|b"']);

    // The escaped pipe has to stay inside the cell rather than opening another column, which the
    // parser is the only honest judge of: the row the url is in still has exactly one cell.
    const table = parseToMdast(out).children[0] as { type: string; children: Array<{ children: unknown[] }> };
    expect(table.type).toBe("table");
    expect(table.children.map((tableRow) => tableRow.children.length)).toEqual([1, 1]);
    expect(write(out)).toBe(out);
  });

  it("holds for the adjacency fixture as a whole file", () => {
    const source = fixture("autolink-adjacency.md");
    const once = write(source);
    expect(linksIn(once)).toEqual(linksIn(source));
    expect(write(once)).toBe(once);
  });
});

describe("still fixed: the bare url boundary, widened", () => {
  const URLS = [
    "https://example.com",
    "http://example.com",
    "www.example.com/a",
    "https://exa_mple.com/a",
    "https://a.exa_mple.com/b",
    "https://example.com/a_b",
    "https://example.com/a\\_b",
    "https://example.com/a\\b",
    "https://example.com/a&amp",
    "https://example.com/x&",
    "https://example.com/a(b)",
    "https://example.com/a(b",
    "https://example.com/a)b",
    "https://example.com/a[b]",
    "https://example.com/a]b",
    "https://example.com/a*b",
    "https://example.com/a`b",
    "https://example.com/a|b",
    "https://example.com/#frag",
    "https://example.com/?q=1&r=2",
    "https://example.com/ünïcode",
    "https://例え.jp/a",
  ];
  const SUFFIXES = ["", ".", "!?", "'s", ".Next", ";", "&x", ")", "))", "*b*", "`c`", " next", "|x", "]", "[x]", "…", "-", "\\", "<b>"];
  const PREFIXES = ["", "See ", "(", "*", "_", "~~", "x", "[", "<", "\\", "|"];

  it("keeps every link through every angle autolink and suffix, without growing", () => {
    const broken: string[] = [];
    for (const url of URLS) {
      for (const suffix of SUFFIXES) {
        const source = `See <${url}>${suffix}\n`;
        const first = write(source);
        const second = write(first);
        if (JSON.stringify(linksIn(first)) !== JSON.stringify(linksIn(source))) broken.push(`links ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
        else if (second !== first) broken.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(first)} -> ${JSON.stringify(second)}`);
        else if (!doc(first).eq(doc(source))) broken.push(`meaning ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
      }
    }
    expect(broken).toEqual([]);
  }, 20000);

  it("keeps every link through every bare url, prefix and suffix", () => {
    const broken: string[] = [];
    for (const url of URLS) {
      for (const prefix of PREFIXES) {
        for (const suffix of SUFFIXES) {
          const source = `${prefix}${url}${suffix}\n`;
          if (linksIn(source).length === 0) continue;
          const first = write(source);
          if (JSON.stringify(linksIn(first)) !== JSON.stringify(linksIn(source))) broken.push(`links ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
          else if (write(first) !== first) broken.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
        }
      }
    }
    expect(broken).toEqual([]);
  }, 30000);

  it("keeps the destination in every inline container the schema has", () => {
    const containers = ["*<URL>*", "**<URL>**", "~~<URL>~~", "_a <URL>_ b", "# <URL>", "## a <URL>.Next", "> <URL>", "> a\n> <URL>", "- <URL>", "- [ ] <URL>", "1. <URL>", "> [!NOTE]\n> a <URL>", "> [!TIP]\n> a\n>\n> <URL>", "a <URL> b", "(<URL>)", "[l](x.md) <URL>", "![i](i.png) <URL>", "`c` <URL>", "$$m$$ <URL>"];
    const broken: string[] = [];
    for (const url of ["https://example.com/a", "https://exa_mple.com/a", "a@b.com", "a@b_c.com"]) {
      for (const container of containers) {
        const source = `${container.replace("URL", url)}\n`;
        const first = write(source);
        if (JSON.stringify(linksIn(first)) !== JSON.stringify(linksIn(source))) broken.push(`links ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
        else if (write(first) !== first) broken.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(first)}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("still fixed: the fallback carries the link on its own", () => {
  // `[text](href)` is now the only spelling left when the bare form cannot be proved, so it is
  // load bearing in a way it never was: if it does not round trip, nothing catches it, because
  // the verifier compares the bare form against the explicit one and returns the explicit one
  // when neither matches.

  const URLS = [
    "https://example.com/a_b",
    "https://exa_mple.com/a",
    "https://example.com/a\\b",
    "https://example.com/a\\",
    "https://example.com/a(b)",
    "https://example.com/a(b",
    "https://example.com/a)b",
    "https://example.com/a[b]",
    "https://example.com/a]b",
    "https://example.com/a*b*c",
    "https://example.com/a`b",
    "https://example.com/a&amp",
    "https://example.com/a<b",
    "https://example.com/a>b",
    'https://example.com/a"b',
    "https://example.com/a'b",
    "https://example.com/a|b",
    "https://example.com/#frag",
    "https://example.com/a%20b",
    "https://example.com/a b",
    "https://example.com/.",
    "https://example.com/a-",
    "www.exa_mple.com",
    "https://例え.jp/パス",
  ];

  it("round trips a link whose text is its own destination, in every block that takes one", () => {
    const blocks: Array<[string, (content: ProseMirrorNode) => ProseMirrorNode]> = [
      ["paragraph", (content) => para(schema.text("See "), content, schema.text(" here"))],
      ["paragraph alone", (content) => para(content)],
      ["heading", (content) => n.heading.create({ level: 2 }, [schema.text("H "), content])],
      ["blockquote", (content) => n.blockquote.create(null, [para(content)])],
      ["callout", (content) => n.callout.create({ kind: "note" }, [para(content)])],
      ["list item", (content) => n.bulletList.create({ tight: true }, [n.listItem.create(null, [para(content)])])],
      ["task item", (content) => n.taskList.create({ tight: true }, [n.taskItem.create({ checked: false }, [para(content)])])],
      ["table cell", (content) => n.table.create(null, [row(cell(schema.text("h")), cell(schema.text("h2"))), row(cell(content), cell(schema.text("x")))])],
    ];
    const broken: string[] = [];
    for (const url of URLS) {
      for (const [name, build] of blocks) {
        const node = n.doc.create(null, [build(linked(url, url))]);
        const out = writeDoc(node);
        const want = `link ${url}  ${JSON.stringify(url)}`;
        if (!linksIn(out).includes(want)) broken.push(`${name} ${JSON.stringify(url)} -> ${JSON.stringify(out)} gave ${JSON.stringify(linksIn(out))}`);
        else if (write(out) !== out) broken.push(`${name} ${JSON.stringify(url)} unstable -> ${JSON.stringify(out)}`);
      }
    }
    expect(broken).toEqual([]);
  }, 20000);

  it("round trips a destination that could never have been bare", () => {
    const hrefs = ["", "#", "#frag", "a b.md", "a(b).md", "a(b.md", "a)b.md", "a\\b.md", "a\\", "a<b.md", "./a b/c.md", "mailto:a@b.com", "a%20b", 'a"b.md', "a'b.md", "a`b.md", "a|b.md", "../x.md", "?q=1"];
    const broken: string[] = [];
    for (const href of hrefs) {
      const node = n.doc.create(null, [para(schema.text("x "), linked("t", href), schema.text(" y"))]);
      const out = writeDoc(node);
      if (!linksIn(out).includes(`link ${href}  "t"`)) broken.push(`${JSON.stringify(href)} -> ${JSON.stringify(out)} gave ${JSON.stringify(linksIn(out))}`);
      else if (write(out) !== out) broken.push(`${JSON.stringify(href)} unstable -> ${JSON.stringify(out)}`);
    }
    expect(broken).toEqual([]);
  });

  it("round trips a fallback whose text carries marks of its own", () => {
    const url = "https://exa_mple.com/a";
    const cases: Array<[string, ProseMirrorNode]> = [
      ["strong", n.doc.create(null, [para(marked(url, url, "strong"))])],
      ["em", n.doc.create(null, [para(marked(url, url, "em"))])],
      ["strikethrough", n.doc.create(null, [para(marked(url, url, "strikethrough"))])],
      ["code", n.doc.create(null, [para(marked(url, url, "code"))])],
      ["strong and em", n.doc.create(null, [para(marked(url, url, "strong", "em"))])],
      ["half of it strong", n.doc.create(null, [para(marked("https://exa", url, "strong"), linked("_mple.com/a", url))])],
      ["a title as well", n.doc.create(null, [para(linked(url, url, 'a "quoted" title'))])],
      ["an image for text", n.doc.create(null, [para(n.image.create({ src: "i.png", alt: "a", title: null }, null, [schema.marks.link.create({ href: url, title: null })]))])],
    ];
    for (const [name, node] of cases) {
      const out = writeDoc(node);
      const found = linksIn(out).filter((entry) => entry.startsWith("link "));
      expect(found, `${name}: ${JSON.stringify(out)}`).toHaveLength(1);
      expect(found[0].startsWith(`link ${url} `), `${name}: ${JSON.stringify(out)}`).toBe(true);
      expect(write(out), name).toBe(out);
      expect(doc(write(out)).eq(doc(out)), name).toBe(true);
    }
  });
});

describe("still fixed: a block holding more than one candidate", () => {
  it("spells out only the url that cannot be bare, and keeps every destination", () => {
    const good = "https://example.com/a";
    const bad = "https://exa_mple.com/b";
    const other = "https://ok.example.com/c";
    const cases: Array<[string, ProseMirrorNode]> = [
      ["good then bad", n.doc.create(null, [para(linked(good, good), schema.text(" and "), linked(bad, bad))])],
      ["bad then good", n.doc.create(null, [para(linked(bad, bad), schema.text(" and "), linked(good, good))])],
      ["good bad good", n.doc.create(null, [para(linked(good, good), schema.text(" "), linked(bad, bad), schema.text(" "), linked(other, other))])],
      ["two bad", n.doc.create(null, [para(linked(bad, bad), schema.text(" "), linked("https://exc_mple.com/d", "https://exc_mple.com/d"))])],
      ["across list items", n.doc.create(null, [n.bulletList.create({ tight: true }, [n.listItem.create(null, [para(linked(good, good))]), n.listItem.create(null, [para(linked(bad, bad))])])])],
      ["across quote lines", n.doc.create(null, [n.blockquote.create(null, [para(linked(good, good)), para(linked(bad, bad))])])],
    ];
    for (const [name, node] of cases) {
      const out = writeDoc(node);
      const want: string[] = [];
      node.descendants((child) => {
        for (const mark of child.marks) if (mark.type.name === "link") want.push(`link ${mark.attrs.href}  ${JSON.stringify(child.textContent)}`);
        return true;
      });
      expect(linksIn(out), `${name}: ${JSON.stringify(out)}`).toEqual(want);
      expect(write(out), name).toBe(out);
    }
  });

  it("does not spell out the whole paragraph because one url in it is awkward", () => {
    const source = "See <https://a.example.com> and <https://exa_mple.com/b> and <https://c.example.com> here\n";
    const out = write(source);
    // The awkward url keeps its angle brackets rather than being spelled out, so this paragraph is
    // now byte identical to its source. The property under test is the same either way: one url the
    // bare rung cannot take must not drag the two beside it out of the bare form with it.
    expect(out).toBe("See https://a.example.com and <https://exa_mple.com/b> and https://c.example.com here\n");
    expect(linksIn(out)).toEqual(linksIn(source));
    expect(write(out)).toBe(out);
  });

  it("keeps a bare url next to a link that is not a candidate at all", () => {
    for (const source of ["[docs](./docs.md) and https://example.com/a\n", "https://example.com/a and [docs](./docs.md)\n", "[docs](./docs.md 'T') https://example.com/a\n", "![i](i.png) https://example.com/a and <a@b.com>\n"]) {
      const once = write(source);
      expect(linksIn(once), source).toEqual(linksIn(source));
      expect(write(once), source).toBe(once);
    }
  });
});

describe("still fixed: the frontmatter boundary agrees with the parser about line endings", () => {
  const heads = ["---\na: 1\n---", "---\na: 1\n--- ", "---\na: 1\n---\t", "---\n---", "---\na: 1\rb: 2\n---", "---\ra: 1\r---", "---\na: 1\r---", "---\r\na: 1\r\n---", "+++\na = 1\n+++", "+++\ra = 1\r+++", "---\nbody: |\n  ---\nb: 2\n---"];
  const separators = ["\n", "\r", "\r\n", "\n\n", "\r\r", "\r\n\r\n", "\n\r", "\r\n\r", "\r\n\n", "\n\r\r", "\r\r\r", "\n \n"];
  const bodies = ["p\n", "p", "- a\n- b\n", "> q\n", "# h\n", "```\nx\n```\n", "| a |\n| - |\n| 1 |\n", "", "\n", "para\rmore\n", "See <https://example.com>.Next\n"];

  it("keeps the slot, the body and the line between them, at every shape of the boundary", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const bom of ["", "﻿"]) {
      for (const head of heads) {
        for (const separator of separators) {
          for (const body of bodies) {
            const source = bom + head + separator + body;
            checked += 1;
            const slot = parseMarkdown(source, "/x.md").frontmatter;
            const once = write(source);
            if (write(once) !== once) bad.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
            else if (!doc(once).eq(doc(source))) bad.push(`meaning ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
            else if (slot !== null && !once.startsWith(slot)) bad.push(`slot lost ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
            else if (slot !== null && parseMarkdown(once, "/x.md").frontmatter === null) bad.push(`slot stopped being frontmatter ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(bad).toEqual([]);
  }, 30000);

  it("never welds the first body line onto the closing delimiter", () => {
    const bad: string[] = [];
    for (const bom of ["", "﻿"]) {
      for (const head of heads) {
        for (const separator of separators) {
          const source = `${bom}${head}${separator}the body\n`;
          const once = write(source);
          const slot = parseMarkdown(source, "/x.md").frontmatter;
          if (slot === null) continue;
          if (/(---|\+\+\+)the body/.test(once)) bad.push(`${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
          if (!once.includes("the body")) bad.push(`body lost ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("still tells frontmatter from a rule when the only line ending is a carriage return", () => {
    expect(parseMarkdown("---\ra: 1\r---\rp\r", "/x.md").frontmatter).toBe("---\ra: 1\r---\r");
    expect(write("---\ra: 1\r---\rp\r")).toBe("---\ra: 1\r---\rp\n");
    expect(write(write("---\ra: 1\r---\rp\r"))).toBe(write("---\ra: 1\r---\rp\r"));
  });
});

describe("still fixed: the sweeps the rework could have broken", () => {
  const SNIPPETS: Record<string, string> = {
    para: "Plain paragraph text.",
    head: "## A heading",
    hr: "---",
    fence: "```js\nconst x = 1;\n```",
    ul: "- one\n- two",
    task: "- [ ] a\n- [x] b",
    quote: "> quoted",
    callout: "> [!NOTE]\n> body",
    table: "| a | b |\n| --- | --: |\n| 1 | 2 |",
    html: '<div class="x">\n  <span>y</span>\n</div>',
    details: "<details>\n<summary>S</summary>\n\nbody\n\n</details>",
    footnote: "[^n]: A footnote definition.",
    defn: '[ref]: https://example.com "Title"',
    math: "$$\nx^2\n$$",
    img: '![alt](i.png "t")',
    link: "A [link](http://x.com) here.",
    emph: "Some **bold** and _em_ and ~~del~~.",
    autolink: "See <https://example.com>. Next",
    autolinkTight: "See <https://example.com>.Next",
    badurl: "See <https://exa_mple.com/a> here",
    backslash: "See <https://example.com/a\\_b> here",
    entity: "See <https://example.com/a&amp>; here",
    email: "Mail <a@b_c.com> here",
    bareurl: "Go to https://example.com/a for more",
    wwwrel: "[www.example.com](www.example.com)",
    manyurls: "<https://a.com> <https://b.com> <https://exa_mple.com/c> <https://d.com>",
    cr: "one\rtwo",
    crfence: "```\na\rb\n```",
    unicode: "café \u{1F469}‍\u{1F4BB} é",
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
  }, 60000);

  it("does not change the meaning of a document, for every ordered pair", () => {
    const changed: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n`;
        if (!doc(write(source)).eq(doc(source))) changed.push(`${a}+${b}: ${JSON.stringify(write(source))}`);
      }
    }
    expect(changed).toEqual([]);
  }, 20000);

  it("keeps every link in the file, for every ordered pair", () => {
    const lost: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n`;
        const once = write(source);
        if (JSON.stringify(linksIn(once)) !== JSON.stringify(linksIn(source))) lost.push(`${a}+${b}: ${JSON.stringify(linksIn(source))} -> ${JSON.stringify(linksIn(once))}`);
      }
    }
    expect(lost).toEqual([]);
  }, 20000);

  it("writes every raw block back as the bytes it cut, for every ordered pair", () => {
    const lost: string[] = [];
    for (const a of KEYS) {
      for (const b of KEYS) {
        const source = `${SNIPPETS[a]}\n\n${SNIPPETS[b]}\n`;
        const document = parseMarkdown(source, "/pair.md");
        const out = serializeMarkdown(document, document.doc);
        for (const raw of rawBlocks(document.doc)) {
          // The bridge's own normalisation, rather than an approximation of it: a lone carriage
          // return survives, and so does the CRLF at the end of a run of them.
          const normalised = source.replace(/\r*\n/g, (ending) => (ending.length === 2 ? "\n" : ending));
          if (!normalised.includes(raw)) lost.push(`${a}+${b} not a source slice: ${JSON.stringify(raw)}`);
          else if (!out.includes(raw)) lost.push(`${a}+${b} not in the output: ${JSON.stringify(raw)}`);
        }
      }
    }
    expect(lost).toEqual([]);
  }, 20000);

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
          continue;
        }
        const out = serializeMarkdown(document, edited);
        if (out !== base.replace("EDITME", "EDITED")) bad.push(`${a}|${b}\n  want ${JSON.stringify(base.replace("EDITME", "EDITED"))}\n  got  ${JSON.stringify(out)}`);
      }
    }
    expect(bad).toEqual([]);
  }, 30000);

  it("keeps frontmatter byte identical in front of every snippet", () => {
    for (const prefix of PREFIXES.slice(1)) {
      for (const key of KEYS) {
        const out = write(`${prefix}${SNIPPETS[key]}\n`);
        expect(out.startsWith(prefix), `${key}: ${JSON.stringify(out.slice(0, prefix.length + 16))}`).toBe(true);
      }
    }
  });

  it("is a one paragraph diff on the file full of things the editor cannot model", () => {
    // The house style form of the fixture, not its bytes: its table is written compact and M2 pads
    // a modelled table out to its column on the save that settles the file. That one time rewrite
    // is roundtrip.test.ts's to police. What is asked here is what happens after it.
    const source = write(fixture("locality-edit.md"));
    expect(write(source), "the baseline must be byte stable").toBe(source);
    const document = parseMarkdown(source, "/locality-edit.md");
    const out = serializeMarkdown(document, retypeParagraph(document.doc, "EDITME", "EDITED"));
    expect(out).toBe(source.replace("EDITME", "EDITED"));
  });
});

describe("still fixed: nothing grows on the tenth save", () => {
  // Two of the three losses the second pass found were files that grew on every save, so this is
  // the cheap sweep that catches the whole class: save ten times and the length has to stop moving
  // after the first.
  function tenSaves(name: string, source: string, growing: string[]) {
    const generations: string[] = [];
    let current = source;
    for (let generation = 0; generation < 10; generation += 1) {
      current = write(current);
      generations.push(current);
    }
    for (let generation = 1; generation < generations.length; generation += 1) {
      if (generations[generation] !== generations[0]) {
        growing.push(`${name}: save ${generation + 1} differs, lengths ${generations.map((text) => text.length).join(",")}`);
        return;
      }
    }
  }

  it("holds for every file in the corpus", () => {
    const growing: string[] = [];
    for (const file of corpus()) tenSaves(file.name, file.source, growing);
    expect(growing).toEqual([]);
  }, 20000);

  it("holds for every adversarial fixture", () => {
    const growing: string[] = [];
    for (const [name, source] of Object.entries(fixtures)) tenSaves(name, source, growing);
    expect(growing).toEqual([]);
  }, 20000);

  it("holds for every construct that has ever gone wrong here, alone and paired", () => {
    const CONSTRUCTS: Record<string, string> = {
      angle: "See <https://example.com>. Next",
      angleTight: "See <https://example.com>.Next",
      badDomain: "See <https://exa_mple.com/a> here",
      backslash: "See <https://example.com/a\\_b> here",
      entity: "See <https://example.com/a&amp>; here",
      emailUnderscore: "Mail <a@b_c.com> here",
      email: "Mail <a@b.com> now",
      wwwRelative: "[www.example.com](www.example.com)",
      wrapped: "See the docs\nhttps://example.com/a\nfor more",
      wrappedAngle: "See\n<https://example.com/a>",
      calloutUrl: "> [!NOTE]\n> https://example.com/a",
      calloutUrlInline: "> [!NOTE]\n> See https://example.com/a here",
      hardBreakUrl: "a\\\nhttps://example.com/a",
      several: "<https://a.com> <https://b.com> <https://exa_mple.com/c> <https://d.com>",
      nested: "- a\n  - <https://exa_mple.com/b>",
      innerLink: "[see <https://example.com> more](http://y.com)",
      rule: "---",
      cr: "one\rtwo",
      html: "<div>x</div>",
      footnote: "[^n]: note",
      table: "| a | b |\n| --- | --: |\n| 1 | 2 |",
    };
    const keys = Object.keys(CONSTRUCTS);
    const growing: string[] = [];
    for (const key of keys) {
      for (const prefix of ["", "---\ntitle: T\n---\n\n", '+++\nt = "1"\n+++\n\n', "﻿"]) tenSaves(`${JSON.stringify(prefix)} ${key}`, `${prefix}${CONSTRUCTS[key]}\n`, growing);
    }
    for (const a of keys) for (const b of keys) tenSaves(`${a}+${b}`, `${CONSTRUCTS[a]}\n\n${CONSTRUCTS[b]}\n`, growing);
    expect(growing).toEqual([]);
  }, 60000);

  it("holds for the editor's own nodes, which no parse ever produces", () => {
    const url = "https://exa_mple.com/a|b";
    const nodes: Array<[string, ProseMirrorNode]> = [
      ["a table of urls", n.doc.create(null, [n.table.create(null, [row(cell(schema.text("a")), cell(schema.text("b"))), row(cell(linked(url, url)), cell(linked("https://ok.com", "https://ok.com")))])])],
      ["a callout of urls", n.doc.create(null, [n.callout.create({ kind: "note" }, [para(linked("https://a.com", "https://a.com")), para(linked(url, url))])])],
      ["a toggle of urls", n.doc.create(null, [n.toggle.create({ summary: "S", open: true }, [para(linked("https://a.com", "https://a.com"))])])],
      ["a url with a title", n.doc.create(null, [para(linked("https://a.com", "https://a.com", "T"))])],
      ["a url in every mark", n.doc.create(null, [para(marked("https://a.com", "https://a.com", "strong", "em", "strikethrough"))])],
    ];
    const growing: string[] = [];
    for (const [name, node] of nodes) tenSaves(name, writeDoc(node), growing);
    expect(growing).toEqual([]);
  });
});

// =============================================================================================
// Found. These fail.
// =============================================================================================

describe("found: a bare url that starts a line is spelled out on the first save", () => {
  // The serializer writes a bare url as an inline html node. mdast writes a text node that ends in
  // a soft line break followed by an inline html node onto ONE line: the line ending is turned
  // into a space. So the bare spelling of a url that begins a continuation line is not the same
  // paragraph, and the verifier is right to refuse it.
  //
  // Refusing it is not the bug. The bug is that the serializer has no spelling left that keeps the
  // file as it is: the angle form was removed from the house style in the same change, so what is
  // written is `[url](url)`, and an ordinary hard wrapped document with a url at the start of a
  // line is rewritten the first time it is opened and saved. That is precisely the diff the bare
  // url machinery exists to avoid, and it is not on the cosmetic list in adversarial.test.ts that
  // a first save is allowed to produce.
  //
  // Nothing is lost: the destination, the text, the line break and the meaning all survive, the
  // second save is stable and the file does not grow. It is a rewrite nobody asked for.

  it("cannot write a bare url onto a continuation line at all", () => {
    const written = stringifyMdast({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "See the docs\n" }, { type: "html", value: "https://example.com/a" }] }],
    });
    expect(written, "the soft line break in front of the url was turned into a space").toBe("See the docs\nhttps://example.com/a\n");
  });

  it("leaves a wrapped paragraph whose next line is a url alone", () => {
    const source = "See the docs\nhttps://example.com/a\nfor more.\n";
    expect(write(source)).toBe(source);
  });

  it("leaves a callout whose body line is a url alone", () => {
    // Here the fallback is not optional: the bare spelling would put the label and the url on one
    // line, `> [!NOTE] https://example.com/a`, which is not a GitHub alert at all. The label is
    // written as inline html and the newline after it is the same soft break, so a callout whose
    // first paragraph starts with a url can never keep it bare.
    for (const source of ["> [!NOTE]\n> https://example.com/a\n", "> [!TIP]\n> a@b.com\n"]) {
      expect(write(source), source).toBe(source);
    }
  });

  it("leaves a url after a hard break alone", () => {
    expect(write("a\\\nhttps://example.com/a\n")).toBe("a\\\nhttps://example.com/a\n");
  });

  it("leaves a list item that wraps onto a url alone", () => {
    expect(write("- item\n  https://example.com/a\n")).toBe("- item\n  https://example.com/a\n");
  });

  it("shows up all over an ordinary hard wrapped file", () => {
    const source = fixture("wrapped-url.md");
    const once = write(source);
    // Everything that matters survives, which is why this is a rewrite and not a loss.
    expect(linksIn(once)).toEqual(linksIn(source));
    expect(doc(once).eq(doc(source))).toBe(true);
    expect(write(once)).toBe(once);
    expect(once, "eight of the ten urls in the file were spelled out").toBe(source);
  });
});

describe("found: one url that cannot be bare makes every save quadratic", () => {
  // When the whole block will not verify with every url bare, each candidate is tried on its own,
  // and each try writes the whole block out and reads the whole block back. A block with N urls in
  // it therefore costs N round trips through the parser, and the cost is paid on every save
  // forever, not once: the `[url](url)` the fallback writes is read back as a link whose text is
  // its own destination, which is a candidate again next time.
  //
  // A 7 KB list of links with one awkward url in it takes seconds to save. The same list without
  // it takes milliseconds, because the fast path verifies the whole block in a single round trip.

  function linkList(count: number, awkward: boolean): string {
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) lines.push(`- Item ${index}: <https://example.com/${index}>`);
    if (awkward) lines.push("- Odd one out: <https://exa_mple.com/x>");
    return `${lines.join("\n")}\n`;
  }

  it("costs about the same either way", () => {
    const plain = linkList(100, false);
    const awkward = linkList(100, true);
    write(plain);
    write(awkward);

    const startPlain = performance.now();
    write(plain);
    const plainCost = performance.now() - startPlain;

    const startAwkward = performance.now();
    write(awkward);
    const awkwardCost = performance.now() - startAwkward;

    expect(awkwardCost / Math.max(plainCost, 1), `${plainCost.toFixed(0)}ms without the awkward url, ${awkwardCost.toFixed(0)}ms with it`).toBeLessThan(20);
  }, 30000);
});
