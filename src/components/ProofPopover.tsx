// The menu over a misspelled word: what the system thinks was meant, and the two ways of saying it
// was not a mistake.
//
// Mounted once and drawing nothing until src/editor/proofing.ts puts a word in the store, so App.tsx
// holds one line for it rather than a piece of the feature. It renders into a portal because the
// document scrolls inside its own pane and a menu clipped by the pane it belongs to is no menu at
// all, and it is positioned in viewport coordinates because that is what the editor measured the
// word in.
//
// It never takes focus. A left click on a misspelled word is somebody putting the caret in a word
// they are about to fix by hand as often as it is somebody asking what else it could have been, and
// a menu that steals the caret out of the sentence being typed has broken the more common of the
// two. So the caret stays where the click put it, typing goes on into the document and dismisses the
// menu on the way, and the buttons refuse the focus a mousedown would otherwise give them.
//
// "Learn Spelling" is the item that has to be honest about what it does. The checker is
// NSSpellChecker and the dictionary is the Mac's, so learning a word here teaches Mail, Notes and
// every other app on the machine, which is what makes it useful and also what makes it more than
// this app's business to do quietly. The note under the buttons says so in the menu, where the
// decision is being made, rather than in a tooltip nobody reads first.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { replaceSpelling } from "../editor/proofing";
import { useEscapeLayer } from "../escape";
import { useProofing, type ProofTarget } from "../store/useProofing";

/** Clearance from the word above and from the edges of the window. */
const GAP = 6;
const MARGIN = 8;

export function ProofPopover() {
  const target = useProofing((s) => s.target);
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

  useEscapeLayer(true, closeMenu);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const close = () => closeMenu();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [closeMenu]);

  // The caret belongs to the document, not to this menu, so a press on any of these buttons is not
  // allowed to move it.
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={popRef}
      className="proof-pop"
      role="menu"
      aria-label={`Spelling suggestions for ${target.word}`}
      style={{ left: at.left, top: at.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {target.suggestions.length === 0 ? (
        <p className="proof-none">No suggestions</p>
      ) : (
        target.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            role="menuitem"
            className="proof-suggestion"
            onMouseDown={keepFocus}
            onClick={() => {
              replaceSpelling(target, suggestion);
              closeMenu();
            }}
          >
            {suggestion}
          </button>
        ))
      )}

      <div className="proof-sep" />

      <button
        role="menuitem"
        className="proof-action"
        title={`Adds “${target.word}” to the dictionary every app on this Mac shares.`}
        onMouseDown={keepFocus}
        onClick={() => {
          void learnWord(target.word);
          closeMenu();
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
          closeMenu();
        }}
      >
        Ignore
      </button>

      <p className="proof-note">Learning a word teaches this Mac, not only Margin Docs.</p>
    </div>,
    document.body,
  );
}
