// The wire between the watcher and the open document, driven end to end.
//
// The two halves of external change reconciliation were each proved on their own and never
// together: src-tauri/tests/watch.rs drives a real watcher over a real folder, and
// src/store/useDocument.test.ts calls `documentChangedOnDisk` directly. Between them sits
// `startWorkspaceEvents`, which subscribes to the `watch-event` the backend emits and routes it to
// the open document, and which nothing exercised, because it returns a no-op the moment `isTauri`
// is false and the dev mock could not emit an event to it anyway.
//
// So this file gives it a Tauri to be inside. The init script below installs
// `window.__TAURI_INTERNALS__` before any app module is evaluated, which is the exact object
// `src/ipc.ts` looks for and the exact one `@tauri-apps/api` drives, so `isTauri` is true and the
// app takes every branch it takes in the real binary: `call()` goes through `invoke`,
// `startWorkspaceEvents` really registers a listener through the real `listen()`, and a
// `watch-event` really travels the Tauri event bus into `onWatchEvent`.
//
// What is behind the shim is the dev fixture, and what is emitted over it are the payloads
// src/dev/mockIpc.ts's `external` builds. Those payloads are pinned to the ones the real backend
// serialises by src-tauri/tests/watch_payload.rs, and the event name is a bare string here rather
// than an import of `WATCH_EVENT`, so a rename of that constant breaks these tests rather than
// travelling silently through both sides.
//
// What this does not prove: that macOS delivers the FSEvents these payloads describe (watch.rs
// does that), and that a packaged binary wires the same two modules together (nothing does yet,
// and that is worth knowing).
//
// Every change to a watched folder is made behind the app's back, never through `file_write`, so
// nothing has registered a self-write and the app can only find out the way it finds out in
// production: from the event.

import { expect, test, type Page } from "@playwright/test";
import { caretIsIn, putCaret, settle } from "./caret";
import { ask, change, installTauriShim } from "./disk";
import { dirtyWasShown, watchDirty } from "./saving";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;
const NOTES = `${HANDBOOK}/notes.txt`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Where the caret is, described by the block it is sitting in rather than by an offset. */
function caret(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.anchorNode ?? null;
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    const block = element?.closest(".prose p, .prose h1, .prose h2, .prose li") ?? null;
    return {
      inEditor: document.activeElement?.classList.contains("prose") ?? false,
      tag: block?.tagName ?? null,
      text: block?.textContent ?? null,
    };
  });
}

/**
 * A first launch with the Handbook opened out of recents, and a list of any uncaught exception the
 * page throws along the way. "Handled without crashing" is a claim about that list.
 */
async function launch(page: Page): Promise<string[]> {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(String(error)));

  await page.addInitScript(installTauriShim);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-dev-empty", "1");
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");

  await page.locator(".start-row").first().click();
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  return crashes;
}

async function openReadme(page: Page): Promise<void> {
  await page.locator(row(README)).click();
  await expect(page.locator(".prose h1")).toHaveText("Handbook");
  await expect(page.locator(".prose")).toContainText("Everything the team needs");
}

test("an external edit to a clean document reloads it silently and shows the new text", async ({
  page,
}) => {
  const crashes = await launch(page);
  await openReadme(page);

  const rewritten = [
    "---",
    "title: Handbook",
    "---",
    "",
    "# Handbook",
    "",
    "Another program rewrote this file while the app had it open.",
    "",
  ].join("\n");

  const delivered = await change(page, "write", README, rewritten);
  // The wire is connected. A no-op `startWorkspaceEvents` gives [0], and the assertions below
  // would then be failing for a reason nobody could see from them.
  expect(delivered).toEqual([1]);

  await expect(page.locator(".prose")).toContainText(
    "Another program rewrote this file while the app had it open.",
  );
  await expect(page.locator(".prose")).not.toContainText("Everything the team needs");

  // Silently: nothing was asked, nothing is flagged, nothing became unsaved.
  await expect(page.locator(".panel-conflict")).toHaveCount(0);
  await expect(page.locator(".dirty-dot")).toHaveCount(0);
  await expect(page.locator(".toolbar-status")).toHaveAttribute("data-phase", "idle");
  expect(crashes).toEqual([]);
});

