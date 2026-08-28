// The popup menu a row offers, in two forms over one body: a "..." button that opens it under
// itself, and a bare popup anchored to the point a right click happened. Both render into a portal
// so a menu is never clipped by the scrolling tree it belongs to.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer } from "../escape";
import { Icon } from "./Icon";

export interface RowMenuItem {
  id: string;
  label: string;
  /** A Feather-style 24x24 stroke path, the same shape `<Icon d>` takes everywhere else. */
  icon: string;
  danger?: boolean;
  run: () => void;
}

/** A hairline between groups of items. Written inline in the array so the order stays readable. */
export type RowMenuEntry = RowMenuItem | "sep";

const MENU_ITEM = ".row-menu-item";

interface PopProps {
  x: number;
  y: number;
  /** A thunk, not an array: a tree of a thousand rows should not build a thousand menus it will
   * never show, and the items a row offers can depend on state that moved since it was drawn. */
  items: () => readonly RowMenuEntry[];
  onClose: () => void;
  /** Where focus goes when the menu closes, so keyboard use does not land back at the document. */
  restoreFocus?: () => void;
}

function MenuPop({ x, y, items, onClose, restoreFocus }: PopProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    popRef.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus();
  }, []);

  useEscapeLayer(true, () => {
    onClose();
    restoreFocus?.();
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const close = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = Array.from(popRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? []);
    if (!all.length) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  const choose = (e: React.MouseEvent, item: RowMenuItem) => {
    e.stopPropagation();
    onClose();
    item.run();
  };

  return createPortal(
    <div
      ref={popRef}
      className="row-menu-pop"
      role="menu"
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items().map((item, i) =>
        item === "sep" ? (
          <div key={`sep-${i}`} className="menu-sep" />
        ) : (
          <button
            key={item.id}
            role="menuitem"
            className={item.danger ? "row-menu-item danger" : "row-menu-item"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => choose(e, item)}
          >
            <Icon d={item.icon} size={14} />
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

interface RowMenuProps {
  label: string;
  items: () => readonly RowMenuEntry[];
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/** The "..." trigger, for a row that has room to show one. */
export function RowMenu({ label, items, onOpenChange, className = "" }: RowMenuProps) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const open = anchor !== null;
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    onOpenChange?.(open);
  }, [anchor, onOpenChange]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (anchor) {
      setAnchor(null);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <>
      <button
        ref={btnRef}
        className={`row-menu-btn ${className}`}
        data-open={anchor !== null}
        title={label}
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
      >
        <Icon d="M12 5h.01M12 12h.01M12 19h.01" />
      </button>
      {anchor && (
        <MenuPop
          x={anchor.x}
          y={anchor.y}
          items={items}
          onClose={() => setAnchor(null)}
          restoreFocus={() => btnRef.current?.focus()}
        />
      )}
    </>
  );
}

interface RowMenuAtProps {
  x: number;
  y: number;
  items: () => readonly RowMenuEntry[];
  onClose: () => void;
}

/** The same menu opened at a point, which is what a right click on a row produces. */
export function RowMenuAt({ x, y, items, onClose }: RowMenuAtProps) {
  return <MenuPop x={x} y={y} items={items} onClose={onClose} />;
}
