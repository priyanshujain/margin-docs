// The theme table has three copies of itself that are not written in TypeScript: a palette block
// per theme across three stylesheets, and the two id lists in index.html's boot script, which runs
// before any bundle exists and so cannot import anything. This file is what keeps them one table.
//
// The failure it exists for is quiet. A palette missing a variable does not fall back to nothing,
// it falls back to the warm light value in the `:root` block of tokens.css, so a dark theme short
// of --scrim gets a light scrim over one dialog and looks fine everywhere else until somebody opens
// that dialog. Nothing about that shows up in a screenshot of the app's front page.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES, chosen, isTheme, resolveTheme, storedPreference, type Preference } from "./theme";
import { useTheme } from "./store/useTheme";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

const SHEETS = [
  "../node_modules/margin-shared/css/tokens.css",
  "./styles/tokens.css",
  "./styles/themes.css",
];

/**
 * Every custom property each theme declares for itself, and separately the ones the bare `:root`
 * block hands to whichever theme did not.
 *
 * A parser rather than a browser because the question is which declarations exist, not what they
 * compute to: jsdom would answer the second and quietly resolve the first away.
 */
interface Sheets {
  /** Theme id to the custom properties its own blocks declare. */
  themes: Map<string, Set<string>>;
  /** Theme id to the color-scheme its blocks ask the webview for. */
  schemes: Map<string, string>;
  /** What the bare `:root` block hands to whichever theme did not declare it. */
  defaults: Set<string>;
}

function declarations(): Sheets {
  const themes = new Map<string, Set<string>>();
  const schemes = new Map<string, string>();
  const defaults = new Set<string>();

  for (const sheet of SHEETS) {
    const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      // Whatever came after the previous rule, which is the selector unless the file opened with an
      // @import or another statement this parser has no interest in.
      const selector = (rule[1].split(";").pop() ?? "").trim();
      const body = rule[2];
      const names = [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
      const scheme = body.match(/color-scheme\s*:\s*([a-z]+)/)?.[1];
      const ids = [...selector.matchAll(/:root\[data-theme="([a-z-]+)"\]/g)].map((m) => m[1]);

      if (selector.split(",").some((part) => part.trim() === ":root"))
        for (const name of names) defaults.add(name);

      for (const id of ids) {
        const set = themes.get(id) ?? new Set<string>();
        for (const name of names) set.add(name);
        themes.set(id, set);
        if (scheme) schemes.set(id, scheme);
      }
    }
  }

  return { themes, schemes, defaults };
}

// The two the shipped light palette has always taken from the `:root` defaults, which hold the
// light values. Named here rather than allowed as a gap: every other palette overrides both, and a
// second theme joining this list would be a theme wearing somebody else's scrim.
const FROM_DEFAULTS = ["--scrim", "--shadow-raised"];

describe("the palettes", () => {
  const { themes, schemes, defaults } = declarations();
  const full = new Set([...themes.values()].flatMap((set) => [...set]));

  it("declare the same variables as each other", () => {
    for (const info of THEMES) {
      const declared = themes.get(info.id) ?? new Set<string>();
      const allowed = info.id === "light" ? FROM_DEFAULTS : [];
      const missing = [...full].filter((name) => !declared.has(name) && !allowed.includes(name));
      expect({ theme: info.id, missing }).toEqual({ theme: info.id, missing: [] });
    }
    for (const name of FROM_DEFAULTS) expect(defaults.has(name)).toBe(true);
  });

  it("are exactly the ones the table names", () => {
    expect([...themes.keys()].sort()).toEqual(THEMES.map((info) => info.id).sort());
  });

  it("tell the webview which way round they are", () => {
    for (const info of THEMES) {
      expect([info.id, schemes.get(info.id)]).toEqual([info.id, info.scheme]);
    }
  });

  it("can each draw their own preview tile", () => {
    const css = read("./styles/themes.css");
    for (const info of THEMES) expect(css).toContain(`.theme-swatch[data-theme="${info.id}"]`);
  });
});

describe("the boot script", () => {
  const html = read("../index.html");
  const list = (name: string): string[] => {
    const found = html.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
    return (found?.[1] ?? "").split(",").map((id) => id.trim().replace(/"/g, ""));
  };

  it("knows every theme, and only those", () => {
    for (const scheme of ["light", "dark"] as const) {
      const expected = THEMES.filter((info) => info.scheme === scheme).map((info) => info.id);
      expect(list(scheme.toUpperCase()).sort()).toEqual([...expected].sort());
    }
  });
});

describe("a stored preference", () => {
  const fakeStorage = (entries: Record<string, string>) => {
    const store = new Map(Object.entries(entries));
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} },
    });
  };

  it("survives a theme that no longer exists", () => {
    fakeStorage({
      "margindocs-theme": "solarized",
      "margindocs-theme-light": "sepia",
      "margindocs-theme-dark": "retired",
    });
    const preference = storedPreference();
    // The choice falls back to following the system, the half that still names a theme is kept, and
    // the half that does not goes back to the palette the app shipped with.
    expect(preference).toEqual({ choice: "system", light: "sepia", dark: "dark" });
    expect(isTheme("solarized")).toBe(false);
  });

  it("keeps the one the two value releases wrote", () => {
    fakeStorage({ "margindocs-theme": "dark" });
    expect(resolveTheme(storedPreference())).toBe("dark");
  });

  it("remembers the half it is replacing", () => {
    const start: Preference = { choice: "system", light: "light", dark: "dark" };
    const midnight = chosen(start, "midnight");
    expect(midnight).toEqual({ choice: "midnight", light: "light", dark: "midnight" });
    expect(chosen(midnight, "mist")).toEqual({ choice: "mist", light: "mist", dark: "midnight" });
  });
});

// The `toggle-theme` command is one key that takes the screen from bright to dim and back, and what
// it has to land on is the pair this user chose rather than the two the app ships first. Asserted
// through the store because the command is `useTheme.getState().toggle()` and nothing else.
describe("the theme toggle", () => {
  it("flips between the last light and the last dark palette chosen", () => {
    const { select, toggle } = useTheme.getState();

    select("sepia");
    select("midnight");
    expect(useTheme.getState().theme).toBe("midnight");

    toggle();
    expect(useTheme.getState().theme).toBe("sepia");

    toggle();
    expect(useTheme.getState().theme).toBe("midnight");
  });
});
