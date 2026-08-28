// The menu over a misspelled word: what the system thinks was meant, and the two ways of saying it
// was not a mistake.
//
// Mounted once and drawing nothing until src/editor/proofing.ts puts a word in the store, so App.tsx
// holds one line for it rather than a piece of the feature. It renders into a portal because the
// document scrolls inside its own pane and a menu clipped by the pane it belongs to is no menu at
// all, and it is positioned in viewport coordinates because that is what the editor measured the
// word in.
//
// A pointer never moves focus into it. A left click on a misspelled word is somebody putting the
// caret in a word they are about to fix by hand as often as it is somebody asking what else it could
// have been, and a menu that steals the caret out of the sentence being typed has broken the more
// common of the two. So the caret stays where the click put it, typing goes on into the document and
// dismisses the menu on the way, and the buttons refuse the focus a mousedown would otherwise give
// them.
//
// A chord is the other case and it is the opposite one, which is the whole of what `fromKeyboard`
// on the target decides. Cmd+; had no pointer behind it to leave a caret anywhere useful and no way
// of reaching an item once the menu is up, so that opening moves focus to the first item, walks the
// items with the arrow keys, holds Tab inside the menu, and puts focus back where it came from when
// the menu closes. Enter and Space are not handled here at all: these are real buttons, so the
// browser activates the focused one and src/keys/keymap.ts steps over both keys for exactly that
// reason. WidthMenu.tsx makes the same split between the two ways of opening, and the walk itself is
// RowMenu.tsx's.
//
// "Learn Spelling" is the item that has to be honest about what it does. The checker is
// NSSpellChecker and the dictionary is the Mac's, so learning a word here teaches Mail, Notes and
// every other app on the machine, which is what makes it useful and also what makes it more than
// this app's business to do quietly. The note under the buttons says so in the menu, where the
// decision is being made, rather than in a tooltip nobody reads first.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openSpellingMenu, replaceSpelling } from "../editor/proofing";
import { useEscapeLayer } from "../escape";
import { onCommand } from "../keys/commands";
import { useProofing, type ProofTarget } from "../store/useProofing";
import { notify } from "../store/useToast";

/** Clearance from the word above and from the edges of the window. */
const GAP = 6;
const MARGIN = 8;

/** Everything the arrow keys walk, which is every item and not only the suggestions. */
const ITEM = ".proof-suggestion, .proof-action";

/**
 * The chord's end of the feature, and the one line of explanation it owes when there is nothing
 * beside the caret to correct.
 *
 * Subscribed here rather than run from the command table for the reason that table's own comment
 * gives: this is the component that draws the menu, so it is the thing that has to be on screen for
 * the command to mean anything, and src/keys/commands.ts stays free of the editor.
 */
function correctAtCaret(): void {
  if (openSpellingMenu()) return;
  notify(
    useProofing.getState().enabled
      ? "No misspelled word in this paragraph"
      : "Spell checking is off",
  );
}

export function ProofPopover() {
  const target = useProofing((s) => s.target);

  useEffect(() => onCommand("correct-spelling", correctAtCaret), []);

  if (target === null) return null;
  // Keyed so that opening the menu over a second word rebuilds it rather than sliding the first
  // one's measurements across.
  return <ProofMenu key={`${target.from}:${target.word}`} target={target} />;
}

