// Everything in front of the markdown, and the two normalisations the parser needs applied before
// it sees a byte.
//
// The frontmatter block is carried as the opaque string it was read as and is never parsed, so a
// save puts back exactly the bytes that were there: key order, quoting, comments, blank lines and
// formats this app does not understand at all, TOML included.
//
// A byte order mark rides along in the same string for want of anywhere else to put it. It is not
// frontmatter, but it is leading bytes the parser must not see and the file must not lose, and the
// document contract has one slot for leading bytes. A file with a mark and no frontmatter therefore
// has a frontmatter string that is only the mark.

import type { Root, RootContent } from "mdast";

export const BOM = "\uFEFF";

/**
 * The text the parser is given, which is not always the text on disk.
 *
 * CRLF is collapsed because a document whose raw blocks kept their carriage returns while every
 * reserialized block lost them would write a file with mixed line endings, which is worse than
 * settling on one. A CRLF file is therefore rewritten as LF the first time it is saved, and the
 * offsets in this text are the ones every source slice is cut from.
 *
 * A carriage return that is not part of a CRLF pair is left where it is. It is not a line ending
 * to anyone, the parser keeps it verbatim inside a fenced block or a frontmatter value, and
 * rewriting it as a newline turns one line into two.
 *
 * A CRLF at the end of a run of carriage returns is left alone as well, and that is the only
 * CRLF this ever writes back. Collapsing it would put the carriage return in front of it hard up
 * against the newline, making a CRLF that was not there and that the next save would collapse in
 * turn, so a lone carriage return before a line ending would be eaten one save later.
 */
export interface NormalisedSource {
  text: string;
  bom: boolean;
}

export function normaliseSource(source: string): NormalisedSource {
  const bom = source.startsWith(BOM);
  const body = bom ? source.slice(BOM.length) : source;
  return { text: body.replace(/\r*\n/g, (ending) => (ending.length === 2 ? "\n" : ending)), bom };
}

/** `toml` is a node type only the frontmatter extension knows about, so the test is by name. */
const FRONTMATTER_TYPES: ReadonlySet<string> = new Set(["yaml", "toml"]);

export function isFrontmatterNode(node: RootContent | undefined): boolean {
  return node !== undefined && FRONTMATTER_TYPES.has(node.type);
}

/**
 * The opaque prefix, or null when the file has neither frontmatter nor a byte order mark.
 *
 * The prefix runs to the end of the closing delimiter line and swallows the blank lines after it,
 * because those blank lines are part of how the file was written and nothing downstream would put
 * them back.
 *
 * A line ending here is whatever the parser called a line ending when it decided where the
 * frontmatter stopped, which includes a lone carriage return. Scanning for a newline instead would
 * run past the end of the delimiter line and hand back a prefix that does not end a line, and the
 * first line of the body would be written onto the end of the closing delimiter.
 */
export function splitFrontmatter(tree: Root, text: string, bom: boolean): string | null {
  const first = tree.children[0];
  if (!isFrontmatterNode(first) || !first?.position) return bom ? BOM : null;

  let end = first.position.end.offset ?? 0;
  while (end < text.length) {
    const line = lineEndingAfter(text, end);
    if (!line) {
      if (text.slice(end).trim() === "") end = text.length;
      break;
    }
    if (text.slice(end, line.at).trim() !== "") break;
    end = line.at + line.length;
  }

  return (bom ? BOM : "") + text.slice(0, end);
}

function lineEndingAfter(text: string, from: number): { at: number; length: number } | null {
  const offset = text.slice(from).search(/[\r\n]/);
  if (offset === -1) return null;
  const at = from + offset;
  return { at, length: text.startsWith("\r\n", at) ? 2 : 1 };
}

/** The whole file: the bytes that were in front of the markdown, then the markdown. */
export function withFrontmatter(frontmatter: string | null, body: string): string {
  return frontmatter === null ? body : frontmatter + body;
}
