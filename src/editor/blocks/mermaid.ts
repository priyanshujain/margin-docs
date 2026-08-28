// Mermaid diagrams, which are a fenced code block whose language is `mermaid` and nothing else.
//
// There is no mermaid node in the schema and there will not be one. On disk a diagram is ```mermaid
// and the bridge reads it as a codeBlock like any other fence, so every byte of it round trips as
// that block's text whether or not it draws. This lane only changes how such a block is shown.
//
// Mermaid renders asynchronously, which a ProseMirror view update is not, so the node view draws
// the fence first and swaps the SVG in when it arrives. A diagram that fails to parse stays as the
// code the user wrote, with the error beside it: a broken diagram is a typo to fix, not a block to
// hide.
//
// Nothing below ever writes to the document. The one transaction this file dispatches sets a text
// selection, which is a caret move and not an edit, and it is what makes clicking a drawn diagram
// put the cursor in the source that drew it. A render result is painted into DOM that sits outside
// contentDOM and is declared to ProseMirror as not the document's, so a picture mermaid hands back
// can never be read into the tree and saved over somebody's fence.
//
// ProseMirror resolves node views by node name and the first plugin asked wins, so this file is
// handed every code block in the document, not only the mermaid ones. The other kind gets a node
// view built from the schema's own toDOM, which is the same `pre > code` a code block had before
// this lane existed: the same element prose.css styles and the same one the code lane's decorations
// land on.

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view";
import type { Mermaid, MermaidConfig } from "mermaid";
import { place } from "../fits";

/**
 * The one info string that draws. Matched exactly, case included.
 *
 * The code lane matches the same word case insensitively when it decides what to leave plain, so
 * ```Mermaid is highlighted by nobody and drawn by nobody: it stays the fence the user typed. That
 * is the safe direction for the two lanes to disagree in. Both drawing it and colouring it would
 * mean two plugins fighting over one block.
 */
const LANGUAGE = "mermaid";

const DRAWING = "Drawing diagram…";

const FAILED = "Mermaid could not draw this diagram.";

const mermaidKey = new PluginKey("mermaidRendering");

/** On a node decoration, this marks the code block the selection is currently inside. */
const CURSOR_INSIDE = { mermaidCursor: true };

function isDiagram(node: ProseMirrorNode): boolean {
  return node.type.name === "codeBlock" && node.attrs.language === LANGUAGE;
}

// ------------------------------------------------------------------------------------------------
// The library, loaded once and only if a diagram is ever drawn
// ------------------------------------------------------------------------------------------------

let loading: Promise<Mermaid> | null = null;
let configured: string | null = null;
let drawings = 0;

/**
 * Mermaid is several megabytes and a dependency graph to match, so this is the only place it is
 * mentioned outside a type position and the import is dynamic. The bundler gives it a chunk of its
 * own, and a user who never writes a diagram never fetches it.
 *
 * A failed load clears the promise rather than keeping it, so a chunk that did not arrive once is
 * asked for again by the next block instead of poisoning every diagram in the app.
 */
