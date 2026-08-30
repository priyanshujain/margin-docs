// The macOS overlay title bar. The traffic lights float over its left end, which is why the row
// itself carries `data-tauri-drag-region` and every control inside it does not: an interactive
// element that also drags the window swallows its own click.
//
// The glyphs come from margin-shared, which is where the sibling book app takes them from too, so
// that the two do not each have their own idea of what a search or a moon looks like. They are
// paths and not a dependency: an icon set is six hundred kilobytes for the handful of shapes a
// title bar needs.
//
// What is in the row is a shorter list than what the app can do, and the cut is on purpose. A
// button here is for something whose result the user then looks at on this screen: the sidebar, the
// page's measure, its theme, whether it is underlined, where it goes as a PDF. Making a file is not
// that, which is why New Document is a keystroke and a row in the menu at the end and not a button
// of its own.
//
// The filename is the way in to everything the document itself holds, which is what the sibling
// book app does with the title it shows here. Clicking it opens Document setup, where the name is
// the first field and the faces the page is set in are the second, so neither spends a button on
// the row and neither is somewhere a reader would not think to look.

import { useEffect, useState } from "react";
import { icons } from "margin-shared";
import { useEscapeLayer } from "../escape";
import { keyLabel, keysFor } from "../keys/bindings";
import { commandLabel, onCommand, runCommand, type CommandId } from "../keys/commands";
import { useDocument } from "../store/useDocument";
import { useProofing } from "../store/useProofing";
import { useTheme } from "../store/useTheme";
import { DocumentSetup } from "./DocumentSetup";
import { splitExtension } from "./FileTree";
import { Icon } from "./Icon";
import { WidthMenu } from "./WidthMenu";

const SIDEBAR_KEY = "margindocs-sidebar";

// The glyphs themselves live in margin-shared, so the two apps cannot drift into two ideas of what
// a search or a moon looks like. Which of them this row uses, and in what order, is still this
// app's decision.
const { SIDEBAR: SIDEBAR_ICON, SEARCH, SPELLING, GRAMMAR, EXPORT, MOON, MORE, SUN_RAYS, SUN_DISC } =
  icons;

/** A tooltip that names the action and prints its key in the glyphs the sheet uses. */
export function shortcutTitle(id: CommandId): string {
  const keys = keysFor(id);
  return keys.length ? `${commandLabel(id)} (${keyLabel(keys[0])})` : commandLabel(id);
}

/** The sun, which is the one glyph here that is not a single path. */
function Sun() {
  return (
    <Icon>
      <circle cx={SUN_DISC.cx} cy={SUN_DISC.cy} r={SUN_DISC.r} />
      <path d={SUN_RAYS} />
    </Icon>
  );
}

