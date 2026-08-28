// ProseMirror out, markdown back.
//
// The document becomes an mdast tree and mdast writes it, so escaping, fence lengths, list
// indentation and every other detail of "is this valid markdown" is decided by the same library
// that read the file rather than by string concatenation here.
//
// Two things bypass mdast on purpose. A raw block is written from its text content with no
// escaping at all, because those are the file's own bytes and the only correct thing to do with
// them is nothing. A link that was a bare url in the source is written back as a bare url, through
// an inline html node, because mdast would otherwise spell every plain `https://` in a README as
// `[https://x](https://x)` and put a diff in front of the user that they did not ask for.
//
// Writing a url bare is never assumed to be safe. GFM's literal autolink grammar has far more
// corners than a pair of regular expressions here could hold, and every corner it got wrong cost a
// destination. So the block is written out and read back with the parser the bridge reads files
// with, and a spelling is kept only when what comes back is the same link in the same place. The
// price is a re-parse of the blocks that contain a bare url.
//
// There are three spellings and they are tried shortest first: the url on its own, then `<url>`,
// then `[url](url)`, which has no grammar left to get wrong and is where the ladder ends. The
// middle rung exists because a fair number of urls GFM will not pick up bare are perfectly good
// CommonMark autolinks, and a file that already says `<url>` should not be rewritten into something
// longer and noisier for no reason. Verification is what makes a rung safe rather than the rung
// being short, so a third one is no more of a risk than the first two.
//
// The inline html node a bare or angle url goes out as is retyped by `stringifyMdast` on the way to
// the writer, because mdast turns a soft line break in front of inline html into a space and a url
// at the start of a hard wrapped line would otherwise never survive its own verification.
//
// Two more spellings are decided the same way and for the same reason, which is that mdast is
// cautious about a reader that is not this one. A code span or an equation the file wrapped across
// two lines keeps its line ending rather than having it swapped for a space, and a url the user
// typed as text keeps the characters they typed rather than gaining a backslash the reader ignores.
// Each is written, read back and compared before it is kept, and each falls back to what mdast
// would have written on its own. Neither costs a trip through the parser in a block that has
// nothing of the sort in it, which is nearly every block in nearly every file.
//
// Those two are questions about a spelling: is the short form of this url the same link as the
// long one. Underneath them is a question about the block, and it is the one that matters, because
// a spelling proved equal to a fallback that is itself wrong is a block written wrong twice. So a
// block that holds bytes mdast did not choose, or a line ending somewhere markdown has no way to
// write one, is read back and compared against the document itself before it is written, and falls
// through a ladder of plainer spellings until one of them comes back as the block it started as.
// That check is general: it names no construct and knows nothing about headings, toggles or lists,
// and it is what a heading that loses its own marker and a code span holding a blank line both run
// into on the way out.
//
// It is not free, which is why it is asked only of the blocks that could go wrong. Reading the
// whole document back costs about eight times what writing it does, measured over the corpus, and
// this editor writes a file half a second after the user stops typing.
//
// Two things about a file are not about any block in it, and each has its own check because the one
// above cannot see either. The seam between two blocks is one: a blank line closes every construct
// markdown has except a list, which carries on over one and takes the next block into itself, so a
// list written next to a block of the file's own bytes is proved apart and respelled until it is.
// Where the body starts is the other: `---` on the first line of a file is not a rule, it is the
// opening delimiter of frontmatter, and everything down to the next one stops being markdown.

import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { BlockContent, DefinitionContent, List, ListItem, PhrasingContent, Root, RootContent, TableCell, TableRow } from "mdast";
import { CALLOUT_LABELS, isRawUnchanged, rawOutput } from "../model/doc";
import type { CalloutKind, ColumnAlign } from "../model/doc";
import type { MarkName } from "../model/schema";
import { parseToMdast, rawBlock, stringifyMdast, withOtherBullet, withOtherRule, withWideItems } from "./handlers";
import { isFrontmatterNode, normaliseSource } from "./frontmatter";
import { buildDoc, escapeSummary } from "./parse";

/**
 * Nesting order for the marks on a piece of text, outermost first.
 *
 * ProseMirror holds marks as a set, so `**_x_**` and `_**x**_` arrive here identical and one of
 * them has to win. Fixing the order is what makes the second save of a file produce the same bytes
 * as the first. Code is last because it is a leaf rather than a wrapper.
 */
const MARK_ORDER: MarkName[] = ["link", "strikethrough", "strong", "em", "code"];

/**
 * The two shapes a bare url can have, used only to keep hopeless candidates out of the verifier.
 *
 * Neither is a copy of GFM's grammar and neither decides anything: a url that matches is written
 * both ways and read back, and a url that does not match was never going to survive the trip.
 */
const URL_SHAPED = /^(?:https?:\/\/|www\.)[^\s<>]+$/i;
const EMAIL_SHAPED = /^[^\s<>@]+@[^\s<>@]+$/;

/**
 * And the shape of a url that `<url>` could hold, used the same way and deciding no more than the
 * other two: a scheme, a colon, and nothing in the rest that would close the bracket early.
 */
const ANGLE_SHAPED = /^[A-Za-z][A-Za-z0-9+.-]+:[^\s<>]*$/;

/**
 * The document as the body of a file, which is one question more than the document as blocks.
 *
 * Everything else in this file is decided about a block, or about the seam between one block and
 * the next. Where the body starts is neither: frontmatter is a property of the whole file, it is
 * found by looking at the first byte, and a block that would be perfectly safe two lines further
 * down is read as an opening delimiter there. `---` is what the house style writes a rule as, so a
 * document beginning with a rule writes its own frontmatter delimiter and the next open loses
 * everything down to the next one. A paragraph the user typed as `+++` does the same.
 *
 * The proof is the reader's own answer to the reader's own question, asked of the bytes about to be
 * written, and it is asked only of a body whose first three characters could start a delimiter,
 * which is nearly no document at all. The rule is then written with the other character markdown
 * has for it, and anything else is pushed off the first byte by a blank line, which is where a
 * block whose bytes are the user's own has to go because they are not this writer's to respell.
 *
 * A body with frontmatter in front of it was never in danger, which is what `atStartOfFile` is for.
 * Guessing wrong there is not a cosmetic mistake: the blank line this prepends is handed back by
 * the reader as part of the frontmatter, so it is written again on the next save and again on the
 * one after, and a document of `+++` under a frontmatter block lost both its paragraphs on the
 * first save and then gained a byte every save for the rest of its life. `serializeMarkdown` knows
 * whether it is about to put a prefix in front and is the only thing that can answer, so it does.
 */
export function serializeBody(doc: ProseMirrorNode, atStartOfFile = true): string {
  const tree = docToMdast(doc);
  const body = stringifyMdast(tree);
  if (!atStartOfFile || !swallowed(body)) return body;

  const first = tree.children[0];
  if (first?.type === "thematicBreak") {
    withOtherRule(first, true);
    const respelled = stringifyMdast(tree);
    if (!swallowed(respelled)) return respelled;
    withOtherRule(first, false);
  }
  return `\n${body}`;
}

/** Whether the reader would take the start of this body for frontmatter rather than for a block. */
function swallowed(body: string): boolean {
  if (!body.startsWith("---") && !body.startsWith("+++")) return false;
  return isFrontmatterNode(parseToMdast(body).children[0]);
}

