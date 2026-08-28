// Writing Tools, which nothing in this suite can actually run, and the two halves of it that can
// still be proved here.
//
// The feature needs macOS 15.1 with Apple Intelligence turned on, and what it does when it runs is
// not a call this app makes: the system finds the selection in the webview and rewrites it by
// mutating the DOM, and the first this app hears of it is prosemirror-view reparsing its own
// document. So the risk is not "does the menu item fire". It is what those bytes become, and that
// is reproducible in Chromium without a single line of AppKit, because the mutation is an ordinary
// DOM edit: take the range out, put text in.
//
// The first half of this file does exactly that and then reads the file off the fixture, the way
// tests/bytes.spec.ts does, because the promise being made is about the file rather than about the
// screen. The second half drives the gesture, the Edit menu row, and asserts what
// src/editor/writing.ts refuses and that a refusal really did stop the call. A guard asserted by
// calling it would prove nothing about whether the running program asks it, and this project has
// shipped four that did not.
//
// What is deliberately NOT claimed here: that the mutation below is byte for byte the one macOS
// makes. Nobody outside Apple can promise that. It is the worst plausible shape of it, a range
// deleted and replaced, which is what a browser does for any programmatic text replacement, and a
// guard drawn against the worst shape is a guard that holds for the gentler ones.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { putCaret, settle, type Where } from "./caret";
import { ask, change, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;
const NOTES = `${HANDBOOK}/notes.txt`;

const row = (path: string) => `.tree-row[data-path="${path}"]`;

/** Longer than the 500ms autosave debounce in src/document.ts, with room for the write itself. */
const SAVED = 1500;

interface WritingCall {
  command: string;
  tool: string | null;
}

/** One `listen` the app has registered: which event, and the callback id the shim gave it. */
interface Subscription {
  event: string;
  id: number;
}

interface Internals {
  invoke: (command: string, args?: Record<string, unknown>) => unknown;
  runCallback: (id: number, data: unknown) => void;
}

declare global {
  interface Window {
    __writing: WritingCall[];
    __listening: Subscription[];
    __TAURI_INTERNALS__: Internals;
  }
}

/**
 * Records what crosses the IPC boundary: every writing_* command, so a refusal can be shown to have
 * stopped one, and every event the app subscribes to, so the menu can be fired at it below.
 *
 * Added after `installTauriShim`, which puts `__TAURI_INTERNALS__` on the window synchronously.
 * Wrapping that object's `invoke` rather than the app's own wrapper is what makes this a
 * measurement of what was sent rather than of what src/api/writing.ts meant to send.
 */
function recordIpc(): void {
  window.__writing = [];
  window.__listening = [];
  const internals = window.__TAURI_INTERNALS__;
  const real = internals.invoke;
  internals.invoke = (command, args) => {
    if (command.startsWith("writing_")) {
      window.__writing.push({ command, tool: (args?.tool as string) ?? null });
    }
    if (command === "plugin:event|listen") {
      window.__listening.push({ event: args?.event as string, id: args?.handler as number });
    }
    return real(command, args);
  };
}

interface OpenOptions {
  /** The file to open. The README unless a test wants the .txt surface. */
  path?: string;
  /** Sets the fixture's own switch for a Mac with no Writing Tools menu. */
  unavailable?: boolean;
}

/** Opens a document with the given bytes in it and waits for them to be on screen. */
async function open(page: Page, source: string, options: OpenOptions = {}): Promise<void> {
  const path = options.path ?? README;
  await page.addInitScript(installTauriShim);
  await page.addInitScript(recordIpc);
  await page.addInitScript((unavailable) => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
    if (unavailable) localStorage.setItem("margindocs-dev-no-writing-tools", "1");
  }, options.unavailable === true);
  await page.goto("/");
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  await page.locator(row(path)).click();
  await expect(page.locator(path === NOTES ? "textarea.plain-text" : ".prose")).toBeVisible();

  // Written from outside rather than typed, so the app has not registered a self-write and this is
  // a file it has only ever read.
  await change(page, "write", path, source);
  await expect.poll(() => ask<string>(page, "read", path)).toBe(source);
}

/** What is on disk now. */
const disk = (page: Page, path = README): Promise<string> => ask<string>(page, "read", path);

