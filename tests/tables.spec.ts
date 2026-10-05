// A table as a grid that can be typed into without moving, driven the way a person drives it.
//
// Two things here only a browser can show. The first is layout: whether typing into one cell moves
// the column beside it is a question about pixels, and src/styles/prose.css answers it with a fixed
// table layout that no unit test can see. The second is the arrows, whose "is the caret on the last
// line of this cell" is the view's measurement of wrapped text. src/editor/blocks/tables.test.ts
// stubs that measurement and walks the plugin list; this file presses the real keys against the
// real view and reads the caret back off the page.
//
// The bug this is shaped around was reported from a screen recording: a table whose columns
// shuffled under the caret on every keystroke, and an ArrowDown out of its last row that put the
// caret between two cells of that row, drawn as a phantom column. Both came from the same place:
// prosemirror-tables' own arrow handling never fires against a cell holding inline content, so the
// gap cursor plugin answered instead, and a gap cursor is a `<div>`, which between two `<td>`s is a
// cell as far as the browser is concerned.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { caretIsIn, putCaret, settle } from "./caret";
import { ask, change, installTauriShim } from "./disk";

const HANDBOOK = "/Users/you/Documents/Handbook";
const README = `${HANDBOOK}/README.md`;

async function openReadme(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await page.locator(`.tree-row[data-path="${README}"]`).click();
  await expect(page.locator(".prose h1")).toHaveText("Handbook");
  const paragraph = page.locator(".prose p").first();
  await paragraph.click();
  await caretIsIn(paragraph);
}

/** A 3 by 3 table from the pill, with the caret in its first header cell. */
async function insertTable(page: Page): Promise<Locator> {
  await page.locator('.editor-toolbar .tool[aria-label="Insert table"]').click();
  await page.locator('.table-pop .size-cell[title="3 by 3 table"]').click();
  const table = page.locator(".prose table").first();
  await expect(table.locator("tr")).toHaveCount(3);
  await caretIsIn(table.locator("th").first());
  return table;
}

/** The header cells' widths, rounded, which is what a column's width is. */
function columnWidths(table: Locator): Promise<number[]> {
  return table
    .locator("tr")
    .first()
    .locator("th")
    .evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width)));
}

test("typing into a cell does not move the columns", async ({ page }) => {
  await openReadme(page);
  const table = await insertTable(page);

  // A fresh table is equal columns across the measure, which is the shape to hold on to.
  const before = await columnWidths(table);
  expect(new Set(before).size).toBe(1);

  await page.keyboard.type("A header long enough to wrap on to a second line of its own cell");
  await settle(page);

  await expect(table.locator("th").first()).toContainText("second line");
  expect(await columnWidths(table)).toEqual(before);
});

test("Enter walks down a column and out under the table, and the arrows go both ways", async ({
  page,
}) => {
  await openReadme(page);
  const table = await insertTable(page);
  const rows = table.locator("tr");

  await page.keyboard.type("a");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b");
  await page.keyboard.press("Enter");
  await page.keyboard.type("c");
  await expect(rows.nth(1).locator("td").nth(1)).toHaveText("c");

  // Two more: the last row, then out. Under the table the caret lands at the front of the block
  // that was already there, and the table has not grown a row for it.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("under ");
  await expect(rows).toHaveCount(3);
  const after = page.locator(".prose .tableWrapper + *").first();
  await expect(after).toContainText(/^under /);

  // And nowhere in any of that was the caret a hairline between two cells.
  await expect(page.locator(".prose .ProseMirror-gapcursor")).toHaveCount(0);

  // Back in from below: the last row, and one more up is the row above it.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await caretIsIn(rows.nth(2).locator("td").first());
  await page.keyboard.press("ArrowUp");
  await caretIsIn(rows.nth(1).locator("td").first());
  await expect(page.locator(".prose .ProseMirror-gapcursor")).toHaveCount(0);
});

test("the cell holding the caret is the one ringed", async ({ page }) => {
  await openReadme(page);
  const table = await insertTable(page);

  await expect(table.locator(".cell-focus")).toHaveCount(1);
  await expect(table.locator("th").first()).toHaveClass(/cell-focus/);

  await page.keyboard.press("Tab");
  await expect(table.locator(".cell-focus")).toHaveCount(1);
  await expect(table.locator("th").nth(1)).toHaveClass(/cell-focus/);

  // Out of the table, and there is nothing to ring.
  await page.locator(".prose h1").click();
  await expect(table.locator(".cell-focus")).toHaveCount(0);
});