export function docToMdast(doc: ProseMirrorNode): Root {
  const blocks: RootContent[][] = [];
  const nodes: ProseMirrorNode[] = [];
  doc.forEach((child) => {
    nodes.push(child);
    blocks.push(verifiedBlock(child));
  });
  separate(blocks, nodes);
  return { type: "root", children: blocks.flat() };
}

function blocksToMdast(parent: ProseMirrorNode): RootContent[] {
  const out: RootContent[] = [];
  parent.forEach((child) => out.push(...blockToMdast(child)));
  return out;
}

function containedBlocks(parent: ProseMirrorNode): Array<BlockContent | DefinitionContent> {
  return blocksToMdast(parent) as Array<BlockContent | DefinitionContent>;
}

/** One block, as the one to five mdast nodes it takes to write it. */
function blockToMdast(node: ProseMirrorNode): RootContent[] {
  switch (node.type.name) {
    case "paragraph": {
      const children = inlineToMdast(node);
      return children.length === 0 ? [] : [{ type: "paragraph", children }];
    }
    case "heading":
      return [{ type: "heading", depth: node.attrs.level, children: inlineToMdast(node) }];
    case "blockquote":
      return [{ type: "blockquote", children: containedBlocks(node) }];
    case "callout":
      return [calloutToMdast(node)];
    case "bulletList":
      return [listToMdast(node, false, 1)];
    case "taskList":
      return [listToMdast(node, false, 1)];
    case "orderedList":
      return [listToMdast(node, true, node.attrs.start)];
    case "codeBlock":
      return [{ type: "code", lang: node.attrs.language, meta: node.attrs.meta, value: node.textContent }];
    case "horizontalRule":
      return [{ type: "thematicBreak" }];
    case "table":
      return [tableToMdast(node)];
    case "toggle":
      return toggleToMdast(node);
    case "mathBlock":
      return [{ type: "math", meta: null, value: node.attrs.latex }];
    case "raw": {
      const value = rawOutput(node);
      return value ? [rawBlock(value)] : [];
    }
    default:
      return [{ type: "paragraph", children: inlineToMdast(node) }];
  }
}

/**
 * A GitHub alert: an ordinary blockquote whose first line is the label. The label goes out as
 * inline html so that mdast writes the bracket as the bracket, rather than escaping it into
 * `\[!NOTE]` and quietly turning the alert back into a plain quote.
 */
function calloutToMdast(node: ProseMirrorNode): RootContent {
  const label = CALLOUT_LABELS[node.attrs.kind as CalloutKind] ?? CALLOUT_LABELS.note;
  const marker: PhrasingContent = { type: "html", value: `[!${label}]` };
  const children = containedBlocks(node);
  const first = children[0];

  if (first && first.type === "paragraph") {
    const head = first.children[0];
    const joined: PhrasingContent[] = head && head.type === "text" ? [marker, { ...head, value: `\n${head.value}` }, ...first.children.slice(1)] : [marker, { type: "text", value: "\n" }, ...first.children];
    return { type: "blockquote", children: [{ type: "paragraph", children: joined }, ...children.slice(1)] };
  }

  return { type: "blockquote", children: [{ type: "paragraph", children: [marker] }, ...children] };
}

function listToMdast(node: ProseMirrorNode, ordered: boolean, start: number): RootContent {
  const contents: Array<Array<BlockContent | DefinitionContent>> = [];
  const checks: Array<boolean | null> = [];
  node.forEach((item) => {
    contents.push(containedBlocks(item));
    checks.push(item.type.name === "taskItem" ? Boolean(item.attrs.checked) : null);
  });

  // Tight or loose is one decision, for the list and for every item in it. mdast puts a blank line
  // between the blocks of a spread item and between the items of a spread list, and parse.ts reads
  // a list back loose when the list or any item in it is spread, so a list written loose around
  // items built tight comes back as a loose list of loose items and the save after that one writes
  // a blank line inside every item as well as between them. A file that gains a blank line on the
  // first save and more on the second is a file this editor never stops rewriting.
  //
  // The `tight` attribute is only half of the decision. The other half is an item whose blocks
  // cannot be written a single line apart whatever the attribute says, and one of those makes the
  // whole list loose here rather than on the next save.
  const loose = node.attrs.tight !== true || contents.some(runsTogether);
  const children: ListItem[] = contents.map((content, index) => ({ type: "listItem", spread: loose, checked: checks[index], children: content }));
  return ordered ? { type: "list", ordered: true, start, spread: loose, children } : { type: "list", ordered: false, start: null, spread: loose, children };
}

/**
 * Whether an item's blocks would run into one another if they were written a single line apart.
 *
 * Two blocks written flush are two blocks only when the second one opens a block of its own, which
 * is less often than it looks. A paragraph is still open at the end of its last line, so the line
 * under it joins it: a second paragraph runs on into the first, and `---` under a paragraph is a
 * setext heading rather than a rule. A table and an html block are worse than open: every line up
 * to the next blank one is another row or more html, whatever it says. And two quotes written
 * flush are one quote, because the second one's markers are read as more of the first.
 *
 * Only neighbours are asked about, because the blocks are written in order and a pair of them is
 * the whole of what stands between one block and the next.
 */
function runsTogether(blocks: Array<BlockContent | DefinitionContent>): boolean {
  for (let index = 1; index < blocks.length; index += 1) {
    const left = blocks[index - 1];
    const right = blocks[index];
    if (left.type === "blockquote" && right.type === "blockquote") return true;

    const open = leftOpen(left);
    if (open === "all") return true;
    if (open === "paragraph" && !opensBlock(right)) return true;
    if (open === "lazy" && (!opensBlock(right) || right.type === "table")) return true;
  }
  return false;
}

/**
 * What the line under a block runs into: nothing, a paragraph still open, that same paragraph one
 * container further in, or the block itself.
 */
type OpenEnd = "none" | "paragraph" | "lazy" | "all";

function leftOpen(block: BlockContent | DefinitionContent): OpenEnd {
  switch (block.type) {
    case "paragraph":
      return "paragraph";
    case "table":
    case "html":
    case "rawBlock":
      return "all";
    case "blockquote":
      return lazily(block.children[block.children.length - 1]);
    case "list": {
      const item = block.children[block.children.length - 1];
      return item ? lazily(item.children[item.children.length - 1]) : "none";
    }
    default:
      return "none";
  }
}

/**
 * A quote or a list carries out the paragraph inside it and nothing else, because a lazy
 * continuation is a rule about paragraphs alone: the line under a table inside a quote is not
 * another row of that table, it is a paragraph outside the quote.
 *
 * What it carries out is a narrower kind of open than the paragraph the item wrote itself. A lazy
 * line is handed to the container as more of its paragraph before anything else looks at it, and a
 * table's header row is one of the things that never gets to look: `| h |` under a quote is text
 * in the quote, and the table the item is supposed to have is gone.
 */
function lazily(block: BlockContent | DefinitionContent | undefined): OpenEnd {
  if (!block) return "none";
  const open = leftOpen(block);
  return open === "paragraph" || open === "lazy" ? "lazy" : "none";
}

