// The same six gestures, run against every block tool on the pill.
//
// This file exists because one of them was found broken by hand. The code block tool drew itself
// wrong in a fresh document and ArrowDown inside it left the caret with no way back to a paragraph,
// and neither of those is a fault of fences: they are what happens when a tool is written without
// somebody driving insert, type, escape and press-it-again all the way through in a browser. Every
// tool on the bar is the same shape of thing, so every tool gets the same drive here, and the
// sweep found three more of exactly that kind. A rule the insert left selected, so the next
// character typed replaced it. An inline formula that took one character and then dropped the
// caret on the body. A display formula at the end of a document that Escape could not leave, where
// the next character replaced the whole formula. Each has a named test below.
//
// The document each test starts from is a new one, made through the New Document panel, because
// the "Start writing…" document is where a person meets a tool for the first time and it is the
// one context that has nothing after the block a tool makes. A block that ends the document is
// where every caret fault in this app has been: there is nowhere for a key to move to, so whatever
// the lane does when it has run out of document is what the user gets.
//
// Read through the view's own node rather than off the page wherever the question is about the
// document. A `<ul>` on screen says a list is drawn; the tree says which node the toolbar was
// acting on, and the two came apart in the list tools, where a press that did nothing at all left
// the same `<ul>` standing.

import { expect, test, type Page } from "@playwright/test";
import { putCaret, settle } from "./caret";

const HANDBOOK = "/Users/you/Documents/Handbook";

/** The tree, from the recents list, which is the shortest way to a folder with documents in it. */
async function openFolder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await expect(page.locator(`.tree-row[data-path="${HANDBOOK}/README.md"]`)).toBeVisible();
}

/**
 * An empty document with the caret in it, through the panel rather than by emptying an existing
 * file, so the state under test is the one a new file really opens in.
 *
 * The wait on the pill is not decoration. Every tool is drawn disabled until the editor handle
 * exists, and a click on a disabled button is a thirty second actionability timeout reported
 * against whatever the test was really about.
 */
async function blankDocument(page: Page, name: string): Promise<void> {
  await page.locator('.sidebar-head button[aria-label="New Document"]').click();
  await page.locator(".panel-setup .field input").fill(name);
  await page.locator(".panel-setup .btn-primary").click();
  await expect(page.locator(".prose")).toBeVisible();
  await expect(page.locator(".prose > *")).toHaveCount(1);
  await page.locator(".prose").click();
  await expect(page.locator('.editor-toolbar .tool[aria-label="Bold"]')).toBeEnabled();
  await settle(page);
}

/** The same, then a paragraph either side of an empty one with the caret in it. */
async function betweenTwoParagraphs(page: Page, name: string): Promise<void> {
  await blankDocument(page, name);
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("omega");
  await settle(page);
  await page.locator(".prose p").nth(1).click();
  await settle(page);
}

/** The document as the view holds it, which is what a toolbar command actually acted on. */
function docJson(page: Page): Promise<DocNode> {
  return page.evaluate(() => {
    const el = document.querySelector(".prose") as unknown as {
      pmViewDesc: { node: { toJSON(): unknown } };
    };
    return el.pmViewDesc.node.toJSON() as DocNode;
  });
}

interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
}

/** The names of the document's own children, which is the shape every test here asserts on. */
const topLevel = async (page: Page): Promise<string[]> =>
  (await docJson(page)).content?.map((node) => node.type) ?? [];

/**
 * The names of the tools drawn pressed, which is the whole of what the pill claims.
 *
 * Read off aria-label rather than off title, which is what a tool used to carry and no longer does:
 * the pill draws its own tooltip now, so the name a tool answers to here is its accessible name and
 * the tooltip beside it is data-tip, which says the same thing plus a chord.
 */
function litTools(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".editor-toolbar .tool")]
      .filter((tool) => (tool as HTMLElement).dataset.on === "true")
      .map((tool) => tool.getAttribute("aria-label") ?? ""),
  );
}

const pressTool = (page: Page, title: string) =>
  page.locator(`.editor-toolbar .tool[aria-label="${title}"]`).click();

const pickFromPopover = async (page: Page, title: string, pop: string, item: string) => {
  await pressTool(page, title);
  await page.locator(`${pop} button`, { hasText: item }).first().click();
};

