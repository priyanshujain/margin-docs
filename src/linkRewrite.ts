// Keeping relative links true across a move or a rename.
//
// A document that moves takes two sets of broken links with it. The ones pointing at it, written in
// other files against the place it used to be, and the ones inside it, written against the folder
// it used to sit in. Both are wrong the moment the file lands somewhere else, and a move that
// leaves them wrong breaks every path in and out of the file the user just dragged without showing
// them a single character of what changed.
//
// This is the only thing in the app that edits a file nobody is looking at, so it is built to
// refuse rather than to guess. Four rules hold over everything below.
//
// It edits the destination and nothing else. A file is never round tripped through the markdown
// writer to change a link. The writer settles a file into the house style on its first save, which
// is a diff the user asked for by typing in it, and is not something forty other files should get
// because one file moved. So the work is on the raw text and the only bytes that move are the ones
// between one link's own destination offsets.
//
// A link it cannot prove is left exactly as it was. mdast reports the destination it read and the
// offsets of the node that held it; this module then goes and finds those same bytes in the source
// before it touches them. The destination text has to match what the parser reported character for
// character, it has to be the only reading of the node's bytes that ends where the node ends, and
// the href going back has to be spellable in the form the file already used. Anything short of that
// is counted as refused and reported, because a rewrite that silently skips a link tells the user
// their links are fine when they are not.
//
// A link that is not a link is never touched. Something inside a fenced block, an indented block, a
// code span or a chunk of raw html is text that looks like a link, and rewriting it changes what
// the document says. Nothing here tests for that, because remark hands those back as `code`,
// `inlineCode` and `html` nodes with no `link` anywhere inside them, so a destination this module
// can see is one the file really has. Frontmatter is out for the same reason: the parser hands the
// whole block back as one opaque node.
//
// And every write is proved before it goes out. The spliced text is parsed again and compared
// against what the splice was meant to do: the same destinations in the same order, each holding
// the href it was given, each sitting at the offset the replacements before it shift it to. A file
// that does not answer exactly that is not written at all. The proof sits inside `rewriteLinksIn`,
// between the splice and the bytes coming back out of it, with no condition in front of it, so
// neither the write below nor the one src/document.ts makes for the open document has a path to
// disk that goes around it.
//
// Which files get looked at is decided by walking the open roots rather than by asking the index.
// `backlinksFor` is the cheap route and it is deliberately unused: the index is derived state with
// no freshness this module can check, and a stale answer is a file quietly left broken, which is
// the one outcome this project ranks below doing nothing. The sweep reads every markdown document
// in every open root, a gitignored one included, since the tree's filter is about what a sidebar
// should show and not about whether a link is worth keeping. It skips the parse for text that
// cannot name the thing that moved, and it gives up and says so rather than reading more documents
// than `MAX_SWEEP_DOCUMENTS`. A file outside every open root is never seen by anything here and
// never will be.

import type { Root } from "mdast";
import { fileRead, fileWrite } from "./api/files";
import { sweepDocuments } from "./api/roots";
import { rewriteOpenDocument } from "./document";
import { relativeFrom, resolveRelative } from "./links";
import { BOM } from "./markdown/frontmatter";
import { parseToMdast } from "./markdown/handlers";
import { documentKindForPath } from "./model/doc";
import { useDocument } from "./store/useDocument";
import { useWorkspace } from "./store/useWorkspace";
import { notify } from "./store/useToast";

/**
 * Where a file or folder was and where it is now, both absolute and spelled the way the tree
 * spells them. `fileMove` and `fileRename` both hand back the new path as `node.path`.
 */
export interface Move {
  from: string;
  to: string;
}

export interface FailedFile {
  path: string;
  reason: string;
}

export interface LinkRewriteReport {
  /** Files whose bytes changed, absolute. */
  rewritten: readonly string[];
  /** Links that needed a new destination and did not get one, because it could not be proved. */
  refused: number;
  /** Files that could not be read, could not be written, or that another writer reached first. */
  failed: readonly FailedFile[];
  /**
   * The open document, when writing it would have gone under what the user is looking at: an
   * unsaved edit, a save already on the wire, or bytes the editor cannot vouch for because the
   * file moved on under it.
   */
  heldBack: string | null;
  /**
   * Whether every document that could hold a link into the move was actually read. `partial` means
   * the open roots hold more documents than one move is allowed to read, or a root would not answer
   * at all, so only the moved documents' own links were brought up to date.
   */
  coverage: "complete" | "partial";
}

