// The shell behind all three overlay palettes: the backdrop, the one text field, the list under it
// and the keyboard that drives them.
//
// Three sources, one widget. What differs between quick open, find in files and the command palette
// is where the rows come from and what a row does when it is chosen, and that is the whole of what
// the three concrete palettes hand in. Everything a user would call "how the palette behaves", the
// arrow keys, the wrap at the ends, the selection following the mouse, the row scrolling itself
// into view, lives here once so the three cannot drift into three slightly different lists.
//
// Rendered only while its palette is open, never handed a closed flag: mounting is what opens it.
// That is what keeps the selection, the scroll position and the focus fresh on every open without a
// single reset effect, and it leaves the open flag, the Escape layer and the key context in the
// concrete component beside its `onCommand` subscription, which is the shape Shortcuts.tsx already
// has.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { MatchRange } from "../ipc";

export interface PaletteRow {
  /** Identity, not position: a path, a command id. React's key and nothing more. */
  key: string;
  /** What choosing the row does. The palette is already closed by the time this is called. */
  run: () => void;
}

/** The single line shown in place of the list. */
export interface PaletteStatus {
  text: string;
  /** Something failed and this is its message. An empty result is not a failure. */
  error?: boolean;
}

interface PaletteProps<Row extends PaletteRow> {
  /** Names the dialog, its field and its list for a screen reader. */
  label: string;
  placeholder: string;
  query: string;
  onQuery: (query: string) => void;
  rows: readonly Row[];
  /** Shown only when there are no rows, so an answer that is still in flight keeps the last rows
   * on screen rather than flashing "No results" between two keystrokes. */
  status: PaletteStatus | null;
  renderRow: (row: Row) => ReactNode;
  onClose: () => void;
}

export function Palette<Row extends PaletteRow>({
  label,
  placeholder,
  query,
  onQuery,
  rows,
  status,
  renderRow,
  onClose,
}: PaletteProps<Row>) {
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Clamped where it is read rather than corrected in an effect. The row count changes with every
  // answer the index gives back, and an effect that put the index right afterwards would render one
  // frame with a selection pointing past the end of the list first.
  const at = Math.min(selected, rows.length - 1);
  const current = at >= 0 ? rows[at] : null;

  useEffect(() => inputRef.current?.focus(), []);

  // A new query is a new list, so the selection goes back to the top. Keyed on the query rather
  // than on `rows`, because a palette that filters as it renders hands over a new array every time
  // and this would then undo every arrow key the moment it was pressed.
  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (row: Row) => {
    // Closed before the row runs. A command palette row can put another overlay on screen, and the
    // two would otherwise unwind the Escape stack and the key context stack in the wrong order.
    onClose();
    row.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Without this the caret jumps to one end of the field on every step through the list.
      e.preventDefault();
      if (rows.length === 0) return;
      const next = e.key === "ArrowDown" ? at + 1 : at - 1 + rows.length;
      setSelected(next % rows.length);
      return;
    }
    if (e.key === "Enter" && current) {
      e.preventDefault();
      choose(current);
    }
  };

  return (
    // Mousedown rather than click: a click closes on the release, so dragging a selection out of
    // the field and letting go over the backdrop would dismiss the palette mid-gesture.
    <div className="overlay" data-align="top" onMouseDown={onClose}>
      <div
        className="panel palette"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-field"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-label={label}
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-activedescendant={current ? `${listId}-${at}` : undefined}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {rows.length > 0 ? (
          <ul ref={listRef} id={listId} className="palette-list" role="listbox" aria-label={label}>
            {rows.map((row, index) => (
              <li
                key={row.key}
                id={`${listId}-${index}`}
                className="palette-row"
                role="option"
                aria-selected={index === at}
                data-selected={index === at}
                // Move, not enter. The list re-renders under a still cursor every time the index
                // answers, and `mouseenter` would hand the selection to whichever row happened to
                // slide under a pointer nobody had touched.
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(row)}
              >
                {renderRow(row)}
              </li>
            ))}
          </ul>
        ) : (
          status && (
            <p className="palette-status" data-error={status.error === true}>
              {status.text}
            </p>
          )
        )}
      </div>
    </div>
  );
}

/**
 * The matched characters, marked.
 *
 * `ranges` are half-open offsets into `text` and they come from whatever did the matching, which is
 * the only thing that knows where it landed, so neither search palette runs the match a second time
 * to find out. Offsets are clamped and taken in order rather than trusted: they are computed on the
 * other side of the IPC boundary against a string this side only has a copy of, and one bad pair
 * would otherwise slice a row into nonsense.
 */
export function highlight(text: string, ranges: readonly MatchRange[]): ReactNode {
  if (ranges.length === 0) return text;

  const parts: ReactNode[] = [];
  let at = 0;
  const ordered = [...ranges].sort((a, b) => a.start - b.start);

  ordered.forEach((range, i) => {
    const start = Math.max(at, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (end === start) return;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="palette-mark">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });

  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
