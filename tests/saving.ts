// Watching the unsaved dot without racing the thing that clears it.
//
// The dot is on screen from the first keystroke until the autosave lands, which is 500ms after the
// last one plus however long the write takes. Two specs assert it appears, and both did it by
// looking for it after the typing had finished, which is a poll against a deadline: the dot is
// there for half a second, and a run that stalls for half a second between the last keystroke and
// the first look reads a document that has already been saved and calls it a document that was
// never dirty. Nothing is wrong with the app in that run. The test just arrived late.
//
// So the answer is recorded as it happens rather than asked for afterwards. A MutationObserver
// installed before the typing starts sees the dot go in, and the assertion is about what was seen.
// It is also the stronger claim of the two: a poll that happens to land inside the window cannot
// tell "the dot appeared" from "the dot was already there", and this can.

import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    /** What the observer below has seen since it was installed. */
    __dirtyDot: { seen: boolean; visible: boolean };
  }
}

/** Starts watching. Anything the dot does before this call is not recorded, so call it first. */
export function watchDirty(page: Page): Promise<void> {
  return page.evaluate(() => {
    const state = { seen: false, visible: false };
    window.__dirtyDot = state;

    // Painted as well as present: the dot is a span with nothing in it, so a rule that stopped
    // drawing it would leave every assertion about it passing.
    const look = (): void => {
      if (state.seen) return;
      const dot = document.querySelector(".dirty-dot");
      if (!dot) return;
      state.seen = true;
      state.visible = dot.checkVisibility();
    };

    new MutationObserver(look).observe(document.body, { subtree: true, childList: true });
    look();
  });
}

/** That the document was marked unsaved at some point since `watchDirty`. */
export async function dirtyWasShown(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__dirtyDot), {
      message: "the unsaved dot was never on screen",
    })
    .toEqual({ seen: true, visible: true });
}
