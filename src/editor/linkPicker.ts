// The `[[` picker: two brackets that write an ordinary relative markdown link.
//
// Typing `[` immediately after another `[` opens a list of the documents in every open root, and
// choosing one replaces the run from the first bracket to the caret with `[Title](../notes/x.md)`.
// The brackets are a gesture, not syntax, and nothing in this file can put `[[` into a file. A
// wikilink is a private spelling: a document this app writes has to open, and its links have to
// resolve, in every other markdown tool the folder is ever opened in, and `[[x]]` does neither.
// The href is `relativeFrom`'s answer and only ever `relativeFrom`'s answer, since that function is
// the one place in the app that decides what a link between two documents looks like on disk.
//
// The gesture is read, never driven. This plugin installs no `handleTextInput` and dispatches
// nothing at all while the user types: both brackets and every character of the query go into the
// document through the same ordinary path every other keystroke takes, and this file watches the
// transactions go past. Three things follow from that, and all three are the reason it is written
// this way.
//
// The brackets stay on screen exactly as typed, because nothing rewrites the text under the caret
// while somebody is still typing into it. Cancelling costs nothing and undoes nothing: the document
// already says what the user typed, so closing the picker is forgetting rather than editing, and
// somebody who wanted a literal `[[` in their prose gets to keep it by typing on. And there is no
// insert here to guard, so the only way this file can reach the document at all is the one
// transaction below.
//
// That transaction is the choice, and it is one transaction on purpose. It replaces the whole run
// in a single step and closes the history group in front of itself, so a single undo puts the user
// back with the brackets and the query they had typed, caret included, rather than half of them.
// Two transactions here would be two undos, and two undos is the difference between a feature
// people trust and one they fight.
//
// Where the guard is asked, and why it cannot be missed. `runOf` is the only function that says a
// run is open, and `apply` below is the only caller of it, on every transaction the editor makes.
// So a `[[` in a fence, in a raw block, in an inline code span or anywhere else the file cannot
// hold a link is not a picker that opens and then refuses at the end: it is a picker that never
// opens, and it stops being open the instant the block it is in stops being able to hold a link.
// `choose` asks the same question a second time before it writes, because the answer is what makes
// the write legal and a guard asked once at the start of a gesture is a guard that has not been
// asked at the end of it. This project has now shipped four guards that were correct and never
// reached, and every one of them was a check bolted to one path out of several.
//
// The popup hangs off the caret, is a child of the page body rather than of the document, and is
// therefore clipped by nothing: the scroller, the sheet and every callout, cell and quote in
// between have their own overflow and would each have cut a corner off it. It follows the caret
// while the pane scrolls and closes when the caret scrolls out of the pane, because a list of
// documents left hanging over a document that has moved out from under it is worse than no list.
//
// And when the index is not there, it says so. The Rust side answers `search_quick_open` with an
// error until it has been built, and `quickOpenError` is that error: it goes on screen as it came
// back. Showing an empty list instead would read as "no document matches what you typed", which is
// a different and false statement about the user's own folder.

import { Extension } from "@tiptap/core";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { MarkType } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { MatchRange } from "../ipc";
import { relativeFrom } from "../links";
import { useDocument } from "../store/useDocument";
import { useSearch } from "../store/useSearch";
import type { QuickOpenHit, QuickOpenPhase } from "../store/useSearch";
import { markable } from "./fits";

/** The gesture, and the single character of it that is watched for. */
const RUN = "[[";
const BRACKET = "[";

/**
 * What a query may not contain, which is the whole of "this run is over".
 *
 * A `]` is somebody closing the brackets themselves and is the explicit cancel. A third `[` starts
 * a new gesture rather than continuing this one. A newline means the caret has left the block the
 * run started in. The replacement character is what an atom between the brackets and the caret
 * reads as through `textBetween` below, and an inline formula or an image in the middle of a query
 * is not a query.
 */
const LEAF = "\ufffc";
const OVER = /[[\]\n\ufffc]/;

/**
 * Each keystroke crosses into SQLite through the store, so the index is asked once the typing
 * pauses rather than once per character. Short enough that a deliberate pause feels like an answer
 * rather than a wait.
 */
const DEBOUNCE = 120;

/** How far off the caret the popup sits, and how close to the window edge it may come. */
const GAP = 6;
const EDGE = 8;

