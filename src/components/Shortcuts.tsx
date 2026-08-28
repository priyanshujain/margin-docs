// Every key the app answers to, generated from src/keys/bindings.ts rather than written out here.
// That is the point of the table over there: a binding that exists is a binding this sheet shows,
// so the two cannot drift and there is no list to remember to update.

import { useEffect, useState } from "react";
import { useEscapeLayer } from "../escape";
import { BINDINGS, GROUPS, bindingLabel, keyLabel } from "../keys/bindings";
import { commandLabel, onCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { Icon } from "./Icon";

export function Shortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => onCommand("shortcuts", () => setOpen((v) => !v)), []);
  useEscapeLayer(open, () => setOpen(false));
  useKeyContext("overlay", open);

  if (!open) return null;

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div
        className="panel panel-keys"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2>Keyboard shortcuts</h2>
          <button
            className="icon-button"
            onClick={() => setOpen(false)}
            title="Close (⎋)"
            aria-label="Close"
          >
            <Icon d="M6 6l12 12M18 6L6 18" />
          </button>
        </div>
        <div className="panel-body">
          {GROUPS.map((group) => {
            const rows = BINDINGS.filter((binding) => binding.group === group);
            if (!rows.length) return null;
            return (
              <section key={group} className="key-group">
                <div className="nav-label">{group}</div>
                <ul className="key-list">
                  {rows.map((binding) => (
                    <li key={binding.keys.join("+")} className="key-row">
                      <span className="key-what">{bindingLabel(binding, commandLabel)}</span>
                      <span className="key-combos">
                        {binding.keys.map((combo) => (
                          <kbd key={combo} className="key-cap">
                            {keyLabel(combo)}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
