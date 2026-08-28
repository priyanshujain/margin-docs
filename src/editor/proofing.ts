// Spelling and grammar, drawn over the document as decorations and never as an edit to it.
//
// The whole of this file is paint and a menu. The only transaction in it that carries a step is the
// one a user makes by choosing a suggestion, and that one is a single transaction so a single undo
// puts their word back. Everything else dispatches a decoration set and no steps, which is not a
// document change: TipTap only emits `update` when a transaction changed the document, so nothing
// here dirties a buffer, schedules a save or reaches src/markdown/serialize.ts. A spell checker that
// rewrites text on its own would be a file damaging bug in this project's terms, so it does not have
// the ability to.
//
// TWO CHECKERS, ONE PIPELINE.
//
// Spelling is the system's and grammar is Harper's. They are separate settings, separate commands
// and separate answers, and they share everything between the document and the underline: the same
// blocks, the same batching, the same debounce, the same decoration set and the same popover. There
// is deliberately no second producer of strings and no second pass. The guard below is `proseBlocks`
// and it is one function; a guard that only one of the two checkers happened to go through is a
// guard that stops being there the day somebody adds a third call beside them.
//
// The caches are the one thing that is per checker, because the answers are. A block can have been
// asked about by one and not the other, which is exactly what the first launch after somebody turns
// grammar on looks like, and a single cache would either re-ask the whole document on every toggle
// or claim a block was checked for something it was never sent to.
//
// WHAT IS CHECKED, and where that guard actually sits.
//
// Prose only. A fenced code block, a raw block, a maths field and an inline code span are not prose,
// and underlining somebody's variable names is the fastest way to get a spell checker turned off for
// good. The guard is `proseBlocks` below, and it is the single producer of every string this file
// sends to either checker: `pass` checks only what `proseBlocks` returned, `spellCheck` and
// `grammarCheck` are called from nowhere else in the app outside src/api/spell.ts and
// src/api/grammar.ts themselves, and a block that never went to a checker has no entry in that
// checker's cache and therefore no decoration. There is no second path to either one to forget to
// guard, which is the shape of guard this project has now shipped four times unreached.
//
// A URL is the exception and it is deliberately not handled here. The Rust side asks AppKit to
// recognise links in the run it is given, so an autolink is one URL rather than five misspelled
// words, and the text of a link is otherwise ordinary prose that deserves checking like any other.
//
// WHEN IT RUNS.
//
// Not on every keystroke. Each check crosses the IPC boundary, into AppKit for spelling and into
// Harper's linter for grammar, so typing schedules a pass a few hundred milliseconds out and every
// further keystroke pushes it back. A pass sends only the blocks whose text a checker has not
// already answered about, so an ordinary edit is one paragraph over the wire and a document nobody
// has touched is nothing at all. A cache is keyed by the exact text of a block, which is what makes
// that true without any range tracking: text the user has not touched is text that is still its own
// key.
//
// AND WHY A STALE ANSWER CANNOT LAND.
//
// Two things, one structural and one the sequence number src/store/useSearch.ts uses for the same
// shape. The structural one is that an answer is stored against the exact text it was about, and
// decorations are always rebuilt from the document that is on screen at that moment, so an answer
// about text that has since changed has nothing in the current document to attach to. The counter is
// the belt to that pair of braces: any edit bumps it, and a pass that comes back to find it has
// moved keeps its answers for the cache and draws nothing.

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, PluginView } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { grammarCheck } from "../api/grammar";
import { spellCheck } from "../api/spell";
import type { GrammarIssue, SpellIssue } from "../ipc";
import { useProofing, type ProofTarget } from "../store/useProofing";

/** How long after the last keystroke a pass runs. Long enough that typing a word is one check. */
const IDLE_MS = 400;

/** And how long after a document is installed, which is a wait for nothing in particular. */
const OPEN_MS = 120;

