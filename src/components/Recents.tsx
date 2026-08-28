// The start screen: what the window shows before any folder is open. A quiet list rather than a
// grid of cards, because a folder has no cover and pretending otherwise would just be a row of
// identical rectangles.

import { commandLabel, runCommand } from "../keys/commands";
import { notify } from "../store/useToast";
import { useWorkspace } from "../store/useWorkspace";
import { addRoot } from "../workspace";
import { Icon } from "./Icon";
import { shortcutTitle } from "./Titlebar";

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const OPEN_FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 10v6 M9 13h6";

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

export function Recents() {
  const recentFolders = useWorkspace((s) => s.recentFolders);
  const scanPhase = useWorkspace((s) => s.scanPhase);

  // `openFolder` is the picker and takes no path, so a folder that is already known is opened
  // through the effects module directly rather than by asking the user to find it again.
  const open = (path: string) => {
    addRoot(path).catch((e) => notify(`Could not open that folder: ${String(e)}`));
  };

  return (
    <div className="start">
      <div className="start-drag" data-tauri-drag-region />
      <div className="start-body">
        <h1 className="start-title">Margin Docs</h1>
        <p className="start-line">
          Open a folder of markdown files. Nothing is copied, nothing is imported, and nothing is
          written until you make an edit.
        </p>

        <button
          className="start-open"
          title={shortcutTitle("open-folder")}
          disabled={scanPhase === "scanning"}
          onClick={() => runCommand("open-folder")}
        >
          <Icon d={OPEN_FOLDER} size={18} />
          {scanPhase === "scanning" ? "Opening…" : commandLabel("open-folder")}
        </button>

        {recentFolders.length > 0 && (
          <div className="start-recent">
            <div className="nav-label">Recent</div>
            <ul className="start-list">
              {recentFolders.map((path) => (
                <li key={path}>
                  <button className="start-row" onClick={() => open(path)} title={path}>
                    <Icon d={FOLDER} size={15} />
                    <span className="start-name">{baseName(path)}</span>
                    <span className="start-path">{parentOf(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