/** Whether a block opens where it is written even though a paragraph is still open above it. */
function opensBlock(block: BlockContent | DefinitionContent): boolean {
  switch (block.type) {
    case "heading":
    case "code":
    case "math":
    case "blockquote":
    case "table":
    case "html":
      return true;
    case "list": {
      // A list interrupts a paragraph only when it counts from one and its first item says
      // something, which is the rule that keeps "the answer is\n2024. a good year" from becoming a
      // list, and a bare marker on the line under a paragraph from becoming one either.
      const first = block.children[0];
      if (!first || first.children.length === 0) return false;
      return !block.ordered || (block.start ?? 1) === 1;
    }
    default:
      return false;
  }
}

function tableToMdast(node: ProseMirrorNode): RootContent {
  const rows: TableRow[] = [];
  const align: ColumnAlign[] = [];

  node.forEach((row) => {
    const cells: TableCell[] = [];
    row.forEach((cell, _offset, index) => {
      if (rows.length === 0) align[index] = (cell.attrs.align as ColumnAlign) ?? null;
      cells.push({ type: "tableCell", children: flatten(inlineToMdast(cell)) });
    });
    rows.push({ type: "tableRow", children: cells });
  });

  return { type: "table", align, children: rows };
}

/**
 * A GFM row is one line, so nothing inside a cell may carry a line ending.
 *
 * A newline written into a cell does not produce a wrapped cell, it ends the row and turns the rest
 * of the table into a paragraph, which is a table the user loses on the next open. Every way one
 * can get there collapses to a space instead: a hard break, which Shift+Enter puts in a cell the
 * schema is happy to hold it in; a code span holding a newline; and text carrying the soft breaks
 * of a paragraph pasted in from somewhere with room for them.
 */
function flatten(children: PhrasingContent[]): PhrasingContent[] {
  return children.map(flattenOne);
}

/**
 * A node is copied only when flattening it changed something, because the node itself is the key.
 * `candidateOf` remembers which bare url a link node belongs to by identity, and a link rebuilt on
 * the way out of a cell would cost the whole block its cheap fallback for no reason.
 */
function flattenOne(child: PhrasingContent): PhrasingContent {
  if (child.type === "break") return { type: "text", value: " " };
  // A wrapped span is the node that keeps a line ending, and a cell is the one place that cannot
  // hold one, so inside a cell it is the plain node again and mdast's own handler writes it.
  if (child.type === "wrappedCode") return { type: "inlineCode", value: oneLine(child.value) };
  if (child.type === "wrappedMath") return { type: "inlineMath", value: oneLine(child.value) };
  if (child.type === "text" || child.type === "inlineCode" || child.type === "inlineMath") {
    const value = oneLine(child.value);
    return value === child.value ? child : { ...child, value };
  }
  if (!("children" in child)) return child;
  const inner = flatten(child.children);
  return inner.every((one, index) => one === child.children[index]) ? child : { ...child, children: inner };
}

function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]\s*/g, " ");
}

/**
 * A `<summary>` keeps the line endings the file gave it, which is not obviously safe and is
 * therefore proved rather than assumed.
 *
 * The opening tag and the summary are one html block, and an html block ends at a blank line, so a
 * summary carrying one is a toggle the bridge no longer recognises: the closing tag is outside the
 * block and there is nothing left to pair. A single line ending is not that, and a file that wrote
 * its empty summary as `<summary>\n</summary>` is not a file to put a space into. So the summary
 * goes out as it stands and `verifiedBlock` reads the toggle back before it keeps it, with the
 * flattened spelling below to fall to when it does not come back.
 */
function toggleToMdast(node: ProseMirrorNode): RootContent[] {
  const open = node.attrs.open ? " open" : "";
  const text = String(node.attrs.summary);
  const summary = escapeSummary(fidelity === "flatten" ? oneLine(text) : text);
  return [{ type: "html", value: `<details${open}>\n<summary>${summary}</summary>` }, ...containedBlocks(node), { type: "html", value: "</details>" }];
}

interface Leaf {
  marks: Mark[];
  node: PhrasingContent;
}

/**
 * The inline content of one block, with any hard break at the end of it dropped.
 *
 * A hard break is a line ending inside a block and there is no line left for one to start at the end
 * of the block. mdast writes it anyway, as a backslash and a line ending, and a backslash at the end
 * of a paragraph is not a break to the reader, it is a literal backslash: the break is gone on the
 * next open and the paragraph has gained a character, which the save after that escapes into two.
 * Nothing of the user's is in a break with nothing under it, so the honest spelling is no spelling.
 */
function inlineToMdast(parent: ProseMirrorNode): PhrasingContent[] {
  const leaves: Leaf[] = [];
  parent.forEach((child) => {
    const leaf = leafOf(child);
    if (leaf) leaves.push(leaf);
  });
  while (leaves.length > 0 && leaves[leaves.length - 1].node.type === "break") leaves.pop();
  return nest(leaves, 0);
}

function leafOf(node: ProseMirrorNode): Leaf | null {
  const marks = [...node.marks].sort((a, b) => MARK_ORDER.indexOf(a.type.name as MarkName) - MARK_ORDER.indexOf(b.type.name as MarkName));
  const code = marks.some((mark) => mark.type.name === "code");
  const wrappers = marks.filter((mark) => mark.type.name !== "code");

  if (node.isText) {
    const value = node.text ?? "";
    if (!value) return null;
    return { marks: wrappers, node: code ? codeSpan(value) : { type: "text", value } };
  }
  switch (node.type.name) {
    case "hardBreak":
      return { marks: wrappers, node: { type: "break" } };
    case "image":
      return { marks: wrappers, node: { type: "image", url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title } };
    case "mathInline": {
      const latex = String(node.attrs.latex ?? "");
      // An empty formula has no spelling. `$$$$` is four dollars the reader hands straight back as
      // text, so the node would be gone after one save and the file would have gained the four
      // characters, and the save after that would escape them into six. Nothing of the user's is
      // in an empty equation, so the honest answer is to write nothing at all. The toolbar makes
      // one of these on every click and the editor takes care of it not being left behind on
      // screen; the writer's job is only to not put it in the file.
      return latex ? { marks: wrappers, node: formula(latex) } : null;
    }
    default:
      return { marks: wrappers, node: { type: "text", value: node.textContent } };
  }
}

/**
 * A line ending inside a code span or an equation, which is what makes the spelling a question.
 *
 * mdast's own handlers swap one of these for a space rather than write it, and `wrappedCode` and
 * `wrappedMath` are the nodes that do not. Which spelling a block goes out with is decided once
 * for the whole block by `verifiedBlock`, so both are read here rather than either being assumed.
 */
const LINE_ENDING = /[\r\n]/;

function codeSpan(value: string): PhrasingContent {
  if (fidelity === "keep" && LINE_ENDING.test(value)) return { type: "wrappedCode", value };
  return { type: "inlineCode", value: fidelity === "flatten" ? oneLine(value) : value };
}

function formula(value: string): PhrasingContent {
  if (fidelity === "keep" && LINE_ENDING.test(value)) return { type: "wrappedMath", value };
  return { type: "inlineMath", value: fidelity === "flatten" ? oneLine(value) : value };
}

/**
 * Folds a flat run of leaves back into nested emphasis, strong, strikethrough and link nodes by
 * taking one mark off the front at a time. Every leaf's marks are already in the same fixed order,
 * so leaves that share an outer mark are adjacent and the grouping is unambiguous.
 */