/**
 * How much text goes to the checker in one call.
 *
 * A pass over a document nobody has opened before is every paragraph in it, and one IPC call per
 * paragraph would be several hundred round trips to AppKit for a long file. Blocks are joined into
 * runs up to this size instead, separated by a blank line so no word from one paragraph is ever
 * adjacent to a word from the next. A block longer than this goes on its own rather than being split,
 * because splitting a run cuts a word in half and invents a misspelling that is not in the document.
 */
const RUN_CHARS = 8000;

/** A word is separated from the next block's first word by this, and it is two positions wide. */
const JOIN = "\n\n";

/** What the menu offers, which is what a Mac's own spelling menu offers. */
const MAX_SUGGESTIONS = 5;

/** One prose textblock: where its text starts in the document, and the text itself. */
interface Block {
  base: number;
  text: string;
}

/**
 * The half of an answer this file's plumbing cares about, which is the same half for both checkers.
 *
 * Everything from the run batching to the cache to the offset arithmetic is about where a problem is
 * and nothing about what it is, so it is written once against this and used twice, rather than
 * copied and left to drift apart a fix at a time.
 */
interface Ranged {
  start: number;
  end: number;
}

/** Several blocks' text in one string, and where each of them starts in it. */
interface Run {
  text: string;
  parts: { text: string; at: number }[];
}

/**
 * What each checker has already said, keyed by the exact text it was said about.
 *
 * Module level rather than per view because it is not about a document: two files that share a
 * paragraph share its answers, and switching away from a document and back does not re-ask anything.
 * Both are pruned at the end of every pass down to the text that is actually in the document, so
 * neither can grow past the size of what is open.
 */
const spellCache = new Map<string, SpellIssue[]>();
const grammarCache = new Map<string, GrammarIssue[]>();

/**
 * The view a menu acts on. There is one editor and one document (see src/editor/index.ts), so there
 * is one of these, and it is null whenever no document is on screen.
 */
let activeView: EditorView | null = null;

/** Bumped by every edit and every pass. A pass whose number has moved on does not draw. */
let passSeq = 0;

const proofingKey = new PluginKey<DecorationSet>("proofing");

/**
 * One textblock's text, in a string whose length is exactly the block's content size, so an offset
 * into it is a document position plus a constant.
 *
 * The two things that are not prose are blanked rather than dropped, for that reason: an inline code
 * span and a leaf node (an image, a formula, a line break) become spaces of their own width, which
 * keeps every later word at the position the document has it at, keeps the checker from reading a
 * function name as a sentence, and leaves the words either side of a break as two words rather than
 * one.
 *
 * Null when the arithmetic did not come out, which nothing in the current schema can cause. It is
 * here for the same reason src/editor/blocks/code.ts measures its highlighter's output: a decoration
 * built on an offset that is wrong by one is drawn over the wrong characters, and one built past the
 * end of the block throws inside the view.
 */
function blockText(node: ProseMirrorNode): string | null {
  let text = "";
  node.forEach((child) => {
    if (!child.isText) {
      text += " ".repeat(child.nodeSize);
      return;
    }
    const value = child.text ?? "";
    text += child.marks.some((mark) => mark.type.name === "code") ? " ".repeat(value.length) : value;
  });
  return text.length === node.content.size ? text : null;
}

/**
 * Every block of prose in the document, and nothing else.
 *
 * This is the guard. A node that declares itself code is refused along with everything inside it,
 * which is both the fenced block and the raw block whose bytes are the file's own, taken from the
 * schema rather than from a list of names kept in step by hand. `mathBlock` is an atom holding its
 * LaTeX as an attribute, so it has no text to send anyway; it is named because "it has nothing to
 * check today" is a weaker sentence than "it is not prose".
 */
function proseBlocks(doc: ProseMirrorNode): Block[] {
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (node.type.name === "mathBlock") return false;
    if (!node.isTextblock) return true;
    const text = blockText(node);
    if (text !== null && text.trim() !== "") blocks.push({ base: pos + 1, text });
    return false;
  });
  return blocks;
}

/** The distinct texts in the document one checker has not answered about yet. */
function pending<T>(cache: ReadonlyMap<string, T[]>, blocks: readonly Block[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    if (cache.has(block.text) || seen.has(block.text)) continue;
    seen.add(block.text);
    out.push(block.text);
  }
  return out;
}

