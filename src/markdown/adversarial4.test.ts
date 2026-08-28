// Fourth adversarial pass over the markdown bridge, written after the third pass's finding was
// fixed: a bare url that begins a continuation line is no longer spelled out, because inline
// literals now go out as `phrasingLiteral` rather than `html` and so keep the line ending in front
// of them. Same rules as the three files before it. This is here to break the bridge.
//
// The brief for this pass named three things to attack. Two of them do not exist.
//
// There is no third rung on the autolink ladder. `resourceLink` is still `true` and nothing in the
// serializer writes `<url>`: the angle form is only ever preserved by a raw block, never produced.
// The two ways it used to grow a file without limit, `<a@b_c.com>` and `<https://example.com/a\_b>`,
// are checked here over ten saves rather than two, along with every other loss the first three
// passes found, and all of them are still dead.
//
// The linear fallback selection is real and it holds. It cannot lose anything by construction: the
// mixed spelling it infers is returned only when a full re-parse of it matches the same criterion
// the all-bare spelling had to meet, so a wrong inference costs a fallback to `[text](url)` and
// never a destination. Ambiguous, duplicated, dropped, interfering and demotion-sensitive
// candidates are all attacked below and none of them gets past it.
//
// "found" is the result, and it is not in the autolink machinery at all. It is a strikethrough
// that spans a link. One shape of it corrupts the document's text permanently and another grows
// the file by thirty two bytes on every save for the rest of its life.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { corpus } from "./corpus/load";
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
  const document = parseMarkdown(source, "/adversarial4.md");
  return serializeMarkdown(document, document.doc);
}

function doc(source: string): ProseMirrorNode {
  return parseMarkdown(source, "/adversarial4.md").doc;
}

