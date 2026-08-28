// Code block behaviour: syntax highlighting, and the language on the fence.
//
// Highlighting is decorations over the block's own text and never an edit to it. The spans belong
// to the view, nothing they do reaches the tree, and a highlighted block therefore serializes back
// to exactly the fence it was read from. lowlight rather than shiki, because a decoration set has
// to be rebuilt synchronously inside the plugin and shiki highlights asynchronously.
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
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { LanguageFn } from "highlight.js";
import ini from "highlight.js/lib/languages/ini";
import kotlin from "highlight.js/lib/languages/kotlin";
import rust from "highlight.js/lib/languages/rust";
import swift from "highlight.js/lib/languages/swift";
import { common, createLowlight } from "lowlight";

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

function highlightWholeDoc(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    decorations.push(...decorationsFor(node, pos + 1));
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

export const CodeHighlighting = Extension.create({
  name: "codeHighlighting",

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
              // The spans mapped forward through the edit are the ones this block had before it,
              // stretched over text the grammar has not seen. They go before the new ones do.
              const stale = next.find(from, to);
              if (stale.length) next = next.remove(stale);
              added.push(...decorationsFor(node, from));
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