function runsOf(texts: readonly string[]): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const text of texts) {
    if (current !== null && current.text.length + JOIN.length + text.length > RUN_CHARS) {
      current = null;
    }
    if (current === null) {
      current = { text, parts: [{ text, at: 0 }] };
      runs.push(current);
      continue;
    }
    current.parts.push({ text, at: current.text.length + JOIN.length });
    current.text += JOIN + text;
  }
  return runs;
}

/**
 * Files one run's answers back into the cache, per block and in that block's own offsets.
 *
 * Every block in the run gets an entry, an empty one included. A block with no entry is a block the
 * next pass would send again, so a paragraph the checker is happy with has to be recorded as
 * checked or the document with no misspellings in it is the one that never stops asking.
 */
function store<T extends Ranged>(
  cache: Map<string, T[]>,
  run: Run,
  issues: readonly T[],
): void {
  const byPart = run.parts.map(() => [] as T[]);
  for (const issue of issues) {
    const index = run.parts.findIndex(
      (part) => issue.start >= part.at && issue.end <= part.at + part.text.length,
    );
    // An issue that reaches across the join between two blocks is not about either of them: a
    // misspelling is not a word there, and a sentence is not one sentence there.
    if (index === -1) continue;
    const part = run.parts[index];
    byPart[index].push({ ...issue, start: issue.start - part.at, end: issue.end - part.at });
  }
  run.parts.forEach((part, index) => cache.set(part.text, byPart[index]));
}

/**
 * Down to what is in the document, so a cache is never larger than what is open.
 *
 * In place rather than by building a smaller map, so that the two maps below are the same two
 * objects for the life of the module. A pass hands one of them to `store` and then waits on the IPC
 * boundary, and a second pass can finish and prune in the meantime; if pruning swapped the map, the
 * first pass would come back and file its answers into one nothing reads any more.
 */
function prune<T>(cache: Map<string, T[]>, blocks: readonly Block[]): void {
  const alive = new Set(blocks.map((block) => block.text));
  for (const text of cache.keys()) {
    if (!alive.has(text)) cache.delete(text);
  }
}

/** Which underlines are wanted, and what has been waved away for this sitting. */
interface Drawing {
  spelling: boolean;
  grammar: boolean;
  ignored: ReadonlySet<string>;
}

/**
 * Whether an issue's offsets sit inside the block it claims to be about.
 *
 * A checker is a foreign process walking the user's text, and a decoration running past the end of
 * a node throws inside the view rather than merely looking wrong, so an answer that does not fit is
 * dropped rather than clamped: an underline in the wrong place is a claim about the wrong words.
 */
function inside(issue: Ranged, block: Block): boolean {
  return issue.start >= 0 && issue.end > issue.start && issue.end <= block.text.length;
}

/**
 * The decorations for the document as it stands, built from what the checkers have already said.
 *
 * A block with nothing cached contributes nothing, which is what an underline that has not arrived
 * yet looks like. The two kinds are built in the same set and can overlap: a misspelled word inside
 * a phrase Harper does not like gets both marks, and `menuAt` below decides which of them a click
 * is about.
 */
