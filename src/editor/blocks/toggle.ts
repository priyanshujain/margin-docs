// Toggles: the `<details>` the bridge reads off disk, made into something that can be opened,
// closed and named.
//
// The schema keeps a toggle's summary and its open state as attributes rather than as child nodes,
// because a `<summary>` carrying markup is not modellable and a toggle whose body is content while
// its title is not would be half a node. That decision is what makes this file necessary. An
// attribute is not editable content, so without a node view three things happen and all of them are
// wrong: the browser's own disclosure takes the click and moves the element out of step with the
// node behind it, the `open` the document holds never changes and so never reaches the file, and a
// keystroke aimed at the title lands in the first paragraph of the body instead, which is somebody
// else's sentence quietly rewritten.
//
// So the element built below is the same `<details>` the schema's toDOM describes, and everything
// in it that is not the body is this file's own. ProseMirror is told as much through stopEvent and
// ignoreMutation: nothing outside the body is the document's, nothing typed in the title can be
// read back into the tree, and the two attributes move only through the two commands here.
//
// Native disclosure is cancelled rather than leant on. A `<details>` opens and closes itself on a
// click anywhere in its summary, and the element doing that on its own is the element disagreeing
// with the node, which is the half that gets saved. Cancelling the click is not the whole of it: a
// disclosure is a control, and the browser works one from the keyboard too, so a space or an Enter
// typed anywhere inside the summary arrives here as a click on the row with no press behind it.
// That was every other space in a title flipping the toggle and writing `open` into the file, so
// the flip below asks for a press, or for the row itself holding the keyboard, and takes nothing
// else as consent.
//
// The caret in a title is not in the document. ProseMirror's selection stays wherever it was when
// the caret went in there, so a toolbar button pressed while a title is being typed runs its
// command against a place the user is not looking at, which is somebody else's paragraph edited out
// of sight. A transaction that changes the document is therefore refused while a title holds the
// caret, bar the two this file's own surface makes, and the caret is put back where it was: the
// tools are inert while a title is being typed, which is what they would be if the pill drew them
// disabled. Drawing them disabled is the half of this that belongs to src/editor/Toolbar.tsx.
//
// And a toggle only ever sits among the document's own children. src/markdown/parse.ts pairs
// `<details>` at the top level of a file and nowhere else, so a toggle wrapped around a paragraph
// inside a quote goes to disk as a `<details>` inside a `>` block and comes back as one raw block:
// the bytes are kept, and both constructs stop being editable. An edit whose result this editor
// could not read back is refused rather than offered.
//
// Nothing here escapes anything. The summary attribute holds the title as plain text and the
// serializer turns `&`, `<` and `>` into entities on the way to disk, with the parser undoing
// exactly that on the way back; a node view that wrote markup into the attribute, or read the
// element back with innerHTML, would put an `&amp;` in a title that said `&` and grow another one
// on every save.

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import type { Command, EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view";

const NAME = "toggle";

/**
 * On the transactions the title and the arrow make, which are the two edits a caret sitting outside
 * the document is allowed to produce. A key rather than a string so that nothing else can spell it
 * by accident.
 */
const OWN_EDIT = new PluginKey<boolean>("toggleOwnEdit");

/**
 * The title the caret is in, or null when it is in the document like any other.
 *
 * Module level because a transaction is filtered against a state, and a state cannot be asked where
 * the caret is when the caret is not in the document. There is one editor and one document, per
 * src/editor/index.ts, and every answer taken from this is checked against the editor it came from
 * and against the page before it is acted on.
 */
let focused: ToggleView | null = null;

/** The toggle at this position, or null when the document has something else there. */
function toggleAt(state: EditorState, pos: number): ProseMirrorNode | null {
  const node = pos >= 0 && pos < state.doc.content.size ? state.doc.nodeAt(pos) : null;
  return node && node.type.name === NAME ? node : null;
}

function summaryOf(node: ProseMirrorNode): string {
  const value = node.attrs.summary;
  return typeof value === "string" ? value : "";
}

/**
 * Opens or closes the toggle at `pos`. False when there is no toggle there, or when it already
 * reads that way, which is what a second press of a control that is already in that state means.
 *
 * Closing takes the caret out of the body first. A closed `<details>` does not draw its children,
 * so a selection left in there is a caret nobody can see and every keystroke after it goes
 * somewhere invisible. It comes out into the same transaction as the close, so the two cannot be
 * undone separately. A toggle with nothing either side of it has nowhere to send it, and the node
 * view puts the focus in the title instead.
 */
export function setToggleOpen(pos: number, open: boolean): Command {
  return (state, dispatch) => {
    const node = toggleAt(state, pos);
    if (!node || node.attrs.open === open) return false;
    if (dispatch) {
      const end = pos + node.nodeSize;
      const tr = state.tr.setNodeMarkup(pos, null, { ...node.attrs, open });
      tr.setMeta(OWN_EDIT, true);
      if (!open && state.selection.from > pos && state.selection.from < end) {
        // findFrom rather than Selection.near, which falls back to searching the other way when it
        // finds nothing and would put the caret back inside the toggle that was just closed.
        const out =
          Selection.findFrom(tr.doc.resolve(end), 1) ?? Selection.findFrom(tr.doc.resolve(pos), -1);
        if (out) tr.setSelection(out);
      }
      dispatch(tr);
    }
    return true;
  };
}

/**
 * Writes the title of the toggle at `pos`, as the plain text it is on the node.
 *
 * One line, always: the parser reads the opening tag and the title as a two line html block, so a
 * newline in the middle of one is a toggle that comes back from disk as unmodellable source. The
 * node view keeps Enter and paste from putting one there rather than repairing it here, because a
 * title the user can see and the attribute cannot hold is the same disagreement one layer up.
 */
export function setToggleSummary(pos: number, summary: string): Command {
  return (state, dispatch) => {
    const node = toggleAt(state, pos);
    if (!node || summaryOf(node) === summary) return false;
    if (dispatch) {
      dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, summary }).setMeta(OWN_EDIT, true));
    }
    return true;
  };
}