/**
 * More documents than one move gets to read. A move is a deliberate and infrequent gesture, so the
 * cost of reading a workspace is worth paying to be exact about it, but there is a size past which
 * a drag would sit there for a quarter of a minute, and at that point saying so beats doing it.
 */
const MAX_SWEEP_DOCUMENTS = 5000;

/** `file_read` is an async command, so the sweep is bounded by the round trip rather than by disk. */
const READ_CONCURRENCY = 8;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const isUnder = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);

/**
 * Where a path ends up after the move, which is the path itself for everything the move did not
 * touch. A folder move is the whole of the folder case: every document under it moved at once, so
 * the same prefix rewrite answers for the folder and for every path inside it.
 */
function mapped(path: string, move: Move): string {
  if (path === move.from) return move.to;
  if (isUnder(path, move.from)) return move.to + path.slice(move.from.length);
  return path;
}

// ---------------------------------------------------------------------------------------------
// Finding a destination's own bytes.
//
// mdast reports a link's `url` and the offsets of the node around it, and nothing at all about
// where inside those offsets the destination was written. Reconstructing that from the grammar is
// the only way to splice one href without reserializing the file, so the reader below walks the
// resource the way CommonMark defines it and then checks its answer against the url the parser
// already reported. Two readings that both fit is no reading at all.
// ---------------------------------------------------------------------------------------------

interface Destination {
  /** Offsets into the slice the reader was given, covering the destination text and not its
   * delimiters. */
  start: number;
  end: number;
  /** The `<...>` spelling, which has its own rules about what can be written inside it. */
  angled: boolean;
  /** Index just past the last character the reader consumed. */
  after: number;
}

const WHITESPACE = /\s/;

function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE.test(text[at])) at += 1;
  return at;
}

/**
 * A link destination, in either of the two spellings markdown has for one.
 *
 * The bare form runs to whitespace or to a closing parenthesis that is not inside a balanced pair,
 * and a backslash escape carries the character after it whatever that character is. The angled form
 * runs to the first unescaped `>` and holds no line ending. Both refuse a control character, which
 * markdown has no way to write in a destination at all.
 */
function readDestination(text: string, from: number): Destination | null {
  if (text[from] === "<") {
    let at = from + 1;
    while (at < text.length) {
      const char = text[at];
      if (char === "\\") {
        at += 2;
        continue;
      }
      if (char === "<" || char === "\n" || char === "\r") return null;
      if (char === ">") return { start: from + 1, end: at, angled: true, after: at + 1 };
      at += 1;
    }
    return null;
  }

  let depth = 0;
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (WHITESPACE.test(char)) break;
    else if (isControl(char)) return null;
    at += 1;
  }
  if (depth !== 0) return null;
  // A trailing backslash steps the cursor past the last byte, and an offset outside the text it
  // indexes is the one thing nothing below could splice safely.
  const end = Math.min(at, text.length);
  return { start: from, end, angled: false, after: end };
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** The optional title after a destination, in any of its three delimiters. */
function skipTitle(text: string, from: number): number | null {
  const open = text[from];
  if (open !== '"' && open !== "'" && open !== "(") return null;
  const close = open === "(" ? ")" : open;
  let at = from + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === close) return at + 1;
    if (open === "(" && char === "(") return null;
    at += 1;
  }
  return null;
}

/** `( destination "title" )`, starting at the opening parenthesis. */
function readResource(text: string, from: number): Destination | null {
  const destination = readDestination(text, skipWhitespace(text, from + 1));
  if (destination === null) return null;
  let at = skipWhitespace(text, destination.after);
  if (at > destination.after) {
    const title = skipTitle(text, at);
    if (title !== null) at = skipWhitespace(text, title);
  }
  if (text[at] !== ")") return null;
  return { ...destination, after: at + 1 };
}

/**
 * The destination inside an inline link or image, proved rather than located.
 *
 * A label can hold parentheses of its own, a code span inside it can hold an unbalanced one, and
 * neither is a thing to reason about from the outside. So every parenthesis in the node is tried as
 * the start of the resource, and a reading counts only when it consumes the node exactly to its
 * last byte and hands back the destination the parser already reported. If two readings do that,
 * neither is provable and the link is left alone.
 */
