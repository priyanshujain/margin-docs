// Putting a caret somewhere on purpose, for the specs that press a key afterwards.
//
// Every test in here that types has the same two steps underneath, and both of them are less
// certain than they look.
//
// A click is a hit test. Which character it lands on is decided by the pixel it happened to be
// aimed at, by the element's scroll position at that instant, and by whichever line box the point
// fell in. A fence is the worst case of all three at once: `.prose pre > code` is `white-space:
// pre` with `overflow-x: auto`, so a block wider than the column is scrolled by whatever the caret
// was doing a moment ago, and Playwright aims at the middle of the box, which for a two line block
// is a hair from the boundary between the two lines. The same gesture, repeated at the same
// coordinates, was measured landing at three different offsets in three different text nodes.
//
// End is worse again, and this project has now been bitten by it twice. It is a different key on
// every platform, on macOS it is not a key anyone presses to move a caret, and what answers it
// here moves by line: a block of two lines answers it two ways depending on which of them the
// click chose. One of those two answers puts the next keystroke in the middle of the block, and
// tests/blocks.spec.ts was asserting the text of the whole block afterwards. So nothing in this
// suite presses End to move a caret. It places one and reads it back.
//
// Read back as a character offset rather than as a DOM node and an offset in it, because
// prosemirror-view rewrites the nodes under a code block on every keystroke, and the same caret in
// a differently split span is still the same caret.
//
// The two frames are the other half. prosemirror-view takes the browser's selection into its own
// state on a selectionchange, and a key sent before it has done so is answered about the position
// the caret used to be in. A person cannot press two keys inside one frame; Playwright can, and
// did, about a third of the time.

import { expect, type Locator, type Page } from "@playwright/test";

/** A character offset into an element's text, or either end of it. */
export type Where = "start" | "end" | number;

/** What the browser says about the caret, in the terms this file checks it in. */
interface CaretState {
  /** How many characters of the element's text are before the caret, or null if it is elsewhere. */
  offset: number | null;
  /** Whether the editable this element belongs to is the one holding the keyboard. */
  focused: boolean;
}

/**
 * Two animation frames, which is what it takes for prosemirror-view to have read a selection back.
 */
export function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Where the browser has the caret, measured against this element. */
function caretState(target: Locator): Promise<CaretState> {
  return target.evaluate((element) => {
    const editable = element.closest("[contenteditable='true']");
    const focused = editable !== null && document.activeElement === editable;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return { offset: null, focused };
    }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return { offset: null, focused };
    const measure = document.createRange();
    measure.selectNodeContents(element);
    measure.setEnd(range.startContainer, range.startOffset);
    return { offset: measure.toString().length, focused };
  });
}

/**
 * Puts the caret at a named place in an editable element and does not return until the browser
 * agrees it is there and the view has had its two frames to notice.
 *
 * The element has to be holding the keyboard already, which in these specs means a real click went
 * in first: this places a caret, it does not decide who has focus, and a selection written into an
 * editable nobody is in is read by nobody.
 */
export async function putCaret(target: Locator, where: Where): Promise<void> {
  const wanted = await target.evaluate((element, at) => {
    const text = element.textContent ?? "";
    const offset =
      at === "start" ? 0 : at === "end" ? text.length : Math.max(0, Math.min(at, text.length));

    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let seen = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (offset <= seen + node.data.length) {
        range.setStart(node, offset - seen);
        range.collapse(true);
        break;
      }
      seen += node.data.length;
    }

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return offset;
  }, where);

  await settle(target.page());
  // Still there after the frames, rather than only just after it was written: if the view had a
  // different idea of where the caret was it would have put its own back by now, and a test that
  // typed anyway would be typing somewhere nobody can see.
  await expect
    .poll(() => caretState(target), { message: `the caret did not settle at ${wanted}` })
    .toEqual({ offset: wanted, focused: true });
}

/**
 * Waits until the caret is somewhere inside this element, wherever a click put it, and gives the
 * view its two frames. For the gestures where the point is that a click reaches the caret at all
 * and the offset it lands on is nobody's business.
 */
export async function caretIsIn(target: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await caretState(target);
        return { inside: state.offset !== null, focused: state.focused };
      },
      { message: "the caret never landed in the element that was clicked" },
    )
    .toEqual({ inside: true, focused: true });
  await settle(target.page());
}
