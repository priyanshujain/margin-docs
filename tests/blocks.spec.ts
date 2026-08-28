// The four blocks M2 added, driven from the pill the way a person drives them.
//
// These exist because of the failure they are shaped to catch. Every one of these blocks is a
// toolbar button, a method on the editor handle, and a command in a file of its own, written by
// somebody who could see only their own end of it. Every piece can be present, typechecked and
// unit tested while the wire between two of them is missing, and nothing but a click in a real
// browser notices. So each test here starts at a button and asserts something only the far end
// could have produced: a real table in the document, KaTeX's markup on the page, highlight.js's
// class names on a span.
//
// The mermaid diagram is deliberately not here. It loads a chunk and renders asynchronously, which
// is a timeout in a test suite rather than an assertion; src/editor/blocks/mermaid.test.ts covers
// the node view and the insert command instead.

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
  // Every test below starts by pressing a tool, and a tool runs its command against the selection
  // the view is holding rather than against the one the browser has. Waiting for the click to
  // arrive there is the difference between inserting into this paragraph and inserting wherever
  // the caret was before the file was opened.
  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await caretIsIn(paragraph);
}

test("the table tool inserts a table, puts the caret in it and keeps the header first", async ({
  page,
}) => {
  await openReadme(page);

  await page.locator('.editor-toolbar .tool[title="Insert table"]').click();
  await page.locator('.table-pop .size-cell[title="3 by 3 table"]').click();

  const table = page.locator(".prose table").first();
  await expect(table.locator("tr")).toHaveCount(3);
  await expect(table.locator("tr").first().locator("th")).toHaveCount(3);

  // The caret went into the new table, which is the only reason the tool can read "Table" rather
  // than still offering to insert one.
  const tool = page.locator('.editor-toolbar .tool[title="Table"]');
  await expect(tool).toBeVisible();

  // A row added while the caret is in the header row: GFM has no row above a header, so the new
  // row is the header and the old one becomes the first body row.
  await tool.click();
  await page.locator(".table-pop button", { hasText: "Above" }).first().click();

  await expect(table.locator("tr")).toHaveCount(4);
  await expect(table.locator("tr").first().locator("th")).toHaveCount(3);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(3);

  // The op that cannot round trip is not offered at all.
  await expect(page.locator(".table-pop button", { hasText: "Header row" })).toHaveCount(0);
});

test("the code block tool sets a language and the fence is coloured by it", async ({ page }) => {
  await openReadme(page);

  // The paragraph's own words are what says this fence is the one the tool just made out of it,
  // rather than any block the document grows later on.
  const paragraph = page.locator(".prose p").first();
  const words = (await paragraph.innerText()).trim();
  await paragraph.click();
  await caretIsIn(paragraph);
  await page.locator('.editor-toolbar .tool[title="Code block"]').click();

  await expect(page.locator(".prose pre").filter({ hasText: words })).toHaveCount(1);
  // Pinned by position from here on. A locator that filters on the text is the right way to
  // identify a block and the wrong way to hold one while it is being typed into: the moment a
  // keystroke lands somewhere unexpected it matches nothing, and a wrong caret is then reported as
  // a thirty second timeout waiting for a fence that has gone rather than as a diff.
  const fence = page.locator(".prose pre").first();
  const code = fence.locator("code");

  await page.locator('.editor-toolbar .tool[title="Code block: no language"]').click();
  await page.locator(".lang-pop button", { hasText: "typescript" }).click();
  await expect(page.locator('.editor-toolbar .tool[title="Code block: typescript"]')).toBeVisible();

  // The caret is put at the end of the fence and read back before a key is pressed, because the
  // two gestures this used to be made of both answer differently from run to run. A click is a hit
  // test, and this fence is a horizontal scroller two lines tall whose middle is a hair from the
  // boundary between them; End then moves the caret by line, so the pair of them landed the
  // keystroke below in the middle of the block on some runs and at the end of it on others, and
  // the last assertion here is about the text of the whole block. tests/caret.ts has the numbers.
  await code.click();
  await putCaret(code, "end");
  await page.keyboard.type(" const x = 1;");

  // Decorations, from a grammar, over text the highlighter never rewrote. Asked for the one word
  // rather than the first span, because the paragraph this fence was made out of has words in it
  // that TypeScript reserves too.
  await expect(code.locator(".hljs-keyword").filter({ hasText: /^const$/ })).toHaveCount(1);
  await expect(code).toHaveText(`${words} const x = 1;`);
});

