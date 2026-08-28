// The gate. Every promise the bridge makes is checked here against every file in the corpus, so a
// change that starts quietly rewriting documents fails before it reaches anybody's folder.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { corpus } from "./corpus/load";
import { parseMarkdown, serializeMarkdown, sourceDocument } from "./index";
import { BOM, normaliseSource } from "./frontmatter";

/**
 * The source as a save of it writes it back: CRLF collapsed, the byte order mark still there, and
 * the one line ending the house style ends a file with. Everything else is the file's own bytes.
 */
function settled(source: string): string {
  const { text, bom } = normaliseSource(source);
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return bom ? BOM + body : body;
}

const files = corpus();

function write(source: string, name: string): { text: string; doc: ProseMirrorNode } {
  const document = parseMarkdown(source, `/corpus/${name}`);
  return { text: serializeMarkdown(document, document.doc), doc: document.doc };
}

function rawBlocksIn(doc: ProseMirrorNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "raw") out.push(node.textContent);
    return node.type.name !== "raw";
  });
  return out;
}

/**
 * The documents the first save rewrites, and nothing else.
 *
 * Every entry is a construct the house style spells differently from the author's tool, listed one
 * by one rather than counted, because the interesting failure is a file joining this list rather
 * than the list being the wrong length. A file that leaves it has stopped being reformatted, which
 * is always an improvement; a file that joins it is a new rewrite somebody has to justify.
 */
const NORMALISED_ON_FIRST_WRITE = [
  // The adversarial fixtures, which joined the corpus the day the loader stopped naming folders and
  // started reading them. Nine of the twenty are rewritten and every one of them is rewritten by a
  // rule already on this list: a table taken down to the house width, a mark respelled, a file given
  // the last line ending the house style ends a file with. The other three gates, idempotence,
  // preservation and meaning, took all twenty without a word, which is what the pass that wrote them
  // was aiming for.
  "adversarial/autolink-adjacency.md",
  "adversarial/crlf-throughout.md",
  "adversarial/fence-and-table-torture.md",
  "adversarial/leading-rule-list.md",
  "adversarial/locality-edit.md",
  "adversarial/nested-marks.md",
  "adversarial/no-final-newline.md",
  "adversarial/struck-through-link.md",
  "adversarial/table-torture.md",
  "hand/code-fences.md",
  "hand/crlf.md",
  "hand/emphasis.md",
  "hand/entities-escapes.md",
  "hand/footnotes.md",
  // The two M2 joiners, and the only two of the forty odd files here whose tables are written wider
  // than the house style writes one. A table is a modelled node now rather than a raw source slice,
  // so it is written from the node in the one house style, which is a space either side of every
  // cell and the shortest delimiter row that still carries the alignment. Nothing else about either
  // file moves, which "nothing but the padding" below asserts cell by cell. There is no third
  // option: the schema is frozen and the table node has no `source` attribute to carry the author's
  // spelling, and it could not use one anyway, since Editor.tsx rebuilds every node from JSON when
  // it installs a document.
  "hand/gfm-table.md",
  "hand/locality.md",
  "hand/hard-breaks.md",
  "hand/headings-blocks.md",
  "hand/indented-code.md",
  "hand/links-autolinks.md",
  "hand/lists-tight-loose.md",
  "hand/no-trailing-newline.md",
  "hand/raw-html.md",
  "hand/setext-headings.md",
  "hand/whitespace-only.md",
  "real/calendar-release.md",
  "real/editor-release.md",
  "real/margin-claude.md",
  "real/margin-website-readme.md",
];

describe("the corpus", () => {
  it("is loaded", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("holds every folder under it, so a fixture cannot be added outside the gate", () => {
    // The loader globs folders rather than naming them, and this is the assertion that says so: the
    // three that exist are all read, and a fourth would be read the day somebody makes it.
    const folders = new Set(files.map((file) => file.name.split("/")[0]));
    expect([...folders].sort()).toEqual(["adversarial", "hand", "real"]);
  });

  it("is rewritten by the first save only where the house style says so", () => {
    const rewritten = files.filter((file) => write(file.source, file.name).text !== file.source).map((file) => file.name);
    expect(rewritten.sort()).toEqual([...NORMALISED_ON_FIRST_WRITE].sort());
  });
});

describe("idempotence", () => {
  for (const file of files) {
    it(`is byte stable from the second save on: ${file.name}`, () => {
      const once = write(file.source, file.name).text;
      const twice = write(once, file.name).text;
      expect(twice).toBe(once);
      expect(write(twice, file.name).text).toBe(once);
    });
  }
});

describe("preservation", () => {
  for (const file of files) {
    it(`writes every raw block back byte for byte: ${file.name}`, () => {
      const first = write(file.source, file.name);
      for (const raw of rawBlocksIn(first.doc)) {
        expect(raw).not.toBe("");
        expect(file.source.replace(/\r*\n/g, (ending) => (ending.length === 2 ? "\n" : ending))).toContain(raw);
        expect(first.text).toContain(raw);
      }
    });
  }

  it("keeps every unmodellable construct in the awkward fixtures", () => {
    const cases: Array<[string, string]> = [
      ["hand/footnotes.md", "[^long-name]: A longer note."],
      ["hand/definition-list.md", "[spec]: https://spec.commonmark.org/ \"CommonMark\""],
      ["hand/raw-html.md", "<div class=\"callout\" data-kind=\"note\">"],
      ["hand/mdx-jsx.md", "<Chart data={points} title=\"Sales\" />"],
      ["hand/math.md", "\\frac{a}{b} = \\sum_{i=0}^{n} x_i"],
      ["hand/locality.md", "[^note]: The footnote definition, which must not move."],
    ];
    for (const [name, fragment] of cases) {
      const file = files.find((entry) => entry.name === name);
      expect(file, name).toBeDefined();
      expect(file!.source).toContain(fragment);
      expect(write(file!.source, name).text, name).toContain(fragment);
    }
  });

  /**
   * Every line that is part of a table, as its cells with the padding taken off and a delimiter run
   * collapsed to one dash. Two tables that agree here are the same table written to two widths.
   */
  function tableCells(text: string): string[][] {
    return text
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) =>
        line
          .trim()
          .split("|")
          .map((cell) => cell.trim().replace(/-+/g, "-")),
      );
  }

  it("changes nothing but the padding in the two files whose tables it narrows", () => {
    for (const name of ["hand/gfm-table.md", "hand/locality.md"]) {
      const file = files.find((entry) => entry.name === name);
      expect(file, name).toBeDefined();
      const once = write(file!.source, name).text;

      expect(once, name).not.toBe(file!.source);
      expect(tableCells(once), name).toEqual(tableCells(file!.source));
      // And every line that is not a table line comes through untouched, so the rewrite is
      // confined to the block it belongs to.
      const outside = (text: string) => text.split("\n").filter((line) => !line.trimStart().startsWith("|"));
      expect(outside(once), name).toEqual(outside(file!.source));
    }
  });
});