export function Titlebar() {
  const path = useDocument((s) => s.path);
  const dirty = useDocument((s) => s.dirty);
  const externalChange = useDocument((s) => s.externalChange);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);

  const spelling = useProofing((s) => s.enabled);
  const toggleSpelling = useProofing((s) => s.toggle);
  const spellingAvailability = useProofing((s) => s.availability);
  const grammar = useProofing((s) => s.grammar);
  const toggleGrammar = useProofing((s) => s.toggleGrammar);
  const grammarAvailability = useProofing((s) => s.grammarAvailability);
  const ensureAvailable = useProofing((s) => s.ensureAvailable);

  const [sidebar, setSidebar] = useState(
    () => document.documentElement.getAttribute("data-sidebar") !== "false",
  );
  const [menu, setMenu] = useState(false);
  const [setup, setSetup] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-sidebar", String(sidebar));
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebar));
    } catch {
      // A webview with storage denied still toggles, it just forgets between launches.
    }
  }, [sidebar]);

  useEffect(() => onCommand("toggle-sidebar", () => setSidebar((v) => !v)), []);
  useEffect(() => setSetup(false), [path]);

  // Asked once per launch, and asked here because this is the first thing on screen that has to
  // know: a machine with no checker gets no button rather than a button that toggles a setting
  // nothing acts on. The store answers each question once whichever of its callers gets there
  // first, so this costs nothing when the settings panel or the editor asked already.
  useEffect(() => ensureAvailable(), [ensureAvailable]);

  useEscapeLayer(menu, () => setMenu(false));

  // What the title bar shows is the file on disk, never the document's H1. The two are unrelated
  // and this is the place that promise is easiest to break: editing a heading is a content edit and
  // nothing else, because a path is what git, every other editor and every relative link from
  // another document already agreed on.
  const fileName = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const { base } = splitExtension(fileName);

  const menuItem = (id: CommandId) => (
    <button
      key={id}
      onClick={() => {
        setMenu(false);
        runCommand(id);
      }}
    >
      {commandLabel(id)}
    </button>
  );

  // A checker this machine does not have takes its button off the row rather than showing a dead
  // one, which is the same call src/store/useProofing.ts makes about the underlines themselves. The
  // settings panel keeps its row and says which checker is missing, because a panel is where
  // somebody goes to look for a setting and a row that is simply absent reads as a missing feature.
  const canSpell = spellingAvailability !== "missing";
  const canCheckGrammar = grammarAvailability !== "missing";

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="lead">
        <button
          className="icon-button"
          data-active={sidebar}
          title={shortcutTitle("toggle-sidebar")}
          aria-label={commandLabel("toggle-sidebar")}
          aria-pressed={sidebar}
          onClick={() => setSidebar((v) => !v)}
        >
          <Icon d={SIDEBAR_ICON} />
        </button>
      </div>

      {path && (
        <button
          className="doc-title"
          data-active={setup}
          data-external={externalChange === "changed-on-disk"}
          aria-haspopup="dialog"
          aria-expanded={setup}
          title={
            externalChange === "changed-on-disk"
              ? `${fileName} (changed on disk). Document setup.`
              : `${fileName}. Document setup.`
          }
          onClick={() => setSetup(true)}
        >
          {base}
          {dirty && <span className="dirty-dot" />}
        </button>
      )}

      <div className="actions">
        <button
          className="icon-button"
          title={shortcutTitle("quick-open")}
          aria-label={commandLabel("quick-open")}
          onClick={() => runCommand("quick-open")}
        >
          <Icon d={SEARCH} />
        </button>

        {/* The two checkers, which are two buttons because they are two checkers: spelling is the
            system's and grammar is Harper's, and wanting one underlined without the other is not a
            strange thing to want. Both are settings rather than actions, so they are pressed
            toggles and say so. */}
        {canSpell && (
          <button
            className="icon-button"
            data-active={spelling}
            title={shortcutTitle("toggle-spelling")}
            aria-label={commandLabel("toggle-spelling")}
            aria-pressed={spelling}
            onClick={toggleSpelling}
          >
            <Icon d={SPELLING} />
          </button>
        )}
        {canCheckGrammar && (
          <button
            className="icon-button"
            data-active={grammar}
            title={shortcutTitle("toggle-grammar")}
            aria-label={commandLabel("toggle-grammar")}
            aria-pressed={grammar}
            onClick={toggleGrammar}
          >
            <Icon d={GRAMMAR} />
          </button>
        )}

        {/* The measure, which belongs to the app's view of every document. The face, which belongs
            to the one document, is in the setup panel behind the filename instead: that is the
            difference between them, and src/store/useDocumentFonts.ts is where it is spelled out. */}
        <WidthMenu />

        <button
          className="icon-button"
          title={shortcutTitle("export-pdf")}
          aria-label={commandLabel("export-pdf")}
          onClick={() => runCommand("export-pdf")}
        >
          <Icon d={EXPORT} />
        </button>

        <button
          className="icon-button"
          title={theme === "dark" ? "Light theme" : "Dark theme"}
          aria-label={commandLabel("toggle-theme")}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <Sun /> : <Icon d={MOON} />}
        </button>

        <div className="menu-wrap">
          <button
            className="icon-button"
            data-active={menu}
            title="More"
            aria-label="More"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            <Icon d={MORE} />
          </button>
          {menu && (
            <>
              <div className="menu-backdrop" onClick={() => setMenu(false)} />
              <div className="menu" role="menu">
                {menuItem("open-folder")}
                {menuItem("new-doc")}
                {menuItem("new-folder")}
                <div className="menu-sep" />
                {menuItem("find-in-files")}
                {menuItem("shortcuts")}
                {menuItem("settings")}
                <div className="menu-sep" />
                {menuItem("check-updates")}
                {menuItem("report-issue")}
              </div>
            </>
          )}
        </div>
      </div>
      {setup && path && <DocumentSetup path={path} onClose={() => setSetup(false)} />}
    </header>
  );
}