function nest(leaves: Leaf[], depth: number): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;

  while (i < leaves.length) {
    const mark = leaves[i].marks[depth];
    if (!mark) {
      out.push(leaves[i].node);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < leaves.length && leaves[j].marks[depth]?.eq(mark)) j += 1;
    const children = nest(leaves.slice(i, j), depth + 1);
    out.push(wrap(mark, children));
    i = j;
  }
  return out;
}

function wrap(mark: Mark, children: PhrasingContent[]): PhrasingContent {
  switch (mark.type.name) {
    case "strong":
      return { type: "strong", children };
    case "em":
      return { type: "emphasis", children };
    case "strikethrough":
      return { type: "delete", children };
    default: {
      const link: PhrasingContent = { type: "link", url: mark.attrs.href ?? "", title: mark.attrs.title ?? null, children };
      const text = ownText(mark, children);
      if (text === null) return link;

      // Two rungs, and a candidate that can only reach the second one is still a candidate. The
      // angle form carries every scheme a file can write and the bare form carries four of them,
      // so giving up on a link the bare form cannot spell is giving up on `<ftp://x>` and on every
      // other autolink a user typed that this writer would otherwise spell out longhand.
      const bare = bareForm(mark, text);
      const angle = angleForm(mark, text);
      if (bare === null && angle === null) return link;

      const index = bareSeen++;
      const node = spellingFor(index, bare, angle) ?? link;
      candidateOf.set(node, index);
      return node;
    }
  }
}

/**
 * The node one candidate goes out as under the policy in force, or null for the explicit link.
 *
 * The shortest spelling the candidate has is what the first rung asks for, so a url with no bare
 * form goes out in angle brackets there rather than being counted as a rung that was tried.
 */
function spellingFor(index: number, bare: string | null, angle: string | null): PhrasingContent | null {
  const spelling = spellingOf(index);
  if (spelling === "explicit") return null;
  if (spelling === "bare" && bare !== null) return { type: "html", value: bare } as PhrasingContent;
  if (angle === null) return null;
  angleSeen += 1;
  return { type: "html", value: angle } as PhrasingContent;
}

/** The one text node a link is made of, which is the only shape either short spelling can carry. */
function ownText(mark: Mark, children: PhrasingContent[]): string | null {
  if (mark.attrs.title) return null;
  const only = children.length === 1 ? children[0] : null;
  return only && only.type === "text" ? only.value : null;
}

/**
 * The text a link would be written as if it were written bare, or null when it could not be.
 *
 * This decides nothing. It rules out the links no spelling of a bare url could ever produce, so
 * that the ordinary `[text](./file.md)` never costs a verification pass, and leaves every real
 * question to the verifier.
 */
function bareForm(mark: Mark, text: string): string | null {
  const href = String(mark.attrs.href ?? "");
  if ((href === text || href === `http://${text}`) && URL_SHAPED.test(text)) return text;
  if (href === `mailto:${text}` && EMAIL_SHAPED.test(text)) return text;
  return null;
}

/**
 * The same link as `<url>`, or null when that spelling could not carry it.
 *
 * Like `bareForm` this decides nothing and is not a copy of the autolink grammar. The one thing it
 * does have to be strict about is the destination: a bare `www.example.com` is a link to
 * `http://www.example.com` and the angle form of it is not a link at all, so a candidate whose
 * href was inferred rather than written is never offered this rung.
 */
function angleForm(mark: Mark, text: string): string | null {
  const href = String(mark.attrs.href ?? "");
  if (href === text && ANGLE_SHAPED.test(text)) return `<${text}>`;
  if (href === `mailto:${text}` && EMAIL_SHAPED.test(text)) return `<${text}>`;
  return null;
}

// -----------------------------------------------------------------------------------------------
// Verify and fall back.
// -----------------------------------------------------------------------------------------------

/**
 * The three ways a url that is its own text can be written, shortest first.
 *
 * `bare` is the url on its own and is what the file most likely already said. `angle` is `<url>`,
 * which is the spelling for a url GFM's literal grammar will not pick up but CommonMark's autolink
 * will, and is also a spelling a file may already say. `explicit` is `[url](url)`, which has no
 * grammar left to get wrong and is where the ladder ends.
 */
type Spelling = "bare" | "angle" | "explicit";

type SpellingPolicy = (index: number) => Spelling;

const ALL_BARE: SpellingPolicy = () => "bare";
const ALL_EXPLICIT: SpellingPolicy = () => "explicit";

/**
 * How the build in progress is spelling its urls, how many it has met, and how many of them it
 * actually managed to write in angle brackets.
 *
 * The decision is made after the block exists and is proved rather than while it is being built,
 * so the block is built more than once, and these carry the answer down to `wrap` without
 * threading a parameter through every node type. Building is synchronous and nothing below
 * re-enters it, so they are only ever live for the length of one `buildBlock` call.
 */
let spellingOf: SpellingPolicy = ALL_EXPLICIT;
let bareSeen = 0;
let angleSeen = 0;

/**
 * How much of the block being built is written as the document holds it.
 *
 * A line ending is the thing none of these three can spell, so they are three answers to it.
 * `keep` writes it where the document puts it, in a code span, an equation and a `<summary>`.
 * `collapse` hands the spans back to mdast, which swaps it for a space where it would open a block
 * and leaves it where it would not. `flatten` writes it as a space in all three and as the
 * character reference of itself in the two places a text node cannot hold one, which is the last
 * rung because it is the one with nothing left in it for a reader to take differently.
 *
 * The same two rules as the spelling policy above and it is live for the same length of time. This
 * is settled before the spellings are, because a block whose wrap cannot be kept is a different
 * block to prove the urls in.
 */
type Fidelity = "keep" | "collapse" | "flatten";

const FIDELITY: Fidelity[] = ["keep", "collapse", "flatten"];

let fidelity: Fidelity = "keep";

function buildBlock(node: ProseMirrorNode, policy: SpellingPolicy): RootContent[] {
  spellingOf = policy;
  bareSeen = 0;
  angleSeen = 0;
  const built = blockToMdast(node);
  spellingOf = ALL_EXPLICIT;
  return fidelity === "flatten" ? referenced(built, false) : built;
}

/**
 * A line ending written as the character reference of itself, for the two places a document can
 * hold one and markdown has nowhere to put one.
 *
 * A heading is a line, and a blank line ends the block it lands in and starts another. The reader
 * turns `&#xA;` back into the character it names, so the document is the same document either way
 * and the file is the file the author wrote: `## a&#xA;` is where a heading like this came from.
 *
 * The walk stops at a link and an image for the same two reasons `unescapedText` stops there: the
 * escapes are off inside a label anyway, and those nodes are the keys a spelling is remembered by.
 */
function referenced(nodes: RootContent[], heading: boolean): RootContent[] {
  const out: RootContent[] = [];
  let moved = false;

  for (const node of nodes) {
    if (node.type === "text" && (heading ? LINE_ENDING : BLANK_LINE).test(node.value)) {
      out.push(...referencedRuns(node.value));
      moved = true;
      continue;
    }
    const inside = node.type === "link" || node.type === "image" || !("children" in node) ? null : (node.children as RootContent[]);
    const walked = inside ? referenced(inside, heading || node.type === "heading") : null;
    if (!walked || walked === inside) {
      out.push(node);
      continue;
    }
    out.push({ ...node, children: walked } as RootContent);
    moved = true;
  }
  return moved ? out : nodes;
}

