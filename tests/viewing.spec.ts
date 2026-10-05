// Looking at a file this app cannot edit, and the one thing that has to be true afterwards.
//
// A viewer is a place a file arrives from disk and nothing goes back, so the assertion this feature
// actually needs is about the disk: the bytes and the modification time of the file that was opened
// are the ones it had before, after the autosave debounce has been given long enough to have run.
// Everything else on screen is worth checking too, but that is the promise. tests/bytes.spec.ts
// makes the same claim about a document somebody typed into; this makes it about a picture nobody
// can type into at all, which is the easier half to get right and the worse one to get wrong.
//
// The fixture behind this is src/dev/mockIpc.ts, the same one `pnpm dev` runs against, so the PNG,
// the SVG and the PDF here are real files with real bytes: pdf.js parses the PDF and reports its
// pages, and the picture is decoded by the browser rather than by anything this repository wrote.

import { expect, test, type Page } from "@playwright/test";
import { ask, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;
const REFERENCE = `${HANDBOOK}/reference`;
const ASSETS = `${REFERENCE}/assets`;
const PICTURE = `${ASSETS}/diagram.png`;
const DRAWING = `${ASSETS}/architecture.svg`;
const FOREIGN = `${ASSETS}/brand.sketch`;
const SCAN = `${REFERENCE}/checklist.pdf`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Longer than the 500ms autosave debounce in src/document.ts, with room for a write. */
const SAVED = 1500;

/** The folder open, the sidebar showing, and both nested folders expanded. */
async function openHandbook(page: Page): Promise<void> {
  await page.addInitScript(installTauriShim);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  await page.locator(row(REFERENCE)).click();
  await page.locator(row(ASSETS)).click();
  await expect(page.locator(row(PICTURE))).toBeVisible();
}

/** The file as the fixture holds it: base64 for a binary file, and the time it last changed. */
async function onDisk(page: Page, path: string): Promise<{ data: string; modified: number }> {
  return {
    data: await ask<string>(page, "read", path),
    modified: await ask<number>(page, "modified", path),
  };
}

test("a picture opens in the pane and the file on disk does not move", async ({ page }) => {
  await openHandbook(page);
  const before = await onDisk(page, PICTURE);

  await page.locator(row(PICTURE)).click();

  const image = page.locator(".viewer-image");
  await expect(image).toBeVisible();
  // A blob url, which is bytes this app read and handed to the browser. Not a file path, because
  // the asset protocol is off and there is nothing else for the CSP to allow.
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".viewer-name")).toHaveText("diagram.png");

  // Nothing that edits is in the tree beside it.
  await expect(page.locator(".prose")).toHaveCount(0);
  await expect(page.locator(".editor-toolbar")).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0);

  // The size on disk and the dimensions the browser decoded, said quietly and said correctly: the
  // fixture's PNG really is one pixel across.
  await expect(page.locator(".viewer-meta")).toHaveText("1 × 1 · 70 bytes");

  // The row is the current one, the way an open document's row is.
  await expect(page.locator(row(PICTURE))).toHaveAttribute("data-current", "true");

  // Long enough that a debounce armed by opening the file would have fired by now.
  await page.waitForTimeout(SAVED);
  expect(await onDisk(page, PICTURE)).toEqual(before);
});

test("a picture can be seen at its natural size and back again", async ({ page }) => {
  await openHandbook(page);
  await page.locator(row(DRAWING)).click();

  const stage = page.locator(".viewer-stage");
  const image = page.locator(".viewer-image");
  await expect(image).toBeVisible();
  await expect(stage).toHaveAttribute("data-zoom", "fit");
  await expect(page.locator(".viewer-meta")).toHaveText(/^2400 × 1600 · /);

  // The drawing is 2400 across and the pane is nothing like that wide, so fitting it is a real
  // reduction and actual size is a picture that has to be scrolled to be seen.
  const fitted = await image.boundingBox();
  expect(fitted?.width).toBeLessThan(2400);
  expect(fitted?.width).toBeGreaterThan(200);

  await page.locator('button[aria-label="Actual size"]').click();
  await expect(stage).toHaveAttribute("data-zoom", "actual");
  const actual = await image.boundingBox();
  expect(actual?.width).toBe(2400);
  expect(actual?.height).toBe(1600);

  await page.locator('button[aria-label="Fit to window"]').click();
  await expect(stage).toHaveAttribute("data-zoom", "fit");
});

