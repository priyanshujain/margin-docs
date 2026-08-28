// Find and replace inside the open document. Margin's bar, minus the cross-chapter scope: there
// is one document open at a time here, and searching every file is `find-in-files` against the
// SQLite index, which is a different panel with different results.
//
// The matching itself is the editor's, not this bar's. `EditorHandle` in src/editor/index.ts does
// not carry a search surface, so the shape this bar drives is declared here and handed in: a
// component that draws a text field has no business owning a ProseMirror decoration set, and the
// alternative, walking the contenteditable DOM behind the editor's back, is a second
// implementation of matching that would disagree with the first the day either changed.

import { useEffect, useRef, useState } from "react";
import { useEscapeLayer } from "../escape";
import { onCommand } from "../keys/commands";
import { Icon } from "./Icon";

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface FindState {
  count: number;
  /** Zero based, so `current + 1` is what the "3 of 12" readout shows. */
  current: number;
}

/**
 * What the editor lane implements for this bar to be usable.
 *
 * A new object whenever `state` changes, the way `EditorHandle` already works: this bar draws the
 * "3 of 12" readout from a prop and has nothing to subscribe to, so a handle mutated in place
 * would leave the count stale until something unrelated re-rendered.
 */
export interface DocumentFind {
  state: FindState;
  setQuery: (query: string, options: FindOptions) => void;
  clear: () => void;
  next: () => void;
  prev: () => void;
  replaceCurrent: (text: string) => void;
  replaceAll: (text: string) => void;
  /** Puts the cursor back in the document, which every replace has to do to be worth anything. */
  focus: () => void;
}

export function FindBar({ find }: { find: DocumentFind | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      onCommand("find", () => {
        setOpen(true);
        const input = findRef.current;
        input?.focus();
        input?.select();
      }),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const input = findRef.current;
    input?.focus();
    input?.select();
  }, [open]);

  useEffect(() => {
    if (!find) return;
    if (open) find.setQuery(query, { caseSensitive, wholeWord });
    else find.clear();
  }, [find, open, query, caseSensitive, wholeWord]);

  useEscapeLayer(open, () => setOpen(false));

  if (!open || !find) return null;

  const { count, current } = find.state;
  const countLabel = !query ? "" : count === 0 ? "No results" : `${current + 1} of ${count}`;

  const onFindKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) find.prev();
    else find.next();
  };

  const replaceOne = () => {
    find.replaceCurrent(replacement);
    find.focus();
  };

  const replaceEvery = () => {
    find.replaceAll(replacement);
    find.focus();
  };

  return (
    <div className="find-bar" role="search">
      <button
        className="find-expand"
        data-on={expanded}
        title={expanded ? "Hide replace" : "Show replace"}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon d={expanded ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} size={14} />
      </button>

      <div className="find-stack">
        <div className="find-row">
          <input
            ref={findRef}
            className="find-input"
            value={query}
            placeholder="Find"
            spellCheck={false}
            aria-label="Find"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFindKey}
          />
          <span className="find-count">{countLabel}</span>
          <button className="find-btn" title="Previous (⇧↩)" disabled={!count} onClick={find.prev}>
            <Icon d="M6 15l6-6 6 6" size={14} />
          </button>
          <button className="find-btn" title="Next (↩)" disabled={!count} onClick={find.next}>
            <Icon d="M6 9l6 6 6-6" size={14} />
          </button>
          <button
            className="find-toggle"
            data-on={caseSensitive}
            title="Match case"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            className="find-toggle"
            data-on={wholeWord}
            title="Whole word"
            onClick={() => setWholeWord((v) => !v)}
          >
            <span className="find-ww">ab</span>
          </button>
          <button className="find-btn" title="Close (⎋)" onClick={() => setOpen(false)}>
            <Icon d="M18 6L6 18M6 6l12 12" size={14} />
          </button>
        </div>

        {expanded && (
          <div className="find-row">
            <input
              className="find-input"
              value={replacement}
              placeholder="Replace"
              spellCheck={false}
              aria-label="Replace with"
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                replaceOne();
              }}
            />
            <button
              className="find-action"
              disabled={!count}
              onClick={replaceOne}
              title="Replace the current match"
            >
              Replace
            </button>
            <button
              className="find-action"
              disabled={!count}
              onClick={replaceEvery}
              title="Replace every match in this document"
            >
              Replace All
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
