// The macOS overlay title bar. The traffic lights float over its left end, which is why the row
// itself carries `data-tauri-drag-region` and every control inside it does not: an interactive
// element that also drags the window swallows its own click.
//
// The glyphs come from margin-shared, which is where the sibling book app takes them from too, so
// that the two do not each have their own idea of what a search or a sidebar looks like. They are
// paths and not a dependency: an icon set is six hundred kilobytes for the handful of shapes a
// title bar needs.
//
// What is in the row is a shorter list than what the app can do, and the cut is on purpose. A
// button here is for something whose result the user then looks at on this screen: the sidebar, the
// page's measure, whether it is underlined, where it goes as a PDF. Making a file is not that,
// which is why New Document is a keystroke and a row in the menu at the end and not a button of its
// own.
//
// The theme used to be a button here too and is now a row of previews in Settings, because it
// stopped being one thing to look at. A sun and a moon can carry two palettes between them and
// cannot carry seven, and a menu of names is a worse way to choose a colour than a picture of it.
//
// The filename is the way in to everything the document itself holds, which is what the sibling
// book app does with the title it shows here. Clicking it opens Document setup, where the name is
// the first field and the faces the page is set in are the second, so neither spends a button on
// the row and neither is somewhere a reader would not think to look.

import { useEffect, useRef, useState } from "react";
import { icons } from "margin-shared";
import { useEscapeLayer } from "../escape";
import { keyLabel, keysFor } from "../keys/bindings";
import { commandLabel, onCommand, runCommand, type CommandId } from "../keys/commands";
import { useDocument } from "../store/useDocument";
import { useViewer } from "../store/useViewer";
import { useProofing } from "../store/useProofing";
import { useWindow } from "../store/useWindow";
import { DocumentSetup } from "./DocumentSetup";
import { splitExtension } from "./FileTree";
import { Icon } from "./Icon";
import { WidthMenu } from "./WidthMenu";

const SIDEBAR_KEY = "margindocs-sidebar";

// The glyphs themselves live in margin-shared, so the two apps cannot drift into two ideas of what
// a search or a sidebar looks like. Which of them this row uses, and in what order, is still this
// app's decision.
const { SIDEBAR: SIDEBAR_ICON, SEARCH, SPELLING, GRAMMAR, EXPORT, MORE } = icons;

// The glyphs for the menu at the end of the row, which are this app's and not the shared set's:
// the sibling book app has no folder of files and no updater, so there is nothing here for the two
// of them to agree on. Drawn on the same 24 unit grid for the same 1.6 stroke as everything else.
//
// Open Folder is a folder with its flap out and New Folder is a closed one with a cross in it,
// because the two sit four rows apart and a picture that only differs in what is inside the folder
// is not a difference at fourteen pixels. It is not FileTree.tsx's open folder either: that glyph
// is a fold and a diagonal, which reads beside a closed one in a tree and reads as a flag on its
// own in a menu.
const OPEN_FOLDER_ICON = "M3 19V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2 M3 19l2.9-8h15.3l-2.9 8z";
const NEW_DOC_ICON = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 12v5 M9.5 14.5h5";
const NEW_FOLDER_ICON = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v6 M9 14h6";
// A page with a lens over its corner. Deliberately a page and not the three lines a search over
// text would suggest, because the grammar button two along is already three lines with a mark
// under them and the menu hangs directly beneath it.
const FIND_IN_FILES_ICON =
  "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.4 M14 3l5 5v3.6 M14 3v5h5 M16.4 13.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8 M21.4 21.4l-2.6-2.6";
const SHORTCUTS_ICON = "M3 6h18v12H3z M6.5 10h.01 M10 10h.01 M13.5 10h.01 M17 10h.01 M8.5 14h7";
// Two rails and a knob each, rather than a gear: a gear's teeth are mud below sixteen pixels and
// this row is drawn at fourteen.
const SETTINGS_ICON = "M4 8h9 M17 8h3 M4 16h3 M11 16h9 M15 6v4 M9 14v4";
// The export button in this same row, upside down, which is what an update is.
const UPDATES_ICON = "M5 13v6h14v-6 M12 3v13 M8 12l4 4 4-4";
const ISSUE_ICON = "M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z";

interface MenuRow {
  id: CommandId;
  /** Not `commandLabel`'s, and the ellipsis is the whole difference. See MENU below. */
  label: string;
  icon: string;
}

/** A hairline between groups, written inline so the order of the menu stays readable. */
type MenuEntry = MenuRow | "sep";

