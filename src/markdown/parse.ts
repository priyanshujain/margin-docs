// mdast in, ProseMirror out.
//
// The rule the whole file is built around: a construct this schema cannot hold is never dropped,
// never approximated and never guessed at. It becomes a raw block carrying the exact source slice,
// cut from the node's own position offsets, and the serializer writes those bytes back untouched.
//
// Raw blocks only ever appear at the top level. A node's offsets are into the file, so the slice of
// something inside a blockquote or a list item carries that container's own markers with it, and
// putting that slice back inside the container on the way out would write them twice. So a child
// that cannot be modelled fails its parent, the failure walks up to the top level block that
// contains it, and that whole block is preserved verbatim instead. A footnote definition inside a
// list means the list is raw, which is a fair trade for a list that is still there when the file
// is reopened.

import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { BlockContent, DefinitionContent, List, ListItem, PhrasingContent, RootContent, Table } from "mdast";
import { calloutKindFromLabel, rawNode } from "../model/doc";
import { isFrontmatterNode } from "./frontmatter";
import type { ColumnAlign, HeadingLevel } from "../model/doc";
import { schema } from "../model/schema";

const n = schema.nodes;
const m = schema.marks;

/**
 * `> [!NOTE]` and the four others. The label has to be alone on the quote's first line, because
 * that is the only shape GitHub renders as an alert: `> [!NOTE] and then text` is a quote that
 * happens to start with a bracket, and promoting it would change what the file means.
 */
const CALLOUT_PREFIX = /^\[!([^\]\n]*)\][ \t]*(?:\n|$)/;

/**
 * A line ending only the parser believes in.
 *
 * remark ends a line on one of these and the writer never puts one back, so any construct whose
 * shape is rebuilt from its parts rather than copied out of the source has to refuse a span that
 * holds one. A paragraph keeps its own because the character rides along inside a text node.
 */
const CARRIAGE_RETURN = "\r";

function spanOf(node: RootContent): [number, number] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`markdown node without position: ${node.type}`);
  }
  return [start, end];
}

function isBlank(between: string): boolean {
  return between.trim() === "";
}

/**
 * The document body. Anything unmodellable becomes a raw block, and a run of neighbouring raw
 * blocks separated by nothing but whitespace becomes one block covering the lot, so a stack of
 * footnote definitions or a `<div>` followed by another keeps the spacing the author gave it
 * instead of being pulled apart into blocks with a blank line forced between them.
 */
export function buildDoc(children: RootContent[], text: string): ProseMirrorNode {
  const toggles = togglePairs(children);
  const blocks: ProseMirrorNode[] = [];
  let rawStart = -1;
  let rawEnd = -1;

  const flushRaw = () => {
    if (rawStart < 0) return;
    blocks.push(rawNode(rawSlice(text, rawStart, rawEnd)));
    rawStart = -1;
    rawEnd = -1;
  };

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (isFrontmatterNode(child)) continue;
    const [start, end] = spanOf(child);
    const closing = toggles.get(index);
    const built = closing === undefined ? blockFrom(child, text) : toggleFrom(children, index, closing, text);
    if (built) {
      flushRaw();
      blocks.push(built);
      if (closing !== undefined) index = closing;
      continue;
    }
    if (rawStart >= 0 && isBlank(text.slice(rawEnd, start))) {
      rawEnd = end;
      continue;
    }
    flushRaw();
    rawStart = start;
    rawEnd = end;
  }
  flushRaw();

  if (blocks.length === 0) blocks.push(n.paragraph.create());
  return n.doc.create(null, blocks);
}

