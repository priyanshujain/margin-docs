// Fifth and final adversarial pass over the markdown bridge, written after the delete handler was
// given the `encodeInfo` guard and the angle rung was put back on the autolink ladder. Same rules
// as the four files before it: this is here to break the bridge, not to sign it off.
//
// The file is in three parts.
//
// "audited" re-proves the four expectations that were changed in adversarial3.test.ts under
// authorisation. Each is checked against the property the old expectation carried rather than
// against the new bytes: same destinations, same text, same document, and stable over ten saves
// rather than two. None of the four is a weakening. The changes are recorded honestly.
//
// "still fixed" is the regression net and it passes. The angle rung is attacked where the second
// pass broke it, over ten generations rather than two, and the delete handler is attacked with the
// sweep the fourth pass said nobody had run: every ordered pair of the five marks the schema has,
// nested inside each other, spanning partially and fully, with and without whitespace at the
// boundary, inside every block type the editor can build. Then every sweep that has passed before.
//
// "found" is the result, and it is data loss. A mark nested inside itself in the source, spanning a
// link, doubles its delimiters on the way out. GFM reads a doubled run as literal text, so the
// document permanently gains characters the author never typed and the link loses its text. At two
// levels of nesting it converges after one extra save with the text corrupted; at three it grows by
// thirty two bytes on every save for the rest of the file's life. The cause is in the parser rather
// than in either of the two things this pass was sent to attack, which is why four passes over the
// serializer did not see it.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { corpus } from "./corpus/load";
import { parseToMdast } from "./handlers";
import { parseMarkdown, serializeMarkdown } from "./index";

