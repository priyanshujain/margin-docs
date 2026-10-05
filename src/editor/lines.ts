// One line of a wrapped block, cut out on its own so that a block command can act on it alone.
//
// A paragraph on screen is not always a paragraph in the file. Most markdown is hand wrapped, and
// docs/architecture.md says why a soft break stays a real newline in the paragraph's text: the
// author chose where the line ends and the editor does not get to reflow it. A hard break is the
// same shape one level up, and a paste out of a chat window arrives as a paragraph with two of them
// between every message. Either way what the user sees is several lines with space between them,
// and what the model holds is one block.
//
// Every block command in TipTap acts on the block, which is right for a fence and wrong for a line
// somebody has just selected to make into a heading. Asked for Heading 2 on the first line of one
// of these, `setNode` turned the whole block into a heading, the paragraph under the line went to
// heading size with it, and the serializer wrote the pair out as a setext heading with an underline
// forty characters wide. So before a heading command runs, the line the selection is on is cut out
// of its block: the break in front of it and the break after it are removed, the block is split at
// both places, and the selection is moved into the middle piece. The command then finds one block
// holding exactly the words the user pointed at.
//
// Only a paragraph and a heading are cut, because those are the two blocks whose lines the author
// sees as separate things. The lines of a fence are one block by any reading and turning one of
// them into a heading would be cutting somebody's code in half; src/editor/fits.test.ts pins what a
// conversion does there. A run of breaks with nothing between them is one gap, so that a paragraph
// pasted with a blank line drawn as two breaks does not keep one of them as an empty first line of
// the piece left behind.

import type { CommandProps } from "@tiptap/core";
import type { Attrs, Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { canSplit } from "@tiptap/pm/transform";

/** The blocks whose lines are the author's own: prose that wraps, not code. */
const WRAPPED = new Set(["paragraph", "heading"]);

/** A line ending inside a block, as offsets into the block's content. */
interface Break {
  from: number;
  to: number;
}

/**
 * Every line ending in the block, adjacent ones folded into one.
 *
 * A soft break is a newline in a text node, a hard break is a node of its own, and both are one
 * position wide, which is what lets the two be deleted the same way.
 */
function breaksIn(parent: ProseMirrorNode): Break[] {
  const breaks: Break[] = [];
  const add = (from: number, to: number) => {
    const last = breaks[breaks.length - 1];
    if (last && last.to === from) last.to = to;
    else breaks.push({ from, to });
  };
  parent.forEach((child, offset) => {
    if (child.isText) {
      const text = child.text ?? "";
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
        add(offset + i, offset + i + 1);
      }
    } else if (child.type.name === "hardBreak") {
      add(offset, offset + child.nodeSize);
    }
  });
  return breaks;
}

/**
 * A chainable command that cuts the selected line out of its block, when the block is about to be
 * turned into `type` and it holds other lines besides this one.
 *
 * Goes ahead of the command that converts, in the same chain, so the two are one undo step and
 * `change` in src/editor/fits.ts judges the pair together. True when a line was cut and false when
 * there was nothing to cut, which the chain does not act on: the conversion behind it runs either
 * way, on the isolated line or on the whole block.
 *
 * Nothing is cut when the block already is what is being asked for, so Heading 2 on a line of a
 * level 2 heading leaves the heading whole. Where the line's block sits is not asked about: TipTap's
 * `setNode` lifts a block out of whatever will not hold the new one, a heading out of the front of
 * a list item for instance, and it does that to the line the same way it did to the block.
 */
export function isolatingLine(type: NodeType, attrs: Attrs = {}) {
  return ({ tr, dispatch }: CommandProps): boolean => {
    const { $from, $to } = tr.selection;
    if (!$from.sameParent($to)) return false;
    const parent = $from.parent;
    if (!WRAPPED.has(parent.type.name) || parent.hasMarkup(type, attrs)) return false;

    const breaks = breaksIn(parent);
    const head = breaks.filter((b) => b.to <= $from.parentOffset).pop() ?? null;
    const tail = breaks.find((b) => b.from >= $to.parentOffset) ?? null;
    if (!head && !tail) return false;

    const start = $from.start();
    if ((head && !canSplit(tr.doc, start + head.from)) || (tail && !canSplit(tr.doc, start + tail.from))) {
      return false;
    }
    if (!dispatch) return true;

    // Where the selection sits inside its line, so it can be put back after the line has moved.
    const lineStart = head ? head.to : 0;
    const from = $from.parentOffset - lineStart;
    const to = $to.parentOffset - lineStart;

    // The tail first, so the head's positions are still the ones measured above.
    if (tail) {
      const at = start + tail.from;
      tr.delete(at, at + (tail.to - tail.from));
      tr.split(at);
    }
    if (head) {
      const at = start + head.from;
      tr.delete(at, at + (head.to - head.from));
      tr.split(at);
    }
    // A split puts a closing and an opening token where the break was, so the isolated line's
    // content begins two positions past the cut.
    const lineAt = head ? start + head.from + 2 : start;
    tr.setSelection(TextSelection.create(tr.doc, lineAt + from, lineAt + to));
    return true;
  };
}