/**
 * The source a raw block holds, which is the block's own bytes and not the file's last line ending.
 *
 * Almost every construct ends at its last character and the line ending after it belongs to the
 * file. One does not: a `$$` that is never closed runs to the final byte, blank lines and all,
 * because there is no fence left to stop at. So the last block of a file can be handed back holding
 * the line ending that the writer is about to put there anyway, and the document a save produces is
 * then not the document the save was given.
 *
 * Exactly one line ending is taken off, and only where the writer would put exactly one back. The
 * writer ends a file with a line ending when the last block does not already end in one and adds
 * nothing when it does, so a block ending in two of them keeps both: trimming there would delete a
 * blank line out of the middle of an unclosed `<pre>` or `$$`, where whitespace is what the block is
 * made of. That is a byte of the user's file gone, which is worse in every way than the document
 * settling one save later, and it is what the wider trim this replaces did.
 *
 * Only the end of the file is trimmed at all. A block in the middle of a document has the bytes
 * between it and its neighbour written back by the writer rather than by the block, and trailing
 * spaces on the last line are the user's own wherever the block sits.
 */
function rawSlice(text: string, start: number, end: number): string {
  const slice = text.slice(start, end);
  if (end !== text.length) return slice;
  return /[^\r\n]\n$/.test(slice) ? slice.slice(0, -1) : slice;
}

/** One block, or null when it or anything inside it cannot be modelled. */
function blockFrom(node: RootContent, text: string): ProseMirrorNode | null {
  switch (node.type) {
    case "paragraph": {
      const content = inlineFrom(node.children, []);
      return content && n.paragraph.create(null, content);
    }
    case "heading": {
      const content = inlineFrom(node.children, []);
      return content && n.heading.create({ level: node.depth as HeadingLevel }, content);
    }
    case "blockquote":
      return quoteFrom(node.children, text);
    case "list":
      return listFrom(node, text);
    case "code":
      return n.codeBlock.create(
        { language: node.lang ?? null, meta: node.meta ?? null },
        node.value ? schema.text(node.value) : null,
      );
    case "thematicBreak":
      return n.horizontalRule.create();
    case "table":
      return tableFrom(node, text);
    case "math":
      return mathFrom(node, text);
    default:
      return null;
  }
}

function blocksFrom(nodes: Array<BlockContent | DefinitionContent>, text: string): ProseMirrorNode[] | null {
  const out: ProseMirrorNode[] = [];
  for (const node of nodes) {
    const built = blockFrom(node, text);
    if (!built) return null;
    out.push(built);
  }
  return out;
}

/**
 * A blockquote, or the GitHub alert one is pretending to be.
 *
 * A quote that opens with a bracketed word that is not one of the five alert kinds is left as raw
 * source: the serializer would have to escape the bracket to write it back as ordinary text, and a
 * file that gains a backslash it never had is exactly the kind of quiet rewrite this bridge exists
 * to avoid.
 */
function quoteFrom(children: Array<BlockContent | DefinitionContent>, text: string): ProseMirrorNode | null {
  const first = children[0];
  const opening = first?.type === "paragraph" ? first : null;
  const head = opening?.children[0];
  const opener = head?.type === "text" ? head.value : "";

  if (!opener.startsWith("[!")) {
    const content = blocksFrom(children, text);
    return content && content.length > 0 ? n.blockquote.create(null, content) : null;
  }

  const label = CALLOUT_PREFIX.exec(opener);
  const kind = label ? calloutKindFromLabel(label[1]) : null;
  if (!label || !kind || !opening) return null;
  const rest = opener.slice(label[0].length);
  const remainder: PhrasingContent[] = rest ? [{ type: "text", value: rest }, ...opening.children.slice(1)] : opening.children.slice(1);

  const body: Array<BlockContent | DefinitionContent> = remainder.length > 0 ? [{ type: "paragraph", children: remainder }, ...children.slice(1)] : children.slice(1);

  const content = blocksFrom(body, text);
  if (!content) return null;
  return n.callout.create({ kind }, content.length > 0 ? content : n.paragraph.create());
}