function load(): Promise<Mermaid> {
  if (!loading) {
    loading = import("mermaid")
      .then((module) => module.default)
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

function themeName(): string {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/**
 * The app's palette, handed to mermaid as its own theme variables.
 *
 * `base` is the one mermaid theme meant to be recoloured; the others are fixed palettes that would
 * put somebody else's lavender and yellow in the middle of this page. The values are read off the
 * token layer at render time rather than named here, so a diagram is drawn in the same ink as the
 * document around it and follows tokens.css when that changes.
 */
function themeVariables(): Record<string, string | boolean> {
  const style = getComputedStyle(document.documentElement);
  const variables: Record<string, string | boolean> = {
    darkMode: themeName() === "dark",
    fontFamily: "var(--font-ui)",
  };

  const palette: ReadonlyArray<readonly [string, string]> = [
    ["background", "--paper"],
    ["primaryColor", "--code-surface"],
    ["primaryTextColor", "--ink"],
    ["primaryBorderColor", "--doc-rule-strong"],
    ["secondaryColor", "--shell"],
    ["tertiaryColor", "--raised"],
    ["lineColor", "--ink-soft"],
    ["textColor", "--ink"],
    // The card a label on an arrow sits on. Left to itself the base theme picks near black for it
    // in dark mode, which puts a hole in the middle of the diagram.
    ["edgeLabelBackground", "--code-surface"],
  ];

  for (const [variable, token] of palette) {
    const value = style.getPropertyValue(token).trim();
    // An empty custom property means the stylesheet is not loaded yet. Mermaid derives its shades
    // from these by colour arithmetic, and "" is not a colour, so a missing token is left to the
    // theme's own default rather than passed on.
    if (value) variables[variable] = value;
  }

  return variables;
}

function configFor(): MermaidConfig {
  return {
    // The whole point of this file: nothing scans the page for diagrams, every render is asked for
    // by a node view that knows which block it belongs to.
    startOnLoad: false,
    // Strict is mermaid's own default and the right one here. The text being drawn came out of a
    // file on disk, so it is sanitised and its click handlers are dropped.
    securityLevel: "strict",
    // Without this a parse failure leaves mermaid's own error diagram behind in the page and a
    // stray temporary div in the body. The error belongs in this block, drawn by the code below.
    suppressErrorRendering: true,
    theme: "base",
    fontFamily: "var(--font-ui)",
    themeVariables: themeVariables(),
  };
}

/**
 * One diagram, as an SVG string. Throws whatever mermaid threw.
 *
 * The id has to be unique per diagram: mermaid scopes the stylesheet it puts inside each SVG with
 * `#id`, so two diagrams sharing one would style each other.
 */
async function toSvg(text: string): Promise<string> {
  const mermaid = await load();

  const theme = themeName();
  if (theme !== configured) {
    mermaid.initialize(configFor());
    configured = theme;
  }

  // Parsing first keeps a syntax error away from the renderer entirely, which is the difference
  // between an error this file can show and a half drawn diagram.
  await mermaid.parse(text);
  const { svg } = await mermaid.render(`mermaid-diagram-${(drawings += 1)}`, text);
  return svg;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    // Mermaid's parse errors are plain objects carrying the offending line under `str`.
    const detail = error as { str?: unknown; message?: unknown };
    if (typeof detail.str === "string") return detail.str;
    if (typeof detail.message === "string") return detail.message;
  }
  return String(error);
}

// ------------------------------------------------------------------------------------------------
// The theme watch
// ------------------------------------------------------------------------------------------------

const live = new Set<DiagramView>();

let watcher: MutationObserver | null = null;
let watched: string | null = null;

/**
 * A drawn diagram is a picture with the palette baked into it, so the theme changing under it is
 * the one event that invalidates a render nothing else touched. One observer serves every block,
 * and it exists only while there is a diagram on screen to redraw.
 */
function watchTheme(): void {
  if (watcher) return;
  watched = themeName();
  watcher = new MutationObserver(() => {
    const theme = themeName();
    if (theme === watched) return;
    watched = theme;
    configured = null;
    for (const view of live) view.redraw();
  });
  watcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function unwatchTheme(): void {
  if (!watcher || live.size > 0) return;
  watcher.disconnect();
  watcher = null;
}

// ------------------------------------------------------------------------------------------------
// The node views
// ------------------------------------------------------------------------------------------------

/**
 * Every code block that is not a diagram, rendered by the schema rather than by hand.
 *
 * Going through the node's own serializer is what makes this a no-op: the DOM here is the DOM
 * ProseMirror would have built for a code block if this file did not exist, down to whether
 * `data-language` is written at all, so nothing about an ordinary fence changes because the mermaid
 * lane happens to be installed.
 */
class SourceView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement | null;
  private node: ProseMirrorNode;

  constructor(node: ProseMirrorNode) {
    const serializer = DOMSerializer.fromSchema(node.type.schema);
    const rendered = DOMSerializer.renderSpec(document, serializer.nodes[node.type.name](node));
    this.dom = rendered.dom;
    this.contentDOM = rendered.contentDOM ?? null;
    this.node = node;
  }

  update(next: ProseMirrorNode): boolean {
    // Same markup means the same element, so ProseMirror updates the text inside contentDOM and
    // this view stands. Anything else is a rebuild, the language crossing into mermaid included,
    // and a rebuild is what the standard node view would have done with the same change.
    if (!next.sameMarkup(this.node)) return false;
    this.node = next;
    return true;
  }
}

type DiagramState = "empty" | "source" | "pending" | "diagram" | "error";

/**
 * One mermaid block: the picture, and the source that made it.
 *
 * Both are always in the DOM and which one is shown is a CSS state, because the source is the
 * document's own content and hiding it by removing it would be an edit. The cursor being inside
 * the block arrives as a node decoration from the plugin below rather than being asked for here,
 * since a node view is only told about the selection when something else redraws it.
 */
class DiagramView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;

  private readonly figure: HTMLElement;
  private readonly drawing: HTMLElement;
  private readonly note: HTMLElement;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;

  private node: ProseMirrorNode;
  private inside: boolean;

  /** Bumped by anything that makes a render in flight the answer to a question nobody asked. */
  private token = 0;
  /** The text the picture on screen was drawn from, or null when there is no picture. */
  private drawn: string | null = null;
  private failure: string | null = null;
  private gone = false;

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos: () => number | undefined,
    decorations: readonly Decoration[],
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.inside = hasCursor(decorations);

    this.dom = document.createElement("div");
    this.dom.className = "mermaid-block";

    this.figure = document.createElement("div");
    this.figure.className = "mermaid-figure";
    // Not part of the document, so the caret has no business in it and ProseMirror is told as much
    // here as well as through ignoreMutation below.
    this.figure.contentEditable = "false";

    this.drawing = document.createElement("div");
    this.drawing.className = "mermaid-drawing";

    this.note = document.createElement("div");
    this.note.className = "mermaid-note";

    this.figure.append(this.drawing, this.note);

    const source = document.createElement("pre");
    source.className = "mermaid-source";
    source.setAttribute("data-language", LANGUAGE);
    this.contentDOM = document.createElement("code");
    source.appendChild(this.contentDOM);

    this.dom.append(this.figure, source);

    this.figure.addEventListener("mousedown", this.enter);

    live.add(this);
    watchTheme();
    this.apply();
  }

  update(next: ProseMirrorNode, decorations: readonly Decoration[]): boolean {
    // The language leaving mermaid is a different kind of block with different DOM, so this view is
    // finished and ProseMirror builds the plain one in its place.
    if (!isDiagram(next)) return false;

    const edited = next.textContent !== this.node.textContent;
    this.node = next;
    this.inside = hasCursor(decorations);

    if (edited) {
      // Whatever is being drawn was drawn from text that is no longer in this block, and the error
      // on screen, if there is one, is about a line the user may have just fixed.
      this.token += 1;
      this.failure = null;
    }

    this.apply();
    return true;
  }

  /** The theme changed, so the picture is right about the diagram and wrong about the ink. */
  redraw(): void {
    this.failure = null;
    this.drawn = null;
    this.apply();
  }

  destroy(): void {
    this.gone = true;
    this.figure.removeEventListener("mousedown", this.enter);
    live.delete(this);
    unwatchTheme();
  }

  /**
   * The figure is the view's own drawing, not the document. Reading an SVG mermaid just handed over
   * back into the tree would replace the user's fence with a transcription of its own picture, so
   * every mutation outside contentDOM is none of ProseMirror's business.
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Node ? !this.contentDOM.contains(target) : false;
  }

  /** Clicking the picture puts the caret in the source that drew it, which is how a diagram is edited. */
  private enter = (event: MouseEvent): void => {
    const pos = this.getPos();
    if (pos === undefined) return;
    event.preventDefault();
    const { state } = this.view;
    const inside = Math.min(pos + 1, state.doc.content.size);
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, inside)));
    this.view.focus();
  };

  /** What should be on screen for the block as it is now, and a render if that is not known yet. */
  private apply(): void {
    const text = this.node.textContent;

    if (!text.trim()) {
      this.show("empty");
      return;
    }
    // Shown whether or not the caret is in the block, because a diagram that will not draw is a
    // line to go and fix and the message is how anybody knows which line.
    if (this.failure !== null) {
      this.note.textContent = `${FAILED}\n\n${this.failure}`;
      this.show("error");
      return;
    }
    if (this.inside) {
      this.show("source");
      return;
    }
    if (this.drawn === text) {
      this.show("diagram");
      return;
    }
    this.draw(text);
  }

  private draw(text: string): void {
    const token = (this.token += 1);

    // A diagram already on screen stays there while the next one is drawn, so a theme change or a
    // finished edit does not blink the block out of the page and back into it.
    if (this.drawing.firstChild) {
      this.show("diagram");
      this.dom.setAttribute("data-busy", "");
    } else {
      this.note.textContent = DRAWING;
      this.show("pending");
    }

    toSvg(text).then(
      (svg) => {
        if (this.stale(token)) return;
        this.dom.removeAttribute("data-busy");
        // Mermaid sanitises what it returns, and a script arriving through innerHTML does not run
        // in any case, so the SVG goes in as markup and the error below never does.
        this.drawing.innerHTML = svg;
        this.drawn = text;
        this.failure = null;
        this.apply();
      },
      (error: unknown) => {
        if (this.stale(token)) return;
        this.dom.removeAttribute("data-busy");
        this.drawing.textContent = "";
        this.drawn = null;
        this.failure = messageOf(error);
        this.apply();
      },
    );
  }

  /**
   * Mermaid answers whenever it answers, and by then the block may have been edited, the document
   * may have been closed and this view may have been thrown away. The token covers every one of
   * those: it is bumped by an edit, by a theme change and by destroy, so an answer to a question
   * nobody is asking any more is dropped rather than painted somewhere it no longer belongs.
   */
  private stale(token: number): boolean {
    return this.gone || token !== this.token || this.view.isDestroyed;
  }

  private show(state: DiagramState): void {
    this.dom.setAttribute("data-state", state);
  }
}