/**
 * Whether this transaction puts a toggle anywhere but among the document's own children.
 *
 * Asked of the ranges the steps wrote rather than of the whole document, the way math.ts asks where
 * a formula ended up, so that the answer costs a keystroke nothing.
 *
 * Each range is then widened to the whole top level block it lands in, and that is the half this
 * needs rather than an optimisation given up. A wrap is a ReplaceAroundStep, and the only bytes it
 * rewrites are the two markers it puts either side of the content: the gap between them, which is
 * everything it moved a level deeper, is not in the step's map at all. So a toggle dragged over and
 * given to the Quote button went a level down inside a range that said nothing had happened to it,
 * and the file got a `<details>` inside a `>` block that the next open reads as one raw block.
 *
 * Widening is cheap because the widened range is the block the caret is in: a keystroke walks its
 * own paragraph. A toggle at the top level is visited at depth 0 and is the ordinary case, so
 * typing inside one costs a walk of it and nothing else.
 */
function nestsToggle(tr: Transaction): boolean {
  let found = false;

  for (let step = 0; step < tr.steps.length && !found; step += 1) {
    const forward = tr.mapping.slice(step + 1);
    tr.mapping.maps[step].forEach((_from, _to, newFrom, newTo) => {
      if (found) return;
      const size = tr.doc.content.size;
      const from = Math.min(size, Math.max(0, forward.map(newFrom, -1)));
      const to = Math.min(size, Math.max(from, forward.map(newTo, 1)));
      const $from = tr.doc.resolve(from);
      const $to = tr.doc.resolve(to);
      const start = $from.depth > 0 ? $from.before(1) : from;
      const end = $to.depth > 0 ? $to.after(1) : to;
      tr.doc.nodesBetween(start, end, (node, pos) => {
        if (found) return false;
        if (node.type.name === NAME) found = tr.doc.resolve(pos).depth > 0;
        return !found;
      });
    });
  }

  return found;
}

