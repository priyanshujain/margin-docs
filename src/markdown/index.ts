// The markdown bridge: a file's bytes in, a document the editor can edit out, and the same file
// back again. This is the only place in the app where markdown is parsed or written, and it never
// touches the filesystem: text arrives as a string from the Rust side and leaves as a string going
// back to it.
//
// Four invariants hold over everything below. They are the product's promises before they are
// implementation details, and a change that breaks one of them is a bug in the product, not a
// difference of opinion about formatting.
//
// Opening a document writes nothing. `parseMarkdown` is pure and has nowhere to write to, so a
// file that is opened, read, looked at and closed is byte identical on disk afterwards because
// nothing ever called a serializer.
//
// Serializing is stable. The first save of a file this editor has never written rewrites it in the
// one house style, which may well differ from what the author's other tools produced. Every save
// after that produces the same bytes for the same document, so a file is reformatted at most once
// in its life and then stops moving.
//
// Frontmatter passes through untouched. It is carried as the opaque string it was read as,
// delimiter lines and all, and put back in front of the body without ever being parsed, so key
// order, quoting, comments and formats this app does not understand at all survive a save they had
// no part in.
//
// Nothing is silently dropped. Markdown the schema cannot model becomes a raw node holding the
// exact source slice, and a raw node the user has not edited is written back verbatim. Losing a
// construct quietly is worse than never having supported it, because the loss is invisible until
// the file is opened somewhere else.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import type { MarkdownDocument } from "../model/doc";
import { rawNode } from "../model/doc";
import { BOM, normaliseSource, splitFrontmatter, withFrontmatter } from "./frontmatter";
import { parseToMdast } from "./handlers";
import { buildDoc } from "./parse";
import { serializeBody } from "./serialize";

export type { MarkdownDocument };

/**
 * Parses one markdown file into the document the editor edits.
 *
 * `source` is the whole file exactly as it came off disk, frontmatter included, and `path` is the
 * file it came from, kept on the document because relative links and pasted image paths are
 * resolved against it. Neither is read from disk here and nothing is written anywhere.
 *
 * The result carries `source` unchanged, which is what lets a caller tell a document that would
 * round trip byte identical from one whose first save will normalise it: serialize the untouched
 * parse and compare.
 */
export function parseMarkdown(source: string, path: string): MarkdownDocument {
  const { text, bom } = normaliseSource(source);
  const tree = parseToMdast(text);
  return {
    frontmatter: splitFrontmatter(tree, text, bom),
    doc: buildDoc(tree.children, text),
    source,
    path,
  };
}

/**
 * Writes a document back out as the whole file, frontmatter included, ready to hand to `file_write`
 * as it stands.
 *
 * `doc` is passed separately from `document` because the editor owns the current tree while the
 * document owns everything around it: the frontmatter to put back in front, the path, and the
 * source the result can be compared against. `document.doc` is the tree as it was parsed rather
 * than as it is now, so serializing that would save the document as it was opened.
 *
 * There is one house style, fixed in this module and never varied per document or per call site,
 * which is why there are no options here and why there should not be.
 *
 * The one thing the body writer cannot work out for itself is whether its first byte is the file's
 * first byte, and that is the only thing it is told. A block whose bytes open `---` or `+++` is
 * read back as frontmatter when it sits at the top of a file and is perfectly ordinary two lines
 * down, so the defence against it has to be skipped for a body that already has a prefix coming.
 */
export function serializeMarkdown(document: MarkdownDocument, doc: ProseMirrorNode): string {
  return withFrontmatter(document.frontmatter, serializeBody(doc, document.frontmatter === null));
}

/**
 * The whole body as one raw block: the file, shown as its own source.
 *
 * The last resort for a document the editor will not hold. The bridge refuses a construct by making
 * a raw block of it, which is the same answer at a smaller scale, and a raw block the user has not
 * typed in is written back byte for byte, so a file opened this way and saved is the file that was
 * read. The alternative that was here, an empty document, is the one outcome the module's fourth
 * invariant exists to forbid: the file looks empty on screen and the first keystroke saves it that
 * way over the bytes on disk.
 */
export function sourceDocument(document: MarkdownDocument): ProseMirrorNode {
  const { text } = normaliseSource(document.source);
  // The prefix is the frontmatter as it will be written back, and it carries the byte order mark
  // when there is one. `text` has already had that mark taken off, so putting it into the slice
  // offset would cut the body's first character off with it.
  const head = document.frontmatter ?? "";
  const prefix = head.startsWith(BOM) ? head.slice(BOM.length) : head;
  const body = text.slice(prefix.length);
  const doc = schema.nodes.doc.createAndFill(null, body ? [rawNode(body)] : []);
  if (!doc) throw new Error("the source could not be held as a raw block");
  return doc;
}

/**
 * A .txt file, which the tree marks editable and the editor opens alongside markdown.
 *
 * Plain text is not markdown and is never parsed as it. A line reading `# heading` in a .txt file
 * is that literal text, has to look like that literal text on screen, and has to still be that
 * literal text after a save. The document that comes back has no frontmatter, and its round trip
 * is byte identical for any input, trailing whitespace and a missing final newline included.
 *
 * One line is one paragraph, which makes splitting and joining on the newline exact inverses: a
 * trailing newline is a trailing empty paragraph, and a file that ends without one has no such
 * paragraph to write.
 */
export function parsePlainText(source: string, path: string): MarkdownDocument {
  const lines = source.split("\n");
  const blocks = lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
  return { frontmatter: null, doc: schema.nodes.doc.create(null, blocks), source, path };
}

/**
 * The counterpart of `parsePlainText`, taking the same pair as `serializeMarkdown` so a caller can
 * pick the two functions by `documentKindForPath` and then stop caring which it got.
 *
 * No escaping, no reflowing, no normalising: the characters in the document are the bytes of the
 * file.
 */
export function serializePlainText(document: MarkdownDocument, doc: ProseMirrorNode): string {
  void document;
  const lines: string[] = [];
  doc.forEach((block) => lines.push(block.textContent));
  return lines.join("\n");
}
