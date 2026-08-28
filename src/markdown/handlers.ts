// The remark configuration, both directions, in one place.
//
// There is exactly one parser and exactly one house style in the app, and they live here so that
// "how does this project write markdown" has a single answer that a test can read. Nothing takes
// options: a per document or per call style would mean two files in the same folder disagreeing
// about what a bullet is, and a file that reformats depending on which code path saved it.

import type { Delete, List, Literal, Parents, Root, ThematicBreak } from "mdast";
import { defaultHandlers } from "mdast-util-to-markdown";
import type { Info, State } from "mdast-util-to-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import type { Options as StringifyOptions } from "remark-stringify";
import { unified } from "unified";
import { isFrontmatterNode } from "./frontmatter";

/**
 * A block of source the schema cannot model, written back out exactly as it came in.
 *
 * It is a node type mdast does not have, registered below so the tree stays typed, and its handler
 * is the whole of its behaviour: return the string, escape nothing, indent nothing, wrap nothing.
 */
export interface RawBlock extends Literal {
  type: "rawBlock";
}

/**
 * `mdast-util-gfm-strikethrough` enters this construct and never declares it, which is fine for a
 * package written in JavaScript and not for the handler below.
 */
declare module "mdast-util-to-markdown" {
  interface ConstructNameMap {
    strikethrough: "strikethrough";
  }
}

declare module "mdast" {
  interface RootContentMap {
    rawBlock: RawBlock;
    phrasingLiteral: PhrasingLiteral;
    wrappedCode: WrappedCode;
    wrappedMath: WrappedMath;
  }
  interface BlockContentMap {
    rawBlock: RawBlock;
  }
  interface PhrasingContentMap {
    phrasingLiteral: PhrasingLiteral;
    wrappedCode: WrappedCode;
    wrappedMath: WrappedMath;
  }
}

export function rawBlock(value: string): RawBlock {
  return { type: "rawBlock", value };
}

/**
 * A run of characters written into a paragraph exactly as it stands, escaping nothing.
 *
 * mdast already has a node for that, `html`, and using it costs a line ending. `containerPhrasing`
 * turns a soft break in front of an inline html node into a space on purpose, because an html tag
 * at the start of a line reads back as a block rather than as part of the paragraph and there is
 * no escape that would stop it. Nothing this bridge writes as inline html is a tag: it is a
 * callout's `[!NOTE]` label and a url written bare, both of them the file's own characters, and
 * both of them have to stay on the line the document puts them on. So they get a node type of
 * their own and the special case never sees them.
 */
export interface PhrasingLiteral extends Literal {
  type: "phrasingLiteral";
}

/**
 * Single dollar math is off because a document is far more likely to be about money than about
 * mathematics, and `$5 and $10` parsed as an equation would silently eat the text between them.
 * `$$x$$` is unambiguous enough to keep.
 */
const MATH_OPTIONS = { singleDollarTextMath: false };

// Character for character mdast's own inline html handler, `peek` included: the node exists to
// change one rule and reporting a different first character to whatever is in front of it would
// change the escaping of text that has nothing to do with the line ending.
const phrasingLiteral = (node: PhrasingLiteral) => node.value;
phrasingLiteral.peek = () => "<";

/**
 * A code span, and below it an inline formula, that the file hard wrapped across two lines.
 *
 * These are `phrasingLiteral`'s problem one construct further in. mdast's own `inlineCode` and
 * `inlineMath` handlers finish by walking every `atBreak` unsafe pattern over the value and
 * swapping a line ending followed by a block character for a space, because a code span has no
 * escapes and neither does an equation. That is the same trade `containerPhrasing` makes in front
 * of inline html and it is wrong here for the same reason: `#two` is not a heading, `| y` is not a
 * table, and the file said what it said. A span read across a line ending is written back across
 * the same line ending, and the serializer proves the block still reads as itself before it keeps
 * the spelling. When it does not, the plain node goes out instead and mdast collapses the wrap as
 * it always did, because a span really holding `\n# ` has no spelling in markdown at all.
 *
 * Everything else in the two handlers below is character for character mdast's own, `peek`
 * included: the fence grows past the longest run of ticks or dollars in the value, and a value
 * that opens or closes on a space or on the fence character is padded so the fence still binds.
 */
export interface WrappedCode extends Literal {
  type: "wrappedCode";
}