/**
 * Tight or loose, read off where the items are rather than off the list's own `spread`.
 *
 * A list is loose when a blank line separates two of its items or when one item holds two blocks a
 * blank line apart, and neither of those is a blank line after the last item. remark counts that
 * last one anyway wherever a container carries it: inside a quote the line is `>` rather than empty,
 * the list token runs over it, and `> - one\n> - two\n>\n> > nested` came back spread. The writer
 * then wrote a loose list, so the save after that put a blank line between every item as well, and
 * a file nobody had edited moved on its first save and again on its second.
 *
 * An item's own `spread` is asked for directly because it is the half remark gets right. The other
 * half is the gap between two items, which is a blank line exactly when they are not on adjacent
 * lines, and lines are the one measure a container's markers do not change.
 */
function isTight(list: List): boolean {
  if (list.children.some((child) => child.spread === true)) return false;

  for (let index = 1; index < list.children.length; index += 1) {
    const above = list.children[index - 1].position?.end.line;
    const below = list.children[index].position?.start.line;
    if (above === undefined || below === undefined) return list.spread !== true;
    if (below > above + 1) return false;
  }
  return true;
}

/**
 * A list. Every item has to open with a paragraph, because that is what the schema says and what
 * every list command in the editor assumes; an item that opens with a nested list or a fence is
 * markdown the editor cannot hold, so the list goes back as raw source rather than being reshaped
 * into something that reads the same and writes differently.
 */
function listFrom(list: List, text: string): ProseMirrorNode | null {
  const items: ProseMirrorNode[] = [];
  let allChecked = true;

  for (const child of list.children) {
    if (child.type !== "listItem") return null;
    const item = itemFrom(child, text);
    if (!item) return null;
    if (child.checked === null || child.checked === undefined) allChecked = false;
    items.push(item);
  }
  if (items.length === 0) return null;

  // An ordered list of tasks stays an ordered list: taskList is unordered, and promoting one would
  // renumber "1. [ ] first" into a bullet. Both plain lists take task items, so nothing is lost.
  const tight = isTight(list);
  if (list.ordered) return n.orderedList.create({ tight, start: list.start ?? 1 }, items);
  if (allChecked) return n.taskList.create({ tight }, items);
  return n.bulletList.create({ tight }, items);
}

function itemFrom(item: ListItem, text: string): ProseMirrorNode | null {
  const checked = item.checked;
  const content = item.children.length === 0 ? [n.paragraph.create()] : item.children[0]?.type === "paragraph" ? blocksFrom(item.children, text) : null;
  if (!content) return null;
  if (checked === null || checked === undefined) return n.listItem.create(null, content);
  return n.taskItem.create({ checked }, content);
}

/**
 * A GFM table, the exact inverse of `tableToMdast`.
 *
 * The first row is the header row and the rest are body cells, which is the only shape GFM has:
 * the delimiter line under the first row is what makes the block a table at all.
 *
 * Alignment comes off that delimiter row once per column and is written onto every cell in the
 * column, because that is where the schema keeps it and where the CSS reads it, and because a cell
 * that had to walk upwards for it could not be styled while it was being dragged between rows.
 *
 * Short rows are padded out to the header, which is what GFM already renders them as and what
 * prosemirror-tables needs before any of its commands can be trusted on the table. A row with more
 * cells than the header is not padded and not modelled: GFM shows no more columns than the header
 * has, so the cells past the end are text nobody sees, and there is no third answer between
 * dropping them and promoting them into a column the document never had.
 *
 * A carriage return anywhere in the table is the other thing that stops one being modelled. It is
 * a line ending to the parser and to nobody else, so it ends a row here and would be written back
 * as a newline, which is a byte of the user's file changed by an editor that never touched it.
 */
function tableFrom(table: Table, text: string): ProseMirrorNode | null {
  const [start, end] = spanOf(table);
  if (text.slice(start, end).includes(CARRIAGE_RETURN)) return null;

  const width = table.children[0]?.children.length ?? 0;
  if (width === 0) return null;
  if (table.children.some((row) => row.children.length > width)) return null;

  const rows: ProseMirrorNode[] = [];
  for (const row of table.children) {
    const type = rows.length === 0 ? n.tableHeader : n.tableCell;
    const cells: ProseMirrorNode[] = [];
    for (let column = 0; column < width; column += 1) {
      const cell = row.children[column];
      const content = cell ? inlineFrom(cell.children, []) : [];
      if (!content) return null;
      cells.push(type.create({ align: (table.align?.[column] ?? null) as ColumnAlign }, content));
    }
    rows.push(n.tableRow.create(null, cells));
  }
  return n.table.create(null, rows);
}