const fixtures = import.meta.glob("./corpus/adversarial/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** One save. */
function write(source: string): string {
  const document = parseMarkdown(source, "/adversarial5.md");
  return serializeMarkdown(document, document.doc);
}

function doc(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/adversarial5.md").doc;
}

function writeDoc(node: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/adversarial5.md" }, node);
}

/** The generations a file goes through, so growth and convergence are one call apart. */
function saves(source: string, count: number): string[] {
  const out: string[] = [];
  let current = source;
  for (let generation = 0; generation < count; generation += 1) {
    current = write(current);
    out.push(current);
  }
  return out;
}

/** Every link and image in a file, in document order, as destination, title and text. */
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

/** Every character the document says, with the markup taken off. */
function saidText(source: string): string {
  const walk = (node: { value?: string; children?: unknown[] }): string => (node.value !== undefined ? String(node.value) : ((node.children ?? []) as Array<Parameters<typeof walk>[0]>).map(walk).join(""));
  return walk(parseToMdast(source) as unknown as Parameters<typeof walk>[0]);
}

const n = schema.nodes;
const para = (...content: ProseMirrorNode[]) => n.paragraph.createChecked(null, content);
const only = (...blocks: ProseMirrorNode[]) => n.doc.createChecked(null, blocks);
const cell = (...content: ProseMirrorNode[]) => n.tableCell.createChecked({ colspan: 1, rowspan: 1, colwidth: null, align: null }, content.length > 0 ? content : null);
const row = (...cells: ProseMirrorNode[]) => n.tableRow.createChecked(null, cells);
const linked = (text: string, href: string) => schema.text(text, [schema.marks.link.create({ href, title: null })]);

/**
 * A mark by name, with a link's attributes filled in.
 *
 * Everything below builds documents through `createChecked` rather than `create`, because an
 * invalid document written by a test proves nothing about a valid one and reads exactly like a
 * finding: a cell holding a paragraph, which the schema forbids, serializes as its bare text.
 */
const mk = (name: string, href = "./x.md") => (name === "link" ? schema.marks.link.create({ href, title: null }) : schema.marks[name as "strong"].create());
const marked = (text: string, ...names: string[]) => schema.text(text, names.map((name) => mk(name)));

// =============================================================================================
// Audited: the four expectations changed in adversarial3.test.ts under authorisation.
// =============================================================================================

describe("audited: the four authorised expectation changes", () => {
  // The old expectation and the new one, so the change is in the file rather than only in a
  // report. What is asserted is not the new bytes but the property the old bytes carried: the
  // links are the same links, the text is the same text, the document is the same document, and
  // the file stops moving. A change that kept nicer bytes and dropped one of those would be a
  // weakening, and none of these four is one.
  const changed: Array<[string, string, string, string]> = [
    ["a domain GFM will not autolink", "See <https://exa_mple.com/a> here\n", "See [https://exa\\_mple.com/a](https://exa_mple.com/a) here\n", "See <https://exa_mple.com/a> here\n"],
    ["an entity shaped tail", "See <https://example.com/a&amp>; here\n", "See [https://example.com/a\\&amp](https://example.com/a\\&amp); here\n", "See <https://example.com/a&amp>; here\n"],
    ["an apostrophe after a url", "Read <https://example.com>'s docs\n", "Read [https://example.com](https://example.com)'s docs\n", "Read <https://example.com>'s docs\n"],
    ["a full stop and the word after it", "See <https://example.com>.Next thing\n", "See [https://example.com](https://example.com).Next thing\n", "See <https://example.com>.Next thing\n"],
  ];

  for (const [name, source, oldExpected, newExpected] of changed) {
    it(`${name}: the new spelling still carries every destination`, () => {
      const once = write(source);
      expect(once, "the recorded new expectation must be what the bridge writes").toBe(newExpected);
      expect(linksIn(once), "same destinations, titles and link text as the source").toEqual(linksIn(source));
      expect(saidText(once), "and the same characters, with the markup taken off").toBe(saidText(source));
      expect(doc(once).eq(doc(source)), "and the same document").toBe(true);
    });

    it(`${name}: the old spelling carried the same destinations, so the change is a spelling`, () => {
      // If the expectation that was replaced had described a different document, the change would
      // have been a behaviour change dressed as a spelling change. Both spellings are read back
      // and compared against the source, so the claim is checked rather than trusted.
      expect(linksIn(oldExpected), "the old expectation's destinations").toEqual(linksIn(source));
      expect(saidText(oldExpected), "the old expectation's text").toBe(saidText(source));
      expect(doc(oldExpected).eq(doc(source)), "the old expectation's document").toBe(true);
    });

    it(`${name}: stops moving, over ten saves rather than two`, () => {
      const generations = saves(source, 10);
      expect(new Set(generations).size, `ten generations: ${JSON.stringify(generations.filter((g) => g !== generations[0]).slice(0, 2))}`).toBe(1);
      expect(linksIn(generations[9]), "ten saves later, the same destinations").toEqual(linksIn(source));
      expect(saidText(generations[9]), "ten saves later, the same text").toBe(saidText(source));
    });
  }

  it("the four changes are the only ones the angle rung needed, and a fifth was missed", () => {
    // adversarial3.test.ts pins one more expectation that the angle rung moved and that was not
    // updated with the other four, so the suite does not currently pass. It is a spelling: all
    // three destinations survive and the file is stable. Recorded here as the property, so this
    // file states what is true whichever spelling that test ends up pinning.
    const source = "See <https://a.example.com> and <https://exa_mple.com/b> and <https://c.example.com> here\n";
    const generations = saves(source, 10);
    expect(linksIn(generations[9])).toEqual(linksIn(source));
    expect(saidText(generations[9])).toBe(saidText(source));
    expect(new Set(generations).size).toBe(1);
  });
});

// =============================================================================================
// Still fixed: the angle rung, where the second pass broke it.
// =============================================================================================

describe("still fixed: the angle rung the second pass removed", () => {
  // Both of the second pass's growths were in `<url>`, and both were stable on the second save and
  // only diverged afterwards, so everything here is ten generations rather than two.
  const cases: Array<[string, string]> = [
    ["an email whose domain has an underscore", "Mail <a@b_c.com> here\n"],
    ["a backslash in a destination", "See <https://example.com/a\\_b> here\n"],
    ["a backslash in a destination GFM will not autolink", "See <https://exa_mple.com/a\\_b> here\n"],
    ["a doubled backslash run", "See <https://exa_mple.com/a\\\\b> here\n"],
    ["an entity shaped tail", "See <https://exa_mple.com/a&amp> here\n"],
    ["a host with no dot", "Mail <a@localhost> now\n"],
    ["an angle url that is the whole paragraph", "<https://exa_mple.com/a>\n"],
  ];

  for (const [name, source] of cases) {
    it(`${name} neither grows nor loses its destination over ten saves`, () => {
      const generations = saves(source, 10);
      expect(generations[9].length, `lengths: ${generations.map((g) => g.length).join(",")}`).toBe(generations[1].length);
      expect(new Set(generations.slice(1)).size, "must reach a fixed point on the second save").toBe(1);
      expect(linksIn(generations[9]), "the destinations must survive").toEqual(linksIn(source));
      expect(saidText(generations[9]), "and the text must survive").toBe(saidText(source));
    });
  }

  it("verification, not the shape of the url, is what keeps the rung safe", () => {
    // Every one of these is a url the bare form cannot carry, so the rung is what is under test.
    // A url the angle form cannot carry either has to fall through to `[text](url)` rather than be
    // written and hoped for, and either way the destination is the thing that has to survive.
    const URLS = [
      "https://exa_mple.com/a",
      "https://exa_mple.com/a|b",
      "https://exa_mple.com/a\\_b",
      "https://exa_mple.com/a\\\\b",
      "https://exa_mple.com/a&amp",
      "https://exa_mple.com/a?b=1&c=2",
      "https://exa_mple.com/(a)",
      "https://exa_mple.com/a)b",
      "https://exa_mple.com/a]b",
      "https://exa_mple.com/a'b",
      "https://exa_mple.com/a`b",
      "https://exa_mple.com/*a*",
      "https://exa_mple.com/a__b",
      "https://exa_mple.com/a<b",
      "https://exa_mple.com/a b",
      "https://exa_mple.com/#a",
      "https://exa_mple.com/a%20b",
      "ftp://exa_mple.com/x",
      "a@localhost",
      "a@b_c.com",
      "a@b..com",
      "mailto:a@b_c.com",
    ];
    const builds: Array<[string, (link: ProseMirrorNode) => ProseMirrorNode]> = [
      ["alone", (link) => para(link)],
      ["mid sentence", (link) => para(schema.text("See "), link, schema.text(" here"))],
      ["continuation line", (link) => para(schema.text("See\n"), link)],
      ["tight suffix", (link) => para(link, schema.text(".Next"))],
      ["apostrophe", (link) => para(link, schema.text("'s"))],
      ["semicolon", (link) => para(link, schema.text("; x"))],
      ["between angles", (link) => para(schema.text("<"), link, schema.text(">"))],
      ["heading", (link) => n.heading.createChecked({ level: 2 }, [link])],
      ["callout", (link) => n.callout.createChecked({ kind: "note" }, [para(link)])],
      ["list item", (link) => n.bulletList.createChecked({ tight: true }, [n.listItem.createChecked(null, [para(link)])])],
      ["table cell", (link) => n.table.createChecked(null, [row(cell(schema.text("h"))), row(cell(link))])],
      ["struck", (link) => para(schema.text("x "), link, schema.text(" y"))],
      ["among good urls", (link) => para(linked("https://a.com", "https://a.com"), schema.text(" "), link, schema.text(" "), linked("https://b.com", "https://b.com"))],
    ];

    const found: string[] = [];
    for (const url of URLS) {
      const href = url.includes("@") && !url.includes("://") && !url.startsWith("mailto:") ? `mailto:${url}` : url;
      for (const [name, build] of builds) {
        const node = only(build(linked(url, href)));
        const out = writeDoc(node);

        const want: string[] = [];
        node.descendants((child) => {
          for (const mark of child.marks) if (mark.type.name === "link") want.push(`link ${mark.attrs.href}  ${JSON.stringify(child.textContent)}`);
          return true;
        });
        if (JSON.stringify(linksIn(out)) !== JSON.stringify(want)) found.push(`${name} ${JSON.stringify(url)} lost a destination: ${JSON.stringify(out)} read ${JSON.stringify(linksIn(out))} wanted ${JSON.stringify(want)}`);

        const generations = saves(out, 10);
        if (generations[9] !== out) found.push(`${name} ${JSON.stringify(url)} did not settle: ${JSON.stringify(out)} -> ${JSON.stringify(generations[9])}`);
        if (generations[9].length !== out.length) found.push(`${name} ${JSON.stringify(url)} grew: ${[out.length, ...generations.map((g) => g.length)].join(",")}`);
      }
    }
    expect(found).toEqual([]);
  }, 30000);
});

// =============================================================================================
// Still fixed: the delete handler, and the mark nesting sweep nobody had run.
// =============================================================================================

/**
 * Every run of literal text in a piece of markdown, with the set of marks covering it.
 *
 * This is the comparison the sweep needs and neither of the two the earlier passes used will do.
 * Comparing whole files cannot say which of two spellings is right, comparing destinations misses
 * a lost emphasis entirely, and comparing documents with `eq` fails for reasons that have nothing
 * to do with marks: a table is not modelled by the parser at all and comes back as a raw block, and
 * a one item loose list comes back tight. Runs of text with their marks are exactly what a mark
 * bug damages and nothing else touches.
 */
const WRAPPER: Record<string, string> = { emphasis: "em", strong: "strong", delete: "strikethrough" };

function spansOf(markdown: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (text: string, marks: string[]) => {
    if (!text) return;
    const key = [...marks].sort().join("+");
    const last = out[out.length - 1];
    if (last && last[1] === key) last[0] += text;
    else out.push([text, key]);
  };
  const walk = (node: { type?: string; value?: string; url?: string; alt?: string | null; children?: unknown[] }, marks: string[]) => {
    if (node.type === "text" || node.type === "html") return push(String(node.value ?? ""), marks);
    if (node.type === "inlineCode") return push(String(node.value ?? ""), [...marks, "code"]);
    if (node.type === "break") return push("\n", marks);
    if (node.type === "image") return push(` img:${node.url}:${node.alt ?? ""}`, marks);
    if (node.type === "inlineMath") return push(` math:${node.value}`, marks);
    const inner = node.type === "link" ? [...marks, `link:${node.url}`] : WRAPPER[node.type ?? ""] ? [...marks, WRAPPER[node.type ?? ""]] : marks;
    for (const child of (node.children ?? []) as Array<Parameters<typeof walk>[0]>) walk(child, inner);
    if (node.children && !["link", "emphasis", "strong", "delete"].includes(node.type ?? "")) push(" /", []);
  };
  for (const child of ((parseToMdast(markdown) as unknown as { children?: unknown[] }).children ?? []) as Array<Parameters<typeof walk>[0]>) walk(child, []);
  return out;
}

/** The same reading, taken off the document the editor holds, so the two can be compared. */
function spansOfDoc(document: ProseMirrorNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (text: string, marks: string[]) => {
    if (!text) return;
    const key = [...marks].sort().join("+");
    const last = out[out.length - 1];
    if (last && last[1] === key) last[0] += text;
    else out.push([text, key]);
  };
  const names = (node: ProseMirrorNode) => node.marks.map((mark) => (mark.type.name === "link" ? `link:${mark.attrs.href}` : mark.type.name));
  const walk = (node: ProseMirrorNode) => {
    // The callout's label is an attribute in the document and text in the file.
    if (node.type.name === "callout") push(`[!${String(node.attrs.kind).toUpperCase()}]\n`, []);
    node.forEach((child) => {
      if (child.isText) push(child.text ?? "", names(child));
      else if (child.type.name === "hardBreak") push("\n", names(child));
      else if (child.type.name === "image") push(` img:${child.attrs.src}:${child.attrs.alt ?? ""}`, names(child));
      else if (child.type.name === "mathInline") push(` math:${child.attrs.latex}`, names(child));
      else {
        walk(child);
        if (child.isBlock) push(" /", []);
      }
    });
  };
  walk(document);
  return out;
}

/** The eleven containers an inline run can sit in, built straight from the schema. */
const CONTAINERS: Array<[string, (inline: ProseMirrorNode[]) => ProseMirrorNode]> = [
  ["paragraph", (i) => para(...i)],
  ["heading", (i) => n.heading.createChecked({ level: 3 }, i)],
  ["blockquote", (i) => n.blockquote.createChecked(null, [para(...i)])],
  ["callout", (i) => n.callout.createChecked({ kind: "warning" }, [para(...i)])],
  ["bulletList", (i) => n.bulletList.createChecked({ tight: true }, [n.listItem.createChecked(null, [para(...i)])])],
  ["orderedList", (i) => n.orderedList.createChecked({ tight: true, start: 1 }, [n.listItem.createChecked(null, [para(...i)])])],
  ["taskList", (i) => n.taskList.createChecked({ tight: true }, [n.taskItem.createChecked({ checked: false }, [para(...i)])])],
  ["looseList", (i) => n.bulletList.createChecked({ tight: false }, [n.listItem.createChecked(null, [para(...i)])])],
  ["listInQuote", (i) => n.blockquote.createChecked(null, [n.bulletList.createChecked({ tight: true }, [n.listItem.createChecked(null, [para(...i)])])])],
  ["secondParagraph", (i) => n.blockquote.createChecked(null, [para(schema.text("lead")), para(...i)])],
  ["tableCell", (i) => n.table.createChecked(null, [row(cell(schema.text("h")), cell(schema.text("k"))), row(cell(...i), cell(schema.text("z")))])],
];

const MARKS = ["link", "strikethrough", "strong", "em", "code"];

/** Every pair the schema actually permits: code excludes the formatting marks, and is a leaf. */
function pairs(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const outer of MARKS) {
    for (const inner of MARKS) {
      if (outer === inner || outer === "code") continue;
      if (inner === "code" && outer !== "link") continue;
      out.push([outer, inner]);
    }
  }
  return out;
}