/** One text node as the run of nodes it takes to write it with its line endings named. */
function referencedRuns(value: string): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let at = 0;

  for (const match of value.matchAll(/[\r\n]/g)) {
    if (match.index > at) out.push({ type: "text", value: value.slice(at, match.index) });
    out.push({ type: "phrasingLiteral", value: match[0] === "\r" ? "&#xD;" : "&#xA;" });
    at = match.index + 1;
  }
  if (at < value.length) out.push({ type: "text", value: value.slice(at) });
  return out;
}

/**
 * Which candidate a node in a built block is, for the nodes that are one.
 *
 * The trip that proves the all bare spelling is also the trip that says which url it got wrong, but
 * only in terms of a position in a list of links. This is what turns that position back into the
 * candidate it belongs to. Keys are the mdast nodes `wrap` just made, so an entry dies with the
 * build it came from.
 */
const candidateOf = new WeakMap<object, number>();

/**
 * One top level block, with everything in it that the reader has an opinion about proved rather
 * than assumed: the spelling of every bare url, the escapes mdast writes over a url the user only
 * typed, and underneath both of those the block itself.
 *
 * A block that holds nothing the reader could take differently, which is most blocks in most
 * files, pays for one build and no trip through the parser at all. One that does is written, read
 * back and compared against the document, and falls to a plainer spelling of its line endings each
 * time it does not come back as itself. The last rung is written whether it comes back or not,
 * because a document holding something markdown cannot spell still has to be saved, and the one
 * thing that must not happen is a file that gains bytes on every save for the rest of its life.
 */
function verifiedBlock(node: ProseMirrorNode): RootContent[] {
  let written = spelledBlock(node, "keep");
  if (!needsProof(written)) return written;

  let source = blockSource(written);
  for (let rung = 1; rung < FIDELITY.length; rung += 1) {
    if (readsBack(node, source)) return written;
    const next = spelledBlock(node, FIDELITY[rung]);
    const plainer = blockSource(next);
    if (plainer === source) continue;
    written = next;
    source = plainer;
  }
  return written;
}

/**
 * The seam between two blocks, for the one block mdast cannot see the ends of.
 *
 * A blank line separates almost everything from almost everything, and the handful of pairs it
 * does not separate are mdast's own business: two lists written with the same bullet are one list
 * when they are read back, so it writes the second one with the other bullet, and it knows to
 * because it wrote the first one. A raw block it did not write. Source that opens with `- ` sits
 * down next to the list above it and the two are one list on the next open, with the user's own
 * first item inside a block that can no longer be edited as a list at all.
 *
 * So the pair is written out and read back, and the two blocks have to come back as the two blocks
 * they are on their own. When they do not, the list is respelled until they do, because the list is
 * the half of the pair this writer gets to spell: a raw block is the file's own bytes and there is
 * no such thing as writing those differently. The two spellings are the marker, which is what a
 * following `- ` collides with, and how far the marker pushes the item's content from the margin,
 * which is what a following `  </td>` collides with. They are independent and either can be the one
 * that is wrong, so all four are on the ladder.
 *
 * Both seams of a list are settled together rather than one after the other, because a list with a
 * raw block on each side has one spelling and two neighbours to satisfy with it, and settling the
 * left seam and then the right would leave the left one holding a spelling nothing has checked.
 *
 * The seams that are asked are the ones where the answer could be no, which is the difference
 * between a check a document with three raw blocks pays for and one a document with two hundred
 * pays for. A blank line closes every construct markdown has, so what is left is a list that has
 * not finished, and a list has not finished only over a line that is indented or that carries a
 * marker of its own. That line is the raw block's own first or last line, which is a string this
 * file already holds; reading the pair back is asked for only when it says the answer could be no.
 *
 * A raw block cut from a file is always a pair the ladder can win, and that is not luck: a file
 * cannot produce a raw block indented four columns, because the fourth column is an indented code
 * block and this bridge models one of those, and four columns is exactly how far the widest
 * spelling pushes an item's content. A raw block the user has typed four spaces into is past the
 * end of the ladder and nothing the writer can say about the list reaches it.
 *
 * So the other half of the pair gives instead. A raw block holds two strings, the file's own bytes
 * and what is on screen, and when the second cannot be written next to a list without the list
 * being read back inside it, the first is written and the edit does not reach the file this save.
 * That is the whole of the escape and it is deliberately the smallest one: a keystroke that does
 * not persist is a smaller failure than a save that leaves the user's list inside somebody's html
 * and then puts blank lines through the middle of it on the save after. Every other edit to a raw
 * block, in every document that has no list beside it, is written exactly as it always was.
 * src/editor/ owns whether the edit should have been possible at all.
 */
function separate(blocks: RootContent[][], nodes: ProseMirrorNode[]): void {
  // Twice at the most: the second pass is for the lists settled against bytes the first pass then
  // put back, and a block already holding its source is not put back again, so it cannot go round.
  if (spellEveryList(blocks, nodes)) spellEveryList(blocks, nodes);
}

/** One pass over every list, and whether any raw block beside one gave its edit up to it. */
function spellEveryList(blocks: RootContent[][], nodes: ProseMirrorNode[]): boolean {
  let gaveUp = false;

  for (let index = 0; index < blocks.length; index += 1) {
    if (listIn(blocks[index]) === null || spelledApart(blocks, index)) continue;
    if (keepSource(blocks, nodes, index - 1) || keepSource(blocks, nodes, index + 1)) {
      gaveUp = true;
      spelledApart(blocks, index);
    }
  }
  return gaveUp;
}

/** Whether every seam this list has can be written apart, respelling the list until they are. */
function spelledApart(blocks: RootContent[][], index: number): boolean {
  const list = listIn(blocks[index]);
  if (!list) return true;

  const seams: Seam[] = [];
  const above = index > 0 ? blocks[index - 1] : null;
  const below = index + 1 < blocks.length ? blocks[index + 1] : null;
  if (above && couldRunOn(above, blocks[index])) seams.push([above, blocks[index]]);
  if (below && couldRunOn(blocks[index], below)) seams.push([blocks[index], below]);
  return seams.length === 0 || spellApart(list, seams);
}

/**
 * Puts one raw block back to the bytes it was read from, for the one edit that has nowhere to go.
 *
 * The block has to be a raw block, it has to be one the user has changed, and it has to have bytes
 * to go back to: a raw node built by something other than the parser carries no source and there is
 * nothing here to keep.
 */
function keepSource(blocks: RootContent[][], nodes: ProseMirrorNode[], index: number): boolean {
  if (index < 0 || index >= blocks.length) return false;
  const node = nodes[index];
  if (node.type.name !== "raw" || isRawUnchanged(node) || rawIn(blocks[index]) === null) return false;

  const source = String(node.attrs.source ?? "");
  if (source === "" || source === rawIn(blocks[index])) return false;
  blocks[index] = [rawBlock(source)];
  return true;
}

/** Two blocks in the order they are written, the first of which ends where the second begins. */
type Seam = [RootContent[], RootContent[]];

interface Respelling {
  other: boolean;
  wide: boolean;
}

/**
 * The four ways a list can be written, plainest first: the house style, the other marker, the
 * marker the house uses with its items pushed out as far as a marker pushes them, and both at once.
 */