function decorationsFor(doc: ProseMirrorNode, blocks: readonly Block[], what: Drawing): DecorationSet {
  const decorations: Decoration[] = [];
  for (const block of blocks) {
    if (what.spelling) {
      for (const issue of spellCache.get(block.text) ?? []) {
        if (!inside(issue, block) || what.ignored.has(issue.word.toLowerCase())) continue;
        decorations.push(
          Decoration.inline(
            block.base + issue.start,
            block.base + issue.end,
            { class: "proof-mark" },
            // The word and its suggestions ride on the decoration rather than in a list beside it,
            // so that mapping the set through an edit keeps the menu's offer attached to the word it
            // was about instead of to a position that has moved.
            { word: issue.word, suggestions: issue.suggestions, grammar: null },
          ),
        );
      }
    }
    if (what.grammar) {
      for (const issue of grammarCache.get(block.text) ?? []) {
        if (!inside(issue, block)) continue;
        // Harper answers about a span rather than about a word, so what the popover is "about" is
        // whatever that span covers. It is taken from the block's own text for the same reason the
        // spelling half takes the word the checker sent back: it is what a suggestion will be
        // checked against before anything is written.
        const text = block.text.slice(issue.start, issue.end);
        if (what.ignored.has(text.toLowerCase())) continue;
        decorations.push(
          Decoration.inline(
            block.base + issue.start,
            block.base + issue.end,
            { class: "proof-mark-grammar" },
            {
              word: text,
              suggestions: issue.suggestions,
              grammar: { kind: issue.kind, message: issue.message },
            },
          ),
        );
      }
    }
  }
  return DecorationSet.create(doc, decorations);
}

function draw(view: EditorView, decorations: DecorationSet): void {
  view.dispatch(view.state.tr.setMeta(proofingKey, decorations));
}

function clear(view: EditorView): void {
  const current = proofingKey.getState(view.state);
  if (!current || current === DecorationSet.empty) return;
  draw(view, DecorationSet.empty);
}

/** What is turned on right now, and available to be turned on at all. */
function wanted(): Drawing {
  const state = useProofing.getState();
  return {
    spelling: state.enabled && state.availability === "ready",
    grammar: state.grammar && state.grammarAvailability === "ready",
    ignored: state.ignored,
  };
}

/**
 * One check of whatever the checkers have not seen, and then a redraw.
 *
 * The decorations are built from `view.state.doc` after the awaits rather than from the document the
 * pass started on. By then the sequence number has already answered whether anything moved, so the
 * two agree; building from what is on screen is what makes that a fact about the code rather than a
 * fact about the timing.
 *
 * Spelling first and grammar after, rather than both at once. The two calls are cheap and the user
 * is typing while they run, so the useful thing is that the commoner of the two answers first and
 * its underlines land while the other is still being asked, not that the pair finishes a few
 * milliseconds sooner.
 */
async function pass(view: EditorView): Promise<void> {
  const seq = passSeq;
  const what = wanted();
  if (!what.spelling && !what.grammar) {
    clear(view);
    return;
  }

  const blocks = proseBlocks(view.state.doc);
  // A checker that is not there, which on a build without one is what the first call finds out,
  // ends its own half of the pass and says nothing. There is no toast: "this build cannot check
  // grammar" is what the availability question the store asks once per launch is for, and not
  // something worth repeating on every keystroke. The other checker's loop is untouched, which is
  // why each has its own catch rather than the pair sharing one, and the redraw below still happens
  // from whatever the two of them had already answered.
  if (what.spelling) {
    for (const run of runsOf(pending(spellCache, blocks))) {
      try {
        store(spellCache, run, await spellCheck(run.text));
      } catch {
        break;
      }
    }
  }
  if (what.grammar) {
    for (const run of runsOf(pending(grammarCache, blocks))) {
      try {
        store(grammarCache, run, await grammarCheck(run.text));
      } catch {
        break;
      }
    }
  }

  if (seq !== passSeq || view.isDestroyed) return;
  const current = proseBlocks(view.state.doc);
  draw(view, decorationsFor(view.state.doc, current, wanted()));
  prune(spellCache, current);
  prune(grammarCache, current);
}

/** Harper's half of a decoration's spec, and null for a spelling one. */
function grammarOf(value: unknown): ProofTarget["grammar"] {
  if (typeof value !== "object" || value === null) return null;
  const { kind, message } = value as { kind?: unknown; message?: unknown };
  return typeof kind === "string" && typeof message === "string" ? { kind, message } : null;
}

/**
 * Puts the menu over one underlined run of text, whichever of the three ways in found it.
 *
 * `fromKeyboard` is the only thing that separates a chord from a pointer once the word is known,
 * and the menu reads it to decide whether to take focus. A click has already put the caret where
 * the user wanted it, so a menu that took focus from that click would have broken the commoner half
 * of what clicking a word means; a chord has no other way of reaching the items it has just
 * offered.
 */