function ProofMenu({ target }: { target: ProofTarget }) {
  const closeMenu = useProofing((s) => s.closeMenu);
  const ignoreWord = useProofing((s) => s.ignoreWord);
  const learnWord = useProofing((s) => s.learnWord);

  const popRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: target.left, top: target.bottom + GAP });
  /** Where focus was when a chord opened the menu, and null when a pointer did, since that press
   * never moved it and there is nothing to give back. */
  const returnTo = useRef<HTMLElement | null>(null);
  const ids = useId();

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const left = Math.max(
      MARGIN,
      Math.min(target.left - box.width / 2, window.innerWidth - box.width - MARGIN),
    );
    // Under the word, unless the window has no room under it, in which case above it. Never over it:
    // the word is what the menu is about and covering it hides the mistake being corrected.
    const below = target.bottom + GAP;
    const top =
      below + box.height + MARGIN <= window.innerHeight
        ? below
        : Math.max(MARGIN, target.top - GAP - box.height);
    setAt({ left, top });
  }, [target]);

  // The measuring above has already run by the time this does, so the item is focused where it will
  // be drawn rather than at the corner the popover was first laid out in.
  useEffect(() => {
    if (!target.fromKeyboard) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    popRef.current?.querySelector<HTMLElement>(ITEM)?.focus();
  }, [target.fromKeyboard]);

  /** Closes, and hands focus back to whatever the chord took it from. */
  const dismiss = useCallback(() => {
    const el = returnTo.current;
    returnTo.current = null;
    closeMenu();
    // Not the body: focusing that is not giving anything back, it is losing the caret quietly.
    if (el && el !== document.body && el.isConnected) el.focus();
  }, [closeMenu]);

  useEscapeLayer(true, dismiss);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      // Not `dismiss`: the press is putting focus somewhere of its own, and dragging it back to the
      // document afterwards would undo what the user just did with it.
      closeMenu();
    };
    // Scrolling and resizing are the other way round. Neither is anybody moving focus, so if focus
    // is sitting in a menu that is about to stop existing, it goes back where it came from.
    const close = () => dismiss();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [closeMenu, dismiss]);

  // The caret belongs to the document, not to this menu, so a press on any of these buttons is not
  // allowed to move it.
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /**
   * The walk, and the trap.
   *
   * Only ever reached in the keyboard case, because a menu a pointer opened has no focus in it for a
   * key to be delivered to. Tab is taken along with the arrows rather than left to the browser: the
   * menu is a portal at the end of the body, so a Tab out of it lands on nothing the user can see,
   * with an open menu still on the page and a caret they can no longer get back to.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Tab") return;
    e.preventDefault();
    const all = Array.from(popRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
    if (!all.length) return;
    const current = all.indexOf(document.activeElement as HTMLElement);
    const back = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
    const next = back ? (current - 1 + all.length) % all.length : (current + 1) % all.length;
    all[next]?.focus();
  };

  return createPortal(
    <div
      ref={popRef}
      className="proof-pop"
      role="menu"
      aria-label={`Spelling suggestions for ${target.word}`}
      aria-describedby={
        target.suggestions.length === 0 ? `${ids}-none ${ids}-note` : `${ids}-note`
      }
      style={{ left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The two paragraphs and the rule are not items, so a menu announces the things that can be
          chosen and nothing else. Neither line is thrown away with them: both are named on the
          menu's own aria-describedby above, which is where a sentence about a menu belongs and is
          what gets them read once, on the way in, rather than as a row somebody has to arrow past. */}
      {target.suggestions.length === 0 ? (
        <p className="proof-none" role="presentation" id={`${ids}-none`}>
          No suggestions
        </p>
      ) : (
        target.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            role="menuitem"
            className="proof-suggestion"
            onMouseDown={keepFocus}
            onClick={() => {
              replaceSpelling(target, suggestion);
              dismiss();
            }}
          >
            {suggestion}
          </button>
        ))
      )}

      <div className="proof-sep" role="separator" />

      <button
        role="menuitem"
        className="proof-action"
        title={`Adds “${target.word}” to the dictionary every app on this Mac shares.`}
        onMouseDown={keepFocus}
        onClick={() => {
          void learnWord(target.word);
          dismiss();
        }}
      >
        Learn Spelling
      </button>
      <button
        role="menuitem"
        className="proof-action"
        title="Stops underlining this word until the app is next opened."
        onMouseDown={keepFocus}
        onClick={() => {
          ignoreWord(target.word);
          dismiss();
        }}
      >
        Ignore
      </button>

      <p className="proof-note" role="presentation" id={`${ids}-note`}>
        Learning a word teaches this Mac, not only Margin Docs.
      </p>
    </div>,
    document.body,
  );
}