test("an svg is drawn as a picture and never put into the document", async ({ page }) => {
  await openHandbook(page);
  await page.locator(row(DRAWING)).click();

  await expect(page.locator(".viewer-image")).toHaveAttribute("src", /^blob:/);
  // The one rule an SVG has that a PNG does not. An `<img>` never runs what the file contains; the
  // same bytes inlined into the page would, and a file somebody was sent is not this app's markup.
  await expect(page.locator(".viewer-stage svg")).toHaveCount(0);
  await expect(page.locator(".viewer-stage circle")).toHaveCount(0);
});

test("a pdf opens as pages, says how many, and leaves the file alone", async ({ page }) => {
  await openHandbook(page);
  const before = await onDisk(page, SCAN);

  await page.locator(row(SCAN)).click();

  await expect(page.locator(".viewer-name")).toHaveText("checklist.pdf");
  // Both pages of the fixture's PDF, one under the other in one scroller, and both drawn: they are
  // small enough to be inside the same viewport.
  await expect(page.locator(".viewer-page")).toHaveCount(2);
  await expect(page.locator(".viewer-canvas")).toHaveCount(2);
  await expect(page.locator(".viewer-meta")).toHaveText(/^2 pages · /);

  await page.waitForTimeout(SAVED);
  expect(await onDisk(page, SCAN)).toEqual(before);
});

test("a file the app cannot show is still greyed and still goes to the system", async ({ page }) => {
  await openHandbook(page);

  await expect(page.locator(row(PICTURE))).toHaveAttribute("data-foreign", "false");
  await expect(page.locator(row(SCAN))).toHaveAttribute("data-foreign", "false");
  await expect(page.locator(row(FOREIGN))).toHaveAttribute("data-foreign", "true");

  await page.locator(row(FOREIGN)).click();
  await expect(page.locator(".viewer")).toHaveCount(0);
  await expect(page.locator(".pane-empty")).toBeVisible();
});

test("reveal and open with the system app stay on the row menu of a file that opens here", async ({
  page,
}) => {
  await openHandbook(page);
  await page.locator(row(SCAN)).click({ button: "right" });

  const menu = page.locator(".row-menu-pop");
  await expect(menu).toBeVisible();
  // A PDF somebody wants to annotate belongs in Preview, and the app does not get to be in the way.
  await expect(menu.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open in Default App" })).toBeVisible();
});

test("opening a document takes the picture off screen, and the other way round", async ({
  page,
}) => {
  await openHandbook(page);

  await page.locator(row(PICTURE)).click();
  await expect(page.locator(".viewer-image")).toBeVisible();

  await page.locator(row(README)).click();
  await expect(page.locator(".prose")).toBeVisible();
  await expect(page.locator(".viewer")).toHaveCount(0);

  await page.locator(row(SCAN)).click();
  await expect(page.locator(".viewer-page").first()).toBeVisible();
  await expect(page.locator(".prose")).toHaveCount(0);
});

test("closing the folder takes the picture with it", async ({ page }) => {
  await openHandbook(page);
  await page.locator(row(PICTURE)).click();
  await expect(page.locator(".viewer-image")).toBeVisible();

  // The row menu on the root is where Close Folder lives. What is being checked is the folder after
  // it: a viewer still holding a path out of the folder that has gone would be drawn over the next
  // one and would then fail to read, since the backend refuses a path outside every open root.
  await page.locator(row(HANDBOOK)).click({ button: "right" });
  await page.locator(".row-menu-pop").getByRole("menuitem", { name: "Close Folder" }).click();

  await expect(page.locator(".start-row")).toBeVisible();
  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  await expect(page.locator(".viewer")).toHaveCount(0);
  await expect(page.locator(".pane-empty")).toBeVisible();
});

test("a document with an unsaved edit is written before a picture replaces it", async ({ page }) => {
  await openHandbook(page);
  const before = await ask<string>(page, "read", README);

  await page.locator(row(README)).click();
  const prose = page.locator(".prose");
  await expect(prose).toBeVisible();
  await prose.locator("p").first().click();
  await page.keyboard.type("edited ");

  // Straight to the picture, well inside the debounce. Closing the document is what flushes it, so
  // the edit has to be on disk afterwards rather than lost with the buffer.
  await page.locator(row(PICTURE)).click();
  await expect(page.locator(".viewer-image")).toBeVisible();

  await expect.poll(() => ask<string>(page, "read", README)).not.toBe(before);
  expect(await ask<string>(page, "read", README)).toContain("edited ");
});
