import { describe, expect, it } from "vitest";
import { corpusFile } from "./corpus/load";
import { parseMarkdown, serializeMarkdown } from "./index";
import { BOM } from "./frontmatter";

function roundTrip(source: string, path = "/corpus/x.md"): string {
  const document = parseMarkdown(source, path);
  return serializeMarkdown(document, document.doc);
}

describe("frontmatter", () => {
  it("is carried as the exact bytes it was read as, YAML", () => {
    const file = corpusFile("hand/frontmatter-yaml-odd.md");
    const document = parseMarkdown(file.source, "/corpus/odd.md");
    const closing = file.source.indexOf("\n---\n") + "\n---\n".length;

    expect(document.frontmatter).toBe(file.source.slice(0, closing + 1));
    expect(document.frontmatter).toContain("# a comment inside the frontmatter");
    expect(document.frontmatter).toContain("title: \"A title: with a colon\"");
    expect(document.frontmatter).toContain("author: 'single quoted'");
    expect(document.frontmatter).toContain("  with a blank line");
    expect(roundTrip(file.source)).toBe(file.source);
  });

  it("is carried as the exact bytes it was read as, TOML", () => {
    const file = corpusFile("hand/frontmatter-toml.md");
    const document = parseMarkdown(file.source, "/corpus/toml.md");

    expect(document.frontmatter?.startsWith("+++\n")).toBe(true);
    expect(document.frontmatter).toContain("[[posts]]");
    expect(document.frontmatter).toContain("# a comment");
    expect(roundTrip(file.source)).toBe(file.source);
  });

  it("survives a file that is nothing else", () => {
    const file = corpusFile("hand/frontmatter-only.md");
    const document = parseMarkdown(file.source, "/corpus/only.md");

    expect(document.frontmatter).toBe(file.source);
    expect(roundTrip(file.source)).toBe(file.source);
  });

  it("is never reordered, requoted or reindented", () => {
    const source = ["---", "z_last: 1", "a_first:   \"  padded  \"", "list: [ 3,2,1 ]", "", "trailing_blank: yes", "---", "", "Body.", ""].join("\n");
    expect(roundTrip(source)).toBe(source);
  });

  it("is absent when the file has none", () => {
    expect(parseMarkdown("# Just a heading\n", "/x.md").frontmatter).toBe(null);
  });

  it("is not confused by a rule that looks like a delimiter", () => {
    const source = "Text.\n\n---\n\nMore text.\n";
    const document = parseMarkdown(source, "/x.md");
    expect(document.frontmatter).toBe(null);
    expect(roundTrip(source)).toBe(source);
  });

  it("carries a byte order mark so the file does not lose it", () => {
    const file = corpusFile("hand/bom.md");
    const document = parseMarkdown(file.source, "/corpus/bom.md");

    expect(file.source.startsWith(BOM)).toBe(true);
    expect(document.frontmatter).toBe(BOM);
    expect(roundTrip(file.source)).toBe(file.source);
  });

  it("keeps a mark and a frontmatter block together", () => {
    const source = `${BOM}---\ntitle: Marked\n---\n\n# Body\n`;
    const document = parseMarkdown(source, "/x.md");
    expect(document.frontmatter).toBe(`${BOM}---\ntitle: Marked\n---\n\n`);
    expect(roundTrip(source)).toBe(source);
  });
});
