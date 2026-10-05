// The start screen: what the window shows before any folder is open, which since one folder at a
// time is now every launch rather than only the first one. A quiet list rather than a grid of
// cards, because a folder has no cover and pretending otherwise would just be a row of identical
// rectangles.
//
// A folder is its own name and the path it sits at, and both are on the row, because two projects
// called `docs` are the normal case and the name alone cannot tell them apart. Removing a row is
// the one other thing this screen does: a list that only grows is one somebody has to scroll past
// a folder they will never open again to reach the one they want, and forgetting a folder here
// touches nothing on disk.

import { commandLabel, runCommand } from "../keys/commands";
import { notify } from "../store/useToast";
import { useWorkspace } from "../store/useWorkspace";
import { addRoot } from "../workspace";
import { Icon } from "./Icon";
import { shortcutTitle } from "./Titlebar";

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
// A folder with its flap out, which is the app's one picture of Open Folder: the closed
// folder with a cross in it belongs to New Folder, and this button is not that.
const OPEN_FOLDER = "M3 19V7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2 M3 19l2.9-8h15.3l-2.9 8z";
const CLOSE = "M18 6L6 18M6 6l12 12";

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

export function Recents() {
  const recentFolders = useWorkspace((s) => s.recentFolders);
  const scanPhase = useWorkspace((s) => s.scanPhase);
  const forgetFolder = useWorkspace((s) => s.forgetFolder);

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
                <li key={path} className="start-item">
                  <button className="start-row" onClick={() => open(path)} title={path}>
                    <Icon d={FOLDER} size={15} />
                    <span className="start-name">{baseName(path)}</span>
                    <span className="start-path">{parentOf(path)}</span>
                  </button>
                  <button
                    className="start-forget"
                    title={`Remove ${baseName(path)} from this list`}
                    aria-label={`Remove ${baseName(path)} from this list`}
                    onClick={() => forgetFolder(path)}
                  >
                    <Icon d={CLOSE} size={14} />
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