/**
 * Ahead of every lane and behind src/editor/paste.ts.
 *
 * TipTap reverses the extension array and then sorts it by priority, so this number and not a
 * position in a list is what decides who is asked first. It has to be above the table lane's,
 * because prosemirror-tables claims ArrowUp and ArrowDown whenever the caret is on the first or
 * last line of a cell and moves to the next row with them: at the default priority a picker opened
 * inside a table cell would lose its arrow keys to the table on the very first press, which is the
 * one place a picker is most likely to be used. It stays below the clipboard guard's 1000, which
 * answers for the whole document and has to keep the front of the list.
 *
 * The other half of that decision is that this file claims no `handleTextInput`. It does not need
 * one, since it reads the transaction rather than the keystroke, and claiming one here would put it
 * in front of the table lane's typing guard, which src/editor/blocks/tables.test.ts pins as the
 * first plugin in the list that answers a typed character. That guard is what stops one keystroke
 * emptying every cell of a dragged rectangle, and being in front of it would be this file quietly
 * taking that answer away.
 */
const PRECEDENCE = 500;

/**
 * The document the links are written relative to, asked for rather than looked up.
 *
 * It defaults to the store, which is right in this app because there is one editor and one open
 * document, and it is an option so that the editor can hand over the document it is actually
 * showing instead. That is the stronger answer and is what src/editor/paste.ts is already given:
 * during a switch between files the store and the editor's own props agree only once React has
 * rendered, and an href worked out from the wrong end of that is a link to the wrong file written
 * into somebody's document.
 */
export type DocumentPath = () => string | null;

/**
 * An open run: where it starts, what has been typed into it, and the last answer the index gave.
 *
 * `from` is the position of the FIRST bracket, so the run the choice replaces is `from` to the
 * caret, brackets included. It is document state and is mapped through every transaction like any
 * other position.
 *
 * `answered` is the query `hits` are the answer to, which is not always the query on screen: a
 * keystroke moves the query on and the hits do not catch up until the debounce fires. Keeping the
 * two apart is what lets the popup show the previous answer rather than flashing empty between
 * every letter, and what tells "nothing matches" apart from "nothing has been asked yet".
 */
interface Run {
  from: number;
  query: string;
  answered: string | null;
  hits: readonly QuickOpenHit[];
  phase: QuickOpenPhase;
  error: string | null;
  active: number;
}

/**
 * What the popup and the keys tell the plugin state. Every one of them is a transaction with no
 * steps in it, which is deliberate: TipTap only emits `update` for a transaction that changed the
 * document, so opening, moving through and closing this list never dirties the buffer, never
 * schedules a save and never enters the undo history.
 */
type Message =
  | { kind: "close" }
  | { kind: "results"; query: string; hits: QuickOpenHit[]; phase: QuickOpenPhase; error: string | null }
  | { kind: "move"; by: number }
  | { kind: "point"; at: number };

const key = new PluginKey<Run | null>("linkPicker");

/**
 * Whether a link can exist where the selection is.
 *
 * `markable` is the codebase's own question and answers for the two blocks whose bytes belong to
 * the file: a fence and a raw block both declare `marks: ""`, so a link in either is a mark the
 * schema throws away while the text it was meant to be on stays behind.
 *
 * The code span is the case `markable` deliberately says yes to, because `[`x`](y)` is valid
 * markdown and the Link tool is allowed to make one. It is still not what somebody typing brackets
 * inside backticks meant: `[[` in a code span is on screen as itself, which is the only reason to
 * write it there. So the picker declines, and the characters stay literal.
 */
function linkable(state: EditorState, link: MarkType): boolean {
  if (!markable(state, link)) return false;
  const code = state.schema.marks.code;
  if (!code) return true;
  return !code.isInSet(state.storedMarks ?? state.selection.$from.marks());
}

/** The character just before `pos` in its own block, or "" at the start of one. */
function charBefore(state: EditorState, pos: number): string {
  if (pos < 1 || pos > state.doc.content.size) return "";
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parentOffset < 1) return "";
  return $pos.parent.textBetween($pos.parentOffset - 1, $pos.parentOffset, "\n", LEAF);
}