describe("meaning", () => {
  for (const file of files) {
    it(`is the same document after a save as before it: ${file.name}`, () => {
      const before = parseMarkdown(file.source, `/corpus/${file.name}`);
      const after = parseMarkdown(serializeMarkdown(before, before.doc), `/corpus/${file.name}`);
      expect(after.doc.eq(before.doc)).toBe(true);
    });
  }
});

describe("opening a document", () => {
  it("leaves the source it was handed alone", () => {
    for (const file of files) {
      const before = file.source;
      const document = parseMarkdown(file.source, `/corpus/${file.name}`);
      expect(document.source).toBe(before);
      expect(file.source).toBe(before);
    }
  });

  // The fallback the editor installs when a document is one it cannot hold. It has to be worth
  // more than the empty document it replaced, which means the bytes have to survive a save.
  it("can be shown as its own source, and written back as the bytes that were read", () => {
    for (const file of files) {
      const document = parseMarkdown(file.source, `/corpus/${file.name}`);
      const shown = sourceDocument(document);
      expect(shown.childCount, file.name).toBeLessThanOrEqual(1);
      expect(serializeMarkdown(document, shown), file.name).toBe(settled(file.source));
    }
  });

  it("reaches nothing outside itself", () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [name, text] of Object.entries(sources)) {
      if (name.endsWith(".test.ts")) continue;
      expect(text, name).not.toContain("node:fs");
      expect(text, name).not.toContain("@tauri-apps");
    }
  });
});

describe("editing one paragraph", () => {
  /**
   * A word retyped in one paragraph, and the rest of the file byte for byte.
   *
   * This is the promise a serializer change breaks most quietly: everything still round trips,
   * everything still settles, and a block nobody touched has been rewritten on the way past. The
   * paragraph is one the test appends rather than one of the file's own, so the edit is the same
   * edit in all sixty four documents and the diff it should produce is one word long.
   *
   * The marker is checked for absence first. Two fixtures in the corpus were written with the word
   * an older sweep used, so appending another gave two paragraphs reading the same thing and the
   * edit had nowhere unambiguous to land; a marker that is in the corpus is a sweep that quietly
   * stops sweeping.
   */
  const MARKER = "PARAGRAPHUNDEREDIT";
  const RETYPED = "PARAGRAPHRETYPED";

  it("uses a marker no file in the corpus already contains", () => {
    expect(files.filter((file) => file.source.includes(MARKER)).map((file) => file.name)).toEqual([]);
  });

  it("leaves every other byte of every corpus file where it was", () => {
    const moved: string[] = [];

    for (const file of files) {
      const base = write(`${file.source}\n\n${MARKER}\n`, file.name).text;
      if (write(base, file.name).text !== base) {
        moved.push(`${file.name}: the file with the paragraph appended did not settle`);
        continue;
      }

      const document = parseMarkdown(base, `/corpus/${file.name}`);
      const children: ProseMirrorNode[] = [];
      let hits = 0;
      document.doc.forEach((child) => {
        if (child.type.name === "paragraph" && child.textContent === MARKER) {
          hits += 1;
          children.push(schema.nodes.paragraph.create(null, schema.text(RETYPED)));
          return;
        }
        children.push(child);
      });

      if (hits !== 1) {
        moved.push(`${file.name}: ${hits} paragraphs to retype`);
        continue;
      }
      const out = serializeMarkdown(document, schema.nodes.doc.create(null, children));
      if (out !== base.replace(MARKER, RETYPED)) moved.push(`${file.name}: ${JSON.stringify(out.slice(-80))}`);
    }
    expect(moved).toEqual([]);
  }, 20000);
});
