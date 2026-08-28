// Writing Tools, from the editor's side.
//
// The system rewrites the selection by mutating the DOM under prosemirror-view, which reparses it.
// That is the same seam docs/architecture.md blames for the hard break bug, so this module is where
// the guard belongs: what may be handed to a rewrite, and what has to be refused before one starts.
//
// WHAT THE BYTES ACTUALLY DO, because none of the below is a guess. tests/writing-tools.spec.ts
// makes the mutation the system makes, in a running editor, and reads the file afterwards.
//
// Prose survives. A hand wrapped paragraph rewritten across its wraps comes back as one line and
// no backslash anywhere; a heading, a list item and a single table cell all keep their spelling;
// markdown characters that arrive in the new text are escaped, so a rewrite that opens with "1." or
// "-" stays the paragraph it was. A newline in the new text is a newline in the file, which is the
// paragraph's own contract, and a pipe inside a cell comes out `\|`.
//
// Structure does not. A selection with an end in each of two blocks is where every real failure
// was: two paragraphs became three with `&#x20;` in the middle of the user's words, a heading and
// the paragraph under it became a truncated heading and an invented paragraph, two list items
// became three, and two table cells became a table one column wider whose rows disagree, which is
// not a table any more. So a rewrite gets one block, and it is refused rather than trimmed to fit:
// the selection is the user's and silently rewriting a different range than the one they made is
// its own bug.
//
// Inside one block, the danger is anything whose spelling is not in the words on screen. A range
// crossing a link is replaced by plain text and the address goes with it, invisibly, and the same
// gesture eats an inline picture. A range wholly inside a link is safe and stays allowed, because
// the mark is an ancestor of it rather than something it can delete. Code and formulae are refused
// the way src/editor/proofing.ts refuses them, and for its reason rather than a byte one: a fenced
// block, a raw block and a code span all round trip cleanly, and a tool that rewrites somebody's
// variable names is a tool they turn off. A raw block is the file's own bytes and the only correct
// thing to do with them is nothing.
//
// Nothing here writes to the document. The rewrite arrives as a DOM mutation, TipTap sees the
// transaction it becomes and the shell's debounce saves it, exactly as if the user had typed.
//
// AND THE SELECTION IS READ, NEVER PUT BACK. Writing Tools rewrites whatever holds the keyboard, so
// the document has to be holding it before one starts, and this refuses rather than reaching over
// and focusing the document itself. That is not squeamishness, it was measured: the command palette
// runs its row and then closes on to `<body>`, and focusing the editor at that moment is what
// destroys the selection rather than what saves it, because prosemirror-view takes the collapsed
// selection left behind by the panel that just unmounted as the document's new one. A refusal that
// says which gesture to use costs the user one click. A rewrite aimed at a caret it moved itself
// costs them a paragraph.

import { writingAvailable, writingRun } from "../api/writing";
import { notify } from "../store/useToast";

/** The two items this app puts on the menu, named as the system's own submenu names them. */
const TITLES = { proofread: "Proofread", rewrite: "Rewrite" } as const;

export type WritingTool = keyof typeof TITLES;

const UNAVAILABLE =
  "Writing Tools needs macOS 15.1 or later with Apple Intelligence turned on.";

/** The two editables a document is ever open in. Exactly one of them is on screen at a time. */
const MARKDOWN = ".prose";
const PLAIN = "textarea.plain-text";

/**
 * Every block a selection's two ends are measured against, prose or not. The ones that may not be
 * rewritten are in the list on purpose: a range inside a fence has to resolve to the fence so the
 * refusal can name it, rather than resolving to nothing and being reported as spanning blocks.
 */
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, td, th, pre, [data-math-block]";

/** What a range inside one prose block may not contain, and what a partly covered one clones as. */
const FRAGILE = "a, code, img, .math-inline";

