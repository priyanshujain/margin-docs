// Math: KaTeX over the mathInline and mathBlock nodes the bridge produces.
//
// Both are atoms carrying their LaTeX as an attribute, so rendering one is a node view drawing an
// attribute and editing one is that same node view handing the source back. Nothing here parses,
// normalises or rewrites the LaTeX: what round trips to disk is the attribute exactly as it was
// read, and KaTeX only ever gets a copy of it.
//
// LaTeX KaTeX cannot render is shown as the source with the error beside it, never as an empty
// box and never dropped. A formula this editor fails to draw is still the user's formula, and it
// has to survive being opened and saved by an editor that could not display it.
//
// An atom has no editable text of its own, so the field the source is typed into is this file's to
// draw and this file's to write back. It appears while the node is selected, which is what both a
// click on a formula and an arrow key into one produce, and every keystroke in it is a transaction
// like any other. The document is therefore never holding a formula the field has already moved
// past: an autosave that lands mid edit writes what is on screen, and closing the file does not
// take the last few characters with it.

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import type { Command, Transaction } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import katex from "katex";
import { place } from "../fits";

// KaTeX's stylesheet, and the twenty faces it names, are pulled into the bundle from here rather
// than from main.tsx alongside the app's own sheets, because this is the file that cannot work
// without them. The app runs under a CSP of font-src 'self', so a font fetched from KaTeX's CDN
// never arrives and every formula is drawn in a fallback face at metrics the layout was not
// measured for. Importing the sheet is what makes Vite emit the woff2 files as local assets and
// rewrite the URLs on to them, so this import is load bearing and is not a stray dependency.
import "katex/dist/katex.min.css";

/** A paragraph holding exactly this becomes a math block when Enter is pressed in it. */
const FENCE = "$$";

/**
 * What a new formula is made with, since a new formula is never made empty.
 *
 * An empty formula is a box on screen that the file has no way to spell. Inline, it goes out as
 * `$$$$`, which is not math to anything that reads it back, so the box the user is looking at is
 * gone the next time the document is opened and they were never told. That is the failure this
 * editor exists not to have: something on screen that the save quietly does not keep.
 *
 * Three ways out of it were on the table. Refusing to insert until there is content cannot work,
 * because the insert is how the content gets typed. Keeping the node out of the saved document
 * until it has LaTeX is the same disappearance one layer down, since an autosave then writes a file
 * without a formula the user can see. So the node is created with content: `\square` is the glyph
 * mathematics already uses for the term that has not been written yet, KaTeX draws it, and it round
 * trips as `$$\square$$` like any other formula. Nothing vanishes, because there is nothing empty.
 *
 * The field opens with it selected, so typing over it is the same keystroke it would have been in
 * an empty box, and the user who walks away is left with a formula they can see rather than one
 * they cannot.
 */
const PLACEHOLDER = "\\square";

/** Past these the field scrolls rather than growing. A formula this long is not being read. */
const MAX_ROWS = 16;
const MAX_COLS = 64;
const MIN_COLS = 4;

/**
 * KaTeX is never allowed to throw, and never allowed to be the reason a formula is not on screen.
 *
 * `throwOnError` false is what turns a parse failure into markup: KaTeX draws the source it could
 * not read in the error colour with the reason on the element's title, which is the whole of the
 * error state for LaTeX it understands well enough to refuse. `strict` false is the same bargain
 * one level down, for the LaTeX it can read and would rather complain about, a unicode letter in
 * math mode being the usual one; the alternative is a console full of warnings about somebody's
 * own file. `trust` stays off because the markup goes into the page with innerHTML, and it is what
 * decides whether \href in a document that arrived from somewhere else becomes a link.
 *
 * The error colour is a custom property rather than a hex value because KaTeX writes it into a
 * style attribute on the element it draws, and an inline style is not something a stylesheet can
 * take back.
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  strict: false,
  trust: false,
  errorColor: "var(--danger)",
} as const;

/**
 * Where a node of this type ended up, looked for in the ranges the steps from `since` on wrote.
 *
 * Asked this way rather than by mapping the insertion point forward, which is the obvious move and
 * is wrong. A block formula dropped into the middle of a paragraph splits it, and the position it
 * was asked for stays with the first half, several places short of the formula. Mapping it forward
 * then finds no formula there and nothing gets selected, which is a formula on screen with no way
 * into its field. The end of a paragraph is the one place the two answers agree, which is why
 * every test that put the caret there passed.
 */