function inlineDestination(slice: string, url: string): Destination | null {
  let found: Destination | null = null;
  for (let at = 0; at < slice.length; at += 1) {
    if (slice[at] === "\\") {
      at += 1;
      continue;
    }
    if (slice[at] !== "(") continue;
    const resource = readResource(slice, at);
    if (resource === null || resource.after !== slice.length) continue;
    if (slice.slice(resource.start, resource.end) !== url) continue;
    if (found !== null) return null;
    found = resource;
  }
  return found;
}

/**
 * The destination in a reference definition, `[label]: destination "title"`.
 *
 * Anchored at the first byte rather than searched for, because a definition's label cannot hold an
 * unescaped bracket, so the end of it is not a guess.
 */
function definitionDestination(slice: string, url: string): Destination | null {
  if (slice[0] !== "[") return null;
  let at = 1;
  while (at < slice.length) {
    const char = slice[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char === "[") return null;
    if (char === "]") break;
    at += 1;
  }
  if (slice[at] !== "]" || slice[at + 1] !== ":") return null;

  const destination = readDestination(slice, skipWhitespace(slice, at + 2));
  if (destination === null || destination.end === destination.start) return null;
  if (slice.slice(destination.start, destination.end) !== url) return null;

  let rest = skipWhitespace(slice, destination.after);
  if (rest > destination.after) {
    const title = skipTitle(slice, rest);
    if (title !== null) rest = skipWhitespace(slice, title);
  }
  return rest === slice.length ? destination : null;
}

// ---------------------------------------------------------------------------------------------
// What the new href should be.
// ---------------------------------------------------------------------------------------------

/**
 * Whether `href` can be written where the file already has one and read back as itself.
 *
 * A `#` or a `?` is the one class `relativeFrom` cannot make safe: it escapes a space and nothing
 * else, so a file whose name holds either character comes back as a href that every reader splits
 * into a shorter path and a fragment, pointing at a file that is not there. Whitespace, a
 * backslash and an angle bracket are refused for the same reason from the other side, and a bare
 * destination additionally has to keep its parentheses balanced, since that is what tells the
 * parser where it ends.
 */