const REFUSED = {
  closed: "Open a document first.",
  unfocused:
    "Writing Tools rewrites whatever holds the keyboard. Click into the document, select the text you want changed, and use the Edit menu.",
  empty: "Select the text you want Writing Tools to change first.",
  blocks:
    "Writing Tools rewrites one paragraph at a time, and that selection covers more than one.",
  raw: "That block is the file's own bytes, kept exactly as they were read, so Writing Tools is not offered it.",
  code: "Writing Tools is not offered code.",
  math: "Writing Tools is not offered a formula.",
  summary: "Writing Tools is not offered a toggle's summary.",
  link: "That selection covers a link, and a rewrite would take its address with it. Select the words either side instead.",
  image: "That selection covers a picture, and a rewrite would take it out of the document.",
} as const;

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The block a range end is in, or null when it is somewhere with no block under it at all. */
const blockOf = (node: Node): Element | null => elementOf(node)?.closest(BLOCKS) ?? null;

/** Why this block may not be rewritten, or null when it is prose. */
function blockRefusal(block: Element): string | null {
  if (block.matches("pre[data-raw]")) return REFUSED.raw;
  if (block.matches("pre")) return REFUSED.code;
  if (block.matches("[data-math-block]")) return REFUSED.math;
  return null;
}

/**
 * Why the run inside one prose block may not be rewritten, or null when it may.
 *
 * Two questions, not one. `cloneContents` reports what the range covers, including an element it
 * covers only part of, which is the case that destroys a link. It says nothing about an element the
 * range sits wholly inside, since that is an ancestor rather than content, so the marks around the
 * range are asked for separately.
 */
function contentRefusal(range: Range): string | null {
  const around = elementOf(range.commonAncestorContainer);
  if (around?.closest("code")) return REFUSED.code;
  if (around?.closest(".math-inline")) return REFUSED.math;

  const covered = range.cloneContents().querySelector(FRAGILE);
  if (!covered) return null;
  if (covered.matches("code")) return REFUSED.code;
  if (covered.matches("img")) return REFUSED.image;
  if (covered.matches(".math-inline")) return REFUSED.math;
  return REFUSED.link;
}

/** Why the selection on screen may not be handed to a rewrite, or null when it may. */
function selectionRefusal(): string | null {
  const surface = document.querySelector<HTMLElement>(`${MARKDOWN}, ${PLAIN}`);
  if (!surface) return REFUSED.closed;

  const active = document.activeElement;

  // A .txt file is a textarea with no markdown in it to lose, so there is nothing here to guard
  // beyond the document holding the keyboard with something selected in it.
  if (surface.matches(PLAIN)) {
    const field = surface as HTMLTextAreaElement;
    if (active !== field) return REFUSED.unfocused;
    return field.selectionStart === field.selectionEnd ? REFUSED.empty : null;
  }

  // A formula's source field and a toggle's title are editables of their own nested inside the
  // document, so each takes the keyboard away from it. Neither is prose in a block of the file, and
  // saying which one the cursor is in is worth more than the general answer below.
  if (active && active !== surface && surface.contains(active)) {
    if (active.closest("[data-math-block]")) return REFUSED.math;
    if (active.closest("[data-toggle-summary]")) return REFUSED.summary;
    return REFUSED.unfocused;
  }
  if (active !== surface) return REFUSED.unfocused;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return REFUSED.empty;
  const range = selection.getRangeAt(0);
  if (range.collapsed || !surface.contains(range.commonAncestorContainer)) return REFUSED.empty;

  const block = blockOf(range.startContainer);
  if (!block || block !== blockOf(range.endContainer)) return REFUSED.blocks;

  return blockRefusal(block) ?? contentRefusal(range);
}

export async function runWritingTool(tool: WritingTool): Promise<void> {
  try {
    if (!(await writingAvailable())) {
      notify(UNAVAILABLE);
      return;
    }
    const refusal = selectionRefusal();
    if (refusal) {
      notify(refusal);
      return;
    }
    await writingRun(TITLES[tool]);
  } catch (e) {
    notify(`Could not run Writing Tools: ${String(e)}`);
  }
}
