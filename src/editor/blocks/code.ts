// Code block behaviour: syntax highlighting, the copy control, the language on the fence, and the
// two arrows that get a caret back out of one.
//
// Highlighting is decorations over the block's own text and never an edit to it. The spans belong
// to the view, nothing they do reaches the tree, and a highlighted block therefore serializes back
// to exactly the fence it was read from. lowlight rather than shiki, because a decoration set has
// to be rebuilt synchronously inside the plugin and shiki highlights asynchronously.
//
// The copy control rides in the same decoration set, as a widget, and that is a decision rather
// than a convenience. A node view would be the natural place for chrome around a block, and this
// lane cannot have one: ProseMirror resolves a node view by node name and the first plugin asked
// wins, src/editor/blocks/mermaid.ts already claims `codeBlock` for every fence in the document,
// and a second claim would either lose to it or take the diagrams away from it. A widget needs no
// claim. It also cannot be anything but chrome, which is the stronger half of the argument: the
// view's own parseRule for a widget is `{ ignore: true }`, so a copy button is invisible to
// anything that reads the DOM back into the tree, in a way a node view has to be told to be. The
// button carries no text either, only a glyph, so a fence's textContent is still the fence's.
//
// Line numbers are deliberately not here. A gutter costs a column of a 38em measure that the code
// then does not get, and there is nothing on disk for it to come from or go back to: the numbers
// would be this app drawing over the user's file with a ruler.
//
// `language` and `meta` are already attributes on the schema's codeBlock, so setting a language is
// an ordinary attribute edit and does change the document, which is the point: the fence on disk
// changes with it. `meta` is never touched. It is whatever the user wrote after the language on
// their own opening fence, this editor has no model for it, and it rides along untouched.
//
// The decoration set is rebuilt per code block rather than per document. A document is autosaved
// half a second after the last keystroke, so the typing path is the hot one, and re-running a
// grammar over every fence in a long file on every character typed is the obvious way to make this
// editor feel slow. A transaction says which ranges it touched; only the code blocks those ranges
// land in are highlighted again, and the rest are carried over by mapping the old set forward.
//
// A codeBlock whose language is mermaid belongs to the mermaid lane, which draws it as a diagram
// through a node view. Nothing here decorates one.

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { Command, EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { LanguageFn } from "highlight.js";
import ini from "highlight.js/lib/languages/ini";
import kotlin from "highlight.js/lib/languages/kotlin";
import rust from "highlight.js/lib/languages/rust";
import swift from "highlight.js/lib/languages/swift";
import { common, createLowlight } from "lowlight";
import { notify } from "../../store/useToast";

const lowlight = createLowlight(common);

/**
 * The four languages this app's own docs folder is written in, registered by hand.
 *
 * lowlight's common set carries all four today, toml as an alias of ini, so the loop below does
 * nothing on this version. It is here because "common" is somebody else's list and it has been
 * trimmed before: if one of these ever falls out of it, the app's own documentation is the first
 * thing that stops highlighting, and that is a silly way to find out.
 */
const REQUIRED: ReadonlyArray<readonly [string, LanguageFn]> = [
  ["rust", rust],
  ["toml", ini],
  ["swift", swift],
  ["kotlin", kotlin],
];

for (const [name, grammar] of REQUIRED) {
  if (!lowlight.registered(name)) lowlight.register(name, grammar);
}

/**
 * Past this many characters a fence is left plain.
 *
 * A block this long is a pasted file rather than code anyone is reading, and a grammar walking it
 * again on every keystroke is a stutter the user cannot explain. Nothing is lost by not colouring
 * it: the text is the document's, the decorations were only ever paint.
 */
const MAX_HIGHLIGHT_CHARS = 50_000;

type HighlightRoot = ReturnType<ReturnType<typeof createLowlight>["highlight"]>;
type HighlightChild = HighlightRoot["children"][number];

const codeHighlightKey = new PluginKey<DecorationSet>("codeHighlighting");

/** The class names lowlight put on one span, as ProseMirror wants them: one string. */
function classNameOf(properties: Record<string, unknown> | undefined): string {
  const value = properties?.className;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((name): name is string => typeof name === "string").join(" ");
  }
  return "";
}

/**
 * The language to highlight this block with, or null to leave it plain.
 *
 * A fence's info string is the user's text, not a menu selection: it can be blank, it can name a
 * language nobody has a grammar for, and it can be a typo. All three are plain text and none of
 * them is an error, so an unregistered name is answered here rather than by letting the highlighter
 * throw. Guessing is not on the list either: highlightAuto would colour a paragraph of prose as
 * whichever language it happened to resemble.
 */