// The two bars that grow the table, which are a widget decoration and so are only really two
// things in a browser: an element the pointer can find, and an element the parser must not.
//
// Everything about them that can go wrong is geometry or hit testing. Whether a bar is under the
// pointer, whether it takes a click while it is invisible, whether it stays with the table when the
// table scrolls sideways inside its own box: none of those is a question a unit test can be asked,
// and src/editor/blocks/tables.test.ts asks the other half, which is where the widget sits in the
// document and what a press does to the tree.

/**
 * What "revealed" means for a bar: the two properties the reveal in src/styles/prose.css sets.
 *
 * Polled rather than read once, because the reveal is a transition and a value read on the frame
 * the pointer arrived on is a tenth of the way through it. Which is also the assertion: an opacity
 * that settles is a bar that faded in rather than one that was already drawn.
 */
function barIs(table: Locator, which: "row" | "col", state: Record<string, string>) {
  return expect
    .poll(
      () =>
        table.locator(`.table-add-${which}`).evaluate((element) => {
          const style = getComputedStyle(element);
          return { opacity: style.opacity, pointerEvents: style.pointerEvents };
        }),
      { message: `the ${which} bar never settled` },
    )
    .toEqual(state);
}

const HIDDEN = { opacity: "0", pointerEvents: "none" };
const SHOWN = { opacity: "0.7", pointerEvents: "auto" };

test("the bars are nothing until the pointer is on the last row or the last column", async ({
  page,
}) => {
  await openReadme(page);
  const table = await insertTable(page);
  const rows = table.locator("tr");

  // Drawn from the moment the table is, so that nothing has to be built under the pointer, and
  // saying nothing at all from the same moment. Nothing at all includes taking a press: the strip
  // under a table is a place somebody clicks to put the caret past it.
  await expect(table.locator(".table-bars")).toHaveCount(1);
  await page.locator(".prose h1").hover();
  await barIs(table, "row", HIDDEN);
  await barIs(table, "col", HIDDEN);

  // A cell in the middle of the table is neither question, which is the quieter half of the
  // behaviour: a pointer resting in a table is not a pointer asking to grow one.
  await rows.nth(1).locator("td").first().hover();
  await barIs(table, "row", HIDDEN);
  await barIs(table, "col", HIDDEN);

  await rows.nth(2).locator("td").first().hover();
  await barIs(table, "row", SHOWN);
  await barIs(table, "col", HIDDEN);

  // The last cell of a row that is not the last row: the column, and only the column.
  await rows.nth(1).locator("td").last().hover();
  await barIs(table, "row", HIDDEN);
  await barIs(table, "col", SHOWN);

  // And the corner cell is both questions at once.
  await rows.nth(2).locator("td").last().hover();
  await barIs(table, "row", SHOWN);
  await barIs(table, "col", SHOWN);
});

test("the bar under the table appends a row with the caret waiting in it", async ({ page }) => {
  await openReadme(page);
  const table = await insertTable(page);
  const rows = table.locator("tr");

  await rows.nth(2).locator("td").first().hover();
  await table.locator(".table-add-row").click();

  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3).locator("td")).toHaveCount(3);
  await caretIsIn(rows.nth(3).locator("td").first());

  // The point of the caret being there: the next thing after the press is typing into the row.
  await page.keyboard.type("new");
  await expect(rows.nth(3).locator("td").first()).toHaveText("new");
});

test("the bar beside the table appends a column with a header on it", async ({ page }) => {
  await openReadme(page);
  const table = await insertTable(page);

  await table.locator("tr").first().locator("th").last().hover();
  await table.locator(".table-add-col").click();

  // A header row is the one shape GFM has for a table, so the new column's first cell is a header
  // whatever prosemirror-tables built it from, and it is where the caret goes: the column is named
  // before it is filled.
  await expect(table.locator("tr").first().locator("th")).toHaveCount(4);
  await expect(table.locator("tr").nth(1).locator("td")).toHaveCount(4);
  await caretIsIn(table.locator("tr").first().locator("th").nth(3));

  await page.keyboard.type("Fourth");
  await expect(table.locator("th").nth(3)).toHaveText("Fourth");
});