function openFor(view: EditorView, hit: Decoration, fromKeyboard: boolean): boolean {
  const spec = hit.spec as { word?: unknown; suggestions?: unknown; grammar?: unknown };
  if (typeof spec.word !== "string") return false;

  const start = view.coordsAtPos(hit.from);
  const end = view.coordsAtPos(hit.to);
  useProofing.getState().openMenu({
    from: hit.from,
    to: hit.to,
    word: spec.word,
    suggestions: (Array.isArray(spec.suggestions) ? (spec.suggestions as string[]) : []).slice(
      0,
      MAX_SUGGESTIONS,
    ),
    grammar: grammarOf(spec.grammar),
    left: (start.left + end.left) / 2,
    top: start.top,
    // A word that wraps across two lines ends on the lower one, which is where the menu belongs.
    bottom: Math.max(start.bottom, end.bottom),
    fromKeyboard,
  });
  return true;
}

/** The underlined text under a position, if the menu should open over it. */
function menuAt(view: EditorView, pos: number): boolean {
  // A document held open while a conflict is resolved is one nothing may edit, and a menu whose
  // every item is an edit has nothing to offer there. The underlines stay; the menu does not open.
  if (!view.editable) return false;
  const decorations = proofingKey.getState(view.state);
  if (!decorations) return false;
  const found = decorations.find(pos, pos);
  if (found.length === 0) return false;
  // A position at the seam between two words touches both, so hits that actually contain it win.
  // Among those, the shortest: a misspelled word inside a phrase Harper flagged carries both marks,
  // and a click on that word is about the word. The phrase is still one click away, on any of the
  // characters the word does not cover.
  const containing = found.filter((deco) => deco.from < pos && pos < deco.to);
  const hit = (containing.length > 0 ? containing : found).reduce((best, deco) =>
    deco.to - deco.from < best.to - best.from ? deco : best,
  );
  return openFor(view, hit, false);
}

/**
 * The same menu, opened by a chord instead of by a pointer, over the underlined text at the caret
 * or the nearest to it, of either kind.
 *
 * Nearest within the caret's own paragraph and no further. The menu is placed at the viewport
 * coordinates of the word it is about, so a search that ran to the end of the document would open a
 * menu somewhere off screen about a mistake the user cannot see, and correcting a word you are not
 * looking at is not what the key was pressed for. Inside a paragraph the distance is almost always
 * zero or a character or two: this is the word just typed, with the caret still sitting against its
 * end.
 *
 * False when there is nothing to offer, which is what the caller turns into a line of explanation.
 */
export function openSpellingMenu(): boolean {
  const view = activeView;
  if (!view || view.isDestroyed || !view.editable) return false;
  const decorations = proofingKey.getState(view.state);
  if (!decorations) return false;

  const $head = view.state.selection.$head;
  if (!$head.parent.isTextblock) return false;

  let best: Decoration | null = null;
  let nearest = Infinity;
  for (const deco of decorations.find($head.start(), $head.end())) {
    const gap = $head.pos < deco.from ? deco.from - $head.pos : Math.max($head.pos - deco.to, 0);
    // Strictly nearer, so a caret sitting exactly between two of them takes the earlier word,
    // which is the one it was most likely just finished typing.
    if (gap >= nearest) continue;
    best = deco;
    nearest = gap;
  }
  if (!best) return false;
  return openFor(view, best, true);
}

/**
 * The debounce, the store subscription and the one view a menu can act on, for as long as there is
 * an editor to act on.
 */