export interface WrappedMath extends Literal {
  type: "wrappedMath";
}

function wrappedCode(node: WrappedCode): string {
  let value = node.value;
  let sequence = "`";

  while (new RegExp(`(^|[^\`])${sequence}([^\`]|$)`).test(value)) sequence += "`";
  if (/[^ \r\n]/.test(value) && ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^`|`$/.test(value))) value = ` ${value} `;

  return sequence + value + sequence;
}
wrappedCode.peek = () => "`";

function wrappedMath(node: WrappedMath): string {
  let value = node.value;
  let size = MATH_OPTIONS.singleDollarTextMath ? 1 : 2;

  while (new RegExp(`(^|[^$])${"\\$".repeat(size)}([^$]|$)`).test(value)) size += 1;
  const sequence = "$".repeat(size);
  if (/[^ \r\n]/.test(value) && ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^\$|\$$/.test(value))) value = ` ${value} `;

  return sequence + value + sequence;
}
wrappedMath.peek = () => "$";

/**
 * Whitespace, punctuation or neither, for the character on one side of a `~~`.
 *
 * mdast decides this with `classifyCharacter` from micromark, which is not a dependency of this
 * app and is not reachable through one: `mdast-util-to-markdown` exports its writer and nothing
 * else. These are the two character classes that function tests for, in the same order, so a
 * character is classified here exactly as the parser classifies it.
 */
const WHITESPACE = 1;
const PUNCTUATION = 2;

function classify(code: number): number | undefined {
  if (Number.isNaN(code)) return undefined;
  const character = String.fromCharCode(code);
  if (/\s/.test(character)) return WHITESPACE;
  if (/\p{P}|\p{S}/u.test(character)) return PUNCTUATION;
  return undefined;
}

interface EncodeSides {
  inside: boolean;
  outside: boolean;
}

/**
 * Which of the two characters either side of a delimiter have to be encoded for it to bind.
 *
 * This is mdast's own `encodeInfo` for the `*` marker. GFM's `~` flanks the way `*` does and not
 * the way `_` does, which is the only place that function's two markers differ, so the `_` half of
 * its table is not reproduced.
 */
function encodeInfo(outside: number, inside: number): EncodeSides {
  const out = classify(outside);
  const within = classify(inside);

  if (out === undefined) {
    if (within === undefined) return { inside: false, outside: false };
    if (within === WHITESPACE) return { inside: true, outside: true };
    return { inside: false, outside: true };
  }
  if (out === WHITESPACE) {
    return within === WHITESPACE ? { inside: true, outside: true } : { inside: false, outside: false };
  }
  return within === WHITESPACE ? { inside: true, outside: false } : { inside: false, outside: false };
}

function characterReference(code: number): string {
  return `&#x${code.toString(16).toUpperCase()};`;
}

/**
 * Strikethrough, with the guard `strong` and `emphasis` have and `mdast-util-gfm-strikethrough`
 * does not.
 *
 * That extension writes `~~`, the children, `~~`, and nothing else. A delete whose text begins or
 * ends with a space therefore goes out as `~~ b~~`, which GFM does not read back as a
 * strikethrough at all: the four tildes come back as content, the mark is gone, and the paragraph
 * says something the user never wrote. It is reachable from an ordinary file, because a
 * strikethrough that spans a link and the words around it has to be split at the link boundary and
 * the pieces either side of the link start or end with what used to be an interior space.
 *
 * `strong` does not have the problem: it encodes an edge space as `&#x20;` so the delimiter still
 * binds against a character reference. This is that, over `~~`, and everything else is
 * character for character the extension's own handler.
 */
function strikethrough(node: Delete, _parent: Parents | undefined, state: State, info: Info): string {
  const tracker = state.createTracker(info);
  const exit = state.enter("strikethrough");
  const before = tracker.move("~~");

  let between = tracker.move(state.containerPhrasing(node, { after: "~", before, ...tracker.current() }));

  const head = between.charCodeAt(0);
  const open = encodeInfo(info.before.charCodeAt(info.before.length - 1), head);
  if (open.inside) between = characterReference(head) + between.slice(1);

  const tail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), tail);
  if (close.inside) between = between.slice(0, -1) + characterReference(tail);

  const after = tracker.move("~~");
  exit();

  state.attentionEncodeSurroundingInfo = { after: close.outside, before: open.outside };
  return before + between + after;
}
strikethrough.peek = () => "~";

