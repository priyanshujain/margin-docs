// The document's headings, as a rail of ticks down the right edge of the page that opens under the
// pointer into the full list, and a click on a row that goes there.
//
// Notion's pattern, taken on purpose. The rail is a glance: one tick per heading, longer for a
// section and shorter for what sits under it, the one the reader is in drawn darker, and no words
// until they are asked for. Asking is putting the pointer on it, at which point the ticks become
// the titles and the titles are clickable. None of it is in the sidebar, because the sidebar is the
// folder and this is the document, and none of it takes room from the page: it sits in the margin
// the sheet already leaves beside the measure, and the toggle that hides it is for a window too
// narrow to have one.
//
// What is drawn comes off the live tree through the editor's outline handle, so it is true of the
// document a keystroke ago rather than of the file on disk, and a row is a position in that tree
// rather than a search for its words, which is what lets two sections share a title. Which tick is
// the reader's is measured against the pane rather than taken from the caret, for the reason given
// where it is measured, in src/editor/Editor.tsx.
//
// A document with no headings has no rail, since a rail of nothing is a mark on the page for no
// reason; a .txt and a picture have no handle at all and get the same nothing.

import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { useDocumentOutline } from "../editor";
import { useEscapeLayer } from "../escape";
import { onCommand } from "../keys/commands";

const OUTLINE_KEY = "margindocs-outline";

function storedShown(): boolean {
  try {
    return localStorage.getItem(OUTLINE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function Outline() {
  const outline = useDocumentOutline();
  const [shown, setShown] = useState(storedShown);
  // Three ways the list can be open, kept apart because each closes differently: the pointer
  // leaving takes hover with it, focus leaving takes focus with it, and a tap outside or Escape
  // takes a pin, which is what a finger has instead of a hover.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [active, setActive] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem(OUTLINE_KEY, String(shown));
    } catch {
      // A webview with storage denied still toggles, it just forgets between launches.
    }
  }, [shown]);

  useEffect(() => onCommand("toggle-outline", () => setShown((v) => !v)), []);

  const open = hovered || focused || pinned;
  const current = outline?.current ?? null;

  useEffect(() => {
    if (!pinned) return;
    const onDown = (event: globalThis.PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setPinned(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pinned]);

  useEscapeLayer(focused || pinned, () => {
    setPinned(false);
    const held = document.activeElement;
    if (held instanceof HTMLElement && host.current?.contains(held)) held.blur();
  });

  // The reader's row is in sight when the list opens and follows as they scroll. By hand rather
  // than scrollIntoView, which is free to scroll every ancestor of the row as well.
  useEffect(() => {
    if (!open) return;
    const scroller = list.current;
    const row = current === null ? null : rows.current[current];
    if (!scroller || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = bottom - scroller.clientHeight;
  }, [open, current]);

  if (!shown || outline === null || outline.entries.length === 0) return null;
  const { entries, reveal } = outline;

  // Roving focus over the rows, the same shape the backlinks section has: the rail is the one tab
  // stop, and the arrows walk the list it opens.
  const focusedRow = Math.min(active, entries.length - 1);

  const move = (delta: number) => {
    const next = Math.min(Math.max(focusedRow + delta, 0), entries.length - 1);
    setActive(next);
    rows.current[next]?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  };

  // Into the rows from the rail, starting at the reader's own.
  const onRailKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const at = current ?? 0;
    setActive(at);
    rows.current[at]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };

  return (
    <div
      ref={host}
      className="outline"
      data-open={open}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHovered(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <div
        className="outline-rail"
        role="button"
        tabIndex={0}
        aria-label="Outline"
        aria-expanded={open}
        onClick={() => setPinned((v) => !v)}
        onKeyDown={onRailKeyDown}
      >
        {entries.map((entry, index) => (
          <span
            key={index}
            className="outline-tick"
            style={{ "--outline-depth": entry.depth } as CSSProperties}
            data-depth={entry.depth}
            data-current={index === current}
          />
        ))}
      </div>

      {open && (
        <nav className="outline-panel" aria-label="Sections">
          <ul className="outline-list" ref={list} onKeyDown={onListKeyDown}>
            {entries.map((entry, index) => (
              // By index rather than by position: a keystroke above a heading moves every
              // position under it, and a list that remounted its rows on each of those would drop
              // the focus somebody was walking with the arrows.
              <li key={index}>
                <button
                  className="outline-row"
                  ref={(el) => {
                    rows.current[index] = el;
                  }}
                  style={{ "--outline-depth": entry.depth } as CSSProperties}
                  data-depth={entry.depth}
                  data-current={index === current}
                  tabIndex={index === focusedRow ? 0 : -1}
                  onFocus={() => setActive(index)}
                  // A mouse press leaves the keyboard where it is; the click moves it into the
                  // heading itself, which is the point of the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => reveal(entry.pos)}
                >
                  {entry.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
