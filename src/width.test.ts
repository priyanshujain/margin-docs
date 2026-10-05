// The width table against the command table, and the subscription that joins them.
//
// The interesting failure is not `applyWidth` writing the wrong attribute, it is a width that has
// no command, or a command nothing is listening to: either one is a menu row and a palette entry
// that look fine and do nothing when pressed. Both are asserted by running the command rather than
// by calling `applyWidth`, which is the only way to see the wiring at all.
//
// The environment is node, so the two globals the module touches are stubbed. What is being
// checked is which attribute and which key it writes, and a fake records that as well as a browser
// would.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, runCommand, type CommandId } from "./keys/commands";
import { applyWidth, startWidthCommands, WIDTHS } from "./width";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

let attributes: Record<string, string>;
let stored: Record<string, string>;

beforeEach(() => {
  attributes = {};
  stored = {};
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    },
  });
  vi.stubGlobal("localStorage", {
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const widthCommand = (width: string) => `editor-width-${width}` as CommandId;

describe("the editor widths", () => {
  it("has one command per width and no command for a width that is gone", () => {
    const ids = COMMANDS.map((command) => command.id).filter((id) => id.startsWith("editor-width-"));
    expect([...ids].sort()).toEqual(WIDTHS.map(widthCommand).sort());
  });

  it("keeps the three names that are already in somebody's storage", () => {
    // A rename is a silent reset: the boot script would not recognise what it read and the sheet
    // would open at the default with nothing to say about it.
    expect(WIDTHS).toContain("narrow");
    expect(WIDTHS).toContain("normal");
    expect(WIDTHS).toContain("wide");
  });

  it("answers every width command once it has been started", () => {
    const stop = startWidthCommands();
    for (const width of WIDTHS) {
      runCommand(widthCommand(width));
      expect(attributes["data-width"]).toBe(width);
      expect(stored["margindocs-width"]).toBe(width);
    }
    stop();
  });

  it("stops answering when it is torn down", () => {
    const stop = startWidthCommands();
    runCommand("editor-width-full");
    stop();
    runCommand("editor-width-tight");
    expect(attributes["data-width"]).toBe("full");
  });

  it("writes the width under the app's own storage prefix", () => {
    applyWidth("tight");
    expect(Object.keys(stored)).toEqual(["margindocs-width"]);
  });
});

// The two copies of this table that are not TypeScript. A width with no rule behind it is a menu
// item that ticks and changes nothing, and a width the boot script does not recognise is one that
// applies until the app is relaunched and then quietly is not the width any more.
describe("the copies of the width table that cannot import it", () => {
  it("has a sheet rule for every width but the default, and a token behind every measure", () => {
    const sheet = read("./styles/sheet.css");
    const tokens = read("./styles/tokens.css");

    const styled = new Set(
      [...sheet.matchAll(/:root\[data-width="([a-z]+)"\]/g)].map((match) => match[1]),
    );
    // Normal is the measure the sheet already carries, so it is the one name with nothing to say.
    expect([...styled].sort()).toEqual(WIDTHS.filter((w) => w !== "normal").sort());

    for (const rule of sheet.matchAll(/:root\[data-width="[a-z]+"\][^{]*\{([^}]*)\}/g)) {
      for (const use of rule[1].matchAll(/var\((--[a-z-]+)\)/g)) {
        expect(tokens.includes(`${use[1]}:`), `${use[1]} is used but never declared`).toBe(true);
      }
    }
  });

  it("restores exactly the widths the app can set", () => {
    const boot = read("../index.html");
    const list = boot.match(/var WIDTHS = \[([^\]]*)\]/);
    const names = (list?.[1] ?? "").split(",").map((name) => name.trim().replace(/"/g, ""));
    expect(names).toEqual([...WIDTHS]);
  });
});