const RESPELLINGS: Respelling[] = [
  { other: false, wide: false },
  { other: true, wide: false },
  { other: false, wide: true },
  { other: true, wide: true },
];

function spellApart(list: List, seams: Seam[]): boolean {
  for (const respelling of RESPELLINGS) {
    withOtherBullet(list, respelling.other);
    withWideItems(list, respelling.wide);
    if (seams.every(staysApart)) return true;
  }

  // Nothing this writer can say about the list keeps the block beside it out, and the caller is told
  // so rather than the pair being written anyway. The house spelling goes back on meanwhile, because
  // a pair that reads as one block reads as one block whichever marker it was written with, and an
  // indent that bought nothing is a diff with nothing behind it.
  withOtherBullet(list, false);
  withWideItems(list, false);
  return false;
}

/**
 * Whether a list and the raw block beside it could possibly be read back as one block, asked of
 * the one line of the pair that decides it and answered without writing or reading anything.
 *
 * A list ends at the first line that is neither indented into it nor another of its items, so a raw
 * block written under a list runs into it only over its own first line, and a list written under a
 * raw block runs into it only when the raw block's last line has left a list open. A raw block that
 * could still be inside something a blank line does not close is asked as well: those all run to
 * the end of the file when they are read, so there is nothing under them to run into, and one can
 * be there at all only because the block was edited after it was read.
 */
function couldRunOn(left: RootContent[], right: RootContent[]): boolean {
  const under = rawIn(right);
  if (under !== null) return listIn(left) !== null && continuesList(firstLine(under));

  const over = rawIn(left);
  if (over === null || listIn(right) === null) return false;
  return continuesList(lastLine(over)) || UNCLOSED.test(over);
}

const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** The openers markdown closes at something other than a blank line, and so past one. */
const UNCLOSED = /```|~~~|\$\$|<(?:pre|script|style|textarea)\b|<!--|<\?|<!\[CDATA\[/i;

function continuesList(line: string): boolean {
  return line.trim() === "" || /^[ \t]/.test(line) || LIST_MARKER.test(line);
}

function firstLine(value: string): string {
  const at = value.indexOf("\n");
  return at === -1 ? value : value.slice(0, at);
}

function lastLine(value: string): string {
  const at = value.lastIndexOf("\n");
  return at === -1 ? value : value.slice(at + 1);
}

function staysApart([left, right]: Seam): boolean {
  const over = blockSource(left);
  const under = blockSource(right);
  const apart = [...blocksOf(over), ...blocksOf(under)];
  const together = blocksOf(`${over}\n${under}`);
  return together.length === apart.length && together.every((block, at) => block.eq(apart[at]));
}

function blocksOf(source: string): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  opened(source).forEach((child) => out.push(child));
  return out;
}

/** A raw block is always the whole of a top level block, which is what makes both of these cheap. */
function rawIn(block: RootContent[]): string | null {
  return block.length === 1 && block[0].type === "rawBlock" ? block[0].value : null;
}

function listIn(block: RootContent[]): List | null {
  return block.length === 1 && block[0].type === "list" ? block[0] : null;
}

/** One block at one fidelity, with its urls and its escapes settled among themselves. */
function spelledBlock(node: ProseMirrorNode, level: Fidelity): RootContent[] {
  fidelity = level;
  const bare = buildBlock(node, ALL_BARE);
  const linked = linkedBlock(node, bare, bareSeen);
  const written = literalBlock(linked.nodes, linked.read);
  fidelity = "keep";
  return written;
}

function blockSource(nodes: RootContent[]): string {
  return stringifyMdast({ type: "root", children: nodes });
}

/**
 * Whether the file would hand this block back as the block the document holds.
 *
 * The comparison is against the ProseMirror node rather than against the mdast tree the block was
 * built from, and that is the whole point of it. The two trees disagree in ways that mean nothing:
 * remark reads an item's `spread` off the blank lines inside it while the writer sets it from the
 * list, and an extension hangs its own fields on the nodes it made. Every one of those differences
 * is a comparison that fails on a block that is perfectly fine, and each one of them was a rung of
 * this ladder quietly switched off. The document is the thing that has to survive, so the document
 * is what is compared, through the same pair of functions the app opens a file with.
 */
function readsBack(node: ProseMirrorNode, source: string): boolean {
  const built = opened(source);
  return built.childCount === 1 && sameBlock(built.child(0), node);
}

/**
 * Two nodes that would be written the same bytes, which is not what `Node.eq` answers.
 *
 * `eq` compares node types and mark types as objects, and the two nodes here are never built on the
 * same schema. The one on the left came out of `opened`, which parses against src/model/schema.ts.
 * The one on the right is the document the editor hands to a save, and src/editor/Editor.tsx binds
 * every document it opens to TipTap's own schema: the same specs, a second `Schema`, and therefore a
 * different object for every type in it. `a.type === b.type` was false for every pair this function
 * had ever been given from the running app, so every rung of the ladder above answered no and every
 * block that reached it was written at the last fidelity. A file holding a code span wrapped across
 * two lines came back through the bridge byte for byte and through the editor with the line ending
 * swapped for a space, which is a file changed by an editor nobody had typed into.
 *
 * The name is the right thing to compare and not only a way round that, for the reason
 * src/document.ts gives for comparing names in its own answer to the same problem: this file
 * dispatches on `type.name` and reads nothing else off a type, so two nodes agreeing on their name,
 * their attributes, their marks, their text and their children are two nodes it writes alike.
 */
function sameBlock(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  if (a.type.name !== b.type.name || a.text !== b.text) return false;
  if (!sameAttrs(a.attrs, b.attrs) || !sameMarks(a.marks, b.marks)) return false;
  if (a.childCount !== b.childCount) return false;
  for (let index = 0; index < a.childCount; index += 1) {
    if (!sameBlock(a.child(index), b.child(index))) return false;
  }
  return true;
}

function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const names = Object.keys(a).sort();
  const others = Object.keys(b).sort();
  if (names.length !== others.length || names.some((name, at) => name !== others[at])) return false;
  // An attribute can hold a list, `colwidth` does, so the values are compared as the json they are
  // written and read as rather than by identity.
  return names.every((name) => JSON.stringify(a[name]) === JSON.stringify(b[name]));
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((mark, at) => mark.type.name === b[at].type.name && sameAttrs(mark.attrs, b[at].attrs));
}

/**
 * Markdown opened as the document it would be opened as, which is not quite the same as parsed.
 *
 * `\r\n` is a line ending the reader turns into `\n` before the parser is handed anything, so a
 * comparison that skipped that step would pass a block the app is about to read differently: a
 * heading holding a carriage return reads back as itself right up until the file is opened again.
 */
function opened(source: string): ProseMirrorNode {
  const { text } = normaliseSource(source);
  return buildDoc(parseToMdast(text).children, text);
}

/**
 * Whether this block has to be read back before it is written, which is a question about line
 * endings and about bytes mdast did not choose.
 *
 * Everything else in a block is mdast's own tree written by mdast's own writer, which is the one
 * thing that library is for and the thing it is tested on. A raw block is not: it is the file's
 * bytes, handed to the writer whole, and what the block above or below it does with them is
 * nobody's decision. And a line ending is not, because several of the places a document can hold
 * one have no way to write one: a code span and an equation have no escapes at all, a heading is a
 * line, and a blank line ends whatever it lands in.
 */
function needsProof(nodes: RootContent[] | AnyNode[]): boolean {
  return (nodes as AnyNode[]).some(proofOf);
}

const BLANK_LINE = /[\r\n][ \t]*[\r\n]/;
const SPANS: ReadonlySet<string> = new Set(["inlineCode", "inlineMath", "wrappedCode", "wrappedMath"]);

function proofOf(node: AnyNode): boolean {
  // A fence and a `$$` block are the two places a line ending is ordinary, and both of them are
  // written with a fence that grows past whatever is inside it.
  if (node.type === "code" || node.type === "math") return false;
  if (node.type === "heading") return brokenHeading(node);
  const value = typeof node.value === "string" ? node.value : "";
  if (SPANS.has(node.type) && LINE_ENDING.test(value)) return true;
  if (node.type === "html" && LINE_ENDING.test(value)) return true;
  if (node.type === "text" && BLANK_LINE.test(value)) return true;
  return needsProof(node.children ?? []);
}

/**
 * A heading holding a line ending, which mdast writes as a setext heading whatever the house style
 * says, because `#` is a line and there is nowhere in it for a second one.
 *
 * That spelling is not safe either. The underline is as long as the last line of the text, so a
 * heading whose text ends where the line does gets an underline of nothing and is written as a
 * paragraph, and the marker the author put there is gone.
 */
