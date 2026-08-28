// The app, driven in a real browser against the dev IPC mock in src/dev/mockIpc.ts. No Tauri and
// no Rust: the fixture answers every command, so this exercises the actual UI without going
// anywhere near anybody's documents.
//
// What is asserted here is the product's promises rather than the implementation's details. A
// folder opens and shows a tree. A markdown file opens as formatted prose with no markdown syntax
// anywhere on screen, which is the whole point of the editor. Typing marks the document unsaved and
// the autosave clears it again. A .txt file opens as plain text with no formatting toolbar, because
// there is nothing to format.

import { expect, test, type Page } from "@playwright/test";
import { caretIsIn } from "./caret";
import { dirtyWasShown, watchDirty } from "./saving";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;
const NOTES = `${HANDBOOK}/notes.txt`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/**
 * A first launch: the fixture is seeded with two folders already open, which is the one state the
 * start screen can never be seen in. `margindocs-dev-empty` is the mock's own switch for that, and
 * the recents list is seeded beside it so a folder can be opened without a native picker there is
 * no browser equivalent of.
 */
async function firstLaunch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-dev-empty", "1");
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
}

async function openHandbook(page: Page): Promise<void> {
  await firstLaunch(page);
  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
}

test("the app renders and opens on the start screen", async ({ page }) => {
  await firstLaunch(page);

  await expect(page.locator(".app")).toBeVisible();
  await expect(page.locator(".titlebar")).toBeVisible();
  await expect(page.locator(".start-title")).toHaveText("Margin Docs");
  await expect(page.locator(".start-open")).toBeVisible();
  await expect(page.locator(".start-row")).toHaveCount(1);
  await expect(page.locator(".start-name")).toHaveText("Handbook");

  // Nothing is open, so there is no tree and no document.
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".prose")).toHaveCount(0);
});