/**
 * The transactions a document is allowed to take, which is all of them bar two kinds of edit that
 * would land somewhere nobody aimed at.
 *
 * The first is anything but this file's own while a title holds the caret, for the reason at the
 * top: the selection those commands read is stale by then. The second is a toggle put anywhere the
 * bridge could not read one back from.
 *
 * Both answers are checked against the page and against the editor the transaction is for, so a
 * focus event that never got its blur, or a second editor that never existed, can cost this file a
 * refusal it should have made and never one it should not have. Letting an edit through is the
 * failure that is survivable.
 */
function allowTransaction(tr: Transaction, state: EditorState): boolean {
  if (!tr.docChanged) return true;
  if (nestsToggle(tr)) return false;
  if (focused === null || tr.getMeta(OWN_EDIT) === true) return true;
  if (!focused.isFor(state) || !focused.holdsCaret()) return true;
  focused.reclaim();
  return false;
}

/**
 * An edit that leaves the caret inside a collapsed toggle opens it.
 *
 * The toolbar's Toggle button is why this exists. Wrapping a block makes a toggle with the
 * attribute's own default, which is closed, so the paragraph the user just wrapped would vanish
 * behind an arrow and read as a deletion. The rule is more general than that one button though: a
 * closed toggle draws nothing of its body, and an edit that puts the caret somewhere the user
 * cannot see is an edit whose next keystroke disappears.
 *
 * Only for a transaction that changed the document, and that guard is load bearing rather than an
 * optimisation. A selection cannot walk into content the browser is not drawing on its own, and a
 * document being installed restores the caret it was last left at: a toggle opened by that would
 * be a byte written into a file nobody has edited.
 */
function openAroundSelection(
  transactions: readonly Transaction[],
  old: EditorState,
  state: EditorState,
): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged)) return null;
  // A title being typed into leaves the selection wherever it was, so the toggle around it is one
  // nobody is inside. Opening it would write `open` into the file for a keystroke aimed elsewhere.
  if (focused !== null && focused.isFor(old) && focused.holdsCaret()) return null;

  const { $from } = state.selection;
  let tr: Transaction | null = null;

  // Outwards, so a toggle inside a toggle opens along with the one holding it. setNodeMarkup keeps
  // a node the size it was, which is what lets these positions stay right across the whole walk.
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== NAME || node.attrs.open === true) continue;
    tr = (tr ?? state.tr).setNodeMarkup($from.before(depth), null, { ...node.attrs, open: true });
  }

  return tr;
}

/**
 * One toggle: the row that opens it and names it, and the body, which is the only part of it that
 * is the document.
 *
 * The title is an editable island. The summary row is declared not editable so that ProseMirror and
 * the browser both leave it alone, and the title inside it is declared editable again, which is
 * what makes a caret possible there without the text ever being content. Every keystroke in it is a
 * transaction like any other, for the reason math.ts gives about its own field: a title the element
 * is holding and the document is not is one an autosave writes the previous version of.
 */
