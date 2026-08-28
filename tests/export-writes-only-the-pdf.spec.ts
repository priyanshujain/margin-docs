// An export writes the PDF and nothing else.
//
// The claim in src/export/run.ts is a claim about what an export does NOT do: it never calls
// `save`, never dispatches a transaction, and asks the document store for nothing but the path and
// the tree it is already holding. Every other suite reads that off the screen. This one reads it
// off the wire and off the fixture, the way tests/bytes.spec.ts does, because the promise is about
// bytes: choosing to export a document must not turn into writing over a file the user had not
// decided to write yet, and there is no undo for that on disk.
//
// The document exported here has an unsaved edit in it, which is the case that can actually hurt.
// A save on the way into an export would look harmless on a clean buffer and would silently commit
// half a paragraph on a dirty one. Writes are held through `external.pauseWrites` so the buffer
// stays dirty for as long as the export takes rather than racing the 500ms autosave, and the edit
// is let through afterwards to prove it was real: a file that did not change because the edit had
// evaporated would prove nothing at all.
//
// It also carries an image, a table, a formula and a mermaid fence, because those are the four
// blocks the converter does extra work for, and three of them put something in the compile that no
// other block does: the image travels as an absolute path for the backend to open, the diagram is
// drawn to SVG and travels as bytes, and the formula becomes a mitex call. The Typst source and the
// image list handed to `pdf_compile` are asserted here for exactly that reason. An export that
// wrote nothing because it never got past the first paragraph is the shape of green this suite is
// built to refuse.
//
// WHAT A BROWSER CANNOT REACH. `exportPdf` gates on `isDesktop`, which is `isTauri` and not a
// phone. `isTauri` reads `__TAURI_INTERNALS__` off the window and tests/disk.ts puts that there at
// document start, so the gate opens and the whole path runs: convert, draw, compile, panel, write.
// What is behind it is the dev fixture, so `pdf_compile` answers with a PDF header instead of a
// typeset document and `pdf_write` puts nothing anywhere. That the compiler produces a real PDF and
// that the write lands where it was pointed are Rust questions, and they are asked in
// src-tauri/tests/export_writes_only_the_pdf.rs. The one piece nothing can drive from either side
// is the native save panel itself: it is an AppKit window, so this spec answers the command for it
// and cannot say what a real panel would hand back for a name the user typed. That distinction
// matters, and the Rust suite is where it is followed up.