function hasCursor(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => decoration.spec?.mermaidCursor === true);
}

// ------------------------------------------------------------------------------------------------
// The plugin
// ------------------------------------------------------------------------------------------------

/**
 * A node decoration on every mermaid block the selection touches.
 *
 * This is how a node view is told the caret is inside it. A decoration changing is one of the two
 * things that make ProseMirror ask a node view to update, and the selection moving on its own is
 * not the other, so without this a block would keep drawing the diagram with the cursor in it.
 */
function cursorDecorations(state: EditorState): DecorationSet | null {
  const { from, to } = state.selection;
  const found: Decoration[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    if (isDiagram(node)) found.push(Decoration.node(pos, pos + node.nodeSize, {}, CURSOR_INSIDE));
    return false;
  });

  return found.length > 0 ? DecorationSet.create(state.doc, found) : null;
}

export const MermaidRendering = Extension.create({
  name: "mermaidRendering",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mermaidKey,
        props: {
          nodeViews: {
            codeBlock: (node, view, getPos, decorations) =>
              isDiagram(node)
                ? new DiagramView(node, view, getPos, decorations)
                : new SourceView(node),
          },
          decorations: cursorDecorations,
        },
      }),
    ];
  },
});

/**
 * Inserts an empty ```mermaid fence. False where a code block cannot go.
 *
 * Through `place` rather than asking `fits` about each end itself, which is what this did while it
 * was the only insert in its own file. Both spellings refuse the same things today, but only one of
 * them refuses the next thing the guard learns: `fits` gained a cell selection rule after a drag
 * across a table lost six cells to an insert that had asked it the older way, and a caller holding
 * its own copy of the question is a caller that does not get told. There is one gate and every
 * insert goes through it.
 */
export function insertMermaid(editor: Editor): boolean {
  return place(editor, editor.schema.nodes.codeBlock, (chain) =>
    chain.insertContent({ type: "codeBlock", attrs: { language: LANGUAGE, meta: null } }),
  );
}
