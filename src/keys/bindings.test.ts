// The table's own invariants. Two bindings on one combo in one context would silently shadow each
// other, a group the sheet does not render would silently hide a key, and a menu id with no real
// command behind it would build fine in Rust and do nothing at all in TypeScript, so all three are
// asserted here rather than discovered later.

import { describe, expect, it } from "vitest";
import { BINDINGS, GROUPS, bindingLabel, keyLabel, normalizeCombo } from "./bindings";
import { COMMANDS } from "./commands";
import { MENU_IDS } from "./menu";

describe("the binding table", () => {
  it("never binds one combo twice in the same context", () => {
    const seen = new Set<string>();
    for (const binding of BINDINGS) {
      for (const key of binding.keys) {
        const slot = `${binding.context}:${normalizeCombo(key)}`;
        expect(seen.has(slot), `${slot} is bound twice`).toBe(false);
        seen.add(slot);
      }
    }
  });

  it("puts every binding in a group the sheet renders", () => {
    for (const binding of BINDINGS) expect(GROUPS).toContain(binding.group);
  });

  it("can name every binding, including the ones it does not own", () => {
    for (const binding of BINDINGS) {
      expect(bindingLabel(binding, (id) => `command ${id}`)).not.toBe("");
    }
  });

  it("documents Escape without claiming to handle it", () => {
    const escape = BINDINGS.find((b) => b.keys.includes("Escape"));
    expect(escape?.command).toBeNull();
  });

  it("reads a combo the same way the dispatcher builds one", () => {
    expect(normalizeCombo("cmd+k")).toBe("cmd+k");
    expect(normalizeCombo("Cmd+K")).toBe("cmd+K");
    expect(normalizeCombo("H")).toBe("H");
    expect(normalizeCombo("/")).toBe("/");
  });

  it("prints a shifted letter as a shifted letter", () => {
    expect(keyLabel("H")).toBe("⇧H");
    expect(keyLabel("h")).toBe("h");
    expect(keyLabel("Enter")).toBe("↩");
    expect(keyLabel("Escape")).toBe("⎋");
  });

  it("tells a plain modifier combo apart from its shifted twin", () => {
    // The exact glyph depends on the platform PRIMARY_LABEL resolves to; what must hold
    // everywhere is that the two combos never collide once normalized or labeled.
    expect(normalizeCombo("cmd+f")).not.toBe(normalizeCombo("cmd+F"));
    expect(keyLabel("cmd+f")).not.toBe(keyLabel("cmd+F"));
  });
});

describe("the menu bridge", () => {
  it("maps every menu id src-tauri/src/lib.rs emits to a real command", () => {
    const ids = new Set(COMMANDS.map((c) => c.id));
    for (const id of MENU_IDS) expect(ids.has(id)).toBe(true);
  });
});