/** The run of dollars a math block opens with, which is two or more of them. */
const MATH_FENCE = /^\$\$+/;

/**
 * A `$$` block, or null when writing it back would not reproduce the bytes it was read from.
 *
 * A fence carrying meta, `$$ tag`, has nowhere to keep the tag: the serializer writes
 * `meta: null` and the word would be gone from the file without the user having touched the block.
 * A fence that is never closed, which a file ending mid equation gives, ends at the last byte
 * rather than at a fence, and writing it back would gain a closing `$$` this editor invented.
 * Inventing syntax is a worse answer than leaving the source alone, so both stay raw.
 *
 * The offsets also decide whether the block is somewhere its own bytes can be written back. Inside
 * a blockquote or a list item the slice starts at the fence and the container's markers fall on
 * the lines after it, which still reads as this construct; anything that begins with indentation
 * or with anything else does not, and stays raw.
 */
function mathFrom(node: Extract<RootContent, { type: "math" }>, text: string): ProseMirrorNode | null {
  if (node.meta) return null;
  const [start, end] = spanOf(node);
  const slice = text.slice(start, end);
  const fence = MATH_FENCE.exec(slice);
  if (!fence || slice.length <= fence[0].length || !slice.endsWith("$$")) return null;
  if (slice.includes(CARRIAGE_RETURN)) return null;
  return n.mathBlock.create({ latex: node.value });
}

/**
 * `<details>` on disk, exactly as `toggleToMdast` writes it and no other spelling.
 *
 * remark hands back html blocks rather than a tree, so a toggle arrives as two opaque strings with
 * real markdown between them and the pairing has to be done here. Everything about the two strings
 * is pinned: the tag on its own line, one optional bare `open`, the summary on the next line with
 * no markup in it. An attribute the schema cannot hold, an indented tag, a summary carrying a span,
 * a `<details>` all on one line with its body: none of those is this construct, and each stays the
 * raw source it was read as.
 */
/**
 * The summary of a `<details>`, as html rather than as markdown.
 *
 * The two halves are one table and live here rather than beside the writer because the parser has
 * to undo exactly what the writer does and no more: a summary the parser cannot hand back
 * character for character is one it refuses to model, so the pair being an exact inverse is what
 * decides whether a toggle on disk is editable or stays a raw block.
 */
export function escapeSummary(summary: string): string {
  return summary.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SUMMARY_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">" };

export function unescapeSummary(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) => SUMMARY_ENTITIES[name]);
}

const TOGGLE_OPEN = /^<details( open)?>\n<summary>([^<>]*)<\/summary>$/;
const TOGGLE_CLOSE = "</details>";
const TOGGLE_TAG = /<\/?details\b/;

interface OpenToggle {
  index: number;
  nested: boolean;
}

/**
 * Which top level html blocks open a toggle, and which one closes each of them.
 *
 * Pairing is decided for the whole document before any of it is built, because whether one
 * `<details>` is modellable depends on what the rest of the file does with the tag. A pair is only
 * taken when it is unambiguous: nothing nested inside it, nothing outside it holding it, and no
 * tag anywhere before it that this file cannot read. The first tag it cannot read ends pairing for
 * the rest of the document rather than guessing at what the tags after it belong to, since the one
 * thing worse than a `<details>` that stays a raw block is a `</details>` closing the wrong one.
 */