import { expect, test, type Page } from "@playwright/test";
import { putCaret } from "./caret";
import { ask, change, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;
/** The picture the document points at, which the fixture really has. */
const PICTURE = `${HANDBOOK}/reference/assets/diagram.png`;
/** Where the save panel is pointed: outside the folder, which is the ordinary case. */
const TARGET = "/Users/you/Desktop/README.pdf";

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Longer than the 500ms autosave debounce in src/document.ts, with room for the write itself. */
const SAVED = 1500;

/** Mermaid is several megabytes and is fetched on the first diagram, so the first export is slow. */
const EXPORTED = 20_000;

/**
 * One document holding all four of the blocks the converter does extra work for. Built by joining
 * lines rather than as a template literal because a mermaid fence is three backticks.
 */
const SOURCE = [
  "# Quarterly report",
  "",
  "Prose before anything difficult.",
  "",
  "![the diagram](reference/assets/diagram.png)",
  "",
  "| region | total |",
  "| ------ | ----- |",
  "| north | 12 |",
  "| south | 9 |",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B[Finish]",
  "```",
  "",
  "Closing line.",
  "",
].join("\n");

/** One command as it crossed the boundary, with the fields worth keeping off the ones that have them. */
interface Sent {
  command: string;
  /** The destination, for the two commands that name one: `file_write` and `pdf_write`. */
  path: string | null;
  /** The Typst source, for the one command that carries it. */
  source: string | null;
  /** What the compile was handed to open, and whether the bytes came with it or are on disk. */
  images: { path: string; inline: boolean }[] | null;
}

/** One `listen` the app has registered: which event, and the callback id the shim gave it. */
interface Listen {
  event: string;
  id: number;
}

interface Internals {
  invoke: (command: string, args?: Record<string, unknown>) => unknown;
  runCallback: (id: number, data: unknown) => void;
}

declare global {
  interface Window {
    __sent: Sent[];
    __listens: Listen[];
    /** What the save panel answers with. `null` is the user pressing Cancel. */
    __savePanel: string | null;
    __TAURI_INTERNALS__: Internals;
  }
}

/**
 * Records every command the app sends, and answers the one a browser has no window for.
 *
 * Added after `installTauriShim`, which puts `__TAURI_INTERNALS__` on the window synchronously.
 * Wrapping that object's `invoke` rather than the app's own wrapper is what makes this a
 * measurement of what was sent rather than of what src/api/pdf.ts meant to send: a `file_write`
 * from anywhere in the app, on any path, lands in this list.
 */
function recordIpc(): void {
  window.__sent = [];
  window.__listens = [];
  window.__savePanel = null;
  const internals = window.__TAURI_INTERNALS__;
  const real = internals.invoke;
  internals.invoke = (command, args) => {
    const images = (args?.images as { path: string; data: string | null }[] | undefined) ?? null;
    window.__sent.push({
      command,
      path: (args?.path as string) ?? null,
      source: (args?.source as string) ?? null,
      images: images === null ? null : images.map((i) => ({ path: i.path, inline: i.data !== null })),
    });
    if (command === "plugin:event|listen") {
      window.__listens.push({ event: args?.event as string, id: args?.handler as number });
    }
    // The save panel is an AppKit window. This is the one thing in the whole path a browser cannot
    // have, so it is answered here and everything either side of it is the running program.
    if (command === "plugin:dialog|save") return Promise.resolve(window.__savePanel);
    return real(command, args);
  };
}

/** Opens the README with the given bytes in it and waits for them to be on screen. */
async function open(page: Page, source: string): Promise<void> {
  await page.addInitScript(installTauriShim);
  await page.addInitScript(recordIpc);
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
const disk = (page: Page, path = README): Promise<string> => ask<string>(page, "read", path);

const sent = (page: Page): Promise<Sent[]> => page.evaluate(() => window.__sent);

const commands = async (page: Page): Promise<string[]> =>
  (await sent(page)).map((call) => call.command);

const toast = (page: Page) => page.locator(".toast");

/**
 * The gesture, which is the File menu and not a call to `exportPdf`.
 *
 * The same route tests/writing-tools.spec.ts takes and for the same reason: src-tauri/src/lib.rs
 * answers its own row by emitting `menu-action` with the command id, App.tsx has a `listen` on that
 * event, and src/keys/menu.ts turns the payload into a command. Everything from the event on is the
 * running program.
 */
async function runFromMenu(page: Page, command: string): Promise<void> {
  const delivered = await page.evaluate((id) => {
    let count = 0;
    for (const subscription of window.__listens) {
      if (subscription.event !== "menu-action") continue;
      window.__TAURI_INTERNALS__.runCallback(subscription.id, {
        event: "menu-action",
        id: subscription.id,
        payload: id,
      });
      count += 1;
    }
    return count;
  }, command);
  // An event nobody is subscribed to is the shape of test that passes because nothing happened.
  expect(delivered, "the app has no menu-action listener to fire at").toBeGreaterThan(0);
}

/**
 * Types a character into the first paragraph and holds the save that would follow, so the buffer is
 * dirty and the file is not, for as long as the caller needs. Answers with the log as it stood the
 * moment the buffer settled, which is the line everything after it is measured from.
 */
async function dirtyWithHeldSave(page: Page): Promise<number> {
  await ask(page, "pauseWrites");

  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await putCaret(paragraph, "end");
  await page.keyboard.type("Z");

  await expect(page.locator(".dirty-dot")).toBeVisible();
  // The autosave has fired and is sitting in the gate. Waiting for it rather than for a timeout is
  // what makes the count below a line the export is measured against instead of a race with it.
  await expect
    .poll(async () => (await commands(page)).filter((c) => c === "file_write").length)
    .toBe(1);

  return (await sent(page)).length;
}

test("an export of a document with unsaved edits writes nothing but the PDF", async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, SOURCE);

  // All four of the blocks the converter does extra work for are really on screen, so the export
  // below is the export this test is about and not a page of prose that happens to be green.
  // Not every `img` under `.prose` is the document's: prosemirror-view puts a zero width
  // `ProseMirror-separator` after an inline node that ends a textblock, and it is one too.
  await expect(page.locator(".prose img:not(.ProseMirror-separator)")).toHaveCount(1);
  await expect(page.locator(".prose table")).toHaveCount(1);
  await expect(page.locator(".prose [data-math-block]")).toHaveCount(1);
  await expect(page.locator(".prose .mermaid-block")).toHaveCount(1);

  const line = await dirtyWithHeldSave(page);
  const before = await page.locator(".prose").innerHTML();
  await page.evaluate((target) => {
    window.__savePanel = target;
  }, TARGET);

  await runFromMenu(page, "export-pdf");
  await expect(toast(page)).toContainText("Exported README.pdf", { timeout: EXPORTED });

  const during = (await sent(page)).slice(line);

  // 1. Exactly these commands crossed the boundary, in this order, and no other. `file_write` is
  //    not among them, and neither is `file_read`: the export asked the document store for the
  //    tree it was already holding and went to the compiler with it.
  expect(during.map((call) => call.command)).toEqual([
    "plugin:event|listen",
    "pdf_compile",
    "plugin:event|unlisten",
    "plugin:dialog|save",
    "pdf_write",
  ]);

  // 2. The bytes went where the panel pointed, and nowhere else.
  expect(during.find((call) => call.command === "pdf_write")?.path).toBe(TARGET);

  // 3. The file on disk is the one that was read, byte for byte. This is the whole test.
  expect(await disk(page)).toBe(SOURCE);

  // 4. And the buffer is still dirty, which is the other half of it: an export that had quietly
  //    saved on the way past would leave a clean buffer and an unchanged-looking file, and the
  //    unchanged-looking file would be the one with the edit in it. The document on screen is the
  //    one that went in, too: `documentToTypst` is handed the live tree rather than a copy, so a
  //    converter that mutated it, or a transaction that changed the document on the way past,
  //    would show up here as a paragraph that is not the one that was exported.
  await expect(page.locator(".dirty-dot")).toBeVisible();
  expect(await page.locator(".prose").innerHTML()).toBe(before);

  // 5. The four paths did their extra work. The image travels as the absolute path the backend
  //    opens under the root guard; the diagram was drawn and travels as bytes because it has no
  //    file behind it; the formula is a mitex call; the table is a Typst table. A compile handed
  //    none of that would have written nothing either, and would have proved nothing.
  const compile = during.find((call) => call.command === "pdf_compile");
  expect(compile?.images).toEqual([
    { path: PICTURE, inline: false },
    { path: "/inline/diagram-1.svg", inline: true },
  ]);
  expect(compile?.source).toContain(PICTURE);
  expect(compile?.source).toContain("#table(");
  expect(compile?.source).toContain("mitex");

  // 6. The edit was real all along. Letting the held save through writes the character that was
  //    typed, so the file that did not move during the export was a file with a pending edit
  //    against it rather than a buffer that had lost one.
  await ask(page, "resumeWrites");
  await expect.poll(() => disk(page)).toContain("difficult.Z");
  expect(await disk(page)).not.toBe(SOURCE);

  // 7. One write for the whole session, which is the autosave's, and it went out before the export
  //    started rather than because of it.
  //
  //    What this cannot see, said plainly rather than left for the next person to assume. Holding
  //    the write is what keeps the buffer dirty for the length of an export, and it is also the
  //    one state in which a fire and forget `void save()` inside `exportPdf` would leave no trace:
  //    `saveNow` in src/document.ts folds a request that arrives while a write is on the wire into
  //    a single next lap, and by the time the gate opens that lap finds the buffer clean and skips.
  //    Measured, by putting that line into the module and watching this test stay green. An
  //    `await`ed one is caught, loudly, because the export then never reaches the panel at all.
  //    The reason the gap is narrow rather than alarming is the debounce itself: the buffer can
  //    only be dirty while a save is pending or in flight, so an export that saved would be
  //    writing the bytes the debounce was about to write anyway. What is worth proving is that the
  //    export adds no write of its own, and that is what steps 1 to 6 are.
  await page.waitForTimeout(SAVED);
  expect((await commands(page)).filter((c) => c === "file_write")).toEqual(["file_write"]);
});

test("cancelling the save panel leaves the document exactly where it was", async ({ page }) => {
  // The branch that returns halfway through, after a compile and before a write. It is worth its
  // own test because it is the one place an export ends without a toast to say so, and a tidy-up
  // on that path that reached for `save` would be invisible on screen and permanent on disk.
  test.setTimeout(60_000);
  await open(page, SOURCE);
  await expect(page.locator(".prose .mermaid-block")).toHaveCount(1);

  const line = await dirtyWithHeldSave(page);
  // Left as null, which is what the panel answers when the user presses Cancel.

  await runFromMenu(page, "export-pdf");
  await expect
    .poll(async () => (await commands(page)).filter((c) => c === "plugin:dialog|save").length, {
      timeout: EXPORTED,
    })
    .toBe(1);

  const during = (await sent(page)).slice(line);
  expect(during.map((call) => call.command)).toEqual([
    "plugin:event|listen",
    "pdf_compile",
    "plugin:event|unlisten",
    "plugin:dialog|save",
  ]);

  expect(await disk(page)).toBe(SOURCE);
  await expect(page.locator(".dirty-dot")).toBeVisible();
  await expect(toast(page)).toHaveCount(0);
});