// The same block, with the caret on the first of its two lines, which is the state the test above
// was a coin flip in.
//
// A fence does not wrap. Its `code` is a horizontal scroller of whole lines, so this one is two
// lines tall, and a click aimed at the middle of the element is aimed within a pixel or two of the
// boundary between them. Which line it lands on decides what End does next, because what answers
// End moves the caret to the end of a line and not to the end of a block: from the first line it
// stops at "and nothing", eleven words short of where the next keystroke was supposed to go. That
// was measured landing both ways on the same machine on the same afternoon.
//
// The click below is therefore aimed at a point read off the first line itself rather than at the
// middle of the element, so the caret starts somewhere known, and the gesture under test is the
// one that has to survive it. Driven the old way, with End in place of the placement, this fails
// three runs out of three with " TAIL" sitting in the middle of the block.
test("typing at the end of a two line fence appends to the block, not to the line", async ({
  page,
}) => {
  await openReadme(page);

  const paragraph = page.locator(".prose p").first();
  const words = (await paragraph.innerText()).trim();
  await paragraph.click();
  await caretIsIn(paragraph);
  await page.locator('.editor-toolbar .tool[title="Code block"]').click();

  await expect(page.locator(".prose pre").filter({ hasText: words })).toHaveCount(1);
  const code = page.locator(".prose pre").first().locator("code");
  // Two lines, from the break the paragraph had in it, which is what makes the difference between
  // the end of a line and the end of a block something a test can see.
  expect((await code.innerText()).split("\n")).toHaveLength(2);

  // Scrolled back to the beginning of the line first, which is where somebody who wants to read it
  // puts it: a fence arrives scrolled to wherever the caret was when it was made, and the start of
  // the text is off the left edge of the box until it is scrolled back.
  const box = await code.boundingBox();
  if (!box) throw new Error("the fence is not on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(-600, 0);
  await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBe(0);

  const line = await code.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode() as Text | null;
    if (!first) throw new Error("the fence has no text in it");
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, Math.min(4, first.data.length));
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(line.x, line.y);
  await caretIsIn(code);

  await putCaret(code, "end");
  await page.keyboard.type(" TAIL");

  await expect(code).toHaveText(`${words} TAIL`);
});

test("the insert tool adds a formula and KaTeX draws it", async ({ page }) => {
  await openReadme(page);

  await page.locator('.editor-toolbar .tool[title="Insert"]').click();
  await page.locator(".insert-pop button", { hasText: "Display formula" }).click();

  const block = page.locator(".prose .math-block").first();
  await expect(block).toBeVisible();

  // An empty formula opens on its field, which is the whole reason the insert selects the node.
  const field = block.locator(".math-source");
  await expect(field).toBeVisible();
  await field.fill("\\frac{a}{b}");
  await page.keyboard.press("Escape");

  await expect(block.locator(".katex")).toBeVisible();
  // The attribute is the source of truth and the render is a copy of it, never the other way round.
  await expect(block).toHaveAttribute("data-latex", "\\frac{a}{b}");
});

// The toggle, which is the block with the most of itself outside ProseMirror's reach: a native
// <details>, a summary row that is not the document's content, and an arrow that turns on a CSS
// rule keyed off an attribute a command writes. None of that runs in the node environment the unit
// suite uses, so this is the half of it that only a browser can answer. Element.checkVisibility()
// rather than a box measurement, because a closed <details> keeps the intrinsic height of content
// it is not painting.
test("the toggle opens, closes and takes an edit to its title", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-dev-empty", "1");
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  // guides/ is a folder, so the row for the file inside it is not there until it is opened.
  await page.locator(`.tree-row[data-path="${HANDBOOK}/guides"]`).click();
  await page.locator(`.tree-row[data-path="${HANDBOOK}/guides/writing.md"]`).click();
  await expect(page.locator(".prose h1")).toHaveText("Writing");

  const toggle = page.locator(".prose details.toggle").first();
  const row = toggle.locator("summary");
  const title = toggle.locator("[data-toggle-summary]");
  const body = toggle.locator("[data-toggle-body]");
  const visible = () => body.evaluate((node) => node.checkVisibility());

  // The file says <details> with no open attribute, so it arrives closed and its body is not on
  // screen. Nothing has been written to it: opening a document writes nothing.
  await expect(toggle).not.toHaveAttribute("open", /.*/);
  expect(await visible()).toBe(false);
  await expect(title).toHaveText("House style, the short version");

  // The arrow, which is the summary row's own ::before and so a press on the chrome rather than on
  // the title. Native disclosure is cancelled and the attribute is written by a command, so this
  // asserts the command ran and not that a browser did what browsers do.
  await row.click({ position: { x: 8, y: 12 } });
  await expect(toggle).toHaveAttribute("open", "");
  expect(await visible()).toBe(true);

  await row.click({ position: { x: 8, y: 12 } });
  await expect(toggle).not.toHaveAttribute("open", /.*/);
  expect(await visible()).toBe(false);

  // The title is editable text inside chrome that is not, so a click has to land the caret in it
  // and the keystrokes after it have to reach it rather than the document underneath. Typing here
  // put the characters at the end of the toggle's last hidden paragraph before this block existed.
  await title.click({ position: { x: 4, y: 8 } });
  await caretIsIn(title);
  // And then put at the front on purpose. Where in the first glyph a click at x=4 falls is a hit
  // test against half a character, which decides between ZZZHouse and HZZZouse and is no part of
  // what this test is about.
  await putCaret(title, "start");
  await page.keyboard.type("ZZZ");

  await expect(title).toHaveText("ZZZHouse style, the short version");
  await expect(page.locator(".prose", { hasText: "ZZZ" })).toHaveCount(1);
  await expect(body).not.toContainText("ZZZ");

  // And the pill is drawn dead while the caret is in there. ProseMirror's selection is still
  // wherever it was in the document, so a tool pressed now would edit a paragraph nobody is
  // looking at; the editor refuses that outright, and a button that looks live and does nothing is
  // the same lie one layer up. It comes back as soon as the caret is in the document again.
  const bold = page.locator('.editor-toolbar .tool[title="Bold"]');
  await expect(bold).toBeDisabled();

  await page.locator(".prose h1").click();
  await expect(bold).toBeEnabled();
});