/**
 * One block tool, said once, so the two sweeps below and the toggling test all press it the same
 * way. `lit` is what the pill draws pressed with the caret inside the block, and it is a title
 * rather than a boolean because three of these tools change their own title once the caret is in
 * what they made.
 */
interface BlockTool {
  name: string;
  node: string;
  insert: (page: Page) => Promise<void>;
  lit: string;
  /** Where a keystroke lands once the block exists, for the tools whose block is not a textblock. */
  types: boolean;
}

const BLOCK_TOOLS: BlockTool[] = [
  {
    name: "heading",
    node: "heading",
    insert: (page) => pickFromPopover(page, "Heading", ".heading-pop", "Heading 2"),
    lit: "Heading",
    types: true,
  },
  {
    name: "bulleted list",
    node: "bulletList",
    insert: (page) => pressTool(page, "Bulleted list"),
    lit: "Bulleted list",
    types: true,
  },
  {
    name: "numbered list",
    node: "orderedList",
    insert: (page) => pressTool(page, "Numbered list"),
    lit: "Numbered list",
    types: true,
  },
  {
    name: "task list",
    node: "taskList",
    insert: (page) => pressTool(page, "Task list"),
    lit: "Task list",
    types: true,
  },
  {
    name: "quote",
    node: "blockquote",
    insert: (page) => pressTool(page, "Quote"),
    lit: "Quote",
    types: true,
  },
  {
    name: "callout",
    node: "callout",
    insert: (page) => pickFromPopover(page, "Callout", ".callout-pop", "Note"),
    lit: "Callout",
    types: true,
  },
  {
    name: "toggle",
    node: "toggle",
    insert: (page) => pressTool(page, "Toggle"),
    lit: "Toggle",
    types: true,
  },
  {
    name: "table",
    node: "table",
    insert: async (page) => {
      await pressTool(page, "Insert table");
      await page.locator('.table-pop .size-cell[title="2 by 2 table"]').click();
    },
    lit: "Table",
    types: true,
  },
  {
    name: "mermaid diagram",
    node: "codeBlock",
    insert: (page) => pickFromPopover(page, "Insert", ".insert-pop", "Mermaid diagram"),
    lit: "Code block: mermaid",
    types: true,
  },
  // The two that are not textblocks and so have nowhere for the next keystroke to go. Both are
  // atoms, which is what made them worth sweeping: an atom left selected by its own insert is one
  // keystroke from being replaced by that keystroke.
  {
    name: "horizontal rule",
    node: "horizontalRule",
    insert: (page) => pressTool(page, "Horizontal rule"),
    lit: "",
    types: false,
  },
  {
    name: "display formula",
    node: "mathBlock",
    insert: (page) => pickFromPopover(page, "Insert", ".insert-pop", "Display formula"),
    lit: "",
    types: false,
  },
];

for (const tool of BLOCK_TOOLS) {
  test(`the ${tool.name} tool makes its block in an empty document`, async ({ page }) => {
    await openFolder(page);
    await blankDocument(page, "Scratchpad");

    await tool.insert(page);
    await settle(page);

    expect(await topLevel(page)).toContain(tool.node);
    if (tool.lit) expect(await litTools(page)).toContain(tool.lit);
  });

  test(`the ${tool.name} tool makes its block between two paragraphs`, async ({ page }) => {
    await openFolder(page);
    await betweenTwoParagraphs(page, "Scratchpad");

    await tool.insert(page);
    await settle(page);

    // The paragraph either side is untouched, which is the half a snapshot of the middle block
    // cannot say. A wrap that reaches too far takes the neighbours with it.
    const doc = await docJson(page);
    const names = doc.content?.map((node) => node.type) ?? [];
    expect(names[0]).toBe("paragraph");
    expect(names).toContain(tool.node);
    expect(names[names.length - 1]).toBe("paragraph");
  });

  if (tool.types) {
    test(`typing in a fresh ${tool.name} lands inside it`, async ({ page }) => {
      await openFolder(page);
      await blankDocument(page, "Scratchpad");

      await tool.insert(page);
      await settle(page);
      await page.keyboard.type("inside");
      await settle(page);

      // Asked of the block's own text rather than of the document's, so a keystroke that landed in
      // a paragraph beside the block reads as the failure it is rather than as a pass.
      const text = await page.evaluate((name) => {
        const el = document.querySelector(".prose") as unknown as {
          pmViewDesc: { node: { descendants(f: (n: { type: { name: string }; textContent: string }) => void): void } };
        };
        let found = "";
        el.pmViewDesc.node.descendants((node) => {
          if (node.type.name === name && !found) found = node.textContent;
        });
        return found;
      }, tool.node);
      expect(text).toContain("inside");
    });
  }
}