function brokenHeading(node: AnyNode): boolean {
  const literal = typeof node.value === "string" && LINE_ENDING.test(node.value);
  return literal || node.type === "break" || (node.children ?? []).some(brokenHeading);
}

/**
 * One top level block, with every bare url in it proved rather than assumed.
 *
 * The whole block is the unit because several of the ways a bare url goes wrong depend on what
 * follows it: a full stop and then a word, a closing pipe in a table cell, an emphasis marker the
 * url swallows. A block is also self contained, so reading it back on its own reads it back in the
 * context it will be written in.
 *
 * A block that will not survive with every url bare costs a fixed three trips through the parser
 * however many urls are in it, because the all bare trip has already named the urls that went
 * wrong: the links it read back are compared against the links the block is supposed to have, in
 * order, and the candidates that do not line up are the ones to spell out. Trying each url on its
 * own instead would be a trip per url, and a list of a hundred links with one awkward one in it
 * would pay for a hundred of them on every save for the rest of the file's life.
 */
function linkedBlock(node: ProseMirrorNode, bare: RootContent[], count: number): Linked {
  if (count === 0) return { nodes: bare, read: null };

  const explicit = buildBlock(node, ALL_EXPLICIT);
  const meant = shapeOf(unwrapped(explicit));
  const read = reading(bare);
  if (read.shape === meant) return { nodes: bare, read };

  // The bare form did not come back as the block itself, which is usually because it lost a link
  // and occasionally because the writer spells something in a way the reader normalises. The
  // second is not the serializer's business, so the two forms are compared after the same trip.
  const wanted = linkTrace(explicit);
  const truth: Reading = { shape: shapeOf(reread(explicit).children), links: wanted.links };
  if (matches(read, truth)) return { nodes: bare, read };

  // No link moved, so what broke was the shape around one of them and the list has nothing to say
  // about which. That is the one case the whole block pays for, and it is worth the block rather
  // than a search: every shape a bare url is known to break it breaks by taking a destination with
  // it, which the list does see.
  const spelled = count === 1 ? new Set([0]) : misread(wanted, read.links);
  if (spelled.size === 0) return { nodes: explicit, read: null };

  // Second rung. The candidates the bare form lost are written `<url>` and everything else stays
  // bare. A candidate the angle form cannot carry either falls straight to the explicit spelling in
  // this same build, so when none of them can this is already the mixed spelling the third rung
  // would have built and there is nothing left to try.
  const angled = buildBlock(node, (candidate) => (spelled.has(candidate) ? "angle" : "bare"));
  const angles = angleSeen;
  const angleRead = reading(angled);
  if (matches(angleRead, truth)) return { nodes: angled, read: angleRead };
  if (angles === 0 || spelled.size === count) return { nodes: explicit, read: null };

  const some = buildBlock(node, (candidate) => (spelled.has(candidate) ? "explicit" : "bare"));
  const someRead = reading(some);
  return matches(someRead, truth) ? { nodes: some, read: someRead } : { nodes: explicit, read: null };
}

/**
 * A spelled block, and what the parser said about it, for the rung after this one.
 *
 * The reading is filled in only when it is the reading of the nodes beside it, character for
 * character, and is null on the rungs that ended without one. `literalBlock` asks the same
 * question of the same bytes immediately afterwards, and a re-parse is by far the most expensive
 * thing either of them does.
 */
interface Linked {
  nodes: RootContent[];
  read: Reading | null;
}

/** The same tree with the wrapped spellings under the names the parser will hand them back as. */
function unwrapped(nodes: RootContent[] | AnyNode[]): AnyNode[] {
  return (nodes as AnyNode[]).map((node) => {
    const type = node.type === "wrappedCode" ? "inlineCode" : node.type === "wrappedMath" ? "inlineMath" : node.type;
    return { ...node, type, children: node.children ? unwrapped(node.children) : undefined };
  });
}

/**
 * The three characters mdast escapes so that a url the user typed as text is not read back as a
 * link, written as themselves, because this reader autolinks the text either way.
 *
 * GFM's literal autolinks are not found while the file is being tokenised, they are found by a
 * pass over the text of the tree afterwards, and by then a backslash is long gone: the reader
 * hands back a link for `https\://example.com` exactly as it does for `https://example.com`. So
 * the escape buys nothing and costs a byte, and the next save, reading a link where the document
 * had text, writes the url bare and the byte comes back out. The file moves twice for a document
 * nobody edited, which is the one thing the ladder above exists to stop, and it happens here
 * because a block holding no link node never reached the ladder at all.
 *
 * Writing the character bare is the same claim as writing a url bare and it is proved the same
 * way: against what mdast's own spelling of this block reads back as, so the document is what
 * decides, not this file's opinion of the autolink grammar. A block whose bare form says something
 * else keeps the escape. Only a block that has one of these characters in a text node pays for the
 * trip; every other block pays for one walk of a tree it has already built.
 *
 * The block it is compared against is the block the rung above settled on, so when that rung ended
 * by asking the parser about those same bytes its answer comes down here rather than being asked
 * for again. That is half the re-parses this file does on a document full of urls.
 */
function literalBlock(block: RootContent[], read: Reading | null): RootContent[] {
  const plain = unescapedText(block);
  if (plain === block) return block;
  const truth = read ?? reading(block);
  return matches(reading(plain), truth) ? plain : block;
}

/**
 * mdast's own `unsafe` table for GFM autolinks, character for character: an `@` between two word
 * characters, a `.` after a `w`, and the `:` of a scheme. Nothing else in a text node is a
 * candidate, so a block with none of these three is handed straight back unchanged.
 *
 * What goes out literally is the whole run of characters around one of them, not the character on
 * its own, because the reader finds a url while it is reading and not afterwards: a backslash
 * anywhere inside `https://example.com/a\_b` ends the autolink there and leaves half a destination
 * behind, which is a worse answer than the escape and would fail its own verification anyway. The
 * run ends at whitespace and at the brackets that would open inline html, which is where GFM's own
 * autolink ends too.
 *
 * The walk stops at a link or an image, which never carry these escapes anyway because mdast turns
 * them off inside a label, and whose nodes are the keys `candidateOf` remembers a spelling by.
 */