class ToggleView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;

  private readonly summary: HTMLElement;
  private readonly title: HTMLElement;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private node: ProseMirrorNode;
  /** A press on the row waiting for the click it will become. */
  private pressed = false;

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    const owner = view.dom.ownerDocument;
    this.dom = owner.createElement("details");
    this.dom.className = "toggle";

    this.summary = owner.createElement("summary");
    this.summary.contentEditable = "false";

    this.title = owner.createElement("span");
    this.title.setAttribute("data-toggle-summary", "");
    this.summary.appendChild(this.title);

    this.contentDOM = owner.createElement("div");
    this.contentDOM.setAttribute("data-toggle-body", "");

    this.dom.append(this.summary, this.contentDOM);

    this.summary.addEventListener("mousedown", this.onMouseDown);
    this.summary.addEventListener("click", this.onClick);
    this.title.addEventListener("focus", this.onFocus);
    this.title.addEventListener("blur", this.onBlur);
    this.title.addEventListener("beforeinput", this.onBeforeInput);
    this.title.addEventListener("input", this.onInput);
    this.title.addEventListener("keydown", this.onKeyDown);
    this.title.addEventListener("paste", this.onPaste);

    this.draw();
  }

  update(next: ProseMirrorNode): boolean {
    if (next.type !== this.node.type) return false;
    this.node = next;
    this.draw();
    return true;
  }

  /**
   * The summary row is this file's, from the arrow to the title. ProseMirror seeing the mousedown
   * that puts the caret in the title would put a text selection in the body where the caret was
   * going, and the keydowns after it would run the document's commands against that selection.
   */
  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Node && this.summary.contains(target);
  }

  /** Nothing outside the body is the document's, so nothing read off it is news to the tree. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  /** Whether the editor this title is in is the one a transaction is being applied to. */
  isFor(state: EditorState): boolean {
    return this.view.state === state;
  }

  /**
   * Whether the caret really is in this title, asked of the page rather than of the flag that says
   * so. A focus event whose blur never came would otherwise refuse edits nobody was making.
   */
  holdsCaret(): boolean {
    const active = this.title.ownerDocument.activeElement;
    return active !== null && this.title.contains(active);
  }

  destroy(): void {
    if (focused === this) focused = null;
    this.summary.removeEventListener("mousedown", this.onMouseDown);
    this.summary.removeEventListener("click", this.onClick);
    this.title.removeEventListener("focus", this.onFocus);
    this.title.removeEventListener("blur", this.onBlur);
    this.title.removeEventListener("beforeinput", this.onBeforeInput);
    this.title.removeEventListener("input", this.onInput);
    this.title.removeEventListener("keydown", this.onKeyDown);
    this.title.removeEventListener("paste", this.onPaste);
  }

  /**
   * The caret back in the title, a frame from now, after a command was refused because it was in
   * there.
   *
   * A toolbar button keeps the caret where it is with a preventDefault on its own mousedown and
   * then asks the editor to focus, and TipTap's focus command queues that focus for the next frame.
   * It lands after the refusal, so without this the caret is dragged out of the title and into the
   * selection the refusal was there to protect, and the second press of the same button edits it.
   * The range is carried over by hand because focusing an element the caret has left does not put
   * it back where it was in the word being typed.
   */
  reclaim(): void {
    const owner = this.title.ownerDocument;
    const win = owner.defaultView;
    if (!win) return;

    const selection = owner.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const saved = range && this.title.contains(range.commonAncestorContainer) ? range.cloneRange() : null;

    win.requestAnimationFrame(() => {
      if (owner.activeElement === this.title) return;
      this.title.focus();
      if (!saved) return;
      const live = owner.getSelection();
      if (!live) return;
      live.removeAllRanges();
      live.addRange(saved);
    });
  }

  /** Everything on the element that comes off the node. */
  private draw(): void {
    const summary = summaryOf(this.node);

    // textContent rather than innerHTML: a title reading "<b>" is those three characters of
    // somebody's heading and not the start of a bold run. Written only when it differs, because
    // writing it while the caret is in it sends the caret to the end of a word being edited in the
    // middle.
    if (summary !== this.title.textContent) this.title.textContent = summary;
    // A browser leaves a <br> behind when the last character of an editable element goes, which is
    // a blank line standing where the placeholder should be.
    else if (summary === "" && this.title.firstChild) this.title.textContent = "";

    // An empty inline element is nothing to aim at, and a toggle made from the toolbar starts
    // without a title. What the prompt says is prose.css's, the way the callout labels are.
    this.title.toggleAttribute("data-empty", summary === "");

    // Only when it changes. draw runs on every keystroke in the title, and rewriting the attribute
    // that makes an element editable under a caret that is already in it is not something to ask a
    // browser to do sixty times a sentence.
    const editable = this.view.editable ? "true" : "false";
    if (this.title.contentEditable !== editable) this.title.contentEditable = editable;

    this.dom.toggleAttribute("open", this.node.attrs.open === true);
  }

  private readonly onFocus = (): void => {
    focused = this;
  };

  private readonly onBlur = (): void => {
    if (focused === this) focused = null;
  };

  /**
   * The arrow is the summary's own ::before, so a press that lands on the row itself rather than on
   * the title is a press on the chrome. Prevented so it neither focuses the row nor takes the caret
   * out of wherever it was in the document; the flip happens on the click, which is also what the
   * keyboard sends when the row itself has focus. Remembered, because a press is what tells that
   * click apart from the one the browser sends of its own accord.
   */
  private readonly onMouseDown = (event: MouseEvent): void => {
    this.pressed = event.target === this.summary;
    if (this.pressed) event.preventDefault();
  };

  /**
   * A click on the row flips it, when there is a press or a keyboard behind the click.
   *
   * The browser sends the summary a click of its own every time a space or an Enter is typed inside
   * it, because that is how a disclosure is activated from the keyboard, and the caret being in the
   * title makes no difference to it. Flipping on one of those closed the toggle under the caret on
   * every other space of a title and wrote the new `open` to the file each time.
   */
  private readonly onClick = (event: MouseEvent): void => {
    event.preventDefault();
    const pressed = this.pressed;
    this.pressed = false;
    if (event.target !== this.summary) return;
    if (pressed || this.title.ownerDocument.activeElement === this.summary) this.flip();
  };

  private flip(): void {
    const pos = this.getPos();
    // Opening and closing writes `open` to the file, so it is an edit and is refused for the same
    // reason typing is while a conflict is being resolved.
    if (pos === undefined || !this.view.editable) return;

    const open = this.node.attrs.open !== true;
    setToggleOpen(pos, open)(this.view.state, this.view.dispatch);
    // A toggle that is the whole document has nowhere outside itself to send the caret, so the
    // command left it where it was. The title is the one part of a closed toggle still on screen.
    if (!open && this.holdsSelection()) this.title.focus();
  }

  private holdsSelection(): boolean {
    const pos = this.getPos();
    if (pos === undefined) return false;
    const { from } = this.view.state.selection;
    return from > pos && from < pos + this.node.nodeSize;
  }

  /**
   * ProseMirror does not rebuild a node view when the editor stops being editable, so this is what
   * keeps the title out of a buffer that is not allowed to drift: a document waiting on a conflict
   * has already moved on disk, and nothing may be typed into it until the user has said which copy
   * wins. `commit` refuses as well, in case the browser declines to cancel the input.
   */
  private readonly onBeforeInput = (event: Event): void => {
    if (!this.view.editable) event.preventDefault();
  };

  private readonly onInput = (): void => {
    this.commit();
  };

  private commit(): void {
    const pos = this.getPos();
    if (pos === undefined || !this.view.editable) return;
    setToggleSummary(pos, this.title.textContent ?? "")(this.view.state, this.view.dispatch);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // A press on the row that never became a click is stale the moment something is typed, and the
    // click the browser sends on a space must not find it waiting.
    this.pressed = false;
    if (event.key !== "Enter" || event.isComposing) return;
    // A newline in a title is a toggle the bridge will not recognise the next time the file is
    // opened, so Enter leaves the title for the body, which is where the next thing typed belongs.
    event.preventDefault();
    this.enter();
  };

  private enter(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    setToggleOpen(pos, true)(this.view.state, this.view.dispatch);
    const { state } = this.view;
    const inside = Selection.findFrom(state.doc.resolve(Math.min(pos + 1, state.doc.content.size)), 1);
    if (inside) this.view.dispatch(state.tr.setSelection(inside));
    this.view.focus();
  }

  /**
   * A paste goes in as one line of plain text and nothing else.
   *
   * Left to itself the browser puts the clipboard's own markup in here, and a title holding a bold
   * run or a line break is a title whose text content, which is what reaches the attribute, is not
   * what is on screen. The two would disagree until the next save decided between them.
   */
  private readonly onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    if (!this.view.editable) return;

    const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\s*[\r\n]+\s*/g, " ");
    if (!text) return;

    const selection = this.title.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!this.title.contains(range.commonAncestorContainer)) return;

    range.deleteContents();
    const inserted = this.title.ownerDocument.createTextNode(text);
    range.insertNode(inserted);
    range.setStartAfter(inserted);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    this.commit();
  };
}

export const Toggles = Extension.create({
  name: "toggles",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("toggleViews"),
        props: {
          nodeViews: {
            toggle: (node, view, getPos) => new ToggleView(node, view, getPos),
          },
        },
        filterTransaction: allowTransaction,
        appendTransaction: openAroundSelection,
      }),
    ];
  },
});