// The escape, which is the half the code block was found broken in and the half every other block
// here shares a document end with. Nothing asserts that ArrowDown moves: in a heading or a
// paragraph with nothing under it there is nothing to move to and no editor pretends otherwise.
// What is asserted is that a paragraph is reachable at all, by the keys somebody would press, and
// that the block the caret came out of is still there afterwards.
test("a quote, a callout and a toggle at the end of a document all hand the caret back", async ({
  page,
}) => {
  await openFolder(page);

  for (const [name, insert] of [
    ["blockquote", (p: Page) => pressTool(p, "Quote")],
    ["callout", (p: Page) => pickFromPopover(p, "Callout", ".callout-pop", "Note")],
    ["toggle", (p: Page) => pressTool(p, "Toggle")],
  ] as const) {
    await blankDocument(page, `Escape ${name}`);
    await insert(page);
    await settle(page);
    await page.keyboard.type("inside");

    // Enter opens a paragraph inside the wrapper and Enter on that empty paragraph lifts it out,
    // which is the gesture every editor with a quote in it has. ArrowDown is not it: the wrapper is
    // the last thing in the document, so there is no line under the one the caret is on.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await settle(page);
    await page.keyboard.type("after");
    await settle(page);

    const doc = await docJson(page);
    expect(doc.content?.map((node) => node.type)).toEqual([name, "paragraph"]);
    expect(doc.content?.[1].content?.[0]).toMatchObject({ type: "text", text: "after" });
  }
});

test("a list at the end of a document hands the caret back on a second Enter", async ({ page }) => {
  await openFolder(page);

  for (const [node, title] of [
    ["bulletList", "Bulleted list"],
    ["orderedList", "Numbered list"],
    ["taskList", "Task list"],
  ] as const) {
    await blankDocument(page, `Escape ${node}`);
    await pressTool(page, title);
    await settle(page);
    await page.keyboard.type("item");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await settle(page);
    await page.keyboard.type("after");
    await settle(page);

    expect(await topLevel(page)).toEqual([node, "paragraph"]);
  }
});

// The mermaid item is on this side of the bar and the fence it makes is the code lane's, so this
// asserts the wiring between them rather than the lane: a diagram made from the Insert menu ends
// the document like any other block, and the arrow out of it has to find its way to a paragraph
// the same way the arrow out of a table does.
test("ArrowDown out of a mermaid diagram that ends the document reaches a paragraph", async ({
  page,
}) => {
  await openFolder(page);
  await blankDocument(page, "Diagram");

  await pickFromPopover(page, "Insert", ".insert-pop", "Mermaid diagram");
  await settle(page);
  await page.keyboard.type("graph TD");
  await settle(page);
  await page.keyboard.press("ArrowDown");
  await settle(page);
  await page.keyboard.type("after");
  await settle(page);

  const doc = await docJson(page);
  expect(doc.content?.map((node) => node.type)).toEqual(["codeBlock", "paragraph"]);
  expect(doc.content?.[0].attrs).toMatchObject({ language: "mermaid" });
  expect(doc.content?.[0].content?.[0]).toMatchObject({ type: "text", text: "graph TD" });
});

// Pressing the tool again. Three of the block tools are documented in src/editor/index.ts as
// turning their block back into a paragraph on a second press, and for two milestones the three
// list tools did not: TipTap finds the list the caret is in by looking for the word "list" in the
// node's `group`, src/model/schema.ts said only "block", so the branch that lifts the item was
// unreachable and the press ran the wrapping branch instead, which took the item out of the list
// and put it straight back. Nothing moved on screen and the tool stayed lit over a list it could
// not take off.
test("the three list tools take their list back off when they are pressed again", async ({
  page,
}) => {
  await openFolder(page);

  for (const [node, title] of [
    ["bulletList", "Bulleted list"],
    ["orderedList", "Numbered list"],
    ["taskList", "Task list"],
  ] as const) {
    await blankDocument(page, `Off ${node}`);
    await page.keyboard.type("one");
    await pressTool(page, title);
    await settle(page);
    expect(await topLevel(page)).toEqual([node]);
    expect(await litTools(page)).toContain(title);

    await pressTool(page, title);
    await settle(page);
    expect(await topLevel(page)).toEqual(["paragraph"]);
    expect(await litTools(page)).not.toContain(title);

    // And the words are still the words. A lift that drops the item's content is the other way this
    // could have been made to pass.
    const doc = await docJson(page);
    expect(doc.content?.[0].content?.[0]).toMatchObject({ type: "text", text: "one" });
  }
});

