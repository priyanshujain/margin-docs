// Editing one paragraph has to be a one paragraph diff. A save that reflows a table, renumbers a
// footnote or reindents an html block the user never touched is the failure mode that makes an
// editor untrustworthy on files that live in someone else's git history.
//
// Measured from the house style form of the fixture rather than from its bytes. This fixture spells
// its delimiter row `---` and the house style writes the shortest one that carries the alignment, so
// the very first save shortens it whether anything was edited or not; that one time rewrite is
// roundtrip.test.ts's to police, and it is on the list there with its reasons. What is being asked
// here is the separate and harder question: with the file already settled, does editing one
// paragraph move anything else. Everything below the first save has to be byte identical, table
// included.

import { describe, expect, it } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { corpusFile } from "./corpus/load";
import { parseMarkdown, serializeMarkdown } from "./index";

const ORIGINAL = "The first paragraph, which the edit locality test rewrites.";
const EDITED = "The first paragraph, rewritten by hand.";

function retypeParagraph(doc: ProseMirrorNode, from: string, to: string): ProseMirrorNode {
  const children: ProseMirrorNode[] = [];
  let hits = 0;
  doc.forEach((child) => {
    if (child.type.name === "paragraph" && child.textContent === from) {
      hits += 1;
      children.push(schema.nodes.paragraph.create(null, schema.text(to)));
      return;
    }
    children.push(child);
  });
  expect(hits).toBe(1);
  return schema.nodes.doc.create(null, children);
}

describe("edit locality", () => {
  const file = corpusFile("hand/locality.md");

  /** The fixture as it is once the house style has had its one go at it. */
  const settled = (() => {
    const first = parseMarkdown(file.source, "/corpus/locality.md");
    const once = serializeMarkdown(first, first.doc);
    const second = parseMarkdown(once, "/corpus/locality.md");
    expect(serializeMarkdown(second, second.doc), "the baseline has to be stable").toBe(once);
    return once;
  })();

  it("changes the edited paragraph and nothing else", () => {
    const document = parseMarkdown(settled, "/corpus/locality.md");
    const edited = retypeParagraph(document.doc, ORIGINAL, EDITED);
    const out = serializeMarkdown(document, edited);

    expect(out).toBe(settled.replace(ORIGINAL, EDITED));
  });

  it("leaves the table, the footnote, the html and the details block untouched", () => {
    const document = parseMarkdown(settled, "/corpus/locality.md");
    const out = serializeMarkdown(document, retypeParagraph(document.doc, ORIGINAL, EDITED));

    for (const construct of [
      "| Column A | Column B |\n| - | - |\n| one | two |",
      "[^note]: The footnote definition, which must not move.",
      "<div class=\"widget\" data-id=\"7\">\n  <span>hand written html</span>\n</div>",
      "<details>\n<summary>Details block</summary>",
      "A second paragraph, untouched[^note].",
    ]) {
      expect(out, construct).toContain(construct);
    }
  });

  it("does not move the frontmatter", () => {
    const document = parseMarkdown(settled, "/corpus/locality.md");
    const out = serializeMarkdown(document, retypeParagraph(document.doc, ORIGINAL, EDITED));
    expect(out.startsWith("---\ntitle: Locality fixture\n---\n\n")).toBe(true);
  });
});