/**
 * The lists that have to be written with the other bullet, and the handler that lets them.
 *
 * Two lists written flush with the same marker are one list when the file is read back, so mdast
 * keeps them apart by giving the second one `bulletOther`. It decides that from `bulletLastUsed`,
 * which only a list ever sets, and a raw block is not a list node: a block of preserved source
 * whose first line opens with `- ` merges with the list above it and nothing in mdast is watching.
 *
 * So the serializer watches, and marks the list. Setting the field mdast reads is the whole of the
 * mechanism, because the rest of that decision, which bullet is the other one and what a nested
 * list does about it, is the default handler's and is left to it. The marker that has to be handed
 * over is the one this list would otherwise have used, which for an ordered list is the delimiter
 * and not the bullet: handing over the bullet leaves `1.` compared against `-`, never equal, and
 * the lever does nothing at all on the half of the lists in the world that count.
 */
const OTHER_BULLET = new WeakSet<object>();

export function withOtherBullet(node: List, other: boolean): void {
  if (other) OTHER_BULLET.add(node);
  else OTHER_BULLET.delete(node);
}

/**
 * The lists whose items have to be indented as far as a marker can push them, and the same trick
 * one option further along.
 *
 * The bullet is only half a lever. A raw block whose first line is indented is read as more of the
 * item above it whatever marker that item was written with, so the other half is how far the item's
 * content sits from the margin: `- a` puts it at column two and a following `  </td>` is inside the
 * list, and `-   a` puts it at column four and the same two spaces are outside. `tab` is mdast's own
 * name for the second of those and its own handler does the arithmetic; a raw block cut from a file
 * can be indented three columns at the most, because four is an indented code block and this bridge
 * can model one of those, so four is far enough for every list a file can produce.
 *
 * The option is global and lives on the state, so it is put back the moment the list is written.
 * Nothing here is re-entrant: a nested list is written inside this call and is meant to be indented
 * with its parent.
 */
const WIDE_ITEMS = new WeakSet<object>();

export function withWideItems(node: List, wide: boolean): void {
  if (wide) WIDE_ITEMS.add(node);
  else WIDE_ITEMS.delete(node);
}

function list(node: List, parent: Parents | undefined, state: State, info: Info): string {
  if (OTHER_BULLET.has(node)) state.bulletLastUsed = String(node.ordered ? HOUSE_STYLE.bulletOrdered : HOUSE_STYLE.bullet);
  if (!WIDE_ITEMS.has(node)) return defaultHandlers.list(node, parent, state, info);

  const indent = state.options.listItemIndent;
  state.options.listItemIndent = "tab";
  try {
    return defaultHandlers.list(node, parent, state, info);
  } finally {
    state.options.listItemIndent = indent;
  }
}

/**
 * The one rule that cannot be written the way the house writes a rule.
 *
 * `---` at the very start of a file is not a thematic break, it is the opening delimiter of YAML
 * frontmatter, and everything down to the next `---` is swallowed by it. The house style says a
 * rule is dashes and that is right for every rule in every file except the one that lands on the
 * first byte, so that one is written with the other character markdown has for the same construct.
 *
 * `rule` is checked by mdast against its own three characters and read out of the state when the
 * break is written, so this is the same swap `withWideItems` makes one option along.
 */
const OTHER_RULE_CHARACTER = "*";

const OTHER_RULE = new WeakSet<object>();

export function withOtherRule(node: ThematicBreak, other: boolean): void {
  if (other) OTHER_RULE.add(node);
  else OTHER_RULE.delete(node);
}

function thematicBreak(node: ThematicBreak, parent: Parents | undefined, state: State): string {
  if (!OTHER_RULE.has(node)) return defaultHandlers.thematicBreak(node, parent, state);

  const rule = state.options.rule;
  state.options.rule = OTHER_RULE_CHARACTER;
  try {
    return defaultHandlers.thematicBreak(node, parent, state);
  } finally {
    state.options.rule = rule;
  }
}

/**
 * The house style. The only one, which is the point: every value here is a decision the app makes
 * once on the user's behalf, and the first save of a file it has never written is the one time the
 * file moves. Every save after that produces these same bytes.
 */