test("an external edit does not throw the cursor to the top of the document", async ({ page }) => {
  const crashes = await launch(page);
  await openReadme(page);

  const paragraph = page
    .locator(".prose p")
    .filter({ hasText: "Guides are the things you read once" });
  await paragraph.click();
  // Placed and read back rather than moved with End, which is a key nobody presses to move a caret
  // on this platform and which answers by line: see tests/caret.ts.
  await putCaret(paragraph, "end");

  const before = await caret(page);
  expect(before.tag).toBe("P");
  expect(before.text).toContain("Guides are the things you read once");

  // Appended at the end of the file, so every byte before the caret is exactly where it was and a
  // preserved caret is a caret in the same words rather than at a coincidentally similar offset.
  const original = await ask<string>(page, "read", README);
  const delivered = await change(
    page,
    "write",
    README,
    `${original}\nA closing line another program appended.\n`,
  );
  expect(delivered).toEqual([1]);

  await expect(page.locator(".prose")).toContainText("A closing line another program appended.");

  const after = await caret(page);
  expect(after.inEditor).toBe(true);
  expect(after.tag).toBe("P");
  expect(after.text).toContain("Guides are the things you read once");

  // What the caret is for. Typing lands where it was left, not in the heading at the top. The two
  // frames are the view's: the reload put a selection back, and a key sent before it has read that
  // selection is answered about the position the caret used to be in.
  await settle(page);
  await page.keyboard.type("!");
  await expect(paragraph).toContainText("!");
  await expect(page.locator(".prose h1")).toHaveText("Handbook");
  expect(crashes).toEqual([]);
});

test("an external edit while the buffer is dirty leaves the buffer alone and surfaces the clash", async ({
  page,
}) => {
  const crashes = await launch(page);
  await openReadme(page);

  // Held, so the buffer is reliably still dirty when the event lands rather than in a race with
  // the 500ms autosave.
  await ask(page, "pauseWrites");
  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await putCaret(paragraph, "start");
  await page.keyboard.type("MY UNSAVED EDIT. ");
  await expect(page.locator(".dirty-dot")).toBeVisible();

  const theirs = "---\ntitle: Handbook\n---\n\n# Handbook\n\nTHEIR EDIT, made on disk.\n";
  const delivered = await change(page, "write", README, theirs);
  expect(delivered).toEqual([1]);

  await expect(page.locator(".panel-conflict")).toBeVisible();
  await expect(page.locator(".prose")).toContainText("MY UNSAVED EDIT.");
  await expect(page.locator(".prose")).not.toContainText("THEIR EDIT, made on disk.");
  await expect(page.locator(".dirty-dot")).toBeVisible();

  // Dismissing picks neither copy and leaves the warning where it can be reopened.
  await page.getByRole("button", { name: "Decide later" }).click();
  await expect(page.locator(".panel-conflict")).toHaveCount(0);
  await expect(page.locator(".toolbar-status")).toHaveAttribute("data-phase", "conflict");

  // The held save is let go. It is refused, because the file moved on from the timestamp the
  // buffer was read at, so their copy is still the one on disk and the edit is still unsaved.
  await ask(page, "resumeWrites");
  await page.waitForTimeout(1200);
  expect(await ask<string>(page, "read", README)).toBe(theirs);
  await expect(page.locator(".dirty-dot")).toBeVisible();
  expect(crashes).toEqual([]);
});

test("the app's own save does not come back as an external change", async ({ page }) => {
  const crashes = await launch(page);
  await openReadme(page);

  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await putCaret(paragraph, "end");

  // Watched from before the typing rather than polled for after it, because the dot is on screen
  // only until the debounce runs out: see tests/saving.ts.
  await watchDirty(page);
  await page.keyboard.type(" MARKER.");
  await dirtyWasShown(page);
  await expect(page.locator(".dirty-dot")).toHaveCount(0, { timeout: 5000 });
  expect(await ask<string>(page, "read", README)).toContain("MARKER.");

  // The backend suppresses the echo of the app's own write, so in the real app nothing arrives at
  // all: src-tauri/tests/watch.rs, `a_real_save_is_reported_as_nothing`. Send one anyway. The
  // frontend is the second line and has to hold on its own, which is precisely what nobody
  // noticed had stopped being true the last time this went dead.
  expect(await change(page, "signal", README, "modified")).toEqual([1]);
  // And the harder one: the same bytes with a newer timestamp, which is what a touch, a backup
  // tool or a git checkout that restores what was already there looks like from the watcher.
  expect(await change(page, "touch", README)).toEqual([1]);

  await expect(page.locator(".panel-conflict")).toHaveCount(0);
  await expect(page.locator(".toolbar-status")).toHaveAttribute("data-phase", "idle");
  await expect(page.locator(".dirty-dot")).toHaveCount(0);
  await expect(page.locator(".prose")).toContainText("MARKER.");

  // A reload rebuilds the ProseMirror state and takes the undo history with it, and matching text
  // would hide that. The history is still there, so nothing was reloaded.
  await paragraph.click();
  // Undo is answered by the editor's own keymap, so it has to be the editor holding the keyboard
  // when the key arrives rather than a moment afterwards.
  await caretIsIn(paragraph);
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".prose")).not.toContainText("MARKER.");
  expect(crashes).toEqual([]);
});