function highlightableLanguage(node: ProseMirrorNode): string | null {
  const language = typeof node.attrs.language === "string" ? node.attrs.language.trim() : "";
  if (!language) return null;
  // Matched loosely, unlike the mermaid lane's own exact test, because the two must not both draw
  // the same block and the safe direction to be wrong in is leaving a block plain.
  if (language.toLowerCase() === "mermaid") return null;
  return lowlight.registered(language) ? language : null;
}

/** `base` is the position of the block's first character, so `pos + 1` for the node at `pos`. */
function decorationsFor(node: ProseMirrorNode, base: number): Decoration[] {
  const language = highlightableLanguage(node);
  if (!language) return [];

  const text = node.textContent;
  if (!text || text.length > MAX_HIGHLIGHT_CHARS) return [];

  let tree: HighlightRoot;
  try {
    tree = lowlight.highlight(language, text);
  } catch {
    // A grammar that throws on somebody's file is a highlighter's problem and never the document's.
    return [];
  }

  const decorations: Decoration[] = [];
  let offset = 0;

  const walk = (children: readonly HighlightChild[]): void => {
    for (const child of children) {
      if (child.type === "text") {
        offset += child.value.length;
      } else if (child.type === "element") {
        const from = offset;
        walk(child.children);
        const className = classNameOf(child.properties);
        if (className && offset > from) {
          decorations.push(Decoration.inline(base + from, base + offset, { class: className }));
        }
      }
    }
  };
  walk(tree.children);

  // The highlighter is a third party walking the user's text, and a decoration that runs past the
  // end of the block throws inside the view rather than merely looking wrong. If what came back
  // does not measure the same as what went in, the offsets cannot be trusted and the block stays
  // plain.
  return offset === text.length ? decorations : [];
}

const SVG = "http://www.w3.org/2000/svg";

/** Feather's own copy mark, and the tick it becomes for a moment once the clipboard has it. */
const COPY_D =
  "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1";
const COPIED_D = "M20 6 9 17l-5-5";
const COPIED_MS = 1400;

/**
 * The tick each button is showing, so a fence edited or a document closed mid-flash takes its timer
 * with it rather than leaving one running at an element nothing is drawing any more.
 */
const flashes = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/**
 * The button, built once per fence and then reused for as long as the block lives.
 *
 * `getPos` is asked at the moment of the click rather than closed over, because the fence may have
 * moved since the button was made and the text that goes to the clipboard has to be the text under
 * the button now. What is copied is read off the document rather than off the element: the element
 * is whatever the view happens to have built, spans a grammar cut and a widget of this file's own
 * among it, while the node is exactly the bytes the fence goes back to disk as.
 *
 * It is returned inside a wrapper that draws nothing, and that wrapper is load bearing. The widget
 * is a child of the `<code>`, and prosemirror-view decides whether a vertical arrow is leaving a
 * fence by walking that element's own children and comparing each one's client rects against the
 * caret's: a box sitting above the first line of code is a line above the caret as far as that walk
 * is concerned, so with the button itself as the widget, ArrowUp out of a fence that opens a
 * document stopped making the paragraph it is supposed to make. The wrapper has no height for the
 * walk to find and the button hangs off it, which costs the layout nothing and hands the question
 * back to the library. code.css draws both.
 */
function copyControl(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const owner = view.dom.ownerDocument;

  const chrome = owner.createElement("span");
  chrome.className = "code-chrome";

  const button = owner.createElement("button");
  button.className = "code-copy";
  button.type = "button";
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy this block");

  const glyph = owner.createElementNS(SVG, "svg");
  glyph.setAttribute("viewBox", "0 0 24 24");
  glyph.setAttribute("fill", "none");
  glyph.setAttribute("stroke", "currentColor");
  glyph.setAttribute("stroke-width", "1.6");
  glyph.setAttribute("stroke-linecap", "round");
  glyph.setAttribute("stroke-linejoin", "round");
  const stroke = owner.createElementNS(SVG, "path");
  stroke.setAttribute("d", COPY_D);
  glyph.appendChild(stroke);
  button.appendChild(glyph);

  // A press inside the document moves the caret, and this one is aimed at chrome rather than at
  // text: whatever sentence the user was in the middle of keeps the cursor.
  button.addEventListener("mousedown", (event) => event.preventDefault());

  button.addEventListener("click", (event) => {
    event.preventDefault();
    const pos = getPos();
    if (pos === undefined) return;
    const block = view.state.doc.resolve(pos).parent;
    if (block.type.name !== "codeBlock") return;

    navigator.clipboard.writeText(block.textContent).then(
      () => {
        const running = flashes.get(chrome);
        if (running !== undefined) clearTimeout(running);
        button.toggleAttribute("data-copied", true);
        stroke.setAttribute("d", COPIED_D);
        flashes.set(
          chrome,
          setTimeout(() => {
            flashes.delete(chrome);
            button.removeAttribute("data-copied");
            stroke.setAttribute("d", COPY_D);
          }, COPIED_MS),
        );
      },
      // Silence would read as a copy that worked, and the next paste would be last week's clipboard.
      () => notify("Could not copy this block."),
    );
  });

  chrome.appendChild(button);
  return chrome;
}

