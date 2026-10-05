// The headings of a document, as the outline rail draws them, and where a reader is among them.
//
// Read off the live tree rather than off the file, because the outline has to be true of the
// document a keystroke ago and the file is half a second behind that. It is the tree's own
// positions that come out of it, which is what makes a row clickable: a position is the one thing
// the editor can put a caret at without going through the DOM.
//
// Only the document's own children are looked at. A heading inside a callout, a quote or a list is
// a heading in somebody else's block, and one inside a toggle is text the toggle may be hiding, so
// jumping to it would land the caret somewhere the page does not show. A table of contents is a
// claim about the document's sections, and a section is a top level thing.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { HeadingLevel } from "./doc";

export interface OutlineEntry {
  level: HeadingLevel;
  /** The heading's words, with its whitespace folded. Never empty: an empty heading is a slot the
   * writer has not filled rather than a section, and is left out until it says something. */
  text: string;
  /** Where the heading starts in the tree, which is what `reveal` on the editor's outline handle
   * takes. Right for the tree it was read from and stale the moment that tree changes, which is
   * why the editor republishes the whole list on every change rather than patching it. */
  pos: number;
  /** How many headings this one sits under, so `## A` followed by `#### B` puts B one step in and
   * not three. A row's indent is a fact about the outline and not about the heading's level. */
  depth: number;
}

export function outlineOf(doc: ProseMirrorNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const open: HeadingLevel[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (!text) return;
    const level = node.attrs.level as HeadingLevel;
    while (open.length > 0 && open[open.length - 1] >= level) open.pop();
    entries.push({ level, text, pos: offset, depth: open.length });
    open.push(level);
  });
  return entries;
}

/**
 * The heading a reader is in, given where each heading's top edge sits below the top of the pane,
 * in document order.
 *
 * The last heading that has come up into the top third of the pane, which is the section whose text
 * fills the rest of it, and nothing while the pane is still above the first. At the end of the
 * document the last heading is the answer whatever its top says, since a short last section never
 * scrolls that far and a reader who has scrolled to the end is in it.
 */
export function currentAt(
  tops: readonly number[],
  paneHeight: number,
  atEnd: boolean,
): number | null {
  if (tops.length === 0) return null;
  if (atEnd) return tops.length - 1;
  const line = paneHeight / 3;
  let found: number | null = null;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] > line) break;
    found = i;
  }
  return found;
}

/** Whether two outlines would draw the same rows, so an edit under the last heading republishes nothing. */
export function sameOutline(a: readonly OutlineEntry[], b: readonly OutlineEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].level !== b[i].level || a[i].text !== b[i].text || a[i].pos !== b[i].pos) return false;
  }
  return true;
}
