import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Responsiveness is JS-driven: this writes `data-compact` on the root and the stylesheet keys off
 * that attribute, so there are essentially no media queries in app.css.
 */
export function useCompact(): boolean {
  const compact = useMediaQuery("(max-width: 899px)");
  useEffect(() => {
    document.documentElement.toggleAttribute("data-compact", compact);
  }, [compact]);
  return compact;
}

/** Kept in step with the same two queries in index.html's boot script. */
export const PHONE_QUERY = "(max-width: 640px)";
export const TOUCH_QUERY = "(pointer: coarse)";

/**
 * A phone, meaning a window too narrow for the sidebar, the document and the sticky toolbar to
 * all be worth showing at once. The chrome collapses and the sidebar becomes an overlay instead
 * of a permanent column.
 *
 * Deliberately measured in CSS pixels rather than sniffed off the user agent: a phone in landscape
 * is 850 wide and wants the desktop layout back, a tablet at 768 has always wanted it, and a
 * narrow desktop window is a free way to exercise all of this without a device.
 */
export function usePhone(): boolean {
  const phone = useMediaQuery(PHONE_QUERY);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-phone", phone);
  }, [phone]);
  return phone;
}

/**
 * A coarse pointer, which is a different question from `usePhone`: a tablet is touch and not a
 * phone, and a narrow desktop window is a phone and not touch.
 *
 * This is the one that governs interaction rather than layout. Anything that only appears on hover
 * is unreachable here and has to have a tap that does the same job, and a gesture that starts on
 * pointerdown has to wait for a long press instead, because a finger cannot press without also
 * intending to maybe scroll.
 */
export function useTouch(): boolean {
  const touch = useMediaQuery(TOUCH_QUERY);
  useEffect(() => {
    document.documentElement.toggleAttribute("data-touch", touch);
  }, [touch]);
  return touch;
}
