// Something outside the app changed the file that is open, and the buffer has an edit in it that
// is not on disk. Both copies are real work and the app does not get to pick, so it asks.
//
// There is no merge and there will not be one: a three way merge of somebody's prose is a thing
// that looks like it worked. The two answers are the two copies, and dismissing the dialog picks
// neither, which leaves the warning in the toolbar and the buffer exactly as it was.

import { useEffect, useRef } from "react";
import { useEscapeLayer } from "../escape";
import { Icon } from "./Icon";

interface ConflictDialogProps {
  /** The file's name, not its path: the path is already in the title bar. */
  name: string;
  /** Throws the buffer away and takes what is on disk. */
  onReload: () => void;
  /** Keeps the buffer and lets the next save write over the copy on disk. */
  onKeep: () => void;
  /** Neither, for now. The document stays unsaved and the toolbar keeps the warning. */
  onDismiss: () => void;
}

export function ConflictDialog({ name, onReload, onKeep, onDismiss }: ConflictDialogProps) {
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  useEscapeLayer(true, onDismiss);

  return (
    <div className="overlay" onClick={onDismiss}>
      <div
        className="panel panel-conflict"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2>Changed on disk</h2>
          <button className="icon-button" onClick={onDismiss} title="Close (⎋)" aria-label="Close">
            <Icon d="M6 6l12 12M18 6L6 18" />
          </button>
        </div>
        <div className="panel-body">
          <p className="confirm-text">
            Something outside Margin Docs has changed <strong>{name}</strong>, and you have edits
            here that are not on disk. Nothing has been written and nothing has been lost yet.
          </p>
        </div>
        <div className="panel-foot">
          <button className="btn-ghost" onClick={onDismiss}>
            Decide later
          </button>
          <button className="btn-danger" onClick={onReload}>
            Reload from disk
          </button>
          <button ref={keepRef} className="btn-primary" onClick={onKeep}>
            Keep my version
          </button>
        </div>
      </div>
    </div>
  );
}