const calls = (page: Page): Promise<WritingCall[]> => page.evaluate(() => window.__writing);

const commands = async (page: Page): Promise<string[]> =>
  (await calls(page)).map((call) => call.command);

/**
 * What the system does to the selection, as far as anything outside Apple can say: the range comes
 * out and one run of text goes in. No input event, no ProseMirror transaction, nothing the editor
 * was asked about first. prosemirror-view's own MutationObserver is what notices.
 */
async function rewriteRange(
  page: Page,
  selector: string,
  from: number,
  to: number,
  text: string,
  end = selector,
): Promise<void> {
  await page.evaluate(
    (job) => {
      const at = (selector: string, offset: number): [Node, number] => {
        const host = document.querySelector(selector);
        if (!host) throw new Error(`nothing matches ${selector}`);
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let seen = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          if (offset <= seen + node.data.length) return [node, offset - seen];
          seen += node.data.length;
        }
        throw new Error(`offset ${offset} is past the end of ${selector}`);
      };

      const range = document.createRange();
      const [startNode, startOffset] = at(job.selector, job.from);
      const [endNode, endOffset] = at(job.end, job.to);
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      range.deleteContents();
      range.insertNode(document.createTextNode(job.text));
    },
    { selector, from, to, text, end },
  );
  await settle(page);
}

/** A selection a person could have made: a caret, then Shift and the arrow key, held down. */
async function selectFrom(target: Locator, at: Where, characters: number): Promise<void> {
  const page = target.page();
  await target.click();
  await putCaret(target, at);
  for (let i = 0; i < characters; i += 1) await page.keyboard.press("Shift+ArrowRight");
  await settle(page);
}

/** The blocks the two ends of the live selection are in, named by tag. */
function selectionBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return [];
    const range = selection.getRangeAt(0);
    const block = (node: Node): string => {
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      return (
        element?.closest("p, h1, h2, h3, h4, h5, h6, td, th, pre, [data-math-block]")?.tagName ?? "?"
      );
    };
    return [block(range.startContainer), block(range.endContainer)];
  });
}

/**
 * The gesture, which is the Edit menu and not a call to `runWritingTool`.
 *
 * A native menu cannot be clicked from a browser, but everything downstream of the click can be
 * driven exactly as it happens: src-tauri/src/lib.rs answers its own row by emitting `menu-action`
 * with the command id, App.tsx has a `listen` on that event, and src/keys/menu.ts turns the payload
 * into a command. So this delivers that event to the app's own subscriber through the shim's
 * callback registry, and everything from there on is the running program. It is also the one path
 * that leaves the selection alone, which is why it is the path this feature is built around: a
 * native menu does not take the keyboard off the webview.
 */