test("the heading menu takes a heading back to a paragraph, and the toggle tool removes a toggle", async ({
  page,
}) => {
  await openFolder(page);

  await blankDocument(page, "Off heading");
  await page.keyboard.type("title");
  await pickFromPopover(page, "Heading", ".heading-pop", "Heading 2");
  await settle(page);
  expect(await topLevel(page)).toEqual(["heading"]);
  await pickFromPopover(page, "Heading", ".heading-pop", "Paragraph");
  await settle(page);
  expect(await topLevel(page)).toEqual(["paragraph"]);

  await blankDocument(page, "Off toggle");
  await page.keyboard.type("body");
  await pressTool(page, "Toggle");
  await settle(page);
  expect(await topLevel(page)).toEqual(["toggle"]);
  await pressTool(page, "Toggle");
  await settle(page);
  expect(await topLevel(page)).toEqual(["paragraph"]);
});

// A rule is a leaf, so the insert leaves it selected whole, and a selected node is a node the next
// character replaces. In an empty document there is nothing to do after pressing the tool except
// type, so the rule was gone on the first keystroke after it was made and the document had a
// paragraph where it had been.
//
// The second half of this is about where that character lands, which took a second fix and is
// asserted separately because it failed on its own after the first one: the caret was drawn under
// the rule and Chromium went on typing above it.
test("a horizontal rule survives the first thing typed after it", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Rule");

  await pressTool(page, "Horizontal rule");
  await settle(page);
  expect(await topLevel(page)).toEqual(["horizontalRule", "paragraph"]);

  await page.keyboard.type("after");
  await settle(page);
  const doc = await docJson(page);
  expect(doc.content?.map((node) => node.type)).toEqual(["horizontalRule", "paragraph"]);
  expect(doc.content?.[1].content?.[0]).toMatchObject({ type: "text", text: "after" });
});

test("a horizontal rule between two paragraphs takes the next character under it", async ({
  page,
}) => {
  await openFolder(page);
  await betweenTwoParagraphs(page, "Rule between");

  await pressTool(page, "Horizontal rule");
  await settle(page);
  await page.keyboard.type("under");
  await settle(page);

  const doc = await docJson(page);
  const names = doc.content?.map((node) => node.type) ?? [];
  expect(names[0]).toBe("paragraph");
  expect(names[1]).toBe("horizontalRule");
  expect(doc.content?.[2].content?.[0]).toMatchObject({ type: "text", text: "under" });
});

// The formula's source is a textarea inside the node view and it is on screen only while the node
// is selected. Committing a keystroke rewrites the node, and for an inline formula the node
// selection did not survive that rewrite: ProseMirror deselected the node, the node view cleared
// its editing flag, math.css hid the field, and the field losing the keyboard took the caret out of
// the document altogether. Typed at speed it looked like the formula simply refusing to take text.
test("an inline formula takes every character typed into it", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Inline formula");

  await pickFromPopover(page, "Insert", ".insert-pop", "Inline formula");
  await expect(page.locator(".math-source")).toBeFocused();

  await page.keyboard.type("a+b");
  await settle(page);

  const doc = await docJson(page);
  expect(doc.content?.[0].content?.[0]).toMatchObject({
    type: "mathInline",
    attrs: { latex: "a+b" },
  });
  // Still holding the keyboard, which is the half that says the next character would land too.
  await expect(page.locator(".math-source")).toBeFocused();
});

