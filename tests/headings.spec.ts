// A heading asked for on one line of a block that holds several, driven from the pill the way a
// person drives it, and read back off the disk.
//
// The bug this exists for came in through a paste. A note pasted out of a chat window is one
// paragraph with two hard breaks between what were messages, which on screen is several paragraphs
// with space between them. Selecting the first of those lines and choosing Heading 2 turned the
// whole block into a heading, the line under it went to heading size too, and the file got a setext
// heading with the next paragraph inside it. src/editor/lines.test.ts pins the bytes; this is the
// gesture, because a guard or a cut that only a unit test has ever reached is one that ships
// without anybody knowing whether the toolbar gets there.

import { expect, test, type Page } from "@playwright/test";
import { caretIsIn } from "./caret";
import { ask, change, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Longer than the 500ms autosave debounce in src/document.ts, with room for the write itself. */
const SAVED = 1500;

const QUESTION = "Question: Would you expect the tendency to be less overt?";

async function open(page: Page, source: string): Promise<void> {
  await page.addInitScript(installTauriShim);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  await page.locator(row(README)).click();
  await expect(page.locator(".prose")).toBeVisible();

  await change(page, "write", README, source);
  await expect.poll(() => ask<string>(page, "read", README)).toBe(source);
}

/** Drags across a word the way a mouse does, so the selection is the browser's and not a script's. */
async function drag(page: Page, word: string): Promise<void> {
  const box = await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector(".prose")!, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const at = (node as Text).data.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return null;
  }, word);
  if (!box) throw new Error(`no "${word}" on the page`);
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(word);
}

async function chooseHeading(page: Page, item: string): Promise<void> {
  await page.locator('.editor-toolbar .tool[aria-label="Heading"]').click();
  await page.locator(".heading-pop button", { hasText: item }).click();
}

test("Heading 2 on the first line of a pasted block takes that line and not the block", async ({
  page,
}) => {
  await open(page, `Heasder\\\n\\\n${QUESTION}\n`);
  await page.locator(".prose p").first().click();
  await caretIsIn(page.locator(".prose p").first());

  await drag(page, "Heasder");
  await chooseHeading(page, "Heading 2");

  await expect(page.locator(".prose h2")).toHaveText("Heasder");
  await expect(page.locator(".prose p")).toHaveText(QUESTION);

  await page.waitForTimeout(SAVED);
  expect(await ask<string>(page, "read", README)).toBe(`## Heasder\n\n${QUESTION}\n`);
});

test("Heading 2 on a line of a hand wrapped paragraph takes that line", async ({ page }) => {
  await open(page, `Heasder\n${QUESTION}\n`);
  await page.locator(".prose p").first().click();
  await caretIsIn(page.locator(".prose p").first());

  await drag(page, "Heasder");
  await chooseHeading(page, "Heading 2");

  await expect(page.locator(".prose h2")).toHaveText("Heasder");
  await expect(page.locator(".prose p")).toHaveText(QUESTION);

  await page.waitForTimeout(SAVED);
  expect(await ask<string>(page, "read", README)).toBe(`## Heasder\n\n${QUESTION}\n`);
});

test("Paragraph on the second line of a wrapped heading gives that line back", async ({ page }) => {
  // The state the bug left a document in, and the gesture somebody reaches for to put it right.
  await open(page, `Heasder\n${QUESTION}\n-----\n`);
  await page.locator(".prose h2").click();
  await caretIsIn(page.locator(".prose h2"));

  await drag(page, "Question");
  await chooseHeading(page, "Paragraph");

  await expect(page.locator(".prose h2")).toHaveText("Heasder");
  await expect(page.locator(".prose p")).toHaveText(QUESTION);

  await page.waitForTimeout(SAVED);
  expect(await ask<string>(page, "read", README)).toBe(`## Heasder\n\n${QUESTION}\n`);
});
