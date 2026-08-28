// What one keystroke does to the file, read off the disk rather than off the screen.
//
// Every other suite here asks the app what it thinks. This one asks the fixture what was written,
// because the promise this project actually makes is about bytes: saving must not change a byte the
// user did not edit. Four rounds of adversarial review found nine, five, three and three data loss
// bugs behind a green gate, and the ones that hurt most were all the same shape. A unit test built
// a document by hand, asked the serializer to write it, got the right answer, and shipped. The
// document a keystroke really produces was different, because between the key and the serializer
// sits prosemirror-view reparsing its own DOM, and nothing in the unit suite has a DOM.
//
// So these tests type into a running editor and then read the file. They are slow and there are
// few of them on purpose: one per way the app has been caught rewriting bytes nobody touched.

import { expect, test, type Page } from "@playwright/test";
import { putCaret } from "./caret";
import { ask, change, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Longer than the 500ms autosave debounce in src/document.ts, with room for the write itself. */
const SAVED = 1500;

/** Opens the README with the given bytes in it and waits for them to be on screen. */
async function open(page: Page, source: string): Promise<void> {
  await page.addInitScript(installTauriShim);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
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

test("a vite server serving somebody else's copy cannot pass this suite", async ({ page }) => {
  // playwright.config.ts sets `reuseExistingServer`, so the suite talks to whatever already answers
  // on the port. A stale server left behind by another checkout serves that checkout, and every
  // assertion below would then be about a file this repository does not contain. Cheap to check and
  // it has already caught one: the paragraph's whitespace contract is the newest thing in the
  // schema, so a server without it is a server not serving this tree.
  await open(page, "hello\n");
  const paragraph = await page.evaluate(() => {
    const view = (document.querySelector(".prose") as HTMLElement & { pmViewDesc?: { node: { type: { schema: { nodes: Record<string, { spec: Record<string, unknown> }> } } } } }).pmViewDesc;
    if (!view) return null;
    return view.node.type.schema.nodes.paragraph.spec;
  });
  expect(paragraph).not.toBeNull();
  expect(paragraph?.whitespace).toBe("pre");
  expect(JSON.stringify(paragraph?.parseDOM)).toContain("preserveWhitespace");
});

test("one character into a hand wrapped paragraph is a one character diff", async ({ page }) => {
  // The bug a user meets first, because a hand wrapped file is what a text editor leaves behind.
  // prosemirror-view reparses the paragraph's own DOM after a keystroke and asks the schema how to
  // read its whitespace; with the default answer every soft wrap in the paragraph came back a
  // `hardBreak`, and the save put a backslash at the end of every line the user had wrapped. The
  // whole file, from one character. src/model/schema.ts carries the field that stops it, and only
  // a running editor proves the field is reaching the parse: the serializer never saw the fault.
  const source = "# Title\n\none wrapped\nline here\n\nsecond one\nalso wrapped\n";
  await open(page, source);

  const paragraph = page.locator(".prose p").first();
  await putCaret(paragraph, 3);
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("# Title\n\noneZ wrapped\nline here\n\nsecond one\nalso wrapped\n");
});

test("joining two hand wrapped paragraphs keeps every wrap in both of them", async ({ page }) => {
  // The same field, read by prosemirror-transform's `join` rather than by the parser, which is why
  // it is worth its own test: a fix that only taught the parser would leave this one rewriting both
  // paragraphs on a single Backspace.
  await open(page, "one\ntwo\n\nthree\nfour\n");

  await putCaret(page.locator(".prose p").nth(1), "start");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(SAVED);

  const after = await disk(page);
  expect(after).not.toContain("\\");
  expect(after).toBe("one\ntwothree\nfour\n");
});

test("a line break the user asks for mid paragraph reaches the file", async ({ page }) => {
  // The control for the two tests below. A trailing break is written as nothing, and a change that
  // reached this one instead would be taking away the gesture rather than tidying up after it.
  await open(page, "alpha beta\n");

  await putCaret(page.locator(".prose p").first(), 5);
  await page.keyboard.press("Shift+Enter");
  await page.waitForTimeout(SAVED);

  // The escaped space is old, documented and stable on reparse: mdast will not let a hard break be
  // followed by a literal space, and this test is about the break, not about the spelling.
  expect(await disk(page)).toBe("alpha\\\n&#x20;beta\n");
});

test("a break with nothing under it is written as nothing, and the next character makes it real", async ({
  page,
}) => {
  // There is no markdown for a paragraph that ends on a blank line, so the honest spelling of a
  // trailing break is no spelling. It used to be written `\` on a line of its own, which reads back
  // as a literal backslash in the user's words: a character they never typed, in their file, from a
  // key they pressed and had not finished using yet.
  await open(page, "hello there\n");

  await putCaret(page.locator(".prose p").first(), "end");
  await page.keyboard.press("Shift+Enter");
  await page.waitForTimeout(SAVED);
  expect(await disk(page)).toBe("hello there\n");

  await page.keyboard.type("q");
  await page.waitForTimeout(SAVED);
  expect(await disk(page)).toBe("hello there\\\nq\n");
});

test("a break left trailing by a deletion is written as nothing too", async ({ page }) => {
  // The route no keystroke guard covers: the break was legal where it was put, and a Delete took
  // the text out from under it. The answer lives in the serializer for exactly this reason.
  await open(page, "para\n");

  await putCaret(page.locator(".prose p").first(), "end");
  await page.keyboard.type("xy");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("paraxy\n");
});

test("typing into a raw block does not swallow the list above it", async ({ page }) => {
  // An edited raw block has to be written back somewhere the reparse will find it again, and a
  // list directly above one leaves it nowhere: every indent that keeps the list readable puts the
  // block in a fence or in the list. The save gives up the edit rather than the file.
  const source = "- one\n- two\n\n<div>\nraw\n</div>\n\nafter\n";
  await open(page, source);

  await putCaret(page.locator(".prose pre").first(), "start");
  await page.keyboard.type("    ");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(source);
  await expect(page.locator(".prose ul li")).toHaveText(["one", "two"]);
});

test("an edit in the prose does not eat bytes off the end of a raw block", async ({ page }) => {
  // Preserved source running to the end of the file was trimmed of its trailing blank lines on the
  // way out, so a keystroke somewhere else deleted characters inside somebody's html.
  await open(page, "para\n\n<pre>\nkeep\n\n\n");

  await putCaret(page.locator(".prose p").first(), "end");
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("paraZ\n\n<pre>\nkeep\n\n\n");
});

test("a tight list inside a quote is not blown apart by an edit", async ({ page }) => {
  // remark calls a list spread when the blank line is after the last item; CommonMark does not, and
  // inside a quote that line is a `>` the list token runs over. Believing remark put a blank line
  // between every item on the save after next.
  await open(page, "> - one\n> - two\n>\n> > nested\n");

  await putCaret(page.locator(".prose blockquote li p").first(), "end");
  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("> - oneZ\n> - two\n>\n> > nested\n");
});

test("a printable character over a rectangle of cells writes nothing", async ({ page }) => {
  // A rectangle is a selection of containers, not of text. ProseMirror offered the character to
  // every cell range in it and `insertText` replaced all four, so one keypress emptied cells the
  // user could see they had not aimed at.
  const source = "| a | b |\n| - | - |\n| c | d |\n";
  await open(page, source);

  const cells = page.locator(".prose table td, .prose table th");
  const first = await cells.nth(0).boundingBox();
  const last = await cells.nth(3).boundingBox();
  await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
  await page.mouse.down();
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, { steps: 8 });
  await page.mouse.up();
  // The gesture really made a rectangle. Without this the test passes on a suite where the drag
  // silently did nothing, which is the shape of guard this project has shipped four times.
  await expect(page.locator(".prose .selectedCell")).toHaveCount(4);

  await page.keyboard.type("Z");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe(source);
  await expect(page.locator(".prose table")).toContainText("d");
});

test("opening a document and looking at it writes nothing", async ({ page }) => {
  const source = "# Title\n\none wrapped\nline here\n\n<div>\nraw\n</div>\n\n- a\n- b\n";
  await open(page, source);
  await page.waitForTimeout(SAVED * 2);
  expect(await disk(page)).toBe(source);
});