// And the way out of one. Escape puts the caret past the node, which with nothing past it came back
// as the node selection it started from: the field stayed open, the formula stayed selected, and
// the next character replaced the whole formula with itself.
test("Escape leaves a display formula that ends the document", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Display formula");

  await pickFromPopover(page, "Insert", ".insert-pop", "Display formula");
  await page.locator(".math-source").fill("x^2");
  await page.keyboard.press("Escape");
  await settle(page);

  await expect(page.locator(".math-block .katex")).toBeVisible();
  await expect(page.locator(".math-source")).toBeHidden();

  await page.keyboard.type("after");
  await settle(page);
  const doc = await docJson(page);
  expect(doc.content?.map((node) => node.type)).toEqual(["mathBlock", "paragraph"]);
  expect(doc.content?.[0].attrs).toMatchObject({ latex: "x^2" });
});

// The pressed states, asked of the pill rather than of the editor, because a tool that is right
// about the document and wrong on screen is the same lie to the person using it.
test("the pill lights the tool for the block the caret is in and goes dark when it leaves", async ({
  page,
}) => {
  await openFolder(page);
  await blankDocument(page, "Active");

  await page.keyboard.type("plain");
  await page.keyboard.press("Enter");
  await pressTool(page, "Quote");
  await settle(page);
  await page.keyboard.type("quoted");
  await settle(page);
  expect(await litTools(page)).toEqual(["Quote"]);

  await page.locator(".prose p").first().click();
  await settle(page);
  expect(await litTools(page)).toEqual([]);

  await page.locator(".prose blockquote p").first().click();
  await settle(page);
  expect(await litTools(page)).toEqual(["Quote"]);
});

// ------------------------------------------------------------------------------------------------
// The dark half of the pill
//
// Sixteen of the eighteen tools have somewhere they cannot run, and until now every one of them
// answered a press there with nothing at all: no toast, no motion, no change of state. The
// commands were right to refuse, which src/editor/fits.test.ts proves block by block; what was
// missing was anybody saying so before the press. So the tools that cannot run are drawn dark, and
// this is where that claim is checked against the running pill rather than against the predicate
// behind it.
//
// Written as a list of the dark titles rather than as one assertion per tool, because the point is
// the whole bar at once: a tool added to the pill without an answer for a fence or a cell shows up
// here as a title in the wrong list, which is the same shape of gate the guard matrix upstairs is.
// ------------------------------------------------------------------------------------------------

/**
 * The tools the pill has drawn dark, in the order they sit on the bar.
 *
 * The code block tool writes the fence's language into its own name, which is not what this is
 * asking about, so a name is cut back to its first half.
 */
function darkTools(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".editor-toolbar .tool")]
      .filter((tool) => (tool as HTMLButtonElement).disabled)
      .map((tool) => (tool.getAttribute("aria-label") ?? "").split(":")[0]),
  );
}

test("an ordinary paragraph leaves every tool live", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Nothing dark");

  expect(await darkTools(page)).toEqual([]);
});

// A fence is the context that takes conversions and refuses everything else, and it is the one a
// coarser rule would have got wrong in the expensive direction: greying the list and heading tools
// out here would take away an edit that works and that the file can spell.
test("the caret in a fence darkens the marks and the inserts, and leaves the conversions live", async ({
  page,
}) => {
  await openFolder(page);
  await blankDocument(page, "Dark in a fence");

  await pressTool(page, "Code block");
  await settle(page);
  await page.keyboard.type("let x = 1;");
  await settle(page);

  expect(await darkTools(page)).toEqual([
    "Bold",
    "Italic",
    "Strikethrough",
    "Inline code",
    "Colour",
    "Link",
    "Horizontal rule",
    "Insert image",
    "Insert table",
    "Insert",
  ]);
});

// And a cell is the other way round. A mark goes on the text in a cell perfectly happily and so
// does a picture, since a cell holds inline content; a block does not fit and there is no block in
// there for a conversion to act on either.
test("the caret in a table cell darkens the conversions, and leaves the marks and the picture live", async ({
  page,
}) => {
  await openFolder(page);
  await blankDocument(page, "Dark in a cell");

  await pressTool(page, "Insert table");
  await page.locator('.table-pop .size-cell[title="2 by 2 table"]').click();
  await settle(page);

  expect(await darkTools(page)).toEqual([
    "Heading",
    "Bulleted list",
    "Numbered list",
    "Task list",
    "Quote",
    "Toggle",
    "Callout",
    "Code block",
    "Horizontal rule",
    "Insert",
  ]);
});