/**
 * The query in the run that starts at `from`, or null when there is no longer a run there.
 *
 * The single definition of "the picker is open", asked on every transaction, so every way of
 * leaving a run ends up here rather than needing a handler of its own: an arrow key or a click out
 * of it, a selection dragged across it, a Backspace through the brackets, the block turned into a
 * fence by the toolbar, a `]` typed at the end. All of them fail one of these lines.
 *
 * `textBetween` is given the replacement character for leaves so that an atom sitting in the run
 * shows up in the query and is rejected by `OVER`. Left to its default, an inline formula between
 * the brackets and the caret would read as nothing at all and the run would look perfectly healthy.
 */
function runOf(state: EditorState, from: number): string | null {
  const link = state.schema.marks.link;
  if (!link || !linkable(state, link)) return null;

  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  if (from < 0 || from + RUN.length > state.doc.content.size) return null;

  const $from = state.doc.resolve(from);
  const $head = selection.$head;
  if (!$from.sameParent($head)) return null;

  const parent = $from.parent;
  const start = $from.parentOffset;
  const end = $head.parentOffset;
  if (end < start + RUN.length) return null;

  const text = parent.textBetween(start, end, "\n", LEAF);
  if (!text.startsWith(RUN)) return null;

  const query = text.slice(RUN.length);
  return OVER.test(query) ? null : query;
}

/**
 * Where a run just opened, or null when this transaction was not the gesture.
 *
 * The description is of the document rather than of the steps, because the shape of the steps a
 * typed character produces is prosemirror-view's business and changes with it. What does not
 * change is this: one character went into the document, it went in exactly where the caret was, the
 * caret moved on by it, and what stands in front of the caret now is two brackets where there was
 * one before. That is the gesture and nothing else is.
 *
 * The mapping line is the one that is not obvious. A single character inserted anywhere earlier in
 * the document also moves the caret on by one and leaves the text around it unchanged, so the four
 * other tests pass for an edit the user did not make and was not looking at. Mapped with a bias
 * towards the left, a position sitting at an insertion point stays put and a position after one
 * moves, which is what proves the character landed under the caret and not somewhere above it.
 *
 * A paste, a drop and an undo are all excluded. Each of them can put a bracket after a bracket, and
 * none of them is somebody typing.
 */
function opened(tr: Transaction, old: EditorState, next: EditorState): number | null {
  if (!tr.docChanged || isHistoryTransaction(tr)) return null;
  const event = tr.getMeta("uiEvent");
  if (event === "paste" || event === "drop" || event === "cut") return null;
  if (next.doc.content.size - old.doc.content.size !== 1) return null;

  const was = old.selection;
  const now = next.selection;
  if (!(was instanceof TextSelection) || !was.empty) return null;
  if (!(now instanceof TextSelection) || !now.empty) return null;
  if (now.head !== was.head + 1) return null;
  if (tr.mapping.map(was.head, -1) !== was.head) return null;

  if (charBefore(old, was.head) !== BRACKET) return null;
  if (charBefore(next, now.head) !== BRACKET) return null;

  const from = now.head - RUN.length;
  return runOf(next, from) === "" ? from : null;
}

/** The run carried through one transaction, or null when it did not survive it. */
function carried(tr: Transaction, prev: Run, next: EditorState, message: Message | undefined): Run | null {
  const from = tr.mapping.map(prev.from, -1);
  const query = runOf(next, from);
  if (query === null) return null;

  let run: Run = prev.from === from && prev.query === query ? prev : { ...prev, from, query };
  // A query that has moved on has no answer yet. The hits stay so the list does not flash empty
  // between letters, except when there is no query left to have hits for.
  if (query !== prev.query) {
    run = query === "" ? { ...run, answered: null, hits: [], phase: "idle", error: null, active: 0 } : run;
  }

  if (message?.kind === "results" && message.query === query) {
    return {
      ...run,
      answered: message.query,
      hits: message.hits,
      phase: message.phase,
      error: message.error,
      active: 0,
    };
  }
  if (message?.kind === "move" && run.hits.length > 0) {
    const count = run.hits.length;
    return { ...run, active: (run.active + message.by + count) % count };
  }
  if (message?.kind === "point" && message.at >= 0 && message.at < run.hits.length) {
    return { ...run, active: message.at };
  }
  return run;
}

/** The link text: the document's filename with its extension taken off. */
function labelOf(hit: QuickOpenHit): string {
  const name = hit.name;
  const dot = name.lastIndexOf(".");
  // A leading dot is not an extension, so a file called `.notes` keeps its whole name.
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.trim() === "" ? name : stem;
}

function close(view: EditorView): void {
  if (!key.getState(view.state)) return;
  view.dispatch(view.state.tr.setMeta(key, { kind: "close" } satisfies Message));
}

