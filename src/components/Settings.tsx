// Cmd+, and the Settings row on the app menu. Four sections, and deliberately not a fifth: how the
// app looks, which version is running and whether there is a newer one, the two proofing checkers,
// and what this build is. Everything else this app can be told is already one click from the thing
// it changes, the editor width in the title bar most of all, and a second place to find a setting
// is worse than a longer walk to its only one.
//
// It takes the whole window rather than floating in the middle of it. A panel that has to hold a
// picker of seven palettes, each of them a picture, is not a panel any more, and a settings screen
// is the one surface in this app nobody is reading a document behind: dimming the page to look at
// it was never buying anything.
//
// A checker the machine does not have leaves its row on screen and turns it off. The store's own
// comment argues for taking a missing checker off the screen entirely, and that is right for
// underlines and for the correction menu: an underline that is absent explains itself. A settings
// screen is where somebody goes to look for a setting, and a row that is simply not there reads as
// a missing feature rather than as a missing checker, so the row stays and says which it is.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEscapeLayer } from "../escape";
import { onCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { useProofing } from "../store/useProofing";
import { useTheme } from "../store/useTheme";
import { useUpdate } from "../store/useUpdate";
import { THEMES, labelOf, type Theme } from "../theme";
import { appVersion, checkForUpdates } from "../update";
import { Icon } from "./Icon";

/**
 * Which build this is, decided at bundle time. `pnpm dev`, and `tauri dev` on top of it, are the
 * development one; a bundle built through `pnpm build` is the other. It is here because it is the
 * first thing worth knowing when the updater says it is not enabled.
 */
const BUILD = import.meta.env.DEV ? "development build" : "release build";

type Section = "appearance" | "updates" | "proofing" | "about";

const SECTIONS: ReadonlyArray<readonly [Section, string]> = [
  ["appearance", "Appearance"],
  ["updates", "Updates"],
  ["proofing", "Proofing"],
  ["about", "About"],
];

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

/**
 * A palette as a picture of itself: chrome, a page, two lines of text and the accent.
 *
 * The colours are the theme's own, not six values written out again here. src/styles/themes.css
 * gives every palette block this element's selector as well as the root's, which is the only way a
 * preview can be trusted: a tile that was drawn by hand would keep looking right after the palette
 * behind it stopped being.
 */
function Swatch({ theme }: { theme: Theme }) {
  return (
    <span className="theme-swatch" data-theme={theme}>
      <span className="theme-swatch-rail" />
      <span className="theme-swatch-page">
        <span className="theme-swatch-line" />
        <span className="theme-swatch-line" />
        <span className="theme-swatch-dot" />
      </span>
    </span>
  );
}

interface ThemeCardProps {
  active: boolean;
  label: string;
  preview: ReactNode;
  onSelect: () => void;
}

function ThemeCard({ active, label, preview, onSelect }: ThemeCardProps) {
  return (
    <button
      type="button"
      className="theme-card"
      data-active={active}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className="theme-preview">
        {preview}
        {active && (
          <span className="theme-tick" aria-hidden="true">
            <Icon d="M5 12.5l4.5 4.5L19 7" size={13} />
          </span>
        )}
      </span>
      <span className="theme-name">{label}</span>
    </button>
  );
}

/**
 * The palettes, applied on the click and never behind a save button.
 *
 * A colour is judged by looking at it, so the window behind this one changes while the picker is
 * still open. There is nothing to confirm and nothing to undo beyond clicking a different tile,
 * which is also why the tiles are the whole control: a list of names would make somebody apply each
 * one to find out what it was.
 */
function ThemePicker() {
  const choice = useTheme((s) => s.choice);
  const light = useTheme((s) => s.light);
  const dark = useTheme((s) => s.dark);
  const select = useTheme((s) => s.select);

  return (
    <div className="theme-grid">
      <ThemeCard
        active={choice === "system"}
        label="Match system"
        preview={
          <span className="theme-pair">
            <Swatch theme={light} />
            <Swatch theme={dark} />
          </span>
        }
        onSelect={() => select("system")}
      />
      {THEMES.map((info) => (
        <ThemeCard
          key={info.id}
          active={choice === info.id}
          label={info.label}
          preview={<Swatch theme={info.id} />}
          onSelect={() => select(info.id)}
        />
      ))}
    </div>
  );
}

export function Settings() {
  const screen = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>("appearance");
  const [version, setVersion] = useState<string | null>(null);

  const phase = useUpdate((s) => s.phase);
  const lastChecked = useUpdate((s) => s.lastChecked);
  const automatic = useUpdate((s) => s.automatic);
  const setAutomatic = useUpdate((s) => s.setAutomatic);

  const light = useTheme((s) => s.light);
  const dark = useTheme((s) => s.dark);

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

  // Cmd+, arrives with the caret sitting in the document, and this screen covers the document
  // completely. Without taking the focus off it, every key typed at a settings screen would go into
  // a page nobody can see, which is the one way a settings screen could lose somebody's work.
  useEffect(() => {
    if (open) screen.current?.focus();
  }, [open]);

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
    <div
      className="settings-screen"
      ref={screen}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      {/* The screen covers the title bar, so the traffic lights are now floating over this row
          instead and it is the row that has to leave them a lane and be draggable. */}
      <header className="settings-head" data-tauri-drag-region>
        <h2>Settings</h2>
        <button
          className="icon-button"
          onClick={() => setOpen(false)}
          title="Close (⎋)"
          aria-label="Close"
        >
          <Icon d="M6 6l12 12M18 6L6 18" />
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="settings-nav-item"
              data-active={section === id}
              aria-current={section === id}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          <div className="settings-column">
            {section === "appearance" && (
              <section className="setting-group">
                <div className="nav-label">Theme</div>
                <ThemePicker />
                <p className="setting-note">
                  Match system follows the operating system between {labelOf(light)} and{" "}
                  {labelOf(dark)}, which are the last of each you chose.
                </p>
              </section>
            )}

            {section === "updates" && (
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
            )}

            {section === "proofing" && (
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
            )}

            {section === "about" && (
              <section className="setting-group">
                <div className="nav-label">About</div>
                <div className="setting-app">Margin Docs</div>
                <div className="setting-build">
                  {version === null ? BUILD : `Version ${version}, ${BUILD}`}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