// The bar sits at the table's own right edge rather than at the edge of the box the table scrolls
// inside, and those are two different places the moment a table is wider than the measure. Measured
// rather than looked at, because "attached to the table" is a claim about two rectangles.
test("the bar beside the table stays on the table when the table scrolls sideways", async ({
  page,
}) => {
  await openReadme(page);
  const table = await insertTable(page);

  // Enough columns that the table's own minimum width is past the measure and the wrapper scrolls.
  for (let column = 0; column < 6; column += 1) {
    await table.locator("tr").first().locator("th").last().hover();
    await table.locator(".table-add-col").click();
  }
  await settle(page);

  const wrapper = page.locator(".prose .tableWrapper");
  const scrolls = await wrapper.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(scrolls).toBe(true);

  const measured = await wrapper.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    const table = element.querySelector("table") as HTMLElement;
    const bar = element.querySelector(".table-add-col") as HTMLElement;
    const prose = element.closest(".prose") as HTMLElement;
    return {
      barLeft: Math.round(bar.getBoundingClientRect().left),
      tableRight: Math.round(table.getBoundingClientRect().right),
      barRight: Math.round(bar.getBoundingClientRect().right),
      wrapperRight: Math.round(element.getBoundingClientRect().right),
      proseRight: Math.round(prose.getBoundingClientRect().right),
    };
  });

  // Flush against the last column, which is what makes it the place a new column goes.
  expect(measured.barLeft).toBe(measured.tableRight);
  // Inside its own box rather than lying over the page beside it, and no wider than the gutter the
  // sheet already leaves.
  expect(measured.barRight).toBeLessThanOrEqual(measured.wrapperRight);
  expect(measured.barLeft).toBeGreaterThanOrEqual(measured.proseRight);
});

// The file contract, with the elements really drawn and the bytes really written. A widget is
// chrome and its parse rule is `ignore`, so a table with two buttons inside its <tbody> has to go
// back to disk as the table that was read off it, and the only way to know is to read the disk.

/** Longer than the 500ms autosave debounce in src/document.ts, with room for the write itself. */
const SAVED = 1500;

const SOURCE = "# Table\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n";

/** Opens the README with the given bytes in it, over the fixture the packaged app itself runs. */
async function openBytes(page: Page, source: string): Promise<void> {
  await page.addInitScript(installTauriShim);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("margindocs-recents", JSON.stringify(["/Users/you/Documents/Handbook"]));
  });
  await page.goto("/");
  await page.locator(".start-row").first().click();
  await page.locator(`.tree-row[data-path="${README}"]`).click();
  await expect(page.locator(".prose")).toBeVisible();

  // Written from outside rather than typed, so this is a file the app has only ever read.
  await change(page, "write", README, source);
  await expect.poll(() => ask<string>(page, "read", README)).toBe(source);
  await expect(page.locator(".prose table")).toBeVisible();
}

const disk = (page: Page) => ask<string>(page, "read", README);

test("a table with the bars drawn over it saves as the table it was", async ({ page }) => {
  await openBytes(page, SOURCE);
  await expect(page.locator(".prose .table-bars")).toHaveCount(1);

  // One character, in the paragraph after the table, which is the whole of what the file is allowed
  // to gain. Anything the widget leaked into the tree would show up as a changed table beside it.
  const paragraph = page.locator(".prose p").last();
  await paragraph.click();
  await putCaret(paragraph, "end");
  await page.keyboard.type("!");

  await expect
    .poll(() => disk(page), { timeout: SAVED })
    .toBe("# Table\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter!\n");
});

test("a row pressed out of the bar is a row in the file, and nothing else is", async ({ page }) => {
  await openBytes(page, SOURCE);
  // Two rows on screen for three lines of markdown: the delimiter row is the spelling of the
  // header rather than a row of its own.
  const rows = page.locator(".prose table tr");
  await expect(rows).toHaveCount(2);

  await rows.nth(1).locator("td").first().hover();
  await page.locator(".prose .table-add-row").click();
  await expect(rows).toHaveCount(3);
  await page.keyboard.type("3");

  await expect
    .poll(() => disk(page), { timeout: SAVED })
    .toBe("# Table\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | |\n\nafter\n");
});