function placedAt(tr: Transaction, since: number, type: NodeType): number | null {
  let found: number | null = null;

  for (let step = since; step < tr.steps.length && found === null; step += 1) {
    const forward = tr.mapping.slice(step + 1);
    tr.mapping.maps[step].forEach((_from, _to, newFrom, newTo) => {
      if (found !== null) return;
      const size = tr.doc.content.size;
      const from = Math.min(size, Math.max(0, forward.map(newFrom, -1)));
      const to = Math.min(size, Math.max(from, forward.map(newTo, 1)));
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (found === null && node.type === type) found = pos;
        return found === null;
      });
    });
  }

  return found;
}

/**
 * A placeholder formula where the cursor is, selected so that its field opens on it.
 *
 * Whether it can go there at all is `place`'s question and is asked before this runs, which is why
 * there is no check of its own here. There used to be one, a private copy of the walk in fits.ts
 * that had never been given the isolating rule, and it answered yes with the caret in a table cell:
 * the insert then split the table around the formula and emptied the row it had been in, and the
 * autosave wrote that to the user's file half a second later with no keystroke behind it.
 */
function placeMath(type: NodeType): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const tr = state.tr;
      const before = tr.steps.length;
      // Marks carry on to an inline formula, since **$x$** is a thing the file can say and the
      // bridge already reads and writes. A block one is in a part of the document where no mark
      // can go, and handing it the marks under the cursor would make it unplaceable.
      tr.replaceSelectionWith(type.create({ latex: PLACEHOLDER }), type.isInline);
      // Selecting it is what opens its field, on the placeholder, which the field selects whole so
      // the first thing typed replaces it.
      const placed = placedAt(tr, before, type);
      if (placed !== null) tr.setSelection(NodeSelection.create(tr.doc, placed));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * `$$` alone in a paragraph, then Enter.
 *
 * Not an input rule, though it reads like one: an input rule fires on text input and Enter is not
 * text, so there would be nothing to run it. There is deliberately no rule for `$…$` either. A
 * dollar sign is money or a shell prompt far more often than it is mathematics, and turning
 * "$5 and $10" into an equation as somebody types is exactly the unasked for rewrite this editor
 * does not do. The bridge takes the same line one layer down, where single dollar math is off in
 * the parser.
 */
const openMathBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parent.type.name !== "paragraph" || $from.parent.textContent !== FENCE) return false;

  const type = state.schema.nodes.mathBlock;
  const depth = $from.depth;
  const index = $from.index(depth - 1);
  if (!type || !$from.node(depth - 1).canReplaceWith(index, index + 1, type)) return false;

  if (dispatch) {
    const from = $from.before(depth);
    // The placeholder, for the reason written on it: this is the other way a formula is made, and
    // a formula made by typing a fence has the same claim to still being there after a save as one
    // made from the toolbar.
    const tr = state.tr.replaceWith(from, $from.after(depth), type.create({ latex: PLACEHOLDER }));
    tr.setSelection(NodeSelection.create(tr.doc, from));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * One formula: what KaTeX drew, and the field the LaTeX behind it is typed into.
 *
 * The two are siblings inside the element the node's own toDOM describes, and which of them is on
 * screen is a data attribute the stylesheet reads. Neither is content in ProseMirror's sense: the
 * node is an atom, there is no contentDOM, and every mutation inside here is declared to be this
 * file's own so that nothing KaTeX draws can be read back into the document.
 */
class MathView implements NodeView {
  readonly dom: HTMLElement;

  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private readonly display: boolean;
  private readonly render: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private node: ProseMirrorNode;
  private editing = false;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    display: boolean,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.display = display;

    const owner = view.dom.ownerDocument;
    this.dom = owner.createElement(display ? "div" : "span");
    this.dom.className = display ? "math-block" : "math-inline";
    if (display) this.dom.setAttribute("data-math-block", "");

    this.render = owner.createElement(display ? "div" : "span");
    this.render.className = "math-render";
    this.dom.appendChild(this.render);

    this.field = owner.createElement("textarea");
    this.field.className = "math-source";
    this.field.spellcheck = false;
    this.field.setAttribute("aria-label", display ? "Display equation source" : "Inline math source");
    this.field.addEventListener("input", this.onInput);
    this.field.addEventListener("keydown", this.onKeyDown);
    this.dom.appendChild(this.field);

    this.draw();
  }

  private get latex(): string {
    const value = this.node.attrs.latex;
    return typeof value === "string" ? value : "";
  }

  update(node: ProseMirrorNode): boolean {
    // A node of another type is another node view; ProseMirror builds a fresh one rather than
    // asking this one to become something it was not written to be.
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.draw();
    return true;
  }

  selectNode(): void {
    // A document being looked at rather than edited gets no field, so it gets the outline
    // ProseMirror would have drawn on its own: it says the formula is selected without offering to
    // change it. Node views that define this one are asked instead of that outline, not as well.
    if (!this.view.editable) {
      this.dom.classList.add("ProseMirror-selectednode");
      return;
    }
    if (this.editing) return;
    this.editing = true;
    this.draw();
    this.take();
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
    if (!this.editing) return;
    this.editing = false;
    this.draw();
  }

  /**
   * Everything that lands inside the field is the field's own. ProseMirror handling the mousedown
   * that opens it would put a node selection where the caret was going, and the field would never
   * take focus at all.
   */
  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof HTMLElement && this.field.contains(target);
  }

  /** The element is this file's from end to end, so nothing read off it is news to the document. */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    // Also what cancels the frame `take` queued: the element is on its way out, and focusing it
    // then would put the caret at a position the document no longer has.
    this.editing = false;
    this.field.removeEventListener("input", this.onInput);
    this.field.removeEventListener("keydown", this.onKeyDown);
  }

  /** Everything on the element that depends on the node or on whether it is being edited. */
  private draw(): void {
    const latex = this.latex;
    // Mirrored on to the element the way the node's own toDOM writes it, so that anything reading
    // the page back, a copy, a drag, a mutation ProseMirror decides to re-parse after all, takes
    // the source out of the attribute the parse rule names rather than out of what KaTeX drew.
    this.dom.setAttribute("data-latex", latex);
    // The empty string and nothing else, because this flag is what tells the user the formula has
    // no spelling and will not be saved, and a formula of one space is saved: the writer drops an
    // equation only when its latex is empty. `paint` below asks a different question, which is
    // whether KaTeX has anything to draw, and whitespace is a fair no to that one.
    this.flag("data-math-empty", latex === "");
    this.flag("data-editing", this.editing);
    // The field is the source of truth while it is being typed in. Writing to it here would take
    // the caret to the end of a formula the user is in the middle of.
    if (!this.editing) {
      this.field.value = latex;
      this.size();
    }
    this.paint(latex);
  }

  private flag(name: string, on: boolean): void {
    if (on) this.dom.setAttribute(name, "");
    else this.dom.removeAttribute(name);
  }

  private paint(latex: string): void {
    if (latex.trim() === "") {
      this.render.textContent = "";
      this.render.removeAttribute("data-math-error");
      this.render.removeAttribute("title");
      return;
    }
    try {
      this.render.innerHTML = katex.renderToString(latex, {
        ...KATEX_OPTIONS,
        displayMode: this.display,
      });
      this.render.removeAttribute("data-math-error");
      this.render.removeAttribute("title");
    } catch (error) {
      // throwOnError covers the LaTeX KaTeX parses and then refuses to typeset. This is the rest of
      // it: input it never expected, on which it throws something that is not a parse error. What
      // goes on the page is the source as it stands, because that is what the file holds and what
      // there is to fix.
      this.render.textContent = latex;
      this.render.setAttribute("data-math-error", "");
      this.render.title = String(error);
    }
  }

  /** Sized by the textarea's own rows and cols, so nothing here measures anything or sets a style. */
  private size(): void {
    const lines = this.field.value.split("\n");
    const widest = lines.reduce((most, line) => Math.max(most, line.length), 0);
    this.field.rows = Math.min(MAX_ROWS, lines.length);
    this.field.cols = Math.min(MAX_COLS, Math.max(MIN_COLS, widest + 1));
  }

  /**
   * Focus, on the next frame rather than now.
   *
   * ProseMirror is part way through drawing the selection this call came from and finishes it by
   * putting the document's own selection around the node, and TipTap's focus command may have a
   * frame of its own already queued in front of that. Either would take the caret straight back
   * out of the field.
   */
  private take(): void {
    requestAnimationFrame(() => {
      if (!this.editing) return;
      // Already in it, which is what a keystroke that rewrote the node looks like from here. Moving
      // the caret then would jump it to the end of a formula being edited in the middle.
      if (this.field.ownerDocument.activeElement === this.field) return;
      this.field.focus({ preventScroll: true });
      const end = this.field.value.length;
      // A formula that is still nothing but the placeholder is one nobody has typed into yet, so
      // the placeholder is selected and the first keystroke replaces it. Anything else gets the
      // caret at the end, because it is somebody's formula and a keystroke must not wipe it.
      const start = this.field.value === PLACEHOLDER ? 0 : end;
      this.field.setSelectionRange(start, end);
    });
  }

  private readonly onInput = (): void => {
    this.size();
    this.commit(this.field.value);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // A display equation is written over several lines often enough that Enter has to be a newline
    // inside one, so it is inline math that Enter leaves and a block that needs the modifier.
    const leaving =
      event.key === "Escape" ||
      (event.key === "Enter" && (!this.display || event.metaKey || event.ctrlKey));
    if (leaving) {
      event.preventDefault();
      this.leave();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && this.field.value === "") {
      event.preventDefault();
      this.discard();
    }
  };

  /**
   * The field's text on to the node, as a transaction like any other keystroke in the document.
   *
   * Not held back until the field is left. A formula the field is holding and the document is not
   * is one an autosave writes the previous version of and a switch to another file loses outright,
   * and neither is worth the tidier undo history that batching it would buy.
   */
  private commit(latex: string): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const { state } = this.view;
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== this.node.type || node.attrs.latex === latex) return;
    // Null for the type and nothing for the marks, so an inline formula inside a bold run comes
    // back out of this still bold. setNodeMarkup keeps the marks it was not given new ones for.
    this.view.dispatch(state.tr.setNodeMarkup(pos, null, { ...node.attrs, latex }));
  }

  /** Puts the caret back in the document just past the node, which is what re-renders it. */
  private leave(): void {
    const pos = this.getPos();
    const { state } = this.view;
    if (pos !== undefined) {
      const after = Math.min(pos + this.node.nodeSize, state.doc.content.size);
      this.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(after), 1)));
    }
    this.view.focus();
  }

  /** Backspace in an empty field takes the formula with it, the field being all there is of it. */
  private discard(): void {
    const pos = this.getPos();
    const { state } = this.view;
    if (pos === undefined) return;
    if (!(state.selection instanceof NodeSelection) || state.selection.from !== pos) return;
    this.view.dispatch(state.tr.deleteSelection().scrollIntoView());
    this.view.focus();
  }
}

export const MathRendering = Extension.create({
  name: "mathRendering",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mathViews"),
        props: {
          nodeViews: {
            mathInline: (node, view, getPos) => new MathView(node, view, getPos, false),
            mathBlock: (node, view, getPos) => new MathView(node, view, getPos, true),
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const editor = this.editor;

    // ProseMirror's own calling convention rather than editor.commands.command, which dispatches
    // its transaction whatever the command answered. Enter is pressed everywhere in the document
    // and a key that did nothing here has to leave nothing at all behind it.
    return {
      Enter: () => openMathBlock(editor.state, editor.view.dispatch),
    };
  },
});

/**
 * `display` picks mathBlock over mathInline. False where neither can be placed, which is a toolbar
 * button pressed somewhere a formula cannot go and means nothing happens.
 *
 * The guard is `place`'s and is the same one every other insert in the editor asks, deliberately:
 * this command had a private one and it was the private one that was missing a rule.
 */
export function insertMath(editor: Editor, display: boolean): boolean {
  const type = editor.schema.nodes[display ? "mathBlock" : "mathInline"];
  if (!type) return false;
  return place(editor, type, (chain) =>
    chain.command(({ state, dispatch }) => placeMath(type)(state, dispatch)),
  );
}