class Proofreader implements PluginView {
  private readonly view: EditorView;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(view: EditorView) {
    this.view = view;
    activeView = view;

    // Once per launch, whatever happens next: the store answers the second caller from what the
    // first one asked.
    useProofing.getState().ensureAvailable();

    this.unsubscribe = useProofing.subscribe((next, previous) => {
      // A learned word changes the answer for text nobody has touched, so it is the one thing that
      // throws away what a checker already said. Only the spelling half: Harper's own spell rule is
      // off (see src-tauri/src/grammar.rs), so the system dictionary growing a word cannot change a
      // single thing it said. Ignoring a word throws away nothing either way, since it is filtered
      // when the decorations are built and putting it back costs nothing.
      if (next.revision !== previous.revision) spellCache.clear();
      if (
        next.enabled === previous.enabled &&
        next.availability === previous.availability &&
        next.grammar === previous.grammar &&
        next.grammarAvailability === previous.grammarAvailability &&
        next.ignored === previous.ignored &&
        next.revision === previous.revision
      ) {
        return;
      }
      this.schedule(OPEN_MS);
    });

    this.schedule(OPEN_MS);
  }

  /** Abandons whatever is in flight on the way past, which is the other half of the stale guard. */
  private schedule(delay: number): void {
    passSeq += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void pass(this.view);
    }, delay);
  }

  update(view: EditorView, previous: EditorState): void {
    if (previous.doc === view.state.doc) return;
    // The menu's positions were taken from a document that has now moved, and the word it is offering
    // to correct may not be there at all.
    useProofing.getState().closeMenu();
    this.schedule(IDLE_MS);
  }

  destroy(): void {
    clearTimeout(this.timer);
    this.unsubscribe();
    passSeq += 1;
    if (activeView === this.view) activeView = null;
    useProofing.getState().closeMenu();
  }
}

/**
 * Puts a suggestion in place of the text the menu was opened over, a word for spelling and a phrase
 * for grammar.
 *
 * One transaction, so one undo takes it back, and refused outright unless that text is still exactly
 * where the menu said it was. The menu closes on every document change, so that check should never
 * fail; it is here because this is the one function in the file that can write to somebody's
 * document, and it is worth being unable to write to the wrong part of it.
 *
 * The one case where it refuses something a user meant is a grammar span reaching across an inline
 * code span. `blockText` blanked the code into spaces and the document has the code itself there, so
 * the two do not match and nothing is written. That is the right way round: a phrase Harper judged
 * without being shown the code in the middle of it is a phrase whose correction would have eaten the
 * code, and refusing costs a gesture where writing it would cost the line.
 *
 * No `fits` guard, unlike every insert in src/editor/Editor.tsx, and for the reason src/editor/
 * fits.test.ts gives the find bar's replace: this is text going into the one textblock it came out
 * of, not a node being placed somewhere it may not go. The range is inside a block that `proseBlocks`
 * already refused to send if it was code or raw, and a suggestion is a few words at most, so there
 * is no blank line in it for `holdsText` to be about.
 */
export function replaceSpelling(target: ProofTarget, suggestion: string): void {
  const view = activeView;
  if (!view || view.isDestroyed || !view.editable) return;
  const { from, to, word } = target;
  if (to > view.state.doc.content.size) return;
  if (view.state.doc.textBetween(from, to) !== word) return;

  const tr = view.state.tr.insertText(suggestion, from, to);
  tr.setSelection(TextSelection.create(tr.doc, from + suggestion.length));
  view.dispatch(tr);
  view.focus();
}

export const Proofing = Extension.create({
  name: "proofing",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: proofingKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const next = tr.getMeta(proofingKey) as DecorationSet | undefined;
            if (next) return next;
            // Mapped rather than rebuilt, so an underline stays on its word while the rest of the
            // paragraph is being typed instead of sliding along the line behind the caret.
            return tr.docChanged ? value.map(tr.mapping, tr.doc) : value;
          },
        },
        props: {
          decorations: (state) => proofingKey.getState(state) ?? DecorationSet.empty,

          // False either way: a click on a misspelled word opens the menu AND puts the caret where
          // it was clicked, which is what a click in text does everywhere else in the document.
          handleClick: (view, pos) => {
            menuAt(view, pos);
            return false;
          },

          handleDOMEvents: {
            contextmenu: (view, event) => {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at || !menuAt(view, at.pos)) return false;
              event.preventDefault();
              return true;
            },
          },
        },
        view: (view) => new Proofreader(view),
      }),
    ];
  },
});