/**
 * The chrome for the fence whose first character is at `base`.
 *
 * Every event inside it is stopped, which is what keeps a click on the button from also being a
 * click in the document: without it ProseMirror reads the press as a place to put the caret and
 * runs the whole selection machinery for a gesture that was never aimed at the text. The key is
 * what lets the element survive the block being retyped around it, since the decoration set is
 * rebuilt for a fence on every keystroke in it and a button rebuilt that often would lose the tick
 * a tenth of a second after showing it.
 */
function chromeFor(base: number): Decoration {
  return Decoration.widget(base, copyControl, {
    key: "code-copy",
    side: -1,
    stopEvent: () => true,
    destroy: (node: Node) => {
      const running = flashes.get(node as Element);
      if (running !== undefined) clearTimeout(running);
      flashes.delete(node as Element);
    },
  });
}

/**
 * Everything this lane draws over one code block: the chrome, and the grammar's colours where there
 * is a grammar.
 *
 * The chrome is on every fence, a diagram's included. A mermaid block is a code block on disk and
 * its source is shown whenever there is no picture to show instead, so the one place it would be
 * wrong is inside a drawn diagram, and there the whole fence is hidden and the button with it.
 */
function decorateBlock(node: ProseMirrorNode, base: number): Decoration[] {
  return [chromeFor(base), ...decorationsFor(node, base)];
}

function highlightWholeDoc(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    decorations.push(...decorateBlock(node, pos + 1));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The code blocks a transaction landed in, by position in the new document.
 *
 * Every step carries a map of the ranges it replaced. Mapping a step's range through the steps that
 * came after it puts it in the final document's coordinates, where the blocks it overlaps are the
 * ones whose text or attributes could have changed. An attribute-only edit counts: setting the
 * language rewrites the node, which shows up here as a touched range around it, which is what makes
 * the fence recolour the moment its language changes.
 */
function touchedCodeBlocks(tr: Transaction, doc: ProseMirrorNode): Map<number, ProseMirrorNode> {
  const blocks = new Map<number, ProseMirrorNode>();
  const end = doc.content.size;

  tr.mapping.maps.forEach((stepMap, index) => {
    const rest = tr.mapping.slice(index + 1);
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      const from = Math.max(0, Math.min(end, rest.map(newFrom, -1)));
      const to = Math.max(from, Math.min(end, rest.map(newTo, 1)));
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== "codeBlock") return true;
        blocks.set(pos, node);
        return false;
      });
    });
  });

  return blocks;
}

/**
 * The position just beside the caret's fence, on the side `dir` points at, or null for a caret
 * that is anywhere else.
 *
 * A selection with two ends is left alone rather than collapsed, because prosemirror-view declines
 * a vertical arrow over one too: what the key means over a selection is the browser's to say, and
 * this file has an answer only for a caret standing at the edge of a block.
 */
function besideFence(dir: -1 | 1, state: EditorState): ResolvedPos | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $head } = selection;
  if ($head.parent.type.name !== "codeBlock") return null;
  return state.doc.resolve(dir > 0 ? $head.after() : $head.before());
}