export const HOUSE_STYLE: StringifyOptions = {
  bullet: "-",
  bulletOther: "*",
  bulletOrdered: ".",
  emphasis: "_",
  strong: "*",
  fence: "`",
  fences: true,
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  listItemIndent: "one",
  incrementListMarker: true,
  quote: '"',
  // mdast never picks the angle form on its own. The serializer has a rung for it, written as a
  // literal and proved by a re-parse like every other spelling, and by the time a link reaches this
  // writer as a `link` node it is one the serializer has already decided has to be spelled out.
  resourceLink: true,
  setext: false,
  tightDefinitions: true,
  handlers: { rawBlock: (node: RawBlock) => node.value, phrasingLiteral, wrappedCode, wrappedMath, delete: strikethrough, list, thematicBreak },
};

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, MATH_OPTIONS);

const frontmatterParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, MATH_OPTIONS).use(remarkFrontmatter, ["yaml", "toml"]);

/**
 * The one GFM option the writer sets, and it is a correctness decision rather than a taste one.
 *
 * mdast pads every table cell out to the width of the widest cell in its column, which is lovely
 * for a table of dates and hopeless for a table of prose. One 600 character cell in a research
 * note drags all 120 rows out to 764 characters each and takes the file from 74kB to 126kB on the
 * save that follows a single keystroke, which is not a reformat, it is damage: the diff is the
 * whole document and the source is no longer something a person can read in a terminal.
 *
 * Turning the alignment off writes `| a | b |` with one space either side of every cell, which is
 * valid GFM, renders the same everywhere, and costs each row a length that depends only on its own
 * contents. It is stable under a resave for the same reason the padded form was: the width of a
 * cell is a function of the cell.
 */
const GFM_WRITE_OPTIONS = { tablePipeAlign: false } as const;

const stringifier = unified().use(remarkStringify, HOUSE_STYLE).use(remarkGfm, GFM_WRITE_OPTIONS).use(remarkMath, MATH_OPTIONS);

/**
 * One house style still, and one parser for any file the frontmatter extension has an opinion
 * about. The extension is not free: at the very start of a file its tokenizer competes with the
 * thematic break, and when it starts a block it cannot finish, the blocks after the break come
 * back flattened into a paragraph, so `---` then a list loses the list. Its answer is therefore
 * only kept when it actually found frontmatter, which is the only case it exists for; a file whose
 * first bytes cannot open a block never reaches it at all.
 */
export function parseToMdast(text: string): Root {
  if (!text.startsWith("---") && !text.startsWith("+++")) return parser.parse(text);
  const tree = frontmatterParser.parse(text);
  return isFrontmatterNode(tree.children[0]) ? tree : parser.parse(text);
}

/** The nodes whose children are phrasing, and so the nodes whose `html` children are inline. */
const PHRASING_PARENTS: ReadonlySet<string> = new Set(["paragraph", "heading", "tableCell", "emphasis", "strong", "delete", "link", "linkReference"]);

interface Branch {
  type: string;
  children?: Branch[];
}

/**
 * Inline `html` becomes `phrasingLiteral` on the way out, everywhere in the tree.
 *
 * This is the one place that has to know, because the line ending is lost inside
 * `containerPhrasing` rather than inside a handler, and there is no option that reaches it. Flow
 * html is left alone: a `<details>` on a line of its own is a block and is meant to be.
 */
function phrasingLiterals<T extends Branch>(node: T): T {
  const children = node.children;
  if (!children) return node;

  const inline = PHRASING_PARENTS.has(node.type);
  let moved = false;
  const next = children.map((child) => {
    const walked = phrasingLiterals(child);
    const swapped = inline && walked.type === "html" ? { ...walked, type: "phrasingLiteral" } : walked;
    if (swapped !== child) moved = true;
    return swapped;
  });
  if (!moved) return node;

  // A list that has been told how to keep away from the block beside it is remembered by the node,
  // and a list holding a bare url or a callout label is a list this walk rebuilds. The copy is the
  // node the handler will be given, so it has to be told the same thing, or a seam the serializer
  // proved apart is written back together.
  const copy = { ...node, children: next };
  if (OTHER_BULLET.has(node)) OTHER_BULLET.add(copy);
  if (WIDE_ITEMS.has(node)) WIDE_ITEMS.add(copy);
  return copy;
}

export function stringifyMdast(tree: Root): string {
  return stringifier.stringify(phrasingLiterals(tree));
}