// Pressed anyway, with a real mouse, because a button that is drawn dark and still runs its command
// is the same lie the other way round. Forced past Playwright's own actionability check on purpose:
// what is under test is what the browser does with a press on a disabled control, not whether
// Playwright would have made it.
test("a tool drawn dark does nothing when it is pressed", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Press a dark tool");

  await pressTool(page, "Insert table");
  await page.locator('.table-pop .size-cell[title="2 by 2 table"]').click();
  await settle(page);
  const before = await docJson(page);

  await expect(page.locator('.editor-toolbar .tool[aria-label="Bulleted list"]')).toBeDisabled();
  await page.locator('.editor-toolbar .tool[aria-label="Bulleted list"]').click({ force: true });
  await settle(page);

  expect(await docJson(page)).toEqual(before);
});

// ------------------------------------------------------------------------------------------------
// The page under the document
//
// A sheet grows to fill the pane whether the document does or not, so most of what is on screen
// under a short file is blank page. None of it was the editable: a press landed on the article the
// editor is mounted in, moved no caret, and took the focus out of the document, so clicking the
// page put the writer out of their own file.
// ------------------------------------------------------------------------------------------------

test("clicking the page below a short document puts the caret at the end of it", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Below the document");

  await page.keyboard.type("alpha");
  await settle(page);
  await page.locator(".append-zone").click();
  await settle(page);
  await page.keyboard.type("omega");
  await settle(page);

  const doc = await docJson(page);
  expect(doc.content?.map((node) => node.type)).toEqual(["paragraph", "paragraph"]);
  expect(doc.content?.[0].content?.[0]).toMatchObject({ type: "text", text: "alpha" });
  expect(doc.content?.[1].content?.[0]).toMatchObject({ type: "text", text: "omega" });
});

// The same press with nothing to land in, which is the state the block tools leave a fresh document
// in and the one a person gets stuck in: the table is the whole document, so there is no line under
// it and no key that makes one from outside the table.
test("clicking the page below a table that is the whole document hands the caret back", async ({
  page,
}) => {
  await openFolder(page);
  await blankDocument(page, "Below a table");

  await pressTool(page, "Insert table");
  await page.locator('.table-pop .size-cell[title="2 by 2 table"]').click();
  await settle(page);

  await page.locator(".append-zone").click();
  await settle(page);
  await page.keyboard.type("after");
  await settle(page);

  const doc = await docJson(page);
  expect(doc.content?.map((node) => node.type)).toEqual(["table", "paragraph"]);
  expect(doc.content?.[1].content?.[0]).toMatchObject({ type: "text", text: "after" });
});

// Held down, or pressed twice by somebody who did not see the caret arrive. The second press finds
// the paragraph the first one made, so a column of empty blocks cannot be built up by pressing the
// page, and the file gains no byte for the one that is there.
test("pressing the page twice leaves one paragraph", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Pressed twice");

  await page.keyboard.type("alpha");
  await settle(page);
  await page.locator(".append-zone").click();
  await settle(page);
  await page.locator(".append-zone").click();
  await settle(page);

  expect(await topLevel(page)).toEqual(["paragraph", "paragraph"]);
});

// The mermaid insert, from the middle of a sentence rather than from an empty block, which is the
// shape the sweep above cannot reach. The insert splits the paragraph, and the caret used to land
// in the half UNDER the new fence: the first line of somebody's diagram went into their prose.
test("a mermaid diagram made mid paragraph takes the caret into the fence", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "Mermaid mid paragraph");

  await page.keyboard.type("alphaomega");
  await settle(page);
  await putCaret(page.locator(".prose p").first(), 5);

  await pickFromPopover(page, "Insert", ".insert-pop", "Mermaid diagram");
  await settle(page);
  await page.keyboard.type("graph TD");
  await settle(page);

  const doc = await docJson(page);
  expect(doc.content?.map((node) => node.type)).toEqual(["paragraph", "codeBlock", "paragraph"]);
  expect(doc.content?.[1].attrs).toMatchObject({ language: "mermaid" });
  expect(doc.content?.[1].content?.[0]).toMatchObject({ type: "text", text: "graph TD" });
  // And the sentence it was inserted into is still the sentence, in two halves either side of it.
  expect(doc.content?.[0].content?.[0]).toMatchObject({ type: "text", text: "alpha" });
  expect(doc.content?.[2].content?.[0]).toMatchObject({ type: "text", text: "omega" });
});

