// One capture-phase listener for the whole app, and a context stack that decides what it is
// allowed to do.
//
// The stack starts empty, which means the document context: whatever the WYSIWYG editor and the
// tree answer to day to day. Pushing `overlay` is how a panel on screen, quick open, find in
// files, the command palette, settings, the shortcuts sheet, shadows the whole document keymap
// while leaving `global` reachable, and each of those panels pushes its own frame with
// `useKeyContext` when it mounts: this module does not hold a registry of which overlays exist,
// only of which one currently has the floor.
//
// Escape is not part of this: `src/escape.ts` already stacks Escape handlers of its own and knows
// about nested confirmations, so this listener steps over the key entirely rather than racing it.
//
// A key is never taken from a text field, and here that mostly means the document itself: the
// WYSIWYG editor is contenteditable, so it counts as "typing" the same way an `<input>` does, and
// only a binding marked `allowInInput` fires while the cursor sits inside it.

import { useEffect } from "react";
import {
  BINDINGS,
  normalizeCombo,
  primaryHeld,
  secondaryHeld,
  type Binding,
  type KeyContext,
} from "./bindings";
import { runCommand } from "./commands";

const index = new Map<string, Binding[]>();
for (const binding of BINDINGS) {
  for (const key of binding.keys) {
    const combo = normalizeCombo(key);
    const found = index.get(combo);
    if (found) found.push(binding);
    else index.set(combo, [binding]);
  }
}

interface Frame {
  context: KeyContext;
}

const stack: Frame[] = [];

const activeContext = (): KeyContext => stack[stack.length - 1]?.context ?? "document";

/** Takes the keyboard until the returned function is called. Frames are identity, never by name. */
export function pushContext(context: KeyContext): () => void {
  const frame: Frame = { context };
  stack.push(frame);
  return () => {
    const at = stack.indexOf(frame);
    if (at !== -1) stack.splice(at, 1);
  };
}

/** The hook form, for a component that owns the keyboard while it is on screen. */
export function useKeyContext(context: KeyContext, active = true): void {
  useEffect(() => {
    if (!active) return;
    return pushContext(context);
  }, [context, active]);
}

function comboOf(e: KeyboardEvent): string {
  const mods =
    (primaryHeld(e) ? "cmd+" : "") + (secondaryHeld(e) ? "ctrl+" : "") + (e.altKey ? "alt+" : "");
  // Not lowercased: Cmd+Shift+F and Cmd+F arrive as "F" and "f" respectively, and that case is
  // the only thing telling them apart once a real modifier is already in the combo.
  return mods ? `${mods}${e.key}` : e.key;
}

function resolve(combo: string): Binding | null {
  const candidates = index.get(combo);
  if (!candidates) return null;
  const top = activeContext();
  return (
    candidates.find((b) => b.context === top) ??
    candidates.find((b) => b.context === "global") ??
    null
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * A button the user can tab to activates itself on Enter, so the keymap leaves that alone.
 */
function isActivatable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string" || el.tabIndex < 0) return false;
  return (
    el.tagName === "BUTTON" ||
    el.tagName === "A" ||
    el.tagName === "SUMMARY" ||
    el.getAttribute("role") === "button"
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.defaultPrevented) return;
  if (e.key === "Escape") return;
  if ((e.key === "Enter" || e.key === " ") && isActivatable(e.target)) return;

  const binding = resolve(comboOf(e));
  if (!binding || binding.command === null) return;

  if (!binding.allowInInput && (isTyping(e.target) || isTyping(document.activeElement))) return;

  e.preventDefault();
  e.stopPropagation();
  runCommand(binding.command);
}

let installs = 0;

/** Installs the one listener. Reference counted, so React's double effect in dev is harmless. */
export function installKeymap(): () => void {
  installs += 1;
  if (installs === 1) window.addEventListener("keydown", onKeyDown, true);
  return () => {
    installs -= 1;
    if (installs === 0) window.removeEventListener("keydown", onKeyDown, true);
  };
}

/** Mount once, at the top of the tree. */
export function useKeymap(): void {
  useEffect(() => installKeymap(), []);
}
