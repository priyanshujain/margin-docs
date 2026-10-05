// The outline is read from the parsed tree and never from the bytes, so every case here goes in as
// markdown, through the real bridge, and comes out as the rows the rail would draw.

import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../markdown";
import { currentAt, outlineOf, sameOutline } from "./outline";

const parse = (source: string) => parseMarkdown(source, "/notes/a.md").doc;

const rows = (source: string) =>
  outlineOf(parse(source)).map(({ level, text, depth }) => ({ level, text, depth }));

describe("outlineOf", () => {
  it("lists every top level heading in document order", () => {
    expect(rows("# One\n\ntext\n\n## Two\n\n### Three\n\n## Four\n")).toEqual([
      { level: 1, text: "One", depth: 0 },
      { level: 2, text: "Two", depth: 1 },
      { level: 3, text: "Three", depth: 2 },
      { level: 2, text: "Four", depth: 1 },
    ]);
  });

  it("indents by the headings above it rather than by the level number", () => {
    // A document that starts at ## does not start one step in, and a skipped level is one step
    // rather than the two the numbers would say.
    expect(rows("## A\n\n#### B\n\n## C\n\n### D\n")).toEqual([
      { level: 2, text: "A", depth: 0 },
      { level: 4, text: "B", depth: 1 },
      { level: 2, text: "C", depth: 0 },
      { level: 3, text: "D", depth: 1 },
    ]);
  });

  it("comes back out when the levels do", () => {
    expect(rows("# A\n\n## B\n\n### C\n\n# D\n")).toEqual([
      { level: 1, text: "A", depth: 0 },
      { level: 2, text: "B", depth: 1 },
      { level: 3, text: "C", depth: 2 },
      { level: 1, text: "D", depth: 0 },
    ]);
  });

  it("leaves out a heading with nothing in it", () => {
    expect(rows("#\n\n## Kept\n\n###   \n")).toEqual([{ level: 2, text: "Kept", depth: 0 }]);
  });

  it("folds a hand wrapped heading on to one line", () => {
    expect(rows("A heading\nover two lines\n===\n")).toEqual([
      { level: 1, text: "A heading over two lines", depth: 0 },
    ]);
  });

  it("reads the words and not the marks", () => {
    expect(rows("## **Bold** and `code`\n")).toEqual([{ level: 2, text: "Bold and code", depth: 0 }]);
  });

  it("ignores a heading inside another block", () => {
    const source = [
      "# Top",
      "",
      "> ## Quoted",
      "",
      "> [!NOTE]",
      "> ### In a callout",
      "",
      "- ## In a list",
      "",
      "<details>",
      "<summary>Folded</summary>",
      "",
      "## Hidden",
      "",
      "</details>",
      "",
      "## Bottom",
    ].join("\n");
    expect(rows(source)).toEqual([
      { level: 1, text: "Top", depth: 0 },
      { level: 2, text: "Bottom", depth: 1 },
    ]);
  });

  it("gives every row the position its heading starts at", () => {
    const doc = parse("intro\n\n# One\n\ntext\n\n## Two\n");
    for (const entry of outlineOf(doc)) {
      const node = doc.nodeAt(entry.pos);
      expect(node?.type.name).toBe("heading");
      expect(node?.textContent).toBe(entry.text);
    }
  });

  it("is empty for a document with no headings", () => {
    expect(rows("just a paragraph\n")).toEqual([]);
    expect(rows("")).toEqual([]);
  });
});

describe("currentAt", () => {
  // Where each heading's top sits below the top of a 900px pane, in document order.
  it("is null while nothing has reached the top third", () => {
    expect(currentAt([400, 700], 900, false)).toBeNull();
    expect(currentAt([301], 900, false)).toBeNull();
  });

  it("is the last heading that has come into the top third", () => {
    expect(currentAt([80, 400, 700], 900, false)).toBe(0);
    expect(currentAt([-200, 100, 700], 900, false)).toBe(1);
    expect(currentAt([-600, -300, 40], 900, false)).toBe(2);
    expect(currentAt([300], 900, false)).toBe(0);
  });

  it("is the last heading at the end of the document, whatever the tops say", () => {
    expect(currentAt([-100, 500, 800], 900, true)).toBe(2);
  });

  it("is null with no headings", () => {
    expect(currentAt([], 900, false)).toBeNull();
    expect(currentAt([], 900, true)).toBeNull();
  });
});

describe("sameOutline", () => {
  it("is true for two readings of the same tree", () => {
    const doc = parse("# A\n\n## B\n");
    expect(sameOutline(outlineOf(doc), outlineOf(doc))).toBe(true);
  });

  it("is false once a heading moves, is renamed or changes level", () => {
    const base = outlineOf(parse("# A\n\n## B\n"));
    expect(sameOutline(base, outlineOf(parse("# A\n\ntext\n\n## B\n")))).toBe(false);
    expect(sameOutline(base, outlineOf(parse("# A\n\n## C\n")))).toBe(false);
    expect(sameOutline(base, outlineOf(parse("# A\n\n### B\n")))).toBe(false);
    expect(sameOutline(base, outlineOf(parse("# A\n")))).toBe(false);
  });
});