/**
 * Up or down off the outer line of a fence that has nothing at all beyond it: a paragraph is made
 * there for the caret to land in.
 *
 * Everything else about the two arrows in a fence is already right and is deliberately left alone.
 * A code block is a textblock, so the browser walks the caret through it a line at a time, and off
 * the last line it walks into the block below the same way it would out of a paragraph. What
 * neither the browser nor prosemirror-view has an answer for is a fence with nothing on the far
 * side of it, and that is the state a code block made from the toolbar in an empty document is in
 * from the moment it appears: it is the only node in the document, so there is no line to move to
 * and no block to move into, and the caret stays where it is for as long as the user keeps
 * pressing. The gap cursor is not the way out either, since prosemirror-gapcursor refuses to stand
 * beside a node holding inline content and a fence is one. Measured in Chromium, with the caret at
 * the end of the only block in the document: ArrowDown left the selection exactly where it was, no
 * transaction was dispatched and no gap cursor was drawn, and ArrowUp did the same at the front.
 *
 * Whether anything is beyond the fence is asked of `Selection.findFrom`, which is the question
 * prosemirror-view's own `moveSelectionBlock` asks before it moves a block at a time. So a rule or
 * a picture under the fence is still selected by the library and a paragraph under it is still
 * walked into by the browser; only the empty answer is this file's. The paragraph it makes is
 * nothing to the serializer, so the document is dirtied and the file is not, which is the same
 * trade src/editor/blocks/tables.ts makes for the same key at the edge of a table.
 */
function verticalArrow(dir: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (!view) return false;
    const $edge = besideFence(dir, state);
    if (!$edge) return false;
    // Which line of the fence the caret is on is a question about laid out text rather than about
    // the document, so it is the view's to answer and not this file's to work out from offsets.
    if (!view.endOfTextblock(dir > 0 ? "down" : "up")) return false;
    if (Selection.findFrom($edge, dir)) return false;

    const paragraph = state.schema.nodes.paragraph;
    const index = $edge.index();
    if (!$edge.parent.canReplaceWith(index, index, paragraph)) return false;

    if (dispatch) {
      const tr = state.tr.insert($edge.pos, paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, $edge.pos + 1)).scrollIntoView());
    }
    return true;
  };
}

export const CodeHighlighting = Extension.create({
  name: "codeHighlighting",

  addKeyboardShortcuts() {
    const editor = this.editor;

    // ProseMirror's own calling convention rather than editor.commands.command, which dispatches
    // its transaction whatever the command answered. These two are asked on every vertical arrow
    // in the document, and a key pressed outside a fence has to leave nothing at all behind it.
    const run = (command: Command) => () =>
      command(editor.state, editor.view.dispatch, editor.view);

    return {
      ArrowUp: run(verticalArrow(-1)),
      ArrowDown: run(verticalArrow(1)),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: codeHighlightKey,
        state: {
          init: (_config, state) => highlightWholeDoc(state.doc),
          apply(tr, value) {
            if (!tr.docChanged) return value;

            const doc = tr.doc;
            const touched = touchedCodeBlocks(tr, doc);
            let next = value.map(tr.mapping, doc);
            if (!touched.size) return next;

            const added: Decoration[] = [];
            for (const [pos, node] of touched) {
              const from = pos + 1;
              const to = from + node.content.size;
              // Whatever this block was carrying before the edit, mapped forward: spans stretched
              // over text the grammar has not seen, and the chrome. All of it goes before the new
              // set does, and the chrome comes back at the same key, which is what keeps its
              // element and its listeners rather than building a button per keystroke.
              const stale = next.find(from, to);
              if (stale.length) next = next.remove(stale);
              added.push(...decorateBlock(node, from));
            }
            return added.length ? next.add(doc, added) : next;
          },
        },
        props: {
          decorations: (state) => codeHighlightKey.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

/** null clears the fence back to a bare ```. False when the cursor is not in a code block. */
export function setCodeLanguage(editor: Editor, language: string | null): boolean {
  if (!editor.isActive("codeBlock")) return false;

  const next = language === null ? null : language.trim() || null;

  // A fence's info string is one word of language and everything after it is `meta`, so a language
  // with a space in it would be read back off disk as a different language plus a meta the user
  // never wrote. Refusing leaves the file saying what it already says.
  if (next !== null && /\s/.test(next)) return false;

  // Setting the language a block already has would dirty the document and spend an autosave
  // rewriting the file the user is looking at, for no change at all.
  const current = (editor.getAttributes("codeBlock").language as string | null | undefined) ?? null;
  if (current === next) return false;

  // Read out of the chain rather than off run(), because focus answers a different question, and
  // answers it with false whenever there is no view to focus.
  let changed = false;
  editor
    .chain()
    .focus()
    .command(({ commands }) => {
      changed = commands.updateAttributes("codeBlock", { language: next });
      return changed;
    })
    .run();
  return changed;
}
