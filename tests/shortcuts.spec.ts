// The two chords that moved, pressed for real.
//
// A binding is proved by the key and not by the handler, and this pair is the reason that rule is
// written down. Cmd+K reaching the link popover is four things agreeing at once: the table in
// src/keys/bindings.ts owning the combo, the capture-phase listener in src/keys/keymap.ts letting
// it through with the caret inside a contenteditable, the command table dispatching it, and
// src/editor/Toolbar.tsx being subscribed. A unit test can see any one of those and none of the
// four together, and the version of this feature that shipped before it was a window listener
// checking `defaultPrevented`, which passed every test it had and never fired.
//
// The palette moving off Cmd+K is asserted from both ends: the new chord opens it, and the old one
// does not. A swap that only added the new binding would leave the palette stealing the link key
// and look green from the palette's side.

import { expect, test, type Page } from "@playwright/test";
import { caretIsIn, putCaret } from "./caret";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** A launch with the README open and the caret in its first paragraph, which is where a person
 * pressing any of these keys would be. */
async function openReadme(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  await page.locator(row(README)).click();
  await expect(page.locator(".prose")).toBeVisible();

  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await caretIsIn(paragraph);
}

test("Cmd+K opens the link popover rather than the command palette", async ({ page }) => {
  await openReadme(page);

  await page.keyboard.press("Meta+k");

  const popover = page.locator(".link-pop");
  await expect(popover).toBeVisible();
  await expect(popover.locator(".link-input")).toBeFocused();
  // The chord's previous owner, which must not have answered as well.
  await expect(page.locator(".palette")).toHaveCount(0);

  // A second press is the same gesture again, so it closes what the first one opened.
  await page.keyboard.press("Meta+k");
  await expect(popover).toHaveCount(0);
});

test("Cmd+K puts a real link in the document", async ({ page }) => {
  await openReadme(page);
  await putCaret(page.locator(".prose p").first(), "end");

  await page.keyboard.press("Meta+k");
  await page.locator(".link-pop .link-input").fill("https://example.com");
  await page.keyboard.press("Enter");

  // With a collapsed caret the address goes in as linked text, which is src/editor/Editor.tsx's
  // answer for a link with nothing selected to hang it on.
  await expect(page.locator('.prose p a[href="https://example.com"]')).toHaveCount(1);
  await expect(page.locator(".link-pop")).toHaveCount(0);
});

test("Cmd+Shift+P opens the command palette and Cmd+P still opens quick open", async ({ page }) => {
  await openReadme(page);

  // The capital is load bearing. A real keyboard hands the shifted character to the page, so the
  // event's `key` is "P" and the table spells the combo `cmd+P`, but Playwright sends whatever
  // character it is given: `Meta+Shift+p` arrives as a "p" with shiftKey set, which is a keystroke
  // no hardware produces and which this app would answer as quick open.
  await page.keyboard.press("Meta+Shift+P");
  const palette = page.locator('.palette[aria-label="Command palette"]');
  await expect(palette).toBeVisible();
  await expect(palette.locator(".palette-field")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  await page.keyboard.press("Meta+p");
  await expect(page.locator('.palette[aria-label="Quick open"]')).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the link chord belongs to the document, so an open palette keeps it", async ({ page }) => {
  await openReadme(page);

  await page.keyboard.press("Meta+Shift+P");
  await expect(page.locator('.palette[aria-label="Command palette"]')).toBeVisible();

  // Bound in the document context on purpose: there is no selection behind an overlay to put an
  // address on, so the key does nothing here rather than opening a popover under the palette.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".link-pop")).toHaveCount(0);
  await expect(page.locator('.palette[aria-label="Command palette"]')).toBeVisible();
});

test("Cmd+U says markdown has no underline instead of underlining", async ({ page }) => {
  await openReadme(page);
  const paragraph = page.locator(".prose p").first();
  const before = await paragraph.innerHTML();

  await page.keyboard.press("Meta+u");

  await expect(page.locator(".toast")).toHaveText(/no underline/);
  // The half that needed the key taken rather than left alone: WebKit's own answer to Cmd+U in a
  // contenteditable is a `<u>` around the selection, and the schema has nowhere to put one.
  await expect(paragraph.locator("u")).toHaveCount(0);
  expect(await paragraph.innerHTML()).toBe(before);
});
