// The macOS overlay title bar. The traffic lights float over its left end, which is why the row
// itself carries `data-tauri-drag-region` and every control inside it does not: an interactive
// element that also drags the window swallows its own click.

import { useEffect, useRef, useState } from "react";
import { useEscapeLayer } from "../escape";
import { keyLabel, keysFor } from "../keys/bindings";
import { commandLabel, onCommand, runCommand, type CommandId } from "../keys/commands";
import { useDocument } from "../store/useDocument";
import { useTheme } from "../store/useTheme";
import { notify } from "../store/useToast";
import { useWorkspace } from "../store/useWorkspace";
import { splitExtension } from "./FileTree";
import { Icon } from "./Icon";
import { WidthMenu } from "./WidthMenu";


const SIDEBAR_KEY = "margindocs-sidebar";

const SIDEBAR_ICON = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 3v18";
const NEW_DOC = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 12v5 M9.5 14.5h5";
const SEARCH = "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-3.6-3.6";
const SUN = "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4";
const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z";
const MORE = "M5 12h.01M12 12h.01M19 12h.01";

/** A tooltip that names the action and prints its key in the glyphs the sheet uses. */
export function shortcutTitle(id: CommandId): string {
  const keys = keysFor(id);
  return keys.length ? `${commandLabel(id)} (${keyLabel(keys[0])})` : commandLabel(id);
}

export function Titlebar() {
  const path = useDocument((s) => s.path);
  const dirty = useDocument((s) => s.dirty);
  const externalChange = useDocument((s) => s.externalChange);
  const renameEntry = useWorkspace((s) => s.renameEntry);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggle);

  const [sidebar, setSidebar] = useState(
    () => document.documentElement.getAttribute("data-sidebar") !== "false",
  );
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-sidebar", String(sidebar));
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebar));
    } catch {
      // A webview with storage denied still toggles, it just forgets between launches.
    }
  }, [sidebar]);

  useEffect(() => onCommand("toggle-sidebar", () => setSidebar((v) => !v)), []);
  useEffect(() => setRenaming(false), [path]);

  useEscapeLayer(menu, () => setMenu(false));

  const fileName = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const { base, hidden } = splitExtension(fileName);

  // The filename and the document's H1 are unrelated, and this is the place that promise is
  // easiest to break. What the title bar shows is the file on disk, and the only thing that ever
  // renames it is the user typing here. Editing a heading is a content edit and nothing else: it
  // does not move the file, because a path is what git, every other editor and every relative
  // link from another document already agreed on.
  const commitRename = (next: string) => {
    setRenaming(false);
    const trimmed = next.trim();
    if (!path || !trimmed || trimmed === base) return;
    renameEntry(path, `${trimmed}${hidden}`).catch((e) => notify(`Could not rename: ${String(e)}`));
  };

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

      {path &&
        (renaming ? (
          <TitleRename value={base} onCommit={commitRename} onCancel={() => setRenaming(false)} />
        ) : (
          <button
            className="doc-title"
            data-external={externalChange === "changed-on-disk"}
            title={
              externalChange === "changed-on-disk"
                ? `${fileName} (changed on disk). Click to rename.`
                : `${fileName}. Click to rename.`
            }
            onClick={() => setRenaming(true)}
          >
            {base}
            {dirty && <span className="dirty-dot" />}
          </button>
        ))}

      <div className="actions">
        <button
          className="icon-button"
          title={shortcutTitle("new-doc")}
          aria-label={commandLabel("new-doc")}
          onClick={() => runCommand("new-doc")}
        >
          <Icon d={NEW_DOC} />
        </button>
        <button
          className="icon-button"
          title={shortcutTitle("quick-open")}
          aria-label={commandLabel("quick-open")}
          onClick={() => runCommand("quick-open")}
        >
          <Icon d={SEARCH} />
        </button>
        <button
          className="icon-button"
          title={theme === "dark" ? "Light theme" : "Dark theme"}
          aria-label={commandLabel("toggle-theme")}
          onClick={toggleTheme}
        >
          <Icon d={theme === "dark" ? SUN : MOON} />
        </button>
        <WidthMenu />
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
    </header>
  );
}

function TitleRename({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = (next: string) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(next);
  };

  useEscapeLayer(true, () => {
    settled.current = true;
    onCancel();
  });

  return (
    <input
      ref={ref}
      className="doc-title title-rename"
      defaultValue={value}
      spellCheck={false}
      autoComplete="off"
      aria-label="Rename this file"
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit(e.currentTarget.value);
      }}
    />
  );
}