function writeDoc(node: ProseMirrorNode): string {
  return serializeMarkdown({ frontmatter: null, doc: node, source: "", path: "/adversarial4.md" }, node);
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

/**
 * Every character the document says, with the markup taken off.
 *
 * The first three passes compared destinations and whole files. Neither catches a save that keeps
 * every link and every byte count but moves a delimiter into the text, which is what the finding
 * below does: the file still has all its links, and four characters that were markup are now
 * content.
 */
function saidText(source: string): string {
  const walk = (node: { value?: string; children?: unknown[] }): string => (node.value !== undefined ? String(node.value) : ((node.children ?? []) as Array<Parameters<typeof walk>[0]>).map(walk).join(""));
  return walk(parseToMdast(source) as unknown as Parameters<typeof walk>[0]);
}

/**
 * Every link in a piece of markdown that is spelled `<url>`, exactly.
 *
 * Read off the parser's own offsets rather than by looking for a bracket, because a bare url
 * between two literal brackets, which is what `Mail <a@b_c.com> here` is, looks identical to an
 * angle autolink and is not one: the link node's span covers the brackets for the angle form and
 * only the url for the bare one.
 */
function angleAutolinks(text: string): string[] {
  const out: string[] = [];
  const walk = (node: { type?: string; position?: { start: { offset: number }; end: { offset: number } }; children?: unknown[] }) => {
    if (node.type === "link" && node.position) {
      const slice = text.slice(node.position.start.offset, node.position.end.offset);
      if (slice.startsWith("<") && slice.endsWith(">")) out.push(slice);
    }
    for (const child of (node.children ?? []) as Array<Parameters<typeof walk>[0]>) walk(child);
  };
  walk(parseToMdast(text) as unknown as Parameters<typeof walk>[0]);
  return out;
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

const n = schema.nodes;
const linked = (text: string, href: string, title: string | null = null) => schema.text(text, [schema.marks.link.create({ href, title })]);
const struck = (text: string, ...names: string[]) => schema.text(text, names.map((name) => schema.marks[name].create()));
const para = (...content: ProseMirrorNode[]) => n.paragraph.create(null, content);
const cell = (...content: ProseMirrorNode[]) => n.tableCell.create({ colspan: 1, rowspan: 1, colwidth: null, align: null }, content.length > 0 ? content : null);
const row = (...cells: ProseMirrorNode[]) => n.tableRow.create(null, cells);
const only = (block: ProseMirrorNode) => n.doc.create(null, [block]);

// =============================================================================================
// Still fixed. These pass.
// =============================================================================================

describe("still fixed: the angle form is safe because it is verified, not because it is banned", () => {
  // The second pass found two unbounded growths in `<url>` and the fix at the time was to stop
  // writing the form at all. A later decision put it back as the middle rung of the ladder,
  // because for a source that already says `<url>` the ban meant rewriting the user's own bytes
  // into a longer spelling for no reason.
  //
  // These two tests used to assert the ban. The ban was only ever a proxy for the property that
  // matters, which is that no spelling loses a destination and no spelling grows. They now assert
  // that property directly, which is what the growths would have violated and is strictly more
  // than the ban proved: the ban could not have caught a growth in the bare or explicit form.

  const URLS = ["https://example.com", "https://exa_mple.com/a", "https://example.com/a\\_b", "https://example.com/a&amp", "www.example.com/a", "a@b.com", "a@b_c.com", "a:b@c.com"];

  it("keeps the destination and stops growing, whatever the url and whatever holds it", () => {
    const builds: Array<[string, (link: ProseMirrorNode) => ProseMirrorNode]> = [
      ["alone", (link) => para(link)],
      ["mid sentence", (link) => para(schema.text("See "), link, schema.text(" here"))],
      ["line start", (link) => para(schema.text("See\n"), link)],
      ["tight suffix", (link) => para(link, schema.text(".Next"))],
      ["apostrophe", (link) => para(link, schema.text("'s"))],
      ["semicolon", (link) => para(link, schema.text("; x"))],
      ["angle before", (link) => para(schema.text("<"), link, schema.text(">"))],
      ["heading", (link) => n.heading.create({ level: 2 }, [link])],
      ["callout", (link) => n.callout.create({ kind: "note" }, [para(link)])],
      ["list item", (link) => n.bulletList.create({ tight: true }, [n.listItem.create(null, [para(link)])])],
      ["table cell", (link) => n.table.create(null, [row(cell(schema.text("h"))), row(cell(link))])],
    ];
    const found: string[] = [];
    for (const url of URLS) {
      const href = url.includes("@") ? `mailto:${url}` : url;
      for (const [name, build] of builds) {
        const out = writeDoc(only(build(linked(url, href))));
        const links = linksIn(out);
        if (links.length !== 1) found.push(`lost the link: ${name} ${JSON.stringify(url)} -> ${JSON.stringify(out)}`);
        if (!links[0]?.startsWith(`link ${href} `)) found.push(`destination: ${name} ${JSON.stringify(url)} -> ${JSON.stringify(out)} gave ${JSON.stringify(links)}`);
        // Ten saves, not two. Both growths the ban was standing in for were stable on the second
        // save and only diverged later, which is why two is not enough to see them.
        let text = out;
        for (let i = 0; i < 10; i++) {
          const next = write(text);
          if (i > 0 && next !== text) found.push(`unstable at save ${i + 2}: ${name} ${JSON.stringify(url)} -> ${JSON.stringify(next)}`);
          text = next;
        }
        if (text.length > out.length) found.push(`grew ${out.length} to ${text.length}: ${name} ${JSON.stringify(url)}`);
        // The second pass's growth was a bare url between literal brackets being re-read as an
        // angle autolink and re-bracketed, so "<<url>>" then "<<<url>>>". Only the parser's spans
        // tell the two apart, which is what angleAutolinks reads. One angle form at most, ever.
        if (angleAutolinks(out).length > 1) found.push(`nested angle: ${name} ${JSON.stringify(url)} -> ${JSON.stringify(out)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("survives a source that already spells it that way, and settles", () => {
    const found: string[] = [];
    for (const url of URLS) {
      const source = `See <${url}> here\n`;
      const once = write(source);
      if (JSON.stringify(linksIn(once)) !== JSON.stringify(linksIn(source))) found.push(`links ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
      if (saidText(once) !== saidText(source)) found.push(`text ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
      // The two growths the removed ban was guarding, "<a@b_c.com>" and an escaped underscore in
      // the path, are both in URLS. Neither is angle eligible now, but the point is that the rung
      // is safe because the verifier re-reads what it wrote, not because the form is forbidden.
      let text = once;
      for (let i = 0; i < 10; i++) {
        const next = write(text);
        if (next !== text) found.push(`unstable at save ${i + 2} ${JSON.stringify(source)} -> ${JSON.stringify(next)}`);
        text = next;
      }
      if (text.length > once.length) found.push(`grew ${once.length} to ${text.length} ${JSON.stringify(source)}`);
    }
    expect(found).toEqual([]);
  });
});

describe("still fixed: every loss the first three passes found, over ten saves", () => {
  // Pinned as ten generations rather than two, because both of the second pass's growths were
  // stable on the second save and only diverged afterwards.
  const cases: Array<[string, string]> = [
    ["an email whose domain has an underscore", "Mail <a@b_c.com> here\n"],
    ["a backslash in a destination", "See <https://example.com/a\\_b> here\n"],
    ["a domain GFM will not autolink", "See <https://exa_mple.com/a> here\n"],
    ["a relative destination starting www.", "[www.example.com](www.example.com)\n"],
    ["a semicolon after an entity shaped tail", "See <https://example.com/a&amp>; here\n"],
    ["an address the literal grammar rejects", "[a:b@c.com](mailto:a:b@c.com)\n"],
    ["an apostrophe after a url", "Read <https://example.com>'s docs\n"],
    ["a full stop and the word after it", "See <https://example.com>.Next thing\n"],
    ["a url inside another link's text", "[see <https://example.com> more](http://y.com)\n"],
    ["a url that can be written bare", "Angle <https://example.com> here.\n"],
    ["a url that begins a continuation line", "See the docs\nhttps://example.com/a\nfor more.\n"],
    ["a lone carriage return", "one\rtwo\n"],
    ["a list under a leading thematic break", "---\n\n- a\n- b\n"],
    ["frontmatter closed by a carriage return", "---\ra: 1\r---\rp\r"],
  ];

  for (const [name, source] of cases) {
    it(name, () => {
      const generations = saves(source, 10);
      expect(generations.slice(1), `lengths ${generations.map((text) => text.length).join(",")}`).toEqual(Array(9).fill(generations[0]));
      expect(linksIn(generations[0]), "the links must be the same links").toEqual(linksIn(source));
      expect(saidText(generations[0]), "and the text must be the same text").toBe(saidText(source));
      expect(doc(generations[0]).eq(doc(source)), "and the same document").toBe(true);
    });
  }
});

describe("still fixed: the linear fallback selection", () => {
  // The old code proved one candidate at a time. This one proves the whole block once and reads
  // which candidates failed off an ordered comparison of two link lists. The inference is allowed
  // to be wrong; what is not allowed is for a wrong inference to reach the file. Every shape below
  // is one the comparison cannot line up on its own.

  const GOOD = "https://example.com/a";
  const BAD = "https://exa_mple.com/b";

  function intended(node: ProseMirrorNode): string[] {
    const out: string[] = [];
    node.descendants((child) => {
      if (child.type.name === "image") {
        const mark = child.marks.find((entry) => entry.type.name === "link");
        if (mark) out.push(`link ${mark.attrs.href} ${mark.attrs.title ?? ""} ${JSON.stringify("")}`);
        out.push(`image ${child.attrs.src} ${child.attrs.title ?? ""} ${JSON.stringify("")}`);
        return true;
      }
      for (const mark of child.marks) if (mark.type.name === "link") out.push(`link ${mark.attrs.href} ${mark.attrs.title ?? ""} ${JSON.stringify(child.textContent)}`);
      return true;
    });
    return out;
  }

  const cases: Array<[string, ProseMirrorNode]> = [
    ["ten identical goods and one bad", para(...Array.from({ length: 10 }, () => [linked(GOOD, GOOD), schema.text(" ")]).flat(), linked(BAD, BAD))],
    ["ten identical bads and one good", para(...Array.from({ length: 10 }, () => [linked(BAD, BAD), schema.text(" ")]).flat(), linked(GOOD, GOOD))],
    ["identical urls, one demoted by what follows it", para(linked(GOOD, GOOD), schema.text(" "), linked(GOOD, GOOD), schema.text(".Next "), linked(GOOD, GOOD))],
    ["two candidates with nothing between them", para(linked("https://a.com", "https://a.com"), linked("https://b.com", "https://b.com"))],
    ["a good glued to a bad", para(linked(GOOD, GOOD), linked(BAD, BAD))],
    ["a bad glued to a good", para(linked(BAD, BAD), linked(GOOD, GOOD))],
    ["one url running into the next", para(linked("https://a.com", "https://a.com"), schema.text("/"), linked("https://b.com", "https://b.com"))],
    ["a candidate the bare form would lose entirely", para(schema.text("<"), linked("https://a.com", "https://a.com"), schema.text(">"))],
    ["an email the bare form would lose entirely", para(schema.text("<"), linked("a@b.com", "mailto:a@b.com"), schema.text(">"))],
    ["twenty three candidates, three of them bad", para(...Array.from({ length: 23 }, (_, index) => [linked(`${index % 8 === 3 ? BAD : GOOD}${index}`, `${index % 8 === 3 ? BAD : GOOD}${index}`), schema.text(" x ")]).flat())],
    ["a candidate whose tail eats the next one", para(linked(GOOD, GOOD), schema.text("."), linked("https://b.com", "https://b.com"))],
    ["candidates split across list items", n.bulletList.create({ tight: true }, [n.listItem.create(null, [para(linked(GOOD, GOOD), schema.text(" "), linked(BAD, BAD))]), n.listItem.create(null, [para(linked(GOOD, GOOD), schema.text(" x "), linked(GOOD, GOOD))])])],
    ["candidates in a table row", n.table.create(null, [row(cell(schema.text("h")), cell(schema.text("h2"))), row(cell(linked("https://x.com/a|b", "https://x.com/a|b")), cell(linked(GOOD, GOOD)))])],
    ["candidates under a callout label", n.callout.create({ kind: "note" }, [para(linked(GOOD, GOOD), schema.text(" and "), linked(BAD, BAD))])],
    ["candidates separated by hard breaks", para(linked(GOOD, GOOD), n.hardBreak.create(), linked(BAD, BAD), n.hardBreak.create(), linked(GOOD, GOOD))],
    ["candidates separated by soft breaks", para(linked(GOOD, GOOD), schema.text("\n"), linked(BAD, BAD), schema.text("\n"), linked(GOOD, GOOD))],
    ["a titled link beside a candidate", para(linked(GOOD, GOOD, "T"), schema.text(" "), linked("https://c.com", "https://c.com"))],
    ["an image link beside a candidate", para(n.image.create({ src: "i.png", alt: "a", title: null }, null, [schema.marks.link.create({ href: "./x.md", title: null })]), schema.text(" "), linked(GOOD, GOOD))],
    ["a plain url in the text beside a candidate", para(linked(GOOD, GOOD), schema.text(" and https://exa_mple.com/plain here"))],
  ];

  for (const [name, block] of cases) {
    it(`keeps every destination: ${name}`, () => {
      const node = only(block);
      const out = writeDoc(node);
      expect(linksIn(out), JSON.stringify(out)).toEqual(intended(node));
      expect(saves(out, 10).slice(1), `unstable: ${JSON.stringify(out)}`).toEqual(Array(9).fill(out));
    });
  }

  it("cannot be made to return a spelling it did not prove", () => {
    // The mixed spelling is only ever returned after a full re-parse of it agrees with the
    // explicit spelling, so demoting one candidate can never quietly break another. A block where
    // demotion changes the answer for a neighbour therefore falls back rather than guesses.
    const node = only(para(linked(BAD, BAD), linked(GOOD, GOOD), schema.text("."), linked(BAD, BAD)));
    const out = writeDoc(node);
    expect(linksIn(out)).toEqual(intended(node));
    expect(write(out)).toBe(out);
  });
});

describe("still fixed: a url that begins a line", () => {
  // The third pass's finding. Each of these was rewritten to `[url](url)` on the first save.

  it("is left alone in hard wrapped prose", () => {
    expect(write("See the docs\nhttps://example.com/a\nfor more.\n")).toBe("See the docs\nhttps://example.com/a\nfor more.\n");
  });

  it("is left alone in a list item that wraps", () => {
    expect(write("- item\n  https://example.com/a\n")).toBe("- item\n  https://example.com/a\n");
    expect(write("1. item\n   https://example.com/a\n")).toBe("1. item\n   https://example.com/a\n");
  });

  it("is left alone in a callout body", () => {
    for (const source of ["> [!NOTE]\n> https://example.com/a\n", "> [!TIP]\n> a@b.com\n", "> [!WARNING]\n> words first\n> https://example.com/b\n"]) {
      expect(write(source), source).toBe(source);
    }
  });

  it("is left alone after a hard break", () => {
    expect(write("a\\\nhttps://example.com/a\n")).toBe("a\\\nhttps://example.com/a\n");
  });

  it("is left alone in a quote", () => {
    expect(write("> quote\n> https://example.com/a\n")).toBe("> quote\n> https://example.com/a\n");
  });

  it("leaves the whole hard wrapped fixture byte identical", () => {
    const source = fixture("wrapped-url.md");
    expect(write(source)).toBe(source);
  });

  it("did not buy that by rewrapping anything", () => {
    // The pre-rework code joined hard wrapped lines. Every line break the author put in has to
    // still be exactly where they put it, url or no url.
    const sources = [
      "A paragraph that the author\nhard wrapped at some column\nand nowhere else.\n",
      "Short\nlines\neverywhere\n",
      "A line ending in a url https://example.com/a\nand a continuation.\n",
      "text with https://a.com in it\nand https://b.com starting the next line\nand text after\n",
      "- a list item that wraps\n  onto a second line\n- and another\n",
      "> a quote that wraps\n> onto a second line\n",
      "> [!NOTE]\n> a callout that wraps\n> onto a second line\n",
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    ];
    for (const source of sources) expect(write(source), source).toBe(source);
  });
});

describe("still fixed: the sweeps", () => {
  it("writes every corpus file the same way ten times over", () => {
    const growing: string[] = [];
    for (const file of corpus()) {
      const generations = saves(file.source, 10);
      if (generations.slice(1).some((text) => text !== generations[0])) growing.push(`${file.name}: ${generations.map((text) => text.length).join(",")}`);
    }
    expect(growing).toEqual([]);
  }, 30000);

  it("keeps every link and every character of every corpus file", () => {
    const lost: string[] = [];
    for (const file of corpus()) {
      const once = write(file.source);
      if (JSON.stringify(linksIn(once)) !== JSON.stringify(linksIn(file.source))) lost.push(`links ${file.name}`);
      if (saidText(once) !== saidText(file.source)) lost.push(`text ${file.name}`);
      if (!doc(once).eq(doc(file.source))) lost.push(`meaning ${file.name}`);
    }
    expect(lost).toEqual([]);
  }, 20000);

  it("keeps frontmatter byte identical in front of every corpus body", () => {
    const bad: string[] = [];
    for (const file of corpus()) {
      const slot = parseMarkdown(file.source, `/${file.name}`).frontmatter;
      if (slot === null) continue;
      const once = write(file.source);
      if (!once.startsWith(slot)) bad.push(file.name);
      if (parseMarkdown(once, `/${file.name}`).frontmatter !== slot) bad.push(`reparse ${file.name}`);
    }
    expect(bad).toEqual([]);
  });

  // The word this sweep appends has to be a word no corpus file already contains, and "EDITME" is
  // not one: two fixtures under `adversarial/` are built around that very word for the locality
  // tests in adversarial.test.ts and m2.test.ts, which read the sentinel out of the file rather
  // than appending one. While the corpus glob named its folders those two were out of reach here;
  // once it took every folder they were in, and appending a second EDITME left the retype with two
  // paragraphs to choose from and `replace` picking the fixture's own. That is a collision in the
  // harness, not a serializer fault: with a word nothing in the corpus spells, all 64 files pass.
  const APPENDED = "SWEEPPARAGRAPH";
  const RETYPED = "SWEEPRETYPED";

  it("appends a paragraph no corpus file already contains", () => {
    expect(corpus().filter((file) => file.source.includes(APPENDED)).map((file) => file.name)).toEqual([]);
  });

  it("is a one paragraph diff on every corpus file", () => {
    // A paragraph the test owns is appended to each file, the file is settled, and then only that
    // paragraph is retyped. Anything but a one word diff means a save rewrote a block nobody
    // touched, which is the promise a serializer change is most likely to break quietly.
    const bad: string[] = [];
    for (const file of corpus()) {
      const base = write(`${file.source}\n\n${APPENDED}\n`);
      if (write(base) !== base) {
        bad.push(`${file.name}: not settled`);
        continue;
      }
      const document = parseMarkdown(base, `/${file.name}`);
      const children: ProseMirrorNode[] = [];
      let hits = 0;
      document.doc.forEach((child) => {
        if (child.type.name === "paragraph" && child.textContent === APPENDED) {
          hits += 1;
          children.push(n.paragraph.create(null, schema.text(RETYPED)));
          return;
        }
        children.push(child);
      });
      if (hits !== 1) {
        bad.push(`${file.name}: ${hits} paragraphs reading ${APPENDED}`);
        continue;
      }
      const out = serializeMarkdown(document, n.doc.create(null, children));
      if (out !== base.replace(APPENDED, RETYPED)) bad.push(`${file.name}: ${JSON.stringify(out.slice(-80))}`);
    }
    expect(bad).toEqual([]);
  }, 20000);

  it("survives a deterministic fuzz over urls, links and containers", () => {
    // The generator below is the one that found the strikethrough loss in the "found" section.
    // With strikethrough taken out of the glue it is a clean sweep of the autolink machinery:
    // six thousand blocks, each checked for its links, its text, its meaning and ten saves.
    const random = (() => {
      let state = 20260824 >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
      };
    })();
    const URLS = ["https://example.com/a", "https://b.example.com/x", "https://exa_mple.com/a", "www.example.com/a", "http://example.com", "https://example.com/a_b", "https://example.com/a(b)", "https://example.com/a&amp", "https://example.com/a|b", "https://example.com/#f", "https://例え.jp/a", "https://example.com/a\\_b", "https://example.com/a*b", "https://example.com/a]b"];
    const EMAILS = ["a@b.com", "a@b_c.com", "x.y@z.co.uk", "a-b@c.com"];
    const GLUE = [" ", ". ", ", ", "'s ", ".Next ", "; ", " and ", "\n", " (", ") ", " `x` ", " [t](./y.md) ", " ![i](i.png) ", "\n\n"];
    const WORDS = ["See", "the", "docs", "for", "more", "text", "x86_64", "a*b", "n<m"];
    const pick = <T,>(list: T[]): T => list[Math.floor(random() * list.length)];
    const segment = (): string => {
      const kind = random();
      if (kind < 0.34) return `<${pick(URLS)}>`;
      if (kind < 0.5) return pick(URLS);
      if (kind < 0.62) return `<${pick(EMAILS)}>`;
      if (kind < 0.7) return pick(EMAILS);
      if (kind < 0.8) return `[${pick(URLS)}](${pick(URLS)})`;
      return pick(WORDS);
    };
    const WRAPPERS: Array<(body: string) => string> = [
      (body) => `${body}\n`,
      (body) => `See ${body} here\n`,
      (body) => `- ${body}\n`,
      (body) => `- item\n  ${body.replace(/\n\n/g, "\n  ")}\n`,
      (body) => `> ${body.replace(/\n/g, "\n> ")}\n`,
      (body) => `> [!NOTE]\n> ${body.replace(/\n/g, "\n> ")}\n`,
      (body) => `## ${body.replace(/\n/g, " ")}\n`,
      (body) => `| h |\n| - |\n| ${body.replace(/\n/g, " ").replace(/\|/g, "\\|")} |\n`,
      (body) => `text\n${body}\nmore text\n`,
      (body) => `a\\\n${body}\n`,
    ];

    const broken: string[] = [];
    let checked = 0;
    for (let attempt = 0; attempt < 6000 && broken.length < 5; attempt += 1) {
      const count = 1 + Math.floor(random() * 4);
      let body = "";
      for (let index = 0; index < count; index += 1) {
        body += segment();
        if (index < count - 1) body += pick(GLUE);
      }
      const source = pick(WRAPPERS)(body);
      if (!source.trim()) continue;
      checked += 1;
      const once = write(source);
      if (JSON.stringify(linksIn(once)) !== JSON.stringify(linksIn(source))) broken.push(`links ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
      else if (saidText(once) !== saidText(source)) broken.push(`text ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
      else if (!doc(once).eq(doc(source))) broken.push(`meaning ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
      else if (saves(once, 9).some((text) => text !== once)) broken.push(`unstable ${JSON.stringify(source)} -> ${JSON.stringify(once)}`);
    }
    // A generator that stops generating is a test that stops testing.
    expect(checked).toBeGreaterThan(5000);
    expect(broken).toEqual([]);
  }, 120000);
});

// =============================================================================================
// Found. These fail.
// =============================================================================================

describe("found: a strikethrough that spans a link is written back as literal tildes", () => {
  // `MARK_ORDER` puts `link` outside `strikethrough`, so a strikethrough that covers a link AND
  // some of the words around it cannot stay one node: it is split into the delete inside the link
  // and one delete run for the text on either side, and those runs begin or end with the space
  // that used to be in the middle of the strikethrough.
  //
  // mdast will not write that. `strong` and `emphasis` guard against it, encoding an edge space as
  // `&#x20;` so the delimiter still binds, which is why `**a [t](./x.md) b**` survives. The GFM
  // `delete` handler in mdast-util-gfm-strikethrough has no such guard: it writes `~~` + children
  // + `~~` and nothing else, so a run whose first character is a space goes out as `~~ b~~`, which
  // GFM does not read back as a strikethrough at all.
  //
  // What comes back is a paragraph with four more characters in its text than the one that was
  // saved. The strikethrough is gone and `~~` is now content. Nothing warns, and the file looks
  // fine until somebody reads it.

  it("keeps the strikethrough over an ordinary struck out sentence", () => {
    const source = "~~[the old guide](./old.md) has moved~~\n";
    const once = write(source);
    expect(saidText(once), `the tildes became text: ${JSON.stringify(once)}`).toBe("the old guide has moved");
    expect(doc(once).eq(doc(source)), JSON.stringify(once)).toBe(true);
  });

  it("does not turn a strikethrough delimiter into content", () => {
    const cases = ["~~[t](./x.md) b~~\n", "~~a [t](./x.md)~~\n", "~~a@b.com b~~\n", "~~a~~ and ~~b [t](./x.md)~~\n", "- ~~[done](./x.md) already~~\n", "## ~~[old](./o.md) title~~\n", "> [!NOTE]\n> ~~[old](./o.md) note~~\n"];
    const corrupted: string[] = [];
    for (const source of cases) {
      const once = write(source);
      if (saidText(once) !== saidText(source)) corrupted.push(`${JSON.stringify(source)} -> ${JSON.stringify(once)}\n  said ${JSON.stringify(saidText(source))} then ${JSON.stringify(saidText(once))}`);
    }
    expect(corrupted).toEqual([]);
  });

  it("writes a delete run whose edge is a space the way it writes a strong one", () => {
    // The same document with `strong` instead of `strikethrough` round trips exactly, which is
    // what the fix has to match: encode the edge space rather than emit a delimiter that cannot
    // bind. No link is needed to show it, so this is not really about autolinks at all.
    const strong = only(para(schema.text("a"), struck(" b", "strong")));
    expect(doc(writeDoc(strong)).eq(strong), JSON.stringify(writeDoc(strong))).toBe(true);

    const delete_ = only(para(schema.text("a"), struck(" b", "strikethrough")));
    expect(doc(writeDoc(delete_)).eq(delete_), `wrote ${JSON.stringify(writeDoc(delete_))}`).toBe(true);
  });

  it("does not grow the file by thirty two bytes on every save, forever", () => {
    const source = "We ~~use [the old API](./api.md) here~~ now.\n";
    const generations = saves(source, 10);
    expect(generations.slice(1), `lengths ${generations.map((text) => text.length).join(",")}`).toEqual(Array(9).fill(generations[0]));
  });

  it("does not inject a hundred and fifty tildes into a document that is saved twenty times", () => {
    const source = "~~a [t](./x.md) b~~\n";
    let current = source;
    for (let generation = 0; generation < 20; generation += 1) current = write(current);
    expect((saidText(current).match(/~/g) ?? []).length, `after twenty saves: ${JSON.stringify(current)}`).toBe(0);
  });

  it("holds for the fixture, which grows without limit", () => {
    const source = fixture("struck-through-link.md");
    const generations = saves(source, 10);
    expect(generations.slice(1), `lengths ${generations.map((text) => text.length).join(",")}`).toEqual(Array(9).fill(generations[0]));
    expect(saidText(generations[0]), "and keeps what the document says").toBe(saidText(source));
  });
});