describe("still fixed: every mark nested inside every other, in every block", () => {
  // The fourth pass found the delete handler's missing whitespace guard and said why three passes
  // had missed it: the sweeps carried strikethrough and link as sibling snippets and never nested
  // them. This is that gap closed. Thirteen ordered pairs, five spanning shapes, three boundary
  // paddings and eleven containers, which is 2145 documents, each built from the schema, written,
  // read back and then saved ten more times.

  it("keeps every mark over every span, in every container, without moving or growing", () => {
    const found: string[] = [];
    let checked = 0;

    for (const [container, build] of CONTAINERS) {
      for (const [outer, inner] of pairs()) {
        for (const pad of ["", " ", "\t"]) {
          const shapes: Array<[string, ProseMirrorNode[]]> = [
            ["partial", [marked("aa", outer), marked(`${pad}bb${pad}`, outer, inner), marked("cc", outer)]],
            ["full", [marked(`${pad}bb${pad}`, outer, inner)]],
            ["head", [marked(`${pad}bb${pad}`, outer, inner), marked("cc", outer)]],
            ["tail", [marked("aa", outer), marked(`${pad}bb${pad}`, outer, inner)]],
            ["surrounded", [schema.text("pre"), marked("aa", outer), marked(`${pad}bb${pad}`, outer, inner), marked("cc", outer), schema.text("post")]],
          ];

          for (const [shape, inline] of shapes) {
            checked += 1;
            const where = `${container} ${outer} over ${inner} ${shape} pad=${JSON.stringify(pad)}`;
            const node = only(build(inline));
            const out = writeDoc(node);

            const want = JSON.stringify(spansOfDoc(node));
            const got = JSON.stringify(spansOf(out));
            if (want !== got) found.push(`${where} changed the marked text\n    wrote ${JSON.stringify(out)}\n    want  ${want}\n    got   ${got}`);

            const generations = saves(out, 10);
            if (generations[9] !== out) found.push(`${where} did not settle\n    wrote ${JSON.stringify(out)}\n    ten   ${JSON.stringify(generations[9])}`);
            if (generations[9].length !== out.length) found.push(`${where} grew: ${[out.length, ...generations.map((g) => g.length)].join(",")}`);
          }
        }
      }
    }

    expect(checked, "the sweep has to actually be the size it claims").toBe(2145);
    expect(found).toEqual([]);
  }, 120000);

  it("keeps three and four marks nested at once", () => {
    const found: string[] = [];
    const NESTABLE = ["link", "strikethrough", "strong", "em"];
    for (const a of NESTABLE) {
      for (const b of NESTABLE) {
        for (const c of NESTABLE) {
          if (a === b || b === c || a === c) continue;
          for (const pad of ["", " "]) {
            const cases: Array<[string, ProseMirrorNode]> = [
              [`${a}>${b}>${c} stepped`, only(para(marked("q", a), marked("r", a, b), marked(`${pad}s${pad}`, a, b, c), marked("u", a, b), marked("v", a)))],
              [`${a}>${b}>${c} whole`, only(para(marked(`${pad}s${pad}`, a, b, c)))],
              [`${a}>${b}>${c} all four`, only(para(marked("q", a), marked(`${pad}s${pad}`, "link", "strikethrough", "strong", "em"), marked("v", a)))],
            ];
            for (const [name, node] of cases) {
              const out = writeDoc(node);
              if (JSON.stringify(spansOfDoc(node)) !== JSON.stringify(spansOf(out))) found.push(`${name} pad=${JSON.stringify(pad)} changed the marked text: ${JSON.stringify(out)}`);
              const generations = saves(out, 10);
              if (generations[9] !== out) found.push(`${name} pad=${JSON.stringify(pad)} did not settle: ${JSON.stringify(out)} -> ${JSON.stringify(generations[9])}`);
            }
          }
        }
      }
    }
    expect(found).toEqual([]);
  }, 30000);

  it("keeps a mark that covers an image, a hard break or an inline equation", () => {
    const found: string[] = [];
    const image = (names: string[]) => n.image.createChecked({ src: "./i.png", alt: "a", title: null }, null, names.map((name) => mk(name)));
    const brk = (names: string[]) => n.hardBreak.createChecked(null, null, names.map((name) => mk(name)));
    const math = (names: string[]) => n.mathInline.createChecked({ latex: "x^2" }, null, names.map((name) => mk(name)));

    for (const outer of ["strikethrough", "strong", "em", "link"]) {
      const cases: Array<[string, ProseMirrorNode]> = [
        [`${outer} over an image`, only(para(marked("a", outer), image([outer]), marked("b", outer)))],
        [`${outer} over a hard break`, only(para(marked("a", outer), brk([outer]), marked("b", outer)))],
        [`${outer} over an equation`, only(para(marked("a", outer), math([outer]), marked("b", outer)))],
        [`${outer} over an image alone`, only(para(image([outer])))],
      ];
      for (const [name, node] of cases) {
        const out = writeDoc(node);
        if (JSON.stringify(spansOfDoc(node)) !== JSON.stringify(spansOf(out))) found.push(`${name}: ${JSON.stringify(out)}`);
        if (saves(out, 10)[9] !== out) found.push(`${name} did not settle: ${JSON.stringify(out)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("keeps a marked run whose content is nothing but delimiters", () => {
    const found: string[] = [];
    const CONTENT = [" ", "  ", "\t", " ", "*", "_", "~", "~~", "`", "[", "]", "\\", "<", ">", "&", "|", "#", "-", "​", "\n", " x ", "*x*", "~~x~~", "&#x20;"];
    for (const content of CONTENT) {
      for (const outer of ["strikethrough", "strong", "em"]) {
        const cases: Array<[string, ProseMirrorNode]> = [
          [`${outer} ${JSON.stringify(content)} between text`, only(para(schema.text("L"), marked(content, outer), schema.text("R")))],
          [`${outer} ${JSON.stringify(content)} alone`, only(para(marked(content, outer)))],
          [`${outer} ${JSON.stringify(content)} after a link`, only(para(linked("L", "./x.md"), schema.text(" "), marked(content, outer)))],
        ];
        for (const [name, node] of cases) {
          const out = writeDoc(node);
          if (JSON.stringify(spansOfDoc(node)) !== JSON.stringify(spansOf(out))) found.push(`${name}: ${JSON.stringify(out)}`);
          if (saves(out, 10)[9] !== out) found.push(`${name} did not settle: ${JSON.stringify(out)}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 30000);

  it("keeps a strikethrough that spans a url the bare form has to prove", () => {
    // The delete handler and the autolink ladder are the two things this pass was sent to attack,
    // and this is where they meet: the ladder builds the block three times over, and a delete's
    // escaping depends on what its neighbours are, which is different in each of the three.
    const found: string[] = [];
    const URLS = ["https://example.com/a", "https://exa_mple.com/a", "www.example.com/a", "a@b.com", "a@b_c.com", "a@localhost"];
    for (const url of URLS) {
      const href = url.includes("@") ? `mailto:${url}` : url.startsWith("www.") ? `http://${url}` : url;
      const struckLink = (...names: string[]) => schema.text(url, [schema.marks.link.create({ href, title: null }), ...names.map((name) => mk(name))]);
      for (const pad of ["", " "]) {
        const cases: Array<[string, ProseMirrorNode]> = [
          [`struck across ${url}`, only(para(marked(`use${pad}`, "strikethrough"), struckLink("strikethrough"), marked(`${pad}here`, "strikethrough")))],
          [`struck only ${url}`, only(para(schema.text("x"), struckLink("strikethrough"), schema.text("y")))],
          [`struck ${url} beside a good one`, only(para(marked(`use${pad}`, "strikethrough"), struckLink("strikethrough"), marked(`${pad}and `, "strikethrough"), schema.text("then "), linked("https://ok.example.com/z", "https://ok.example.com/z")))],
          [`struck and strong across ${url}`, only(para(marked(`use${pad}`, "strikethrough", "strong"), struckLink("strikethrough", "strong"), marked(`${pad}here`, "strikethrough", "strong")))],
        ];
        for (const [name, node] of cases) {
          const out = writeDoc(node);
          if (JSON.stringify(spansOfDoc(node)) !== JSON.stringify(spansOf(out))) found.push(`${name} pad=${JSON.stringify(pad)}: ${JSON.stringify(out)}`);
          if (saves(out, 10)[9] !== out) found.push(`${name} pad=${JSON.stringify(pad)} did not settle: ${JSON.stringify(out)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

// =============================================================================================
// Still fixed: every sweep that has passed before, re-run.
// =============================================================================================

describe("still fixed: the sweeps, re-run over ten generations", () => {
  const files = (): Array<[string, string]> => [...corpus().map((file) => [file.name, file.source] as [string, string]), ...Object.entries(fixtures)];

  it("settles on the second save and never grows again, for every corpus file and fixture", () => {
    const found: string[] = [];
    for (const [name, source] of files()) {
      const generations = saves(source, 10);
      if (new Set(generations.slice(1)).size !== 1) found.push(`${name} never settled: ${generations.map((g) => g.length).join(",")}`);
      if (generations[9].length !== generations[1].length) found.push(`${name} grew: ${generations.map((g) => g.length).join(",")}`);
    }
    expect(found).toEqual([]);
  }, 60000);

  it("keeps every destination and every character, for every corpus file and fixture", () => {
    const found: string[] = [];
    for (const [name, source] of files()) {
      const tenth = saves(source, 10)[9];
      if (JSON.stringify(linksIn(tenth)) !== JSON.stringify(linksIn(source))) found.push(`${name} lost a destination`);
      if (saidText(tenth) !== saidText(source)) found.push(`${name} changed the text it says`);
    }
    expect(found).toEqual([]);
  }, 60000);

  it("writes every raw block back as the exact bytes it cut out, for every fixture", () => {
    const found: string[] = [];
    for (const [name, source] of Object.entries(fixtures)) {
      const document = parseMarkdown(source, name);
      const out = serializeMarkdown(document, document.doc);
      document.doc.forEach((block) => {
        if (block.type.name !== "raw") return;
        const raw = block.textContent;
        if (!raw) found.push(`${name} has an empty raw block`);
        else if (!source.replace(/\r\n/g, "\n").includes(raw)) found.push(`${name} raw block is not a slice of the source: ${JSON.stringify(raw.slice(0, 60))}`);
        else if (!out.includes(raw)) found.push(`${name} raw block did not survive: ${JSON.stringify(raw.slice(0, 60))}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("is idempotent for every ordered pair of the shapes this pass added", () => {
    const SNIPPETS: Record<string, string> = {
      struckLink: "~~use&#x20;~~[~~the old API~~](./api.md)~~&#x20;here~~ now.",
      struckWhole: "[~~all of it~~](./whole.md) and ~~plain~~.",
      angle: "See <https://exa_mple.com/a> here",
      angleTight: "See <https://example.com>.Next",
      angleMail: "Mail <a@localhost> now",
      nestedMarks: "**q**~~**&#x20;r&#x20;**~~**s**",
      codeInLink: "[`code span`](./z.md) and [a`b`c](./w.md)",
      bare: "Go to https://example.com/a for more",
      table: "| a | b |\n| - | - |\n| ~~x~~ | <https://exa_mple.com/c> |",
      list: "- [~~gone~~](./gone.md)~~&#x20;and more~~",
      callout: "> [!NOTE]\n> [~~the old note~~](./old.md)~~&#x20;is gone~~",
      heading: "### ~~a~~ and **b**",
    };
    const keys = Object.keys(SNIPPETS);
    const found: string[] = [];
    for (const a of keys) {
      for (const b of keys) {
        for (const separator of ["\n\n", "\n\n\n", "\n"]) {
          const source = `${SNIPPETS[a]}${separator}${SNIPPETS[b]}\n`;
          const generations = saves(source, 3);
          if (new Set(generations).size !== 1) found.push(`${a} + ${b} (${separator.length}) never settled: ${JSON.stringify(generations[0])} -> ${JSON.stringify(generations[1])}`);
          if (saidText(generations[2]) !== saidText(source)) found.push(`${a} + ${b} (${separator.length}) changed its text`);
          if (JSON.stringify(linksIn(generations[2])) !== JSON.stringify(linksIn(source))) found.push(`${a} + ${b} (${separator.length}) lost a destination`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 60000);

  it("carries frontmatter through untouched, past every shape this pass added", () => {
    const heads = ["---\ntitle: T\n---", "+++\ntitle = \"T\"\n+++", "---\n---", "---\nbody: |\n  ---\nb: 2\n---"];
    const bodies = ["~~use&#x20;~~[~~the old API~~](./api.md)~~&#x20;here~~ now.\n", "See <https://exa_mple.com/a> here\n", "**q**~~**&#x20;r&#x20;**~~**s**\n", "- [~~gone~~](./gone.md)~~&#x20;and more~~\n"];
    const found: string[] = [];
    for (const head of heads) {
      for (const body of bodies) {
        const source = `${head}\n\n${body}`;
        const generations = saves(source, 10);
        if (!generations[9].startsWith(head)) found.push(`${JSON.stringify(head)} + ${JSON.stringify(body)} moved the frontmatter: ${JSON.stringify(generations[9].slice(0, head.length + 8))}`);
        if (new Set(generations.slice(1)).size !== 1) found.push(`${JSON.stringify(head)} + ${JSON.stringify(body)} never settled`);
      }
    }
    expect(found).toEqual([]);
  });

  it("is a one paragraph diff when a paragraph beside these shapes is edited", () => {
    // Written through once first. The table here is compact and M2 pads a modelled table out to its
    // column, so the bytes as typed are not the bytes the file settles at; the diff being measured
    // is the one an edit makes to a file that has already settled.
    const source = write("Edit me.\n\n~~use&#x20;~~[~~the old API~~](./api.md)~~&#x20;here~~ now.\n\nSee <https://exa_mple.com/a> here\n\n| a | b |\n| - | - |\n| ~~x~~ | y |\n\n<div class=\"widget\">raw</div>\n");
    expect(write(source), "the baseline has to be stable first, or the diff is just the first save").toBe(source);

    const document = parseMarkdown(source, "/locality.md");
    const children: ProseMirrorNode[] = [];
    let hits = 0;
    document.doc.forEach((child) => {
      if (child.type.name === "paragraph" && child.textContent === "Edit me.") {
        hits += 1;
        children.push(n.paragraph.createChecked(null, schema.text("Edited.")));
        return;
      }
      children.push(child);
    });
    expect(hits).toBe(1);

    const out = serializeMarkdown(document, n.doc.createChecked(null, children));
    expect(out).toBe(source.replace("Edit me.", "Edited."));
  });
});

// =============================================================================================
// Found. These FAIL. A mark nested inside itself over a link corrupts the document.
// =============================================================================================

describe("found: a mark nested inside itself doubles its delimiters over a link", () => {
  // `inlineFrom` in parse.ts adds a mark to the set for every wrapper node it walks through:
  //
  //     const inner = inlineFrom(node.children, [...marks, mark.create()]);
  //
  // ProseMirror's `Mark.setFrom` sorts that array but does not deduplicate it, so a source that
  // nests a mark inside itself puts two identical marks on one text node. GFM produces exactly
  // that tree for `~~a ~~b~~ c~~`, which is an ordinary thing to write when striking a phrase that
  // already had a struck word in it, and which renders on GitHub as plain strikethrough so the
  // author has no reason to think anything is wrong.
  //
  // Without a link the damage is invisible: `nest` writes the two deletes nested, `~~a ~~b~~ c~~`
  // comes back out byte identical, and only the document in memory is odd.
  //
  // With a link it is not. MARK_ORDER puts link outermost, so the two deletes are pushed inside
  // the link's text where they end up adjacent: `[~~~~b~~~~](./x.md)`. A run of four tildes does
  // not open a strikethrough, so the parser reads them as literal text, and the next save escapes
  // them. The document permanently says `a ~~~~b~~~~ c` where the author wrote `a b c`.
  //
  // The one line fix is to let ProseMirror do the set arithmetic it already has:
  //
  //     const inner = inlineFrom(node.children, mark.create().addToSet(marks));
  //
  // Applied, every case below passes and the rest of the suite is unchanged.

  const cases: Array<[string, string]> = [
    ["a link", "~~a ~~[b](./x.md)~~ c~~\n"],
    ["an angle autolink", "~~a ~~<https://exa_mple.com/q>~~ c~~\n"],
    ["a bare url", "~~a ~~https://example.com/q~~ c~~\n"],
    ["a link in a heading", "# ~~a ~~[b](./x.md)~~ c~~\n"],
    ["a link in a list item", "- ~~a ~~[b](./x.md)~~ c~~\n"],
    ["a link in a quote", "> ~~a ~~[b](./x.md)~~ c~~\n"],
    ["a link in a callout", "> [!NOTE]\n> ~~a ~~[b](./x.md)~~ c~~\n"],
    ["the shape an older save of this bridge produced", "~~use ~~[~~the old API~~](./api.md)~~ here~~ now.\n"],
  ];

  for (const [name, source] of cases) {
    it(`does not put tildes into the text around ${name}`, () => {
      const once = write(source);
      expect(saidText(once), "the document must say what it said before the save").toBe(saidText(source));
      expect(linksIn(once), "and the link must keep its text").toEqual(linksIn(source));
    });
  }

  it("does not grow without limit when the nesting is three deep", () => {
    // Two levels converge with the text already corrupted. Three never converge at all: every save
    // doubles the tilde run again and escapes the last one, which is thirty two more bytes on disk
    // every time the user hits save, for the rest of the file's life.
    const source = "~~a ~~b ~~[c](./x.md)~~ d~~ e~~\n";
    const generations = saves(source, 10);
    expect(generations[9].length, `lengths: ${generations.map((g) => g.length).join(",")}`).toBe(generations[1].length);
    expect(saidText(generations[9])).toBe(saidText(source));
  });

  it("does not put a duplicate mark on a text node in the first place", () => {
    // The root cause, stated where a fix can be aimed at it rather than at the symptom.
    const found: string[] = [];
    for (const source of ["~~a ~~b~~ c~~\n", "**a **b** c**\n", "_a _b_ c_\n", "~~a ~~[b](./x.md)~~ c~~\n", "~~a ~~b ~~c~~ d~~ e~~\n"]) {
      parseMarkdown(source, "/dup.md").doc.descendants((node) => {
        if (!node.isText) return true;
        const names = node.marks.map((mark) => mark.type.name);
        if (new Set(names).size !== names.length) found.push(`${JSON.stringify(source)} put ${JSON.stringify(names)} on ${JSON.stringify(node.text)}`);
        return true;
      });
    }
    expect(found).toEqual([]);
  });
});