function spellable(href: string, angled: boolean): boolean {
  if (href === "") return false;
  if (/[#?\s\\<>]/.test(href)) return false;
  for (const char of href) if (isControl(char)) return false;
  if (angled) return true;
  let depth = 0;
  for (const char of href) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

interface NextHref {
  /** Everything up to the fragment, which is the part `spellable` has to answer for. */
  path: string;
  /** The whole destination going back into the file, the author's own fragment included. */
  text: string;
}

/**
 * The href to put in place of `href`, or null where the file already says the right thing.
 *
 * Both ends of a link can move: the document holding it, which changes what its relative paths are
 * measured from, and the document it points at. So the question is asked as two spellings of the
 * same link, the one this app would have written before the move and the one it would write after,
 * and a link is rewritten only when those two differ. That is what keeps a rename in place from
 * respelling every link in the file it renamed: a `dir/x.md` the author wrote without the leading
 * `./` is left as `dir/x.md`, because the relationship it describes did not change and this module
 * is not here to normalise anybody's text.
 *
 * A href beginning with `/` is left alone whatever moved. This app reads one as a filesystem path,
 * every static site generator reads it as site root relative, and rewriting somebody's link on the
 * strength of the reading this app happens to have picked is a change of meaning rather than a
 * repair.
 */
function nextHref(oldFrom: string, newFrom: string, href: string, move: Move): NextHref | null {
  if (href.startsWith("/")) return null;
  const target = resolveRelative(oldFrom, href);
  if (target === null) return null;

  const before = relativeFrom(oldFrom, target);
  const after = relativeFrom(newFrom, mapped(target, move));
  if (after === before) return null;

  const cut = href.search(/[#?]/);
  const suffix = cut === -1 ? "" : href.slice(cut);
  // A trailing slash is the author saying they mean a folder, and it is a byte of their file.
  const was = cut === -1 ? href : href.slice(0, cut);
  const path = after + (was.endsWith("/") ? "/" : "");
  return { path, text: path + suffix };
}

// ---------------------------------------------------------------------------------------------
// One file's text.
// ---------------------------------------------------------------------------------------------

interface LinkNode {
  type: "link" | "image" | "definition";
  url: string;
  start: number;
  end: number;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

/**
 * Every destination in the tree, in one fixed walk order.
 *
 * Null when a node came back without offsets or without a url, which means the tree does not
 * describe the text it was parsed from and nothing below could be verified against it.
 *
 * A link node is descended into as well as recorded, because an image can sit inside a link and
 * both hold a destination. That makes the node ranges nest, which is why nothing here assumes they
 * do not; the destinations themselves stay disjoint, and that is the thing the splice needs.
 */
function destinations(tree: Root): LinkNode[] | null {
  const found: LinkNode[] = [];
  let whole = true;

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const branch = node as {
      type?: unknown;
      url?: unknown;
      children?: unknown;
      position?: { start?: { offset?: number }; end?: { offset?: number } };
    };
    if (branch.type === "link" || branch.type === "image" || branch.type === "definition") {
      const start = branch.position?.start?.offset;
      const end = branch.position?.end?.offset;
      if (typeof start !== "number" || typeof end !== "number" || typeof branch.url !== "string") {
        whole = false;
      } else {
        found.push({ type: branch.type, url: branch.url, start, end });
      }
    }
    if (Array.isArray(branch.children)) for (const child of branch.children) visit(child);
  };

  for (const child of tree.children) visit(child);
  return whole ? found : null;
}

/**
 * How far a replacement list moves the byte at `offset`.
 *
 * Everything that finished at or before the offset has already shifted it, and a replacement the
 * offset sits inside has not, which is exactly right for both ends of a node that contains one: a
 * link's start is in front of its own destination and its end is behind it.
 */
function shiftFor(replacements: readonly Replacement[], offset: number): number {
  let shift = 0;
  for (const replacement of replacements) {
    if (replacement.end <= offset) shift += replacement.text.length - (replacement.end - replacement.start);
  }
  return shift;
}

/**
 * The proof, run on every file before it is written and never skipped.
 *
 * A splice is meant to change one run of bytes inside each destination it was aimed at and nothing
 * else in the file, and the way to know it did is to read the result back with the same parser.
 * Every destination has to still be there, still be the same kind of node, hold the href it was
 * given or the one it always had, and sit at the offset the replacements in front of it move it to.
 * A destination that swallowed its own title, an href that closed a link early, a splice landing at
 * an offset the parse did not agree with: all of them come out as a mismatch here, and a mismatch
 * means the file is not written at all.
 */
function proves(
  body: string,
  before: readonly LinkNode[],
  replacements: readonly Replacement[],
  expected: ReadonlyMap<number, string>,
): boolean {
  const after = destinations(parseToMdast(body));
  if (after === null || after.length !== before.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    const was = before[index];
    const now = after[index];
    if (now.type !== was.type) return false;
    if (now.url !== (expected.get(was.start) ?? was.url)) return false;
    if (now.start !== was.start + shiftFor(replacements, was.start)) return false;
    if (now.end !== was.end + shiftFor(replacements, was.end)) return false;
  }
  return true;
}

export interface TextOutcome {
  /** The whole file with its destinations brought up to date, or null when nothing was written. */
  text: string | null;
  /** Links that needed a new destination and were left with the old one. */
  refused: number;
  /**
   * The file as a whole was put down rather than one link in it: the parse did not describe the
   * text it came from, or the finished splice did not read back as the thing it was meant to be.
   * Nothing was written and the caller reports it rather than counting it as a file with nothing
   * to do.
   */
  unprovable: boolean;
}

/**
 * One file's raw text in, the same text with its destinations brought up to date out.
 *
 * `path` is where this file was before the move, which for everything outside what moved is simply
 * where it still is. Where it went is not a second argument: it is `path` put through the move, so
 * the two ends of the arithmetic cannot be handed in disagreeing with each other.
 *
 * Pure, and the only part of this module that decides what a file's new bytes are. Nothing here
 * reads or writes anything.
 *
 * A byte order mark is cut off and put back rather than parsed around, because remark's own
 * handling of a leading mark is not something the offsets below can afford to be wrong about. The
 * text is otherwise given to the parser exactly as it came off disk, carriage returns and all: the
 * bridge normalises line endings before it parses and this must not, since the offsets have to
 * index the bytes that are going back to the file.
 */
export function rewriteLinksIn(text: string, path: string, move: Move): TextOutcome {
  const oldFrom = path;
  const newFrom = mapped(path, move);
  const mark = text.startsWith(BOM) ? BOM : "";
  const body = text.slice(mark.length);

  const nodes = destinations(parseToMdast(body));
  if (nodes === null) return { text: null, refused: 0, unprovable: true };

  const replacements: Replacement[] = [];
  const expected = new Map<number, string>();
  let refused = 0;

  for (const node of nodes) {
    const href = nextHref(oldFrom, newFrom, node.url, move);
    if (href === null) continue;

    const slice = body.slice(node.start, node.end);
    const where =
      node.type === "definition"
        ? definitionDestination(slice, node.url)
        : inlineDestination(slice, node.url);
    if (where === null || !spellable(href.path, where.angled)) {
      refused += 1;
      continue;
    }
    replacements.push({
      start: node.start + where.start,
      end: node.start + where.end,
      text: href.text,
    });
    expected.set(node.start, href.text);
  }

  if (replacements.length === 0) return { text: null, refused, unprovable: false };

  replacements.sort((a, b) => a.start - b.start);
  for (let index = 1; index < replacements.length; index += 1) {
    // Two destinations cannot overlap, so a pair that does means the offsets are not describing
    // this text and the splice would cut one of them in half.
    if (replacements[index].start < replacements[index - 1].end) {
      return { text: null, refused, unprovable: true };
    }
  }

  let next = body;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end);
  }

  if (!proves(next, nodes, replacements, expected)) {
    return { text: null, refused, unprovable: true };
  }
  return { text: mark + next, refused, unprovable: false };
}

// ---------------------------------------------------------------------------------------------
// The files.
// ---------------------------------------------------------------------------------------------

type FileResult =
  | { kind: "unchanged"; refused: number }
  | { kind: "rewritten"; path: string; refused: number }
  | { kind: "failed"; path: string; reason: string };

/**
 * Reads one file, rewrites what has to move, and writes it back through the same atomic write every
 * save in this app goes through.
 *
 * `marker` is a name the text has to hold for anything in it to be able to point into the move, and
 * skipping the parse on a file that does not hold it is the whole reason a sweep is affordable. A
 * percent sign is enough to earn a parse on its own, since a percent escaped path can spell a name
 * without containing it.
 *
 * The mtime the read came back with is handed to the write, so a file another program touched in
 * between comes back as a conflict and keeps its bytes rather than losing them to a rewrite built
 * on a copy that is no longer there.
 */
async function rewriteFile(path: string, move: Move, marker: string | null): Promise<FileResult> {
  const newPath = mapped(path, move);
  let text: string;
  let modifiedMs: number;
  try {
    const read = await fileRead(newPath);
    text = read.text;
    modifiedMs = read.modifiedMs;
  } catch (e) {
    return { kind: "failed", path: newPath, reason: String(e) };
  }

  if (marker !== null && !text.includes(marker) && !text.includes("%")) {
    return { kind: "unchanged", refused: 0 };
  }

  let outcome: TextOutcome;
  try {
    outcome = rewriteLinksIn(text, path, move);
  } catch (e) {
    // The parser is the only thing in there that can raise, and a file it will not read is a file
    // whose links nothing here knows the shape of. Nothing has been written at this point.
    return { kind: "failed", path: newPath, reason: String(e) };
  }
  if (outcome.unprovable) {
    return { kind: "failed", path: newPath, reason: "its links could not be matched to its text" };
  }
  if (outcome.text === null) return { kind: "unchanged", refused: outcome.refused };

  try {
    const written = await fileWrite(newPath, outcome.text, modifiedMs);
    if (written.conflict) {
      return { kind: "failed", path: newPath, reason: "it changed on disk part way through" };
    }
  } catch (e) {
    return { kind: "failed", path: newPath, reason: String(e) };
  }
  return { kind: "rewritten", path: newPath, refused: outcome.refused };
}

/**
 * The same work for the file the user is looking at, handed to src/document.ts rather than done
 * here.
 *
 * That module owns the one write the open document is allowed, and it is the only place that can
 * ask whether the buffer is clean and write in the same run of the event loop. Doing it from out
 * here meant reading `dirty`, then two parses of the file, then a write, which on a document of any
 * size is long enough for a keystroke to land in the middle and come back at the user as a conflict
 * over a change this app made itself.
 *
 * `rewriteLinksIn` stays here, because what a file's new bytes are is this module's question and
 * nothing else's. It is handed over as a callback, and everything it works out other than the bytes
 * comes back out of the closure.
 *
 * Only for the document that did not move. One that did is at a path the store does not have open
 * yet, and its caller reopens it there the moment this returns.
 */
async function rewriteOpenFile(
  path: string,
  move: Move,
  marker: string | null,
): Promise<FileResult | "held"> {
  const outcomes: TextOutcome[] = [];
  const result = await rewriteOpenDocument(path, (text) => {
    if (marker !== null && !text.includes(marker) && !text.includes("%")) return null;
    const outcome = rewriteLinksIn(text, path, move);
    outcomes.push(outcome);
    return outcome.text;
  });

  const outcome = outcomes.length === 0 ? null : outcomes[0];
  // Asked before the write's own answer, and it has to be. A file whose links could not be matched
  // to its text is one the callback returned null for, and null is also how it says there was
  // nothing to do, so the outcome is the only thing that can tell those two apart.
  if (outcome !== null && outcome.unprovable) {
    return { kind: "failed", path, reason: "its links could not be matched to its text" };
  }
  if (result.kind === "held") return "held";
  if (result.kind === "failed") return { kind: "failed", path, reason: result.reason };
  const refused = outcome === null ? 0 : outcome.refused;
  return result.kind === "rewritten"
    ? { kind: "rewritten", path, refused }
    : { kind: "unchanged", refused };
}

/**
 * Every markdown document in every open root, read fresh so the move is already in it, and whether
 * that is all of them.
 *
 * `sweep_documents` and not `tree_read`: the tree hides what the folder's gitignore hides, which is
 * the right answer for a sidebar and the wrong one for a writer. `complete` is false when a root
 * came back holding more documents than the sweep will read, which the backend says by handing back
 * one path past the cap.
 */
async function sweepCandidates(): Promise<{ paths: string[]; complete: boolean } | null> {
  const roots = useWorkspace.getState().roots;
  const paths: string[] = [];
  let complete = true;
  for (const root of roots) {
    let batch: string[];
    try {
      // One past the cap, so a root that goes over costs the cap rather than the folder and is
      // still visible as having gone over.
      batch = await sweepDocuments(root.id, MAX_SWEEP_DOCUMENTS + 1);
    } catch {
      // A root that will not answer is a root whose documents were not looked at, and the report
      // has to say so rather than count the ones that did answer as the whole workspace.
      return null;
    }
    if (batch.length > MAX_SWEEP_DOCUMENTS) complete = false;
    paths.push(...batch);
  }
  return { paths, complete };
}

async function inParallel<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
}

const count = (n: number, thing: string): string => `${n} ${thing}${n === 1 ? "" : "s"}`;

function describe(report: LinkRewriteReport): string | null {
  const trouble: string[] = [];
  if (report.failed.length > 0) {
    trouble.push(`${count(report.failed.length, "file")} could not be updated`);
  }
  if (report.heldBack !== null) {
    // Not "has unsaved changes" any more. That is the usual reason and it is no longer the only
    // one: a save still on the wire and a file the editor has lost track of hold it back too, and
    // naming a cause the user can check and find is not true is worse than naming none.
    trouble.push(`${baseName(report.heldBack)} is open and was left as it is`);
  }
  if (report.refused > 0) {
    trouble.push(`${count(report.refused, "link")} could not be matched exactly`);
  }
  if (report.coverage === "partial") {
    trouble.push("only the moved documents' own links were checked");
  }

  if (trouble.length === 0) {
    if (report.rewritten.length === 0) return null;
    return `Updated links in ${count(report.rewritten.length, "file")}.`;
  }
  const done =
    report.rewritten.length === 0
      ? "Links after the move"
      : `Updated links in ${count(report.rewritten.length, "file")}`;
  return `${done}: ${trouble.join("; ")}.`;
}

/**
 * Brings every relative link that the move made wrong back up to date, and says what it could not
 * do.
 *
 * Call it once, after `fileMove` or `fileRename` has come back, and before the open document is
 * reopened at its new path. Both halves of the ordering matter. Before the move there is nothing at
 * the new path to read; after the reopen the editor is holding a buffer of the bytes as they were
 * and the next keystroke would put the old links back.
 *
 * It never throws and never fails a move. Everything that went wrong comes back in the report, and
 * a single toast describing it is raised from here, so a caller has nothing to remember to say and
 * should not add a toast of its own.
 *
 * Two things are worth knowing about what it does not promise. Each file is written on its own, so
 * a failure part way through leaves the files before it correctly rewritten, the file that failed
 * with every byte it had, and the ones after it untouched; that is what `failed` is for, and there
 * is no rollback because a rollback is another round of writes that can fail in the same way. And
 * the open document is skipped when its buffer is dirty, and equally when a save of it is already
 * on the wire, because in both cases the bytes in front of the user are the ones that count and
 * writing under them would put the two on a collision the user has to resolve. When it is written
 * it goes through src/document.ts rather than around it, and the buffer is handed the new links
 * before the bytes leave, so the file and the document on screen cannot come out of this as two
 * copies of the same move.
 */
export async function rewriteLinksForMove(move: Move): Promise<LinkRewriteReport> {
  const rewritten: string[] = [];
  const failed: FailedFile[] = [];
  let refused = 0;
  let heldBack: string | null = null;
  let coverage: "complete" | "partial" = "complete";

  // Nothing moved, or a folder was somehow put inside itself, in which case no prefix rewrite below
  // describes where anything ended up.
  if (move.from === move.to || isUnder(move.to, move.from)) {
    return { rewritten, refused, failed, heldBack, coverage };
  }

  const candidates = await sweepCandidates();
  const documents = candidates?.paths ?? [];
  const inside = new Set(documents.filter((path) => path === move.to || isUnder(path, move.to)));
  // An ignored document is in the sweep now, so what is left for this line is the case that still
  // is not: a document moved to somewhere outside every open root is in no list this module can
  // ask for, and its own links are the half of this that needs no sweep to be answered.
  if (documentKindForPath(move.to) === "markdown") inside.add(move.to);
  let outside = documents.filter((path) => !inside.has(path));

  // `complete` is not something `outside.length` can stand in for. A list cut off at the cap whose
  // every entry landed inside the move leaves nothing outside at all, which reads exactly like a
  // workspace that had nothing to update while documents were quietly dropped.
  if (candidates === null || !candidates.complete || outside.length > MAX_SWEEP_DOCUMENTS) {
    coverage = "partial";
    outside = [];
  }

  const marker = baseName(move.from);
  const openPath = useDocument.getState().path;

  // Every job is named by where its file was before the move, because that is the path the store
  // still has the open document under and the path its own links were written against. A document
  // inside what moved has a marker of null: its base directory changed, so every relative link in
  // it is worth looking at whatever the text mentions.
  const jobs: { path: string; marker: string | null }[] = [
    ...[...inside].map((path) => ({ path: move.from + path.slice(move.to.length), marker: null })),
    ...outside.map((path) => ({ path, marker })),
  ];

  const take = (result: FileResult): void => {
    refused += result.kind === "failed" ? 0 : result.refused;
    if (result.kind === "rewritten") rewritten.push(result.path);
    if (result.kind === "failed") failed.push({ path: result.path, reason: result.reason });
  };

  // The open document is pulled out and done last on its own, because whether it can be written at
  // all is a question about the buffer, and because the editor has to be told afterwards.
  const open = jobs.find((job) => job.path === openPath);
  await inParallel(
    jobs.filter((job) => job !== open),
    async (job) => take(await rewriteFile(job.path, move, job.marker)),
  );

  if (open !== undefined) {
    // A document that stayed where it is goes through src/document.ts, which gives the buffer the
    // new links before the bytes leave and so needs nothing here to tell the editor afterwards. One
    // that moved cannot: the store is still holding it under the path it came from, and the caller
    // reopens it at the new one, which reads the file again anyway. That one keeps the old shape,
    // dirty check and all, because writing under a buffer nobody has landed is the collision this
    // whole module exists to avoid.
    if (mapped(open.path, move) === openPath) {
      const result = await rewriteOpenFile(open.path, move, open.marker);
      if (result === "held") heldBack = open.path;
      else take(result);
    } else if (useDocument.getState().dirty) {
      heldBack = open.path;
    } else {
      take(await rewriteFile(open.path, move, open.marker));
    }
  }

  rewritten.sort();
  failed.sort((a, b) => a.path.localeCompare(b.path));
  const report: LinkRewriteReport = { rewritten, refused, failed, heldBack, coverage };
  const message = describe(report);
  if (message !== null) notify(message);
  return report;
}