function move(view: EditorView, by: number): void {
  view.dispatch(view.state.tr.setMeta(key, { kind: "move", by } satisfies Message));
}

/**
 * The one transaction this file builds: the run replaced by the link, in a single step.
 *
 * The marks are the ones the brackets themselves were typed in, so a `[[` inside a bold run comes
 * out of this as a bold link rather than losing the emphasis around it. The link mark is added to
 * that set rather than replacing it, and a link mark already there is replaced by this one, which
 * is what a picker used inside existing link text should do.
 *
 * False when there is nothing legal to write, and false rather than a refusal on screen: the key
 * that got here was Enter, and an Enter this file does not use has to still make a paragraph.
 */
function choose(view: EditorView, hit: QuickOpenHit, documentPath: DocumentPath): boolean {
  const state = view.state;
  const run = key.getState(state);
  if (!run) return false;

  const from = documentPath();
  // No open document means nothing to be relative to, and an href worked out from nothing is a
  // link that points at the wrong file rather than at no file.
  if (from === null) return false;

  const link = state.schema.marks.link;
  if (!link || !linkable(state, link)) return false;

  const text = labelOf(hit);
  if (text === "") return false;

  const head = state.selection.head;
  const carriedMarks = state.doc.resolve(run.from + 1).marks();
  const marks = link.create({ href: relativeFrom(from, hit.path), title: null }).addToSet(carriedMarks);

  const tr = state.tr.replaceWith(run.from, head, state.schema.text(text, marks));
  tr.setSelection(TextSelection.create(tr.doc, run.from + text.length));
  tr.setMeta(key, { kind: "close" } satisfies Message);
  // The link is its own undo event. Left to group with the characters of the query it was typed
  // over, one Ctrl+Z would take the link and the last letter of the query with it and the user
  // would be looking at a run they never typed.
  closeHistory(tr);
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** What the popup says when it has no rows to show, or null when the rows speak for themselves. */
function noteOf(run: Run): string | null {
  if (run.phase === "error") return run.error ?? "The search index could not be read";
  if (run.query === "") return "Type to find a document";
  if (run.hits.length > 0) return null;
  return run.answered === run.query ? "No documents match" : "Searching…";
}

/**
 * The matched part of a path, marked up without any markup: the ranges are offsets into a string
 * that came off the user's disk, and building this with innerHTML would put a filename through the
 * HTML parser.
 */
function paintPath(el: HTMLElement, text: string, ranges: readonly MatchRange[]): void {
  el.textContent = "";
  let at = 0;
  for (const range of ranges) {
    const start = Math.max(at, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > at) el.append(text.slice(at, start));
    if (end > start) {
      const hit = el.ownerDocument.createElement("span");
      hit.className = "link-picker-hit";
      hit.textContent = text.slice(start, end);
      el.append(hit);
    }
    at = end;
  }
  if (at < text.length) el.append(text.slice(at));
}

/**
 * The list on screen, and the only thing in this file that asks the index anything.
 *
 * It owns the debounce and the request, and it hands the answer back to the document as a message
 * rather than keeping it: the keys need to know how many rows there are to decide whether Enter is
 * theirs, and a second copy of that in here would be a second thing to keep in step.
 *
 * Nothing in `update` may dispatch, since it runs inside the state update that produced it. The
 * request that carries a result back is on a timer and is therefore always a later tick, and the
 * one case that could have answered immediately, an empty query, is answered by drawing rather
 * than by a message.
 */
class Popup {
  private readonly view: EditorView;
  private readonly documentPath: DocumentPath;
  /**
   * The window the editor is in, rather than the ambient global one. The popup is a child of that
   * window's body and its listeners have to come off the same object they went on to.
   */
  private readonly frame: Window | null;
  private readonly dom: HTMLElement;
  private readonly note: HTMLElement;
  private readonly list: HTMLElement;
  private rows: HTMLElement[] = [];
  private drawn: readonly QuickOpenHit[] | null = null;
  private mounted = false;
  private requested: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(view: EditorView, documentPath: DocumentPath) {
    this.view = view;
    this.documentPath = documentPath;
    const owner = view.dom.ownerDocument;
    this.frame = owner.defaultView;

    this.dom = owner.createElement("div");
    this.dom.className = "link-picker";
    this.dom.setAttribute("data-flip", "down");

    this.note = owner.createElement("div");
    this.note.className = "link-picker-note";
    this.note.setAttribute("aria-live", "polite");
    this.dom.appendChild(this.note);

    this.list = owner.createElement("div");
    this.list.className = "link-picker-list";
    this.list.setAttribute("role", "listbox");
    this.dom.appendChild(this.list);

    // Everything the pointer does in here is the popup's own. A mousedown that reached the page
    // would take focus off the document, and the blur that follows closes the picker, so the click
    // that chose a document would have cancelled it a moment before choosing.
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
  }

  update(): void {
    const run = key.getState(this.view.state);
    if (!run) {
      this.hide();
      return;
    }
    if (run.query !== this.requested) this.ask(run.query);
    this.show();
    this.draw(run);
    this.place();
  }

  destroy(): void {
    this.hide();
  }

  private show(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.view.dom.ownerDocument.body.appendChild(this.dom);
    // Capture, because the pane that scrolls under the caret is not the window and a scroll event
    // on an element does not bubble up to one.
    this.frame?.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    this.frame?.addEventListener("resize", this.onScroll, { passive: true });
  }

  private hide(): void {
    if (!this.mounted) return;
    this.mounted = false;
    if (this.timer !== null) clearTimeout(this.timer);
    // Any answer still on its way belongs to a run that is over, and this is what tells it so.
    this.seq += 1;
    this.requested = null;
    this.dom.remove();
    this.frame?.removeEventListener("scroll", this.onScroll, { capture: true });
    this.frame?.removeEventListener("resize", this.onScroll);
  }

  private ask(query: string): void {
    this.requested = query;
    if (this.timer !== null) clearTimeout(this.timer);
    const seq = (this.seq += 1);
    if (query === "") return;
    this.timer = setTimeout(() => {
      // `runQuickOpen` has a sequence guard of its own, so a slow answer to a short query never
      // lands on top of a fast answer to a long one. This counter is the other half of the same
      // question and cannot be folded into it: it is about whether the run this popup is drawing
      // still wants an answer at all.
      useSearch
        .getState()
        .runQuickOpen(query)
        .then(
          () => {
            if (seq !== this.seq) return;
            const search = useSearch.getState();
            this.answer(query, search.quickOpenHits, search.quickOpenPhase, search.quickOpenError);
          },
          (error: unknown) => {
            if (seq !== this.seq) return;
            this.answer(query, [], "error", String(error));
          },
        );
    }, DEBOUNCE);
  }

  private answer(
    query: string,
    hits: QuickOpenHit[],
    phase: QuickOpenPhase,
    error: string | null,
  ): void {
    const run = key.getState(this.view.state);
    if (!run || run.query !== query) return;
    this.view.dispatch(
      this.view.state.tr.setMeta(key, { kind: "results", query, hits, phase, error } satisfies Message),
    );
  }

  private draw(run: Run): void {
    if (run.hits !== this.drawn) {
      this.drawn = run.hits;
      this.rebuild(run.hits);
    }
    this.rows.forEach((row, index) => {
      const on = index === run.active;
      row.toggleAttribute("data-active", on);
      row.setAttribute("aria-selected", String(on));
    });
    const active = this.rows[run.active];
    if (active) this.reveal(active);

    const note = noteOf(run);
    this.note.textContent = note ?? "";
    this.note.hidden = note === null;
    this.note.toggleAttribute("data-error", run.phase === "error");
  }

  private rebuild(hits: readonly QuickOpenHit[]): void {
    const owner = this.dom.ownerDocument;
    this.list.textContent = "";
    this.rows = hits.map((hit, index) => {
      const row = owner.createElement("div");
      row.className = "link-picker-row";
      row.setAttribute("role", "option");

      const name = owner.createElement("span");
      name.className = "link-picker-name";
      name.textContent = labelOf(hit);
      row.appendChild(name);

      const path = owner.createElement("span");
      path.className = "link-picker-path";
      paintPath(path, hit.relPath, hit.ranges);
      row.appendChild(path);

      row.addEventListener("mousedown", () => {
        if (!choose(this.view, hit, this.documentPath)) close(this.view);
      });
      row.addEventListener("mouseenter", () => {
        this.view.dispatch(this.view.state.tr.setMeta(key, { kind: "point", at: index } satisfies Message));
      });

      this.list.appendChild(row);
      return row;
    });
    this.list.scrollTop = 0;
  }

  /** The active row brought into the list's own scroll, and never into the page's. */
  private reveal(row: HTMLElement): void {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (bottom > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = bottom - this.list.clientHeight;
    }
  }

  /**
   * Where the caret is on screen, or null when it is not on screen at all.
   *
   * A closed toggle keeps its body in the page with display none, and a run left open inside one
   * is a position ProseMirror cannot measure. It throws when asked, and a throw out of `update`
   * comes out of the middle of a state update, which is the view and the document disagreeing
   * about what the file says.
   */
  private caret(): { top: number; bottom: number; left: number } | null {
    try {
      return this.view.coordsAtPos(this.view.state.selection.head);
    } catch {
      return null;
    }
  }

  private place(): void {
    const frame = this.frame;
    const caret = this.caret();
    if (!frame || !caret) return;
    const box = this.dom.getBoundingClientRect();

    const below = frame.innerHeight - caret.bottom;
    const up = below < box.height + GAP * 2 && caret.top > box.height + GAP;
    const top = up ? caret.top - box.height - GAP : caret.bottom + GAP;
    const left = Math.max(EDGE, Math.min(caret.left, frame.innerWidth - box.width - EDGE));

    this.dom.setAttribute("data-flip", up ? "up" : "down");
    this.dom.style.top = `${Math.round(top)}px`;
    this.dom.style.left = `${Math.round(left)}px`;
  }

  /**
   * A scroll moves the popup with the caret, and takes the picker away entirely once the caret has
   * left the pane. Closing is done from here rather than from `update`, which cannot dispatch: a
   * scroll event is its own tick and a transaction is safe in it.
   */
  private readonly onScroll = (): void => {
    if (!this.mounted) return;
    const pane = this.view.dom.closest(".editor-pane");
    const caret = this.caret();
    if (pane && caret) {
      const bounds = pane.getBoundingClientRect();
      if (caret.bottom < bounds.top || caret.top > bounds.bottom) {
        close(this.view);
        return;
      }
    }
    this.place();
  };
}

function picker(documentPath: DocumentPath): Plugin<Run | null> {
  return new Plugin<Run | null>({
    key,

    state: {
      init: () => null,

      apply(tr, prev, old, next) {
        const message = tr.getMeta(key) as Message | undefined;
        if (message?.kind === "close") return null;

        // A run that did not survive this transaction still lets the same transaction open a new
        // one, which is what a third bracket on the end of `[[` is: the run it broke is over and
        // the gesture it made is a fresh one.
        const held = prev === null ? null : carried(tr, prev, next, message);
        if (held) return held;

        const from = opened(tr, old, next);
        if (from === null) return null;
        return { from, query: "", answered: null, hits: [], phase: "idle", error: null, active: 0 };
      },
    },

    props: {
      handleKeyDown(view, event) {
        if (event.isComposing) return false;
        const run = key.getState(view.state);
        if (!run) return false;

        if (event.key === "Escape") {
          close(view);
          return true;
        }

        // Everything else is taken only when there is a row to take it for. A picker open over a
        // query nothing answers is a picker in the way, and Enter in the middle of a paragraph has
        // to still make a paragraph.
        if (run.hits.length === 0) return false;

        if (event.key === "ArrowDown") {
          move(view, 1);
          return true;
        }
        if (event.key === "ArrowUp") {
          move(view, -1);
          return true;
        }
        if (event.key === "Enter") {
          // A modifier on Enter is somebody asking for something else, and this list has nothing to
          // say about what.
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
          const hit = run.hits[run.active];
          if (hit && choose(view, hit, documentPath)) return true;
          close(view);
          return false;
        }
        return false;
      },

      handleDOMEvents: {
        // The caret is still in the run, but the user is somewhere else: a palette, a dialog,
        // another window. Both halves of the picker are wrong then, since the list is drawn over a
        // document nobody is typing in and the store it reads from is about to be answering
        // somebody else's query.
        blur(view) {
          close(view);
          return false;
        },
      },
    },

    view: (view) => new Popup(view, documentPath),
  });
}

export interface LinkPickerOptions {
  documentPath: DocumentPath;
}

export const LinkPicker = Extension.create<LinkPickerOptions>({
  name: "linkPicker",
  priority: PRECEDENCE,

  addOptions() {
    return { documentPath: () => useDocument.getState().path };
  },

  addProseMirrorPlugins() {
    return [picker(this.options.documentPath)];
  },
});