// ------------------------------------------------------------------------------------------------
// What the pill says about itself
//
// Two claims that are only true on screen, so neither can be checked anywhere but here.
//
// A menu says which value is the current one. It used to say it by filling the row with the accent,
// which is what the row under the pointer also looks like, so the two states were told apart by a
// shade. It says it with a trailing check now, and the fill belongs to hover alone: an assertion
// about the check on its own would still pass if the fill came back, so the paper under both rows
// is asserted too.
//
// And a tool names the key it answers to. The chords for the marks and the blocks live in the
// TipTap keymap rather than in the app's binding table, so the pill is the only surface a person
// meets them on, and the tooltip that carries them is drawn by this app rather than by the webview.
// Which means it is a pseudo element with an opacity, and the only way to ask whether it is on
// screen is to ask the browser for the computed style of `::after`.
// ------------------------------------------------------------------------------------------------

/** The opacity the pill's own tooltip is drawn at, which is the whole of whether it is on screen. */
function tipOpacity(page: Page, name: string): Promise<string> {
  return page.evaluate((tool) => {
    const button = document.querySelector(`.editor-toolbar .tool[aria-label="${tool}"]`);
    return button === null ? "gone" : getComputedStyle(button, "::after").opacity;
  }, name);
}

/** The words the tooltip is actually drawing, which is not the same question as what it was given. */
function tipText(page: Page, name: string): Promise<string> {
  return page.evaluate((tool) => {
    const button = document.querySelector(`.editor-toolbar .tool[aria-label="${tool}"]`);
    return button === null ? "gone" : getComputedStyle(button, "::after").content;
  }, name);
}

/** Comfortably past the tooltip's own delay, which is 400ms in src/styles/toolbar.css. */
const TOOLTIP_DELAY = 700;

test("the heading menu marks the block the caret is in with a check and fills no row", async ({
  page,
}) => {
  await openFolder(page);
  await blankDocument(page, "A check in a menu");

  await pickFromPopover(page, "Heading", ".heading-pop", "Heading 2");
  await page.keyboard.type("a section");
  await settle(page);

  await pressTool(page, "Heading");
  const chosen = page.locator(".heading-pop .pop-item", { hasText: "Heading 2" });
  const other = page.locator(".heading-pop .pop-item", { hasText: "Heading 1" });

  await expect(chosen).toHaveAttribute("data-on", "true");
  await expect(chosen.locator("svg")).toBeVisible();
  await expect(other.locator("svg")).toBeHidden();

  // Neither row is filled. The pointer is on the tool that opened the menu rather than on a row, so
  // an accent behind either of these would be the old pressed state and not a hover.
  await expect(chosen).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(other).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  // And the chord that reaches the same row from the keyboard, which is the other half of what the
  // menu is for: there is no tool on the bar for a heading level to hang a tooltip off.
  await expect(chosen.locator(".pop-chord")).toHaveText(/2$/);
});

test("a tool's tooltip names the chord it answers to", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "A chord in a tooltip");

  // Not a title. A native one beside this would be the same words a second later in the webview's
  // own chrome, so the accessible name and the drawn tooltip are separate attributes.
  const bold = page.locator('.editor-toolbar .tool[aria-label="Bold"]');
  await expect(bold).toHaveAttribute("data-tip", /^Bold \(\S+B\)$/);
  expect(await bold.getAttribute("title")).toBeNull();

  await bold.hover();
  await expect.poll(() => tipOpacity(page, "Bold")).toBe("1");
  expect(await tipText(page, "Bold")).toBe(`"${await bold.getAttribute("data-tip")}"`);
});

test("a tool the caret cannot use draws no tooltip", async ({ page }) => {
  await openFolder(page);
  await blankDocument(page, "No tooltip on a dark tool");

  await pressTool(page, "Insert table");
  await page.locator('.table-pop .size-cell[title="2 by 2 table"]').click();
  await settle(page);

  const list = page.locator('.editor-toolbar .tool[aria-label="Bulleted list"]');
  await expect(list).toBeDisabled();
  await list.hover();
  await page.waitForTimeout(TOOLTIP_DELAY);

  expect(await tipOpacity(page, "Bulleted list")).toBe("0");
});