test("a file deleted from outside is handled without a crash and is not written back", async ({
  page,
}) => {
  const crashes = await launch(page);
  await openReadme(page);

  const delivered = await change(page, "remove", README);
  expect(delivered).toEqual([1]);

  // The buffer is the only copy left, so it stays on screen whole and the user is told.
  await expect(page.locator(".panel-conflict")).toBeVisible();
  await expect(page.locator(".prose h1")).toHaveText("Handbook");
  await expect(page.locator(".prose")).toContainText("Everything the team needs");

  // The tree caught up off the same event, and only the row that went is gone.
  await expect(page.locator(row(README))).toHaveCount(0);
  await expect(page.locator(row(NOTES))).toBeVisible();

  await page.getByRole("button", { name: "Decide later" }).click();
  await expect(page.locator(".toolbar-status")).toHaveAttribute("data-phase", "conflict");

  // Well past the 500ms autosave: a deleted file is not quietly recreated behind the user.
  await page.waitForTimeout(1200);
  expect(await ask<boolean>(page, "exists", README)).toBe(false);
  expect(crashes).toEqual([]);
});

test("an external rename of the open file is handled", async ({ page }) => {
  const crashes = await launch(page);
  await openReadme(page);

  const original = await ask<string>(page, "read", README);
  const renamed = `${HANDBOOK}/Handbook.md`;

  // Two events and not one. macOS reports the two ends of a rename as unrelated changes and
  // src-tauri/src/watch.rs passes on what it is told: see `a_rename_is_reported_at_both_ends`.
  const delivered = await change(page, "rename", README, renamed);
  expect(delivered).toEqual([1, 1]);

  await expect(page.locator(row(renamed))).toBeVisible();
  await expect(page.locator(row(README))).toHaveCount(0);

  // The open document's file went, which reaches it as the same "changed on disk" as a delete.
  await expect(page.locator(".panel-conflict")).toBeVisible();
  await expect(page.locator(".prose h1")).toHaveText("Handbook");

  await page.getByRole("button", { name: "Decide later" }).click();
  await page.waitForTimeout(1200);
  expect(await ask<boolean>(page, "exists", README)).toBe(false);
  expect(await ask<string>(page, "read", renamed)).toBe(original);

  // The document does not follow the rename: the title bar still names the file that went, and
  // the buffer is still pointed at a path that is no longer there. Nothing is lost and nothing is
  // written, which is the claim here, but see the notes: `file_rename` follows and this does not.
  await expect(page.locator(".titlebar .doc-title")).toHaveText("README");
  expect(crashes).toEqual([]);
});

test("an external edit to an open .txt reloads it too", async ({ page }) => {
  const crashes = await launch(page);
  await page.locator(row(NOTES)).click();
  const field = page.locator("textarea.plain-text");
  await expect(field).toHaveValue(/Scratch notes, not markdown, still editable\./);

  const original = await ask<string>(page, "read", NOTES);
  const delivered = await change(
    page,
    "write",
    NOTES,
    `${original}A line another program appended.\n`,
  );
  expect(delivered).toEqual([1]);

  await expect(field).toHaveValue(/A line another program appended\./);
  await expect(page.locator(".panel-conflict")).toHaveCount(0);
  await expect(page.locator(".dirty-dot")).toHaveCount(0);
  expect(crashes).toEqual([]);
});

/**
 * This was a known defect, kept as `test.fail` so it would turn red the day it was fixed rather
 * than sit in a paragraph nobody reads. It has been fixed, so it is an ordinary test now.
 *
 * The caret already survived an external reload on the markdown surface, where Editor.tsx stashes
 * the selection before installing the new document and restores it after. A textarea has no
 * selection that survives its value being replaced, so PlainTextEditor.tsx now carries it by hand
 * across a reload of the same path, clamped in case the file shrank. It used to be measured at
 * offset 46 of 216 coming back as 249 of 249.
 */
test(
  "an external edit to a .txt does not throw the caret to the end of the document",
  async ({ page }) => {
    await launch(page);
    await page.locator(row(NOTES)).click();
    const field = page.locator("textarea.plain-text");
    await expect(field).toBeVisible();

    await field.click();
    // A textarea takes its own keys, so the arrows below go nowhere until it has the focus. That
    // would leave the caret at the top of the file, which is a place this test cannot tell a
    // preserved caret from a reset one at.
    await expect(field).toBeFocused();
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const before = await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    // Somewhere in the middle, or the assertion at the bottom is one a caret thrown to the top
    // would pass as happily as a caret that was kept.
    expect(before).toBeGreaterThan(0);

    const original = await ask<string>(page, "read", NOTES);
    expect(
      await change(page, "write", NOTES, `${original}A line another program appended.\n`),
    ).toEqual([1]);
    await expect(field).toHaveValue(/A line another program appended\./);

    expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(before);
  },
);
