// Cmd+K: every command the app has, by name.
//
// This is the one palette with nothing behind it. No index, no IPC, no store: the rows are the
// table in src/keys/commands.ts filtered by a subsequence match, so it answers on a build where
// SQLite has fallen over and on the first frame after launch, before a folder is even open. That
// is why src/keys/bindings.ts binds it in the `global` context with a comment saying an overlay may
// not shadow it: whatever is on screen, this is how you get anywhere from inside it, and something
// that reaches into a search index for its own row list would not be able to make that promise.
//
// It lists commands, not bindings, which is why the keys on the right come from `keysFor` and
// `keyLabel` rather than from `bindingLabel`: that one turns a binding into its words, and a
// command with no key at all still belongs in this list.

import { useEffect, useState } from "react";
import { useEscapeLayer } from "../escape";
import { keyLabel, keysFor } from "../keys/bindings";
import { COMMANDS, commandMatches, onCommand, runCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { Palette, type PaletteRow } from "./Palette";

interface CommandRow extends PaletteRow {
  label: string;
  keys: readonly string[];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // A toggle, like the shortcuts sheet: the key that opens it is reachable from inside it, so it
  // has to mean something the second time it is pressed.
  useEffect(
    () =>
      onCommand("command-palette", () => {
        setOpen((wasOpen) => !wasOpen);
        setQuery("");
      }),
    [],
  );

  useEscapeLayer(open, () => setOpen(false));
  useKeyContext("overlay", open);

  if (!open) return null;

  const rows: CommandRow[] = COMMANDS.filter(
    (command) => command.palette && commandMatches(command.label, query),
  ).map((command) => ({
    key: command.id,
    label: command.label,
    keys: keysFor(command.id),
    run: () => runCommand(command.id),
  }));

  return (
    <Palette
      label="Command palette"
      placeholder="Run a command"
      query={query}
      onQuery={setQuery}
      rows={rows}
      status={{ text: "No command by that name." }}
      onClose={() => setOpen(false)}
      renderRow={(row) => (
        <span className="palette-main">
          <span className="palette-name">{row.label}</span>
          <span className="palette-keys">
            {row.keys.map((combo) => (
              <kbd key={combo} className="key-cap">
                {keyLabel(combo)}
              </kbd>
            ))}
          </span>
        </span>
      )}
    />
  );
}