// What the button at the end of the row opens: a picture and a name per row, in three groups, and
// the shorter half of what the native menu bar carries.
//
// The labels are written out here rather than taken from `commandLabel`, which every other caller
// uses, and the ellipsis is the reason. Three dots after "Open Folder" mean "this will stop and
// ask you something", and that is worth saying on the File menu and worth saying in the command
// palette, where a row is a name and nothing else. It is not worth saying here. Five of these
// eight rows would end in dots, a column of trailing dots reads as an ornament rather than as a
// promise, and every row already carries a picture of what it is about to do.
const MENU: readonly MenuEntry[] = [
  { id: "open-folder", label: "Open Folder", icon: OPEN_FOLDER_ICON },
  { id: "new-doc", label: "New Document", icon: NEW_DOC_ICON },
  { id: "new-folder", label: "New Folder", icon: NEW_FOLDER_ICON },
  "sep",
  { id: "find-in-files", label: "Find in Files", icon: FIND_IN_FILES_ICON },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: SHORTCUTS_ICON },
  { id: "settings", label: "Settings", icon: SETTINGS_ICON },
  "sep",
  { id: "check-updates", label: "Check for Updates", icon: UPDATES_ICON },
  { id: "report-issue", label: "Report an Issue", icon: ISSUE_ICON },
];

const MENU_ITEM = ".menu [role='menuitem']";

/** A tooltip that names the action and prints its key in the glyphs the sheet uses. */
export function shortcutTitle(id: CommandId): string {
  const keys = keysFor(id);
  return keys.length ? `${commandLabel(id)} (${keyLabel(keys[0])})` : commandLabel(id);
}

export function Titlebar() {
  const path = useDocument((s) => s.path);
  const viewedPath = useViewer((s) => s.path);
  const dirty = useDocument((s) => s.dirty);
  const externalChange = useDocument((s) => s.externalChange);
  const standalone = useWindow((s) => s.standalone);

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
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  /** Whether the open was a keypress, which is what decides if focus goes into the menu. */
  const menuByKeyboard = useRef(false);

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

  // Escape hands the keyboard back to the button the menu came from. Only when the focus is still
  // inside the menu, because a mouse user's caret never left the document and dragging it up here
  // to close a menu they are not in would be the app taking the keyboard off them.
  useEscapeLayer(menu, () => {
    const inside = menuRef.current?.contains(document.activeElement) ?? false;
    setMenu(false);
    if (inside) menuButton.current?.focus();
  });

  useEffect(() => {
    if (!menu || !menuByKeyboard.current) return;
    menuByKeyboard.current = false;
    menuRef.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus();
  }, [menu]);

  // What the title bar shows is the file on disk, never the document's H1. The two are unrelated
  // and this is the place that promise is easiest to break: editing a heading is a content edit and
  // nothing else, because a path is what git, every other editor and every relative link from
  // another document already agreed on.
  const fileName = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const { base } = splitExtension(fileName);

  // A picture or a PDF gets its name here too, and gets it as a label rather than as the button.
  // Behind that button is Document setup, which is a name and a pair of faces, and a file this app
  // can only look at has neither: the faces are the document's own and there is no document. The
  // extension stays on, unlike a document's, because .png and .pdf are what the row in the tree
  // says and what tells two exports of the same drawing apart.
  const viewedName = viewedPath === null ? "" : viewedPath.slice(viewedPath.lastIndexOf("/") + 1);

  // The same bargain the width menu next door makes with the caret: a mouse press leaves focus in
  // the sentence somebody is in the middle of, and only a keyboard open moves it into the menu.
  const openMenu = (e: React.MouseEvent) => {
    if (menu) {
      setMenu(false);
      return;
    }
    menuByKeyboard.current = e.detail === 0;
    setMenu(true);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? []);
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  const menuItem = (row: MenuRow) => (
    <button
      key={row.id}
      className="menu-item"
      role="menuitem"
      onClick={() => {
        setMenu(false);
        runCommand(row.id);
      }}
    >
      <Icon d={row.icon} size={14} />
      {row.label}
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
        {/* A standalone document has no folder, so there is no sidebar to toggle. */}
        {!standalone && (
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
        )}
      </div>

      {path === null && viewedPath !== null && (
        <span className="doc-title" title={viewedName}>
          {viewedName}
        </span>
      )}

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

        <div className="menu-wrap">
          <button
            ref={menuButton}
            className="icon-button"
            data-active={menu}
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openMenu}
          >
            <Icon d={MORE} />
          </button>
          {menu && (
            <>
              <div className="menu-backdrop" onClick={() => setMenu(false)} />
              <div ref={menuRef} className="menu" role="menu" onKeyDown={onMenuKeyDown}>
                {MENU.map((row, i) =>
                  row === "sep" ? <div key={`sep-${i}`} className="menu-sep" /> : menuItem(row),
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {setup && path && <DocumentSetup path={path} onClose={() => setSetup(false)} />}
    </header>
  );
}