test("opening a folder shows its tree", async ({ page }) => {
  await openHandbook(page);

  await expect(page.locator(".start")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toBeVisible();

  // A freshly opened root expands itself, so its contents are on screen without a second click.
  await expect(page.locator(row(README))).toBeVisible();
  await expect(page.locator(row(`${HANDBOOK}/guides`))).toBeVisible();
  await expect(page.locator(row(NOTES))).toBeVisible();

  // Markdown hides its own extension and nothing else does.
  await expect(page.locator(`${row(README)} .tree-name`)).toHaveText("README.md");
  await expect(page.locator(`${row(README)} .tree-ext`)).toHaveText(".md");
  await expect(page.locator(`${row(NOTES)} .tree-name`)).toHaveText("notes.txt");
  await expect(page.locator(`${row(NOTES)} .tree-ext`)).toHaveCount(0);

  // A file the editor will not open is greyed rather than hidden.
  await page.locator(row(`${HANDBOOK}/reference`)).click();
  await page.locator(row(`${HANDBOOK}/reference/assets`)).click();
  const png = page.locator(row(`${HANDBOOK}/reference/assets/diagram.png`));
  await expect(png).toBeVisible();
  await expect(png).toHaveAttribute("data-foreign", "true");
  await expect(page.locator(row(`${HANDBOOK}/reference/keyboard.md`))).toHaveAttribute(
    "data-foreign",
    "false",
  );
});

test("a markdown file opens as formatted prose with no markdown syntax on screen", async ({
  page,
}) => {
  await openHandbook(page);
  await page.locator(row(README)).click();

  const prose = page.locator(".prose");
  await expect(prose).toBeVisible();

  // Rendered, not source: a real h1, a real h2, a real link, a real callout further down.
  await expect(prose.locator("h1")).toHaveText("Handbook");
  await expect(prose.locator("h2")).toHaveText("What lives where");
  await expect(prose.locator('a[href="guides/getting-started.md"]')).toHaveText("Getting started");
  await expect(prose.locator("code").first()).toHaveText("archive/");

  const text = (await prose.innerText()).trim();
  expect(text).toContain("Handbook");
  // The four things that would be on screen if this were a source view.
  expect(text).not.toContain("# Handbook");
  expect(text).not.toContain("](guides/getting-started.md)");
  expect(text).not.toContain("`archive/`");
  // Frontmatter is carried opaque and never shown.
  expect(text).not.toContain("title: Handbook");
  expect(text).not.toContain("tags: [team, reference]");

  // The file's name is what the title bar shows, and the H1 has nothing to do with it.
  await expect(page.locator(".titlebar .doc-title")).toHaveText("README");

  // A markdown document gets the one formatting surface there is.
  await expect(page.locator(".editor-toolbar")).toBeVisible();
  await expect(page.locator('.editor-toolbar .tool[title="Bold"]')).toBeEnabled();
});

test("typing marks the document unsaved and the autosave clears it", async ({ page }) => {
  await openHandbook(page);
  await page.locator(row(README)).click();
  await expect(page.locator(".prose h1")).toHaveText("Handbook");

  await expect(page.locator(".dirty-dot")).toHaveCount(0);

  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await caretIsIn(paragraph);

  // Recorded from before the first keystroke rather than looked for after the last one. The dot is
  // on screen for the 500ms of the debounce and no longer, so a run that stalls for half a second
  // between the typing and the poll used to read a saved document and call it one that was never
  // marked unsaved. See tests/saving.ts.
  await watchDirty(page);
  await page.keyboard.type("Margin");
  await dirtyWasShown(page);

  // The debounce is 500ms and the mock accepts the write, so the dot goes again on its own.
  await expect(page.locator(".dirty-dot")).toHaveCount(0, { timeout: 5000 });
});

test("a .txt file opens as plain text with no toolbar", async ({ page }) => {
  await openHandbook(page);
  await page.locator(row(NOTES)).click();

  const field = page.locator("textarea.plain-text");
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(/Scratch notes, not markdown, still editable\./);

  // Not markdown, so nothing parses it and nothing offers to format it.
  await expect(page.locator(".prose")).toHaveCount(0);
  await expect(page.locator(".editor-toolbar")).toHaveCount(0);
  await expect(page.locator(".titlebar .doc-title")).toHaveText("notes.txt");
});

test("Cmd+F finds matches in a plain text document", async ({ page }) => {
  await openHandbook(page);
  await page.locator(row(NOTES)).click();

  const field = page.locator("textarea.plain-text");
  await expect(field).toBeVisible();
  const text = await field.inputValue();
  const selectionOf = () =>
    field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);

  await field.click();
  // The shortcut is answered by the document and its target is whatever holds the keyboard, so a
  // press sent before the click has landed opens the find bar over the markdown surface instead.
  await expect(field).toBeFocused();
  await page.keyboard.press("Meta+f");

  const bar = page.locator(".find-bar");
  const findInput = bar.locator(".find-input").first();
  const count = page.locator(".find-count");
  await expect(bar).toBeVisible();
  await expect(findInput).toBeFocused();

  // "folder" is in the fixture twice: the archive folder, and the big folder. There is no
  // ProseMirror decoration to paint over a textarea, so the match is the textarea's own selection.
  await findInput.fill("folder");
  await expect(count).toHaveText("1 of 2");
  const first = text.indexOf("folder");
  const second = text.indexOf("folder", first + 1);
  expect(await selectionOf()).toEqual([first, first + "folder".length]);

  await page.locator('.find-btn[title^="Next"]').click();
  await expect(count).toHaveText("2 of 2");
  expect(await selectionOf()).toEqual([second, second + "folder".length]);

  // Wraps back around rather than stopping at the last match.
  await page.locator('.find-btn[title^="Next"]').click();
  await expect(count).toHaveText("1 of 2");

  await page.locator('.find-btn[title^="Previous"]').click();
  await expect(count).toHaveText("2 of 2");

  // Case sensitivity is the one rule shared with the markdown surface, not reimplemented for a
  // textarea: "the" matches four times loosely and three once "The index rebuild" stops counting.
  await findInput.fill("the");
  await expect(count).toHaveText("1 of 4");
  await page.locator('.find-toggle[title="Match case"]').click();
  await expect(count).toHaveText("1 of 3");

  // A query that matches nothing says so, in the same words, and next/prev have nothing to do.
  await findInput.fill("nothing to find here");
  await expect(count).toHaveText("No results");
  await expect(page.locator('.find-btn[title^="Next"]')).toBeDisabled();

  // Replace is offered here exactly as it is for markdown: the same expand arrow, the same two
  // buttons, driven by the same handle.
  await findInput.fill("folder");
  await expect(count).toHaveText("1 of 2");
  await page.locator(".find-expand").click();
  await bar.locator(".find-input").nth(1).fill("room");
  await page.locator('.find-action[title="Replace the current match"]').click();
  await expect(count).toHaveText("1 of 1");
  await expect(field).toHaveValue(/the archive room\. Nobody/);

  await page.locator('.find-action[title="Replace every match in this document"]').click();
  await expect(count).toHaveText("No results");
  await expect(field).toHaveValue(/the archive room\..*the big room\./s);

  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});
