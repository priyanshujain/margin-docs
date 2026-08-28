// The guards that stand between somebody's document and a key they pressed, driven through a real
// EditorView with a real mouse and a real Cmd+V.
//
// This file exists because of what the unit suite cannot see. src/editor/fits.test.ts builds the
// real extension list, collects the real plugin list and walks it with prosemirror-view's own
// someProp, and that is as close as node gets: vitest runs with no DOM, so there is no view to
// construct and no event to send to one. Four times this project has shipped a guard that was
// written, documented, tested and never reached, and the last of them was reached by nothing
// because a library plugin claimed the paste nine places ahead of it. No handler-level test can
// catch that. A browser can, and this is the browser.
//
// So nothing here calls anything. A drag is `page.mouse`, a paste is `Meta+v` off the real system
// clipboard, and every assertion is about what is on screen afterwards. If a guard stops being
// asked, the bytes move and these fail.

import { expect, test, type Page } from "@playwright/test";
import { caretIsIn, putCaret } from "./caret";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;

async function openReadme(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-dev-empty", "1");
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await page.locator(`.tree-row[data-path="${README}"]`).click();
  await expect(page.locator(".prose h1")).toHaveText("Handbook");
}

test("a paste over a dragged rectangle of cells leaves every cell alone", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openReadme(page);

  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await caretIsIn(paragraph);
  await page.locator('.editor-toolbar .tool[title="Insert table"]').click();
  await page.locator('.table-pop .size-cell[title="3 by 3 table"]').click();

  const cell = (row: number, column: number) =>
    page.locator(".prose table tr").nth(row).locator("th, td").nth(column);
  for (const [row, column, text] of [
    [0, 0, "aa"],
    [0, 1, "bb"],
    [1, 0, "cc"],
    [1, 1, "dd"],
  ] as Array<[number, number, string]>) {
    await cell(row, column).click();
    // Typed only once the click has reached the view. A cell is small enough that the hit test
    // cannot land anywhere else, but the keystrokes still go wherever the view thinks the caret
    // is, and that is the cell before this one until it has read the click.
    await caretIsIn(cell(row, column));
    await page.keyboard.type(text);
  }

  // A real drag across the rectangle. Nothing else makes a CellSelection, which is the selection
  // the whole question is about: prosemirror-tables answers a paste made over one by replacing the
  // content of every cell in it, so four cells of somebody's table went for one word on the
  // clipboard, and an image-only clipboard, which carries an empty slice, emptied all four.
  const first = await cell(0, 0).boundingBox();
  const last = await cell(1, 1).boundingBox();
  if (!first || !last) throw new Error("the table is not on screen");
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".prose table .selectedCell")).toHaveCount(4);

  await page.evaluate(() => navigator.clipboard.writeText("zzz"));
  await page.keyboard.press("Meta+v");
  // The one wait in this suite that has to be a wait. What is asserted below is that nothing
  // happened, and nothing happening has no event to listen for: the only way to be sure a paste
  // was refused rather than still in flight is to give it time to arrive and then look.
  await page.waitForTimeout(300);

  const table = await page.locator(".prose table").first().innerText();
  expect(table).not.toContain("zzz");
  expect(table).toContain("aa");
  expect(table).toContain("bb");
  expect(table).toContain("cc");
  expect(table).toContain("dd");
});

test("a paste of two paragraphs into a fence does not split the fence", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openReadme(page);

  const paragraph = page.locator(".prose p").first();
  const words = (await paragraph.innerText()).trim();
  await paragraph.click();
  await caretIsIn(paragraph);
  await page.locator('.editor-toolbar .tool[title="Code block"]').click();
  const fence = page.locator(".prose pre").filter({ hasText: words });
  await expect(fence).toHaveCount(1);
  // Counted rather than matched on its text, because the paste is about to change that text and a
  // filter that stops matching would read as a fence that has gone.
  const fencesBefore = await page.locator(".prose pre").count();
  await fence.click();
  // Which character of the fence the caret is on does not matter here and is deliberately not
  // pinned: a paste in the middle of a block is the one that used to split it. That it is in the
  // fence at all does matter, and that is what this waits for.
  await caretIsIn(fence);

  // ProseMirror does not refuse a paste that does not fit. It splits whatever the caret was in and
  // puts the pieces either side, so before the guard was reached this left two fences with the
  // pasted prose sitting between them.
  await page.evaluate(() => navigator.clipboard.writeText("para one\n\npara two"));
  await page.keyboard.press("Meta+v");
  // The paste has landed when its last word is on screen, wherever the guard put it. A fixed wait
  // here is either longer than the run needs or shorter than a slow one does, and the assertions
  // below are the ones that say where it went.
  await expect(page.locator(".prose")).toContainText("para two");

  expect(await page.locator(".prose pre").count()).toBe(fencesBefore);
  const code = await page.locator(".prose pre code").first().innerText();
  expect(code).toContain("para one");
  expect(code).toContain("para two");
  // And the words the fence was made out of are still all in one fence, rather than half of them
  // sitting in a second one under the pasted prose.
  expect(code.replace(/para one|para two|\n/g, "")).toBe(words.replace(/\n/g, ""));
});

test("Shift+Enter at the end of a heading does not put a break in it", async ({ page }) => {
  await openReadme(page);

  // The caret is placed and then checked, because clicking a heading and pressing a key straight
  // afterwards lands at offset zero often enough to make this test lie, and a break in the MIDDLE
  // of a level one heading is one the file can hold.
  const heading = page.locator(".prose h1").first();
  await heading.click();
  await putCaret(heading, "end");

  // A break with nothing after it has no last line for the underline to go under, so mdast writes
  // no underline and the heading goes to disk as `Handbook\` and comes back as a paragraph. The
  // key is claimed and does nothing, rather than declined, because a browser handed Shift+Enter in
  // a contenteditable puts a <br> in by itself.
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".prose h1")).toHaveCount(1);
  expect(await page.locator(".prose h1").first().innerHTML()).toBe("Handbook");

  // And the same key one character in, which markdown spells as a setext heading and which
  // therefore still works. Without this a guard that refused every break would pass the assertion
  // above, which is the shape of test this round was sent to get rid of.
  await putCaret(heading, 7);
  await page.keyboard.press("Shift+Enter");
  // Polled rather than slept on. The break arrives in the frame the key is answered in, and a
  // fixed wait is only ever either longer than the run needs or shorter than a slow one does.
  await expect.poll(() => heading.innerHTML()).toBe("Handboo<br>k");
});
