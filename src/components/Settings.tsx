// Cmd+, and the Settings row on the app menu. Four things, and deliberately not a fifth: which
// version is running, whether there is a newer one, and the two proofing checkers.
//
// Everything else this app can be told is already somewhere better. The theme is in the title bar,
// the editor width is in the toolbar, and both of them are one click from the thing they change.
// Moving either in here would be a second place to look for a setting that already has a first one,
// so this panel holds only what has nowhere else to live.
//
// A checker the machine does not have leaves its row on screen and turns it off. The store's own
// comment argues for taking a missing checker off the screen entirely, and that is right for
// underlines and for the correction menu: an underline that is absent explains itself. A settings
// panel is where somebody goes to look for a setting, and a row that is simply not there reads as a
// missing feature rather than as a missing checker, so the row stays and says which it is.

import { useEffect, useState } from "react";
import { useEscapeLayer } from "../escape";
import { onCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { useProofing } from "../store/useProofing";
import { useUpdate } from "../store/useUpdate";
import { appVersion, checkForUpdates } from "../update";
import { Icon } from "./Icon";

/**
 * Which build this is, decided at bundle time. `pnpm dev`, and `tauri dev` on top of it, are the
 * development one; a bundle built through `pnpm build` is the other. It is here because it is the
 * first thing worth knowing when the updater says it is not enabled.
 */
const BUILD = import.meta.env.DEV ? "development build" : "release build";

function checkedLabel(at: number | null): string {
  if (at === null) return "Not checked yet";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "Checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Checked ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "Checked an hour ago" : `Checked ${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "Checked yesterday" : `Checked ${days} days ago`;
  return `Checked on ${new Date(at).toLocaleDateString()}`;
}

interface SettingRowProps {
  label: string;
  /** The quiet second line. Empty means the row is one line tall. */
  note: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}

function SettingRow({ label, note, on, disabled = false, onChange }: SettingRowProps) {
  return (
    <div className="setting-row" data-disabled={disabled}>
      <span className="setting-text">
        <span className="setting-label">{label}</span>
        {note !== "" && <span className="setting-note">{note}</span>}
      </span>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={on}
        aria-label={label}
        data-on={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export function Settings() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  const phase = useUpdate((s) => s.phase);
  const lastChecked = useUpdate((s) => s.lastChecked);
  const automatic = useUpdate((s) => s.automatic);
  const setAutomatic = useUpdate((s) => s.setAutomatic);

  const spelling = useProofing((s) => s.enabled);
  const setSpelling = useProofing((s) => s.setEnabled);
  const spellingAvailability = useProofing((s) => s.availability);
  const grammar = useProofing((s) => s.grammar);
  const setGrammar = useProofing((s) => s.setGrammar);
  const grammarAvailability = useProofing((s) => s.grammarAvailability);
  const ensureAvailable = useProofing((s) => s.ensureAvailable);

  useEffect(() => onCommand("settings", () => setOpen((v) => !v)), []);
  useEscapeLayer(open, () => setOpen(false));
  useKeyContext("overlay", open);

  // Both asked on the way in rather than at launch. The editor asks the same two questions the
  // first time it draws a document, and the store answers each of them once per run whichever of
  // us gets there first.
  useEffect(() => {
    if (!open) return;
    ensureAvailable();
    let live = true;
    void appVersion().then((v) => {
      if (live) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, [open, ensureAvailable]);

  if (!open) return null;

  const checking = phase === "checking";
  const spellingMissing = spellingAvailability === "missing";
  const grammarMissing = grammarAvailability === "missing";

  return (
    <div className="overlay" onClick={() => setOpen(false)}>
      <div
        className="panel panel-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2>Settings</h2>
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
          <section className="setting-group">
            <div className="setting-app">Margin Docs</div>
            <div className="setting-build">
              {version === null ? BUILD : `Version ${version}, ${BUILD}`}
            </div>
          </section>

          <section className="setting-group">
            <div className="nav-label">Updates</div>
            <div className="setting-row">
              <span className="setting-text">
                <span className="setting-label">Software update</span>
                <span className="setting-note">{checkedLabel(lastChecked)}</span>
              </span>
              <button
                type="button"
                className="btn-quiet"
                disabled={checking}
                onClick={() => void checkForUpdates()}
              >
                {checking ? "Checking…" : "Check Now"}
              </button>
            </div>
            <SettingRow
              label="Check automatically"
              note="Once a day, in the background, on launch."
              on={automatic}
              onChange={setAutomatic}
            />
          </section>

          <section className="setting-group">
            <div className="nav-label">Proofing</div>
            <SettingRow
              label="Check spelling while typing"
              note={spellingMissing ? "This machine has no spell checker." : ""}
              on={spelling && !spellingMissing}
              disabled={spellingMissing}
              onChange={setSpelling}
            />
            <SettingRow
              label="Check grammar while typing"
              note={grammarMissing ? "This build has no grammar checker in it." : ""}
              on={grammar && !grammarMissing}
              disabled={grammarMissing}
              onChange={setGrammar}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