const AUTOLINK_ESCAPE = /(?<=[+\-.\w])@(?=[\-.\w])|(?<=[Ww])\.(?=[\-.\w])|(?<=[ps]):(?=\/)/;
const UNSPACED_RUN = /[^\s<>]+/g;

function unescapedText(nodes: RootContent[]): RootContent[] {
  const out: RootContent[] = [];
  let moved = false;

  for (const node of nodes) {
    if (node.type === "text") {
      const runs = literalRuns(node.value);
      if (runs) moved = true;
      out.push(...(runs ?? [node]));
      continue;
    }
    const children = node.type === "link" || node.type === "image" || !("children" in node) ? null : (node.children as RootContent[]);
    const walked = children ? unescapedText(children) : null;
    if (!walked || walked === children) {
      out.push(node);
      continue;
    }
    out.push({ ...node, children: walked } as RootContent);
    moved = true;
  }
  return moved ? out : nodes;
}

/** One text node as the run of nodes it takes to write it with those runs left alone. */
function literalRuns(value: string): PhrasingContent[] | null {
  if (!AUTOLINK_ESCAPE.test(value)) return null;

  const out: PhrasingContent[] = [];
  let at = 0;
  for (const match of value.matchAll(UNSPACED_RUN)) {
    if (!AUTOLINK_ESCAPE.test(match[0])) continue;
    if (match.index > at) out.push({ type: "text", value: value.slice(at, match.index) });
    out.push({ type: "phrasingLiteral", value: match[0] });
    at = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (at < value.length) out.push({ type: "text", value: value.slice(at) });
  return out;
}

/**
 * The candidates whose links did not come back, read off one comparison of two ordered lists.
 *
 * A url written bare that the parser does not autolink takes its link out of the list, and a url
 * that autolinks differently changes one entry in place, so the two lists are the same sequence
 * with entries dropped or altered rather than two unrelated lists. Walking them together and
 * blaming the entry that will not line up finds those, and a lookahead of one on either side keeps
 * a single failure from throwing off everything after it.
 *
 * Being exactly right is not what makes this safe. Naming too few candidates or too many is caught
 * by the confirming trip in `verifiedBlock`, which falls back to spelling the whole block out; what
 * this decides is only how much of a block full of good urls one bad one is allowed to cost.
 */
function misread(wanted: LinkTrace, read: string[]): Set<number> {
  // Past the end of a list, and nothing an entry can be mistaken for: every entry is a json array.
  const END = "end";
  const at = (list: string[], index: number) => (index < list.length ? list[index] : END);
  const out = new Set<number>();
  let i = 0;
  let j = 0;

  while (i < wanted.links.length) {
    if (at(wanted.links, i) === at(read, j)) {
      i += 1;
      j += 1;
      continue;
    }
    if (at(wanted.links, i) === at(read, j + 1)) {
      j += 1;
      continue;
    }
    const candidate = wanted.candidates[i];
    if (candidate !== null) out.add(candidate);
    i += 1;
    if (at(wanted.links, i) !== at(read, j)) j += 1;
  }
  return out;
}

interface Reading {
  shape: string;
  links: string[];
}

/**
 * What a spelling of a block says, once the parser has had it back.
 *
 * Both halves matter. The links have to be the same links, destination for destination and
 * character for character, which is the promise a lost autolink breaks. The shape has to be the
 * same shape too, because a bare url can also take the text around it with it, split a table cell
 * in two or eat an emphasis marker without touching a destination at all.
 */
function reading(nodes: RootContent[]): Reading {
  const read = reread(nodes).children;
  return { shape: shapeOf(read), links: linksIn(read) };
}

function matches(read: Reading, truth: Reading): boolean {
  return read.shape === truth.shape && read.links.length === truth.links.length && read.links.every((link, index) => link === truth.links[index]);
}

/** A block written out and read back in, by the same pair the bridge saves and opens files with. */
function reread(nodes: RootContent[]): Root {
  return parseToMdast(stringifyMdast({ type: "root", children: nodes }));
}

interface AnyNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: AnyNode[];
  [key: string]: unknown;
}

/**
 * Text and inline html are the same thing here.
 *
 * The bare form of a url is an html node and the explicit form is a link, so the two spellings are
 * never going to be split into nodes the same way, and neither is either of them going to match
 * what the parser makes of them. What has to match is what the document says, so runs of literal
 * characters are compared as one string however they were divided up.
 */
const LITERAL: ReadonlySet<string> = new Set(["text", "html"]);

function shapeOf(nodes: RootContent[] | AnyNode[]): string {
  return JSON.stringify(outline(nodes as AnyNode[]));
}

function outline(nodes: AnyNode[]): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (LITERAL.has(node.type)) {
      const last = out.length - 1;
      if (typeof out[last] === "string") out[last] = String(out[last]) + String(node.value ?? "");
      else out.push(String(node.value ?? ""));
      continue;
    }
    const attributes: Record<string, unknown> = {};
    for (const key of Object.keys(node).sort()) {
      // `data` is where a parser extension hangs what it would like html to be made of, which the
      // writer never reads and this app never renders from. remark-math puts one on every equation
      // it reads and nothing puts one on an equation this file built, so comparing it would make
      // every block holding maths fail a comparison it should pass.
      if (key === "position" || key === "children" || key === "data") continue;
      attributes[key] = node[key];
    }
    out.push([node.type, attributes, node.children ? outline(node.children) : null]);
  }
  return out;
}

interface LinkTrace {
  links: string[];
  candidates: Array<number | null>;
}

/**
 * Every link and image in a block, in document order, and which candidate each one is.
 *
 * The two arrays are one list read two ways. `links` is what a spelling of the block has to
 * reproduce, and is the only half that means anything for a tree that came back from the parser.
 * `candidates` is filled in only for a tree this file built, and is what lets a position in `links`
 * be blamed on the url that put it there.
 *
 * An entry is the four fields as json rather than joined on a separator, because there is no
 * separator to pick: a destination, a title and a link's own text are all the file's characters and
 * any byte one of them cannot hold is a byte the next file will. This used to be joined on a NUL,
 * which two of those three can carry and which turned the largest file in this project into
 * something `file` calls data, `grep` returns nothing from and `diff` refuses to read.
 */
function linkTrace(nodes: RootContent[] | AnyNode[]): LinkTrace {
  const links: string[] = [];
  const candidates: Array<number | null> = [];
  const walk = (list: AnyNode[]) => {
    for (const node of list) {
      if (node.type === "link" || node.type === "image") {
        links.push(JSON.stringify([node.type, node.url ?? "", node.title ?? "", literalText(node)]));
        candidates.push(candidateOf.get(node) ?? null);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes as AnyNode[]);
  return { links, candidates };
}

function linksIn(nodes: RootContent[] | AnyNode[]): string[] {
  return linkTrace(nodes).links;
}

function literalText(node: AnyNode): string {
  // The wrapped spellings count as the code span they are, because the tree this file built has
  // them under one name and the tree the parser hands back has them under another, and a link
  // whose text is a hard wrapped span would otherwise never line up with itself.
  if (LITERAL.has(node.type) || SPANS.has(node.type)) return String(node.value ?? "");
  return (node.children ?? []).map(literalText).join("");
}