function togglePairs(children: RootContent[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: OpenToggle[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== "html" || !TOGGLE_TAG.test(child.value)) continue;

    if (TOGGLE_OPEN.test(child.value)) {
      for (const entry of open) entry.nested = true;
      open.push({ index, nested: false });
      continue;
    }
    const entry = child.value === TOGGLE_CLOSE ? open.pop() : undefined;
    if (!entry) break;
    if (!entry.nested && open.length === 0) pairs.set(entry.index, index);
  }
  return pairs;
}

/** One paired toggle, or null when the summary or the body between the tags cannot be modelled. */
function toggleFrom(children: RootContent[], opening: number, closing: number, text: string): ProseMirrorNode | null {
  const head = children[opening];
  if (head.type !== "html") return null;
  const tags = TOGGLE_OPEN.exec(head.value);
  if (!tags) return null;
  const [start] = spanOf(head);
  const [, end] = spanOf(children[closing]);
  if (text.slice(start, end).includes(CARRIAGE_RETURN)) return null;

  // The summary goes back out through `escapeSummary`, so a summary that does not survive the trip
  // is one whose bytes would change: `&quot;` is not an entity this pair knows and would come back
  // as `&amp;quot;`, which is a different summary on screen and not the one the author wrote.
  const summary = unescapeSummary(tags[2]);
  if (escapeSummary(summary) !== tags[2]) return null;

  const body: ProseMirrorNode[] = [];
  for (let index = opening + 1; index < closing; index += 1) {
    const built = blockFrom(children[index], text);
    if (!built) return null;
    body.push(built);
  }
  return n.toggle.create({ summary, open: tags[1] !== undefined }, body.length > 0 ? body : n.paragraph.create());
}

/**
 * Inline content, or null when any of it cannot be modelled.
 *
 * Soft line breaks stay inside the text as the newlines mdast gives them, so a paragraph that was
 * hard wrapped at some column on disk is written back wrapped at the same places. Rewrapping is a
 * whole file diff on a document nobody meaningfully edited.
 */
function inlineFrom(nodes: PhrasingContent[], marks: readonly Mark[]): ProseMirrorNode[] | null {
  const out: ProseMirrorNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        if (node.value) out.push(schema.text(node.value, marks));
        break;
      }
      case "emphasis":
      case "strong":
      case "delete": {
        const mark = node.type === "emphasis" ? m.em : node.type === "strong" ? m.strong : m.strikethrough;
        // addToSet, not a spread: Mark.setFrom sorts but does not deduplicate, and GFM really does
        // nest a mark inside itself for "~~a ~~b~~ c~~". Two identical marks on one text node
        // serialize as four tildes, which reopen as literal text and then grow on every save.
        const inner = inlineFrom(node.children, mark.create().addToSet(marks));
        if (!inner) return null;
        out.push(...inner);
        break;
      }
      case "inlineCode": {
        if (node.value) out.push(schema.text(node.value, [...marks, m.code.create()]));
        break;
      }
      case "link": {
        // A link inside another link's text, which `[see <https://x> more](./y.md)` is. A link is
        // a mark and a mark set holds one link, so one of the two destinations has nowhere to go.
        // The block goes back as raw source instead: keeping the bytes is the honest answer, and
        // dropping a destination quietly is the one thing this bridge is here not to do.
        if (marks.some((mark) => mark.type === m.link)) return null;
        const mark = m.link.create({ href: node.url, title: node.title ?? null });
        const inner = inlineFrom(node.children, [...marks, mark]);
        // A mark needs something to sit on, so a link with no text at all, `[](./x.md)`, has
        // nowhere to live in the document and would be dropped along with its destination.
        if (!inner || inner.length === 0) return null;
        out.push(...inner);
        break;
      }
      case "image":
        out.push(n.image.create({ src: node.url, alt: node.alt ?? null, title: node.title ?? null }, null, marks));
        break;
      case "break":
        out.push(n.hardBreak.create(null, null, marks));
        break;
      case "inlineMath":
        out.push(n.mathInline.create({ latex: node.value }, null, marks));
        break;
      default:
        return null;
    }
  }
  return out;
}
