// There is a new version, and this is what the app says about it before it replaces itself.
//
// A toast was the earlier answer and it was the wrong one twice over: four seconds is not long
// enough to read release notes, and an update that installs itself the moment it is found takes a
// decision away from somebody who might be in the middle of a sentence. So the two answers are on
// screen at once, Later costs nothing, and the download is watched rather than waited on.
//
// Escape and the close button are live while the dialog is asking and gone once it is downloading,
// because dismissing a download that carries on in the background is a lie about what happened.
// There is no cancel: the plugin's download has no handle to stop it, and a button that only stops
// the dialog would be a worse promise than no button.

import { useEffect, useRef } from "react";
import { useEscapeLayer } from "../escape";
import { useKeyContext } from "../keys/keymap";
import { useUpdate } from "../store/useUpdate";
import { dismissUpdate, installUpdate } from "../update";
import { Icon } from "./Icon";

/** One decimal from a megabyte up, none below it, so the number under the bar stops twitching. */
function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} kB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateDialog() {
  const phase = useUpdate((s) => s.phase);
  const version = useUpdate((s) => s.version);
  const notes = useUpdate((s) => s.notes);
  const downloaded = useUpdate((s) => s.downloaded);
  const total = useUpdate((s) => s.total);
  const error = useUpdate((s) => s.error);

  const installRef = useRef<HTMLButtonElement>(null);

  const open =
    phase === "available" || phase === "downloading" || phase === "installing" || phase === "error";
  const busy = phase === "downloading" || phase === "installing";

  useEffect(() => {
    if (phase === "available") installRef.current?.focus();
  }, [phase]);

  useEscapeLayer(open && !busy, dismissUpdate);
  useKeyContext("overlay", open);

  if (!open) return null;

  const percent = total === null || total === 0 ? null : Math.min(100, (downloaded / total) * 100);

  return (
    <div className="overlay" onClick={busy ? undefined : dismissUpdate}>
      <div
        className="panel panel-update"
        role="dialog"
        aria-modal="true"
        aria-label="Software update"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2>{version === null ? "Update" : `Margin Docs ${version}`}</h2>
          {!busy && (
            <button
              className="icon-button"
              onClick={dismissUpdate}
              title="Close (⎋)"
              aria-label="Close"
            >
              <Icon d="M6 6l12 12M18 6L6 18" />
            </button>
          )}
        </div>

        <div className="panel-body">
          {phase === "error" ? (
            <p className="confirm-text">{error ?? "The update could not be installed."}</p>
          ) : (
            <>
              <p className="confirm-text">
                A new version is ready. Margin Docs will restart once it is installed, and anything
                unsaved is written to disk first.
              </p>
              {notes !== null && notes.trim() !== "" && (
                <div className="update-notes" aria-label="Release notes">
                  {notes.trim()}
                </div>
              )}
            </>
          )}

          {busy && (
            <div className="update-progress">
              <div
                className="update-track"
                role="progressbar"
                aria-label="Download progress"
                aria-valuenow={percent === null ? undefined : Math.round(percent)}
                data-unknown={percent === null}
              >
                <div
                  className="update-bar"
                  style={percent === null ? undefined : { width: `${percent}%` }}
                />
              </div>
              <span className="update-count">
                {phase === "installing"
                  ? "Installing…"
                  : total === null
                    ? `${bytes(downloaded)} downloaded`
                    : `${bytes(downloaded)} of ${bytes(total)}`}
              </span>
            </div>
          )}
        </div>

        <div className="panel-foot">
          {phase === "error" ? (
            <button className="btn-ghost" onClick={dismissUpdate}>
              Close
            </button>
          ) : (
            <>
              {!busy && (
                <button className="btn-ghost" onClick={dismissUpdate}>
                  Later
                </button>
              )}
              <button
                ref={installRef}
                className="btn-primary"
                disabled={busy}
                onClick={() => void installUpdate()}
              >
                {phase === "downloading"
                  ? "Downloading…"
                  : phase === "installing"
                    ? "Installing…"
                    : "Install and Relaunch"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