async function runFromMenu(page: Page, command: string): Promise<void> {
  const delivered = await page.evaluate((id) => {
    let count = 0;
    for (const subscription of window.__listening) {
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

/** The other way in, and the one that cannot preserve a selection. */
async function runFromPalette(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  await page.locator(".palette-field").fill(label);
  // The row about to run is the row this test means, rather than whatever fuzzy matching put at the
  // top today.
  await expect(page.locator(".palette-row").first()).toContainText(label);
  await page.keyboard.press("Enter");
}

const REWRITE = "writing-rewrite";
const PROOFREAD = "writing-proofread";

const toast = (page: Page): Locator => page.locator(".toast");

// ---------------------------------------------------------------------------------------------
// What the bytes do. No guard involved: this is the ground the guard below is drawn on.
// ---------------------------------------------------------------------------------------------

test("a rewrite across a hand wrapped paragraph leaves no backslash behind", async ({ page }) => {
  // The one that would matter most, because a hand wrapped file is what a text editor leaves
  // behind and a rewrite is asked for on whole sentences. The paragraph is declared
  // `whitespace: "pre"` in src/model/schema.ts so prosemirror-view reparses the wraps as newlines
  // rather than as hard breaks; without that field the wraps the rewrite did not touch would come
  // back as `\` at the end of every line, which is the bug docs/architecture.md is about.
  await open(page, "alpha beta\ngamma delta\n");

  await rewriteRange(page, ".prose p", 0, 22, "One rewritten sentence.");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("One rewritten sentence.\n");
});

test("a rewrite that only covers the first wrapped line leaves the second one alone", async ({
  page,
}) => {
  await open(page, "alpha beta\ngamma delta\n");

  await rewriteRange(page, ".prose p", 0, 10, "Alpha Beta");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("Alpha Beta\ngamma delta\n");
});

test("a rewrite inside a heading is still a heading, and inside a list item still an item", async ({
  page,
}) => {
  await open(page, "# Title Here\n\n- one\n- two\n");

  await rewriteRange(page, ".prose h1", 0, 10, "Another Title");
  await rewriteRange(page, ".prose li p", 0, 3, "ONE rewritten");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("# Another Title\n\n- ONE rewritten\n- two\n");
});

test("markdown the rewrite invents is escaped rather than obeyed", async ({ page }) => {
  // A rewrite is prose from a language model and it will happily open a sentence with "1." or "-".
  // Those are the file's own syntax, so if they went in raw the paragraph would come back as a list
  // the next time the file was read, which is a block the user never asked for.
  await open(page, "plain sentence\n");

  await rewriteRange(page, ".prose p", 0, 14, "- a list? *maybe* [really](no)");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("\\- a list? \\*maybe\\* \\[really]\\(no)\n");
  await expect(page.locator(".prose ul")).toHaveCount(0);
});

test("a rewrite whose ends are in two paragraphs damages both of them", async ({ page }) => {
  // The evidence for the guard, reproduced with the guard out of the way. Two paragraphs become
  // three, and `&#x20;` lands in the middle of words nobody selected: the serializer's honest
  // spelling for a leading space markdown has no other way to keep, in a place no author would
  // have put one. Nothing here is a serializer bug. It is the wrong range to hand a rewrite.
  await open(page, "one alpha\n\ntwo beta\n");

  await rewriteRange(page, ".prose p:nth-of-type(1)", 4, 3, "MERGED", ".prose p:nth-of-type(2)");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("one&#x20;\n\nMERGED\n\n&#x20;beta\n");
});

test("a rewrite whose ends are in two table cells is not a table any more", async ({ page }) => {
  // The worst of them. GFM has one header row and every row has to be the same width; this comes
  // back a column wider with an empty first cell in both rows, so the file now says something about
  // the user's data that the user did not.
  await open(page, "| a | b |\n| - | - |\n| c | d |\n");

  await rewriteRange(page, ".prose td:nth-of-type(1)", 0, 1, "X", ".prose td:nth-of-type(2)");
  await page.waitForTimeout(SAVED);

  expect(await disk(page)).toBe("| | a | b |\n| - | - | - |\n| | X | |\n");
});

test("a rewrite across a link takes the address with it, and one inside the link does not", async ({
  page,
}) => {
  // Both halves in one test because the pair is the rule. The address is not in the words on
  // screen, so a range that swallows the whole anchor loses something the user cannot see they had.
  // A range wholly inside the anchor is safe: the mark is an ancestor of the range rather than
  // content the range can delete, so the destination is still there afterwards.
  await open(page, "see [docs page](x.md) now\n");

  await rewriteRange(page, ".prose a", 0, 9, "the guide");
  await page.waitForTimeout(SAVED);
  expect(await disk(page)).toBe("see [the guide](x.md) now\n");

  await rewriteRange(page, ".prose p", 0, 13, "rewritten");
  await page.waitForTimeout(SAVED);
  expect(await disk(page)).toBe("rewritten now\n");
});

// ---------------------------------------------------------------------------------------------
// The guard, through the gesture.
// ---------------------------------------------------------------------------------------------

test("an ordinary sentence is handed to the system", async ({ page }) => {
  // The control. Without it every refusal below would still pass on a build where nothing ever
  // reaches the system at all, which is the same green as a guard that works.
  await open(page, "just a plain sentence here\n");

  await selectFrom(page.locator(".prose p"), 0, 4);
  await runFromMenu(page, REWRITE);

  await expect.poll(() => commands(page)).toEqual(["writing_available", "writing_run"]);
  expect((await calls(page))[1].tool).toBe("Rewrite");
  await expect(toast(page)).toHaveCount(0);
});

test("Proofread asks for the item the system calls Proofread", async ({ page }) => {
  await open(page, "just a plain sentence here\n");

  await selectFrom(page.locator(".prose p"), 0, 4);
  await runFromMenu(page, PROOFREAD);

  await expect.poll(() => commands(page)).toEqual(["writing_available", "writing_run"]);
  expect((await calls(page))[1].tool).toBe("Proofread");
});

test("a selection covering two paragraphs is refused and nothing is asked", async ({ page }) => {
  await open(page, "one alpha\n\ntwo beta\n");

  await selectFrom(page.locator(".prose p").first(), 4, 8);
  // The gesture really did cross the boundary. Without this the test passes on a build where
  // Shift+ArrowRight quietly stopped at the end of the paragraph, and the refusal below would be
  // answering a question nobody asked.
  expect(await selectionBlocks(page)).toEqual(["P", "P"]);
  expect(
    await page.evaluate(() => {
      const range = window.getSelection()!.getRangeAt(0);
      const block = (node: Node) =>
        (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest("p");
      return block(range.startContainer) === block(range.endContainer);
    }),
  ).toBe(false);

  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("one paragraph at a time");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a selection covering a link is refused and nothing is asked", async ({ page }) => {
  await open(page, "see [docs](x.md) now\n");

  await selectFrom(page.locator(".prose p"), 0, 8);
  await expect
    .poll(() =>
      page.evaluate(() => window.getSelection()!.getRangeAt(0).cloneContents().querySelector("a") !== null),
    )
    .toBe(true);

  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("address");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a selection covering a picture or a formula is refused", async ({ page }) => {
  // Both are atoms: a range that covers one deletes it, and neither the file name nor the LaTeX is
  // in the words on screen for a rewrite to put back. Inline maths is `$$…$$` here, not `$…$`:
  // src/markdown/handlers.ts turns single dollar text maths off, so a lone `$` is a dollar sign.
  await open(page, "see ![pic](p.png) now\n\nand $$x+1$$ too\n");

  await selectFrom(page.locator(".prose p").first(), 0, 6);
  await runFromMenu(page, REWRITE);
  await expect(toast(page)).toContainText("picture");

  await selectFrom(page.locator(".prose p").nth(1), 0, 6);
  await runFromMenu(page, REWRITE);
  await expect(toast(page)).toContainText("formula");

  await expect.poll(() => commands(page)).toEqual([
    "writing_available",
    "writing_available",
  ]);
});

test("a selection wholly inside a code span is refused", async ({ page }) => {
  // The bytes survive this one, which is exactly why it needs its own test: the range is inside the
  // `code` element rather than covering it, so `cloneContents` reports nothing and the refusal
  // comes from the marks around the range instead.
  await open(page, "a `some code` b\n");

  await selectFrom(page.locator(".prose code"), 0, 4);
  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("code");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("with no document open it says to open one", async ({ page }) => {
  await page.addInitScript(installTauriShim);
  await page.addInitScript(recordIpc);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await expect(page.locator(row(HANDBOOK))).toBeVisible();
  await expect(page.locator(".prose")).toHaveCount(0);

  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("Open a document");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a selection inside a fenced code block is refused and nothing is asked", async ({ page }) => {
  // Not a byte argument: a fence round trips a rewrite cleanly. It is the argument
  // src/editor/proofing.ts already made for the spell checker, which is that a tool rewriting
  // somebody's variable names is a tool they turn off, and a rewriter is the louder version of it.
  await open(page, "```js\nconst a = 1;\n```\n");

  await selectFrom(page.locator(".prose pre code"), 0, 5);
  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("code");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
  expect(await disk(page)).toBe("```js\nconst a = 1;\n```\n");
});

test("a selection inside a raw block is refused and nothing is asked", async ({ page }) => {
  // A raw block is the file's own bytes, held twice so the editor can prove it has not touched
  // them. Handing them to a rewriter is the one thing they must never be handed to.
  await open(page, 'para\n\n<div class="x">raw</div>\n');

  await selectFrom(page.locator(".prose pre.raw-block code"), 0, 5);
  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("the file's own bytes");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
  expect(await disk(page)).toBe('para\n\n<div class="x">raw</div>\n');
});

test("the cursor in a formula's source is refused, and the message says so", async ({ page }) => {
  // A formula is not prose and its field is not the document: it is a textarea of its own inside
  // it, so it takes the keyboard away and the general answer would be to click into the document.
  // That answer is true and unhelpful, hence the branch and hence this test, which is here because
  // a refusal nothing can reach is the shape of guard this project has shipped four times.
  const source = "before\n\n$$\ny = 2\n$$\n";
  await open(page, source);

  await page.locator(".prose .math-block").click();
  await expect(page.locator(".prose textarea.math-source")).toBeFocused();

  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("formula");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a drag across a rendered formula is refused, and the message says so", async ({ page }) => {
  // The other way into a display equation, and the one the cursor never enters: the block is
  // `contenteditable=false`, so clicking it opens the source field above, but a drag across the
  // rendered maths still leaves a real selection with both ends inside the block and the document
  // holding the keyboard. A mouse drag because that is the only gesture that makes one.
  await open(page, "before\n\n$$\ny = 2 + 3 + 4\n$$\n\nafter\n");

  const box = await page.locator(".prose .math-render").boundingBox();
  await page.mouse.move(box!.x + 4, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 4, box!.y + box!.height / 2, { steps: 10 });
  await page.mouse.up();
  // The drag really made a selection inside the block, rather than a caret somewhere near it.
  expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(false);
  expect(await selectionBlocks(page)).toEqual(["DIV", "DIV"]);

  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("formula");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("the cursor in a toggle's title is refused, and the message says so", async ({ page }) => {
  // The same shape. A toggle's title is an attribute on the node rather than text in a block, and
  // the span holding it is its own editable inside the document.
  await open(page, "<details>\n<summary>Sum</summary>\n\nbody\n\n</details>\n");

  await page.locator(".prose [data-toggle-summary]").click();
  await expect(page.locator(".prose [data-toggle-summary]")).toBeFocused();

  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("toggle");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a caret with nothing selected is refused", async ({ page }) => {
  await open(page, "hello there\n");

  await page.locator(".prose p").click();
  await putCaret(page.locator(".prose p"), 3);
  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("Select the text");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a Mac with no Writing Tools menu says so and asks for nothing", async ({ page }) => {
  await open(page, "just a plain sentence here\n", { unavailable: true });

  await selectFrom(page.locator(".prose p"), 0, 4);
  await runFromMenu(page, REWRITE);

  await expect(toast(page)).toContainText("Apple Intelligence");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("a .txt file has no markdown to lose, so its selection goes straight through", async ({
  page,
}) => {
  await open(page, "some plain notes\n", { path: NOTES });

  const field = page.locator("textarea.plain-text");
  await field.click();
  await field.press("Meta+a");
  expect(
    await field.evaluate((e: HTMLTextAreaElement) => e.selectionEnd - e.selectionStart),
  ).toBeGreaterThan(0);

  await runFromMenu(page, REWRITE);

  await expect.poll(() => commands(page)).toEqual(["writing_available", "writing_run"]);
  await expect(toast(page)).toHaveCount(0);
});

test("the palette says which gesture to use, rather than rewriting a caret it moved itself", async ({
  page,
}) => {
  // The palette runs its row and then closes on to `<body>`, so by the time the command reaches
  // src/editor/writing.ts the document holds neither the keyboard nor the selection: measured here
  // rather than assumed, because the tempting fix, focusing the editor back, is what destroys the
  // selection outright. prosemirror-view takes the collapsed one the panel left behind as the
  // document's own, and nothing brings the user's back afterwards. So this path says so and stops.
  await open(page, "just a plain sentence here\n");

  await selectFrom(page.locator(".prose p"), 0, 4);
  await runFromPalette(page, "Rewrite with Writing Tools");

  await expect(toast(page)).toContainText("holds the keyboard");
  await expect.poll(() => commands(page)).toEqual(["writing_available"]);
});

test("running the tool writes nothing by itself", async ({ page }) => {
  // The system's rewrite is an edit and dirties the buffer like any other. Asking for one must not.
  const source = "# Title\n\none wrapped\nline here\n";
  await open(page, source);

  await selectFrom(page.locator(".prose p"), 0, 3);
  await runFromMenu(page, REWRITE);
  await expect.poll(() => commands(page)).toEqual(["writing_available", "writing_run"]);
  await page.waitForTimeout(SAVED * 2);

  expect(await disk(page)).toBe(source);
});
