// What a keystroke does to a coloured word, read off the disk rather than off the screen.
//
// The sibling of bytes.spec.ts and here for the same reason. A colour is a mark, a mark is drawn as
// an element, and between the key and the serializer sits prosemirror-view reparsing its own DOM:
// what comes back out of that parse is what gets saved. A mark whose `parseDOM` rule does not
// recognise its own `toDOM` output survives every unit test in the repository, because a unit test
// builds the document by hand and never renders it, and then vanishes on the first keystroke in the
// paragraph it is in. That is the whole reason src/model/schema.ts writes the hex into a data
// attribute rather than leaving it to be read back off a style the browser has normalised.
//
// So these tests type into a running editor and then ask the file what happened. Slow, and few on
// purpose.

import { expect, test, type Page } from "@playwright/test";
import { putCaret } from "./caret";
import { ask, change, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Longer than the 500ms autosave debounce in src/document.ts, with room for the write itself. */
const SAVED = 1500;

const RED = "#c4453a";
const AMBER = "#977927";

/** Opens the README with the given bytes in it and waits for them to be on screen. */
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

  // Written from outside rather than typed, so the app has not registered a self-write and this is
  // a file it has only ever read.
  await change(page, "write", README, source);
  await expect.poll(() => ask<string>(page, "read", README)).toBe(source);
}

/** What is on disk now. */
function disk(page: Page): Promise<string> {
  return ask<string>(page, "read", README);
}

test("a colour is drawn from the document, and the hex is kept somewhere it survives", async ({ page }) => {
  // The control for everything below, and the measurement behind the data attribute rather than an
  // argument for it. The style attribute this app writes is `color: #c4453a` and the attribute the
  // browser hands back is `color: rgb(196, 69, 58)`: it parses what it is given and reserialises
  // it, so a parse rule reading the colour off the style would have to undo that, in every notation
  // CSS has, before it could tell whether the mark it just drew is the mark it is looking at.
  await open(page, `A <span style="color: ${RED}">red</span> word.\n`);

  const span = page.locator(".prose p span[data-text-color]");
  await expect(span).toHaveText("red");
  await expect(span).toHaveAttribute("data-text-color", RED);
  await expect(span).toHaveCSS("color", "rgb(196, 69, 58)");
  expect(await span.getAttribute("style")).not.toContain(RED);
});

test("a highlight is a mark carrying the document's background", async ({ page }) => {
  await open(page, `A <mark style="background-color: ${AMBER}">lit</mark> word.\n`);

  const mark = page.locator(".prose p mark[data-highlight]");
  await expect(mark).toHaveText("lit");
  await expect(mark).toHaveAttribute("data-highlight", AMBER);
  await expect(mark).toHaveCSS("background-color", "rgb(151, 121, 39)");
  // The user agent gives a <mark> black text as well as a yellow background, which is black on a
  // mid tone under the dark theme. prose.css puts it back to the document's own ink.
  await expect(mark).toHaveCSS("color", await page.locator(".prose p").first().evaluate((el) => getComputedStyle(el).color));
});

test("one character typed into a coloured word keeps the colour", async ({ page }) => {
  // The failure this file exists for. The mark is on screen, the character lands, and the reparse
  // decides whether the save still has a colour in it.
  await open(page, `A <span style="color: ${RED}">red</span> word.\n`);

  await putCaret(page.locator(".prose p").first(), 3);
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(`A <span style="color: ${RED}">rZed</span> word.\n`);
});

test("one character typed beside a highlight keeps the highlight where it was", async ({ page }) => {
  await open(page, `A <mark style="background-color: ${AMBER}">lit</mark> word.\n`);

  await putCaret(page.locator(".prose p").first(), 0);
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(`ZA <mark style="background-color: ${AMBER}">lit</mark> word.\n`);
});

test("an edit in one paragraph leaves the colours in the next one alone", async ({ page }) => {
  // The quiet one. Every mark in the document goes through the same reparse, so a colour three
  // paragraphs from the caret is as exposed as the one under it, and a file that lost those would
  // look perfectly fine on screen until it was opened somewhere else.
  const source = [
    "Plain paragraph.",
    "",
    `A <span style="color: ${RED}">red</span> word and a <mark style="background-color: ${AMBER}">lit</mark> one.`,
    "",
    `<mark style="background-color: ${AMBER}"><span style="color: ${RED}">Both at once.</span></mark>`,
    "",
  ].join("\n");
  await open(page, source);

  await putCaret(page.locator(".prose p").first(), "end");
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(source.replace("Plain paragraph.", "Plain paragraph.Z"));
});

test("a colour spanning a hand wrapped line keeps the wrap through a keystroke", async ({ page }) => {
  // Two things that are each other's worst case. The wrap survives because the paragraph is
  // `whitespace: "pre"`, and the closing tag stays on the second line because it is written as a
  // phrasing literal; a keystroke asks both questions at once.
  const source = `<span style="color: ${RED}">over\ntwo lines</span> here.\n`;
  await open(page, source);

  await putCaret(page.locator(".prose p").first(), "end");
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(`<span style="color: ${RED}">over\ntwo lines</span> here.Z\n`);
});

test("a span this app did not write stays the raw block it was read as", async ({ page }) => {
  // The other half of the promise, from the editor's side: a spelling the parser refuses is a block
  // of preserved source, and an edit somewhere else must not rewrite it into anything.
  const source = `Plain paragraph.\n\n<span class="colour">Not our spelling.</span>\n`;
  await open(page, source);

  await expect(page.locator(".prose pre[data-raw]")).toHaveCount(1);
  await putCaret(page.locator(".prose p").first(), "end");
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(`Plain paragraph.Z\n\n<span class="colour">Not our spelling.</span>\n`);
});
