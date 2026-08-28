// The width control there was no way to click: a title bar button that shows the applied width and
// opens the three named steps with the current one marked.
//
// It belongs beside the theme toggle rather than in the editor pill. Everything in the pill edits
// the file; this edits the app's view of it and touches no byte on disk, and the title bar already
// holds the other two of exactly that kind, the sidebar and the theme, both persisted under the
// same `margindocs-` prefix and both restored by the same boot script. The pill is also the wrong
// place mechanically: its tools go dead while a save conflict is open, and being unable to widen
// the page because the file moved on disk is nonsense, and the foot of src/styles/toolbar.css
// records that the row is already four pixels over the pane at the app's minimum window.
//
// The DOM is the source of truth and this component's state is a cache of it. `applyWidth` writes
// `data-width` on the root element and index.html's boot script writes it before React exists,
// while the keyboard commands and the native menu both call `applyWidth` without telling anyone,
// so the attribute is read on mount and watched with a MutationObserver. A component that
// remembered the last width it set itself would open showing the wrong one the first time somebody
// reached for the key instead.
//
// Focus is not taken from the document. A mouse press on any button here is prevented, so the
// caret stays in the sentence somebody is in the middle of; only a keyboard open moves focus into
// the menu, and closing puts it back where it came from.

import { useEffect, useId, useRef, useState } from "react";
import { useEscapeLayer } from "../escape";
import { applyWidth, WIDTHS, type EditorWidth } from "../width";
import { Icon } from "./Icon";

const ITEM = ".width-menu-item";

const CHECK_D = "M20 6L9 17l-5-5";

/** The page's two edges with three lines of text between them, so the button says which width is
 * applied without spending a word of the title bar on it. The edges never move and only the
 * measure does, which is the whole of what the setting changes. The sibling's glyph for this is a
 * double headed arrow, and it is not ported: an arrow six units long is a smudge at 16px, which is
 * the only size this is ever drawn at. */
const WIDTH_ICON: Record<EditorWidth, string> = {
  narrow: "M3 4v16M21 4v16M9 7h6M9 12h6M9 17h6",
  normal: "M3 4v16M21 4v16M7 7h10M7 12h10M7 17h10",
  wide: "M3 4v16M21 4v16M5 7h14M5 12h14M5 17h14",
};

function isWidth(value: string | null): value is EditorWidth {
  return WIDTHS.includes(value as EditorWidth);
}

/** Capitalised for a menu. The names themselves belong to src/width.ts and the command ids. */
function widthLabel(width: EditorWidth): string {
  return width.charAt(0).toUpperCase() + width.slice(1);
}

/** No attribute at all is the default, because sheet.css only writes rules for narrow and wide and
 * the boot script only sets the attribute when something was saved. */
function appliedWidth(): EditorWidth {
  const value = document.documentElement.getAttribute("data-width");
  return isWidth(value) ? value : "normal";
}

function useAppliedWidth(): EditorWidth {
  const [width, setWidth] = useState(appliedWidth);

  useEffect(() => {
    const read = () => setWidth(appliedWidth());
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributeFilter: ["data-width"] });
    // The attribute can have moved between the first render and this effect running.
    read();
    return () => observer.disconnect();
  }, []);

  return width;
}

export function WidthMenu() {
  const width = useAppliedWidth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Where focus was when a keyboard user opened the menu, and null when a mouse user did, since
   * that press never moved it. */
  const returnTo = useRef<HTMLElement | null>(null);
  const focusOnOpen = useRef(false);
  const labelId = useId();

  const close = (restoreFocus = true) => {
    setOpen(false);
    const el = returnTo.current;
    returnTo.current = null;
    if (restoreFocus && el?.isConnected) el.focus();
  };

  useEscapeLayer(open, () => close());

  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    menuRef.current?.querySelector<HTMLElement>(ITEM)?.focus();
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    if (open) {
      close();
      return;
    }
    // `detail` is 0 when Enter or Space activated the button and 1 when a pointer did. A keyboard
    // user cannot reach the items unless focus is moved into the menu; a mouse user is mid
    // sentence and would lose their caret to a setting that has nothing to do with the text.
    const byKeyboard = e.detail === 0;
    returnTo.current = byKeyboard ? (document.activeElement as HTMLElement | null) : null;
    focusOnOpen.current = byKeyboard;
    setOpen(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  const choose = (next: EditorWidth) => {
    applyWidth(next);
    close();
  };

  const name = `Editor width: ${widthLabel(width)}`;

  return (
    <div
      className="menu-wrap"
      // Tabbing out of an open menu has to leave the menu behind, since nothing here traps focus,
      // and focus that has deliberately gone somewhere else is not dragged back.
      onBlur={(e) => {
        if (!open || e.currentTarget.contains(e.relatedTarget)) return;
        close(false);
      }}
    >
      <button
        className="icon-button"
        data-active={open}
        title={name}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
      >
        <Icon d={WIDTH_ICON[width]} />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => close()} />
          <div
            ref={menuRef}
            className="menu"
            role="menu"
            aria-labelledby={labelId}
            onKeyDown={onKeyDown}
          >
            {/* Three words that mean nothing on their own, so the menu says what they are a width
                of and then lends the same line to assistive tech as its own name. Presentational
                because a menu's children are meant to be its items, and because being announced as
                the menu's name and again as a line inside it is the same sentence twice. */}
            <div className="menu-label" id={labelId} role="presentation">
              Editor width
            </div>
            {WIDTHS.map((w) => (
              <button
                key={w}
                className="width-menu-item"
                role="menuitemradio"
                aria-checked={w === width}
                data-on={w === width}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(w)}
              >
                <span className="width-menu-check" aria-hidden="true">
                  <Icon d={CHECK_D} size={14} />
                </span>
                {widthLabel(w)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
