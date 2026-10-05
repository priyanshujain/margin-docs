// The outline rail, driven for real. The ticks come off the document on screen and change with it,
// the pointer over them opens the list, a click on a row puts the caret in that heading with the
// heading at the top of the pane, the tick for the section on screen follows the scroll, and the
// rail hides and shows on its key.
//
// The pane is short here on purpose. Bringing a heading to the top of the pane needs a pane's worth
// of document under it, and the fixture's documents are a screen or two long at most, so at the
// suite's usual 900px the heading this file clicks would stop wherever the scroller ran out.

import { expect, test, type Page } from "@playwright/test";
import { caretIsIn } from "./caret";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;
const GUIDES = `${HANDBOOK}/guides`;
const WRITING = `${GUIDES}/writing.md`;
const NOTES = `${HANDBOOK}/notes.txt`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

test.use({ viewport: { width: 1100, height: 520 } });

async function openHandbook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
}

async function openWriting(page: Page): Promise<void> {
  await openHandbook(page);
  await page.locator(row(GUIDES)).click();
  await page.locator(row(WRITING)).click();
  await expect(page.locator(".prose h1")).toHaveText("Writing");
}

/** How far the top of an element sits below the top of the document pane. */
function offsetInPane(page: Page, selector: string, nth: number): Promise<number> {
  return page.evaluate(
    ([selector, nth]) => {
      const target = document.querySelectorAll(selector)[nth as number];
      const pane = document.querySelector(".editor-pane");
      if (!target || !pane) return Number.NaN;
      return target.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    },
    [selector, nth] as const,
  );
}

test("draws a tick per heading and opens into the list under the pointer", async ({ page }) => {
  await openHandbook(page);

  // Nothing open, so no rail: it is about a document and there is none.
  await expect(page.locator(".outline")).toHaveCount(0);

  await page.locator(row(GUIDES)).click();
  await page.locator(row(WRITING)).click();
  const ticks = page.locator(".outline-tick");
  await expect(ticks).toHaveCount(3);
  await expect(ticks.nth(0)).toHaveAttribute("data-depth", "0");
  await expect(ticks.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(ticks.nth(2)).toHaveAttribute("data-depth", "1");
  await expect(page.locator(".outline-panel")).toHaveCount(0);

  await page.locator(".outline-rail").hover();
  const rows = page.locator(".outline-row");
  await expect(rows).toHaveText([
    "Writing",
    "What the editor does with what you type",
    "Before you open a pull request",
  ]);
  await expect(rows.nth(1)).toHaveAttribute("data-depth", "1");

  // The pointer leaving takes the list with it.
  await page.mouse.move(500, 300);
  await expect(page.locator(".outline-panel")).toHaveCount(0);
  await expect(ticks).toHaveCount(3);

  // The rail follows the document, not the folder.
  await page.locator(row(README)).click();
  await expect(ticks).toHaveCount(2);

  // A .txt has no headings to draw and gets no rail rather than an empty one.
  await page.locator(row(NOTES)).click();
  await expect(page.locator(".prose")).toHaveCount(0);
  await expect(page.locator(".outline")).toHaveCount(0);
});

test("a click on a row puts the caret in the heading and brings it to the top of the pane", async ({
  page,
}) => {
  await openWriting(page);

  await page.locator(".outline-rail").hover();
  const rows = page.locator(".outline-row");
  await expect(rows.nth(1)).toHaveAttribute("data-current", "false");

  await rows.nth(1).click();

  const heading = page.locator(".prose h2").first();
  await caretIsIn(heading);
  await expect
    .poll(() => offsetInPane(page, ".prose h2", 0), { message: "the heading never reached the top" })
    .toBeLessThan(60);
  expect(await offsetInPane(page, ".prose h2", 0)).toBeGreaterThanOrEqual(0);

  // The list stays up under the pointer, and now says where the reader is.
  await expect(rows.nth(1)).toHaveAttribute("data-current", "true");
  await expect(page.locator(".outline-tick").nth(1)).toHaveAttribute("data-current", "true");
});

test("the tick for the section on screen follows the scroll", async ({ page }) => {
  await openWriting(page);
  const ticks = page.locator(".outline-tick");
  const pane = page.locator(".editor-pane");

  // At the top the H1 is in the top third of the pane, so the reader is in its section.
  await expect(ticks.nth(0)).toHaveAttribute("data-current", "true");

  await pane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(ticks.nth(2)).toHaveAttribute("data-current", "true");
  await expect(ticks.nth(0)).toHaveAttribute("data-current", "false");

  await pane.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(ticks.nth(0)).toHaveAttribute("data-current", "true");
});

test("hides and shows on its key", async ({ page }) => {
  await openWriting(page);
  await expect(page.locator(".outline")).toHaveCount(1);

  // Cmd+Shift+\, pressed with the caret in the document, which is where a person pressing it is.
  // Spelled as the key the browser reports for it rather than as the fingers, because Playwright
  // does not shift a punctuation key while Meta is held: "Meta+Shift+\" arrives as a backslash
  // with the shift flag on, which is the sidebar's chord and not this one. A real keyboard reports
  // the bar, and the keymap reads the key and never the flag.
  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await caretIsIn(paragraph);
  await page.keyboard.press("Meta+|");
  await expect(page.locator(".outline")).toHaveCount(0);

  await page.keyboard.press("Meta+|");
  await expect(page.locator(".outline")).toHaveCount(1);
});
