// Spelling, as far as the app outside the editor is concerned: whether the machine has a checker at
// all, whether the user wants underlines, which words they have waved away this session, and which
// misspelling the menu is currently open over.
//
// The checker itself is the system's (see src/api/spell.ts), which is why availability is a piece of
// state rather than a constant. `spellAvailable` is asked once per launch and never again: it
// crosses the IPC boundary to AppKit, the answer cannot change while the app is running, and a build
// with no `spell_check` command behind it rejects rather than answering false. Both a false and a
// rejection mean the same thing here, "there is no checker", and neither is a toast. A user on a
// build without one did not do anything, and telling them so on every launch teaches them nothing
// they can act on. What it does instead is take the feature off the screen: no underlines, no menu,
// nothing offering to correct anything.
//
// `revision` is the only unusual field and it is the seam to the editor. src/editor/proofing.ts
// caches what the checker said about a run of text, keyed by that exact text, and a learned word
// changes the answer for text that has not been touched. Rather than let the store reach into a
// ProseMirror view it has no business holding, learning bumps this number and the editor's own
// plugin watches it. `ignored` is watched the same way, by identity, and is deliberately not part of
// the cache: it filters what is drawn, so waving a word away and putting it back costs nothing.

import { create } from "zustand";
import { spellAvailable, spellLearn } from "../api/spell";
import { notify } from "./useToast";

const KEY = "margindocs-spelling";

/**
 * Where the menu is, and what it is about.
 *
 * `from` and `to` are document positions taken when the menu opened. They are not kept up to date
 * afterwards and do not need to be: any edit to the document closes the menu, and the one thing that
 * acts on them checks the word is still there before it writes anything.
 */
export interface ProofTarget {
  from: number;
  to: number;
  /** What the checker flagged, which is also what "Learn Spelling" and "Ignore" are about. */
  word: string;
  /** At most five, already trimmed by the editor. Can be empty: the system often knows a word is
   * wrong without knowing what was meant. */
  suggestions: readonly string[];
  /** Viewport coordinates of the word itself, for placing the menu under it. */
  left: number;
  top: number;
  bottom: number;
  /** True when a chord opened the menu rather than a pointer, which is the whole of what decides
   * whether the menu takes focus. src/components/ProofPopover.tsx says why a click must not. */
  fromKeyboard: boolean;
}

/** "missing" is both a checker that said no and a command that was not there to ask. */
export type SpellAvailability = "unknown" | "asking" | "ready" | "missing";

interface ProofingState {
  availability: SpellAvailability;
  enabled: boolean;
  /** Lower cased, and only for this run of the app. Ignoring is not learning and is not written
   * anywhere: the system checker owns the dictionary, and a word waved away in one sitting is not a
   * word the user has taught their Mac. */
  ignored: ReadonlySet<string>;
  revision: number;
  target: ProofTarget | null;

  ensureAvailable: () => void;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
  ignoreWord: (word: string) => void;
  learnWord: (word: string) => Promise<void>;
  openMenu: (target: ProofTarget) => void;
  closeMenu: () => void;
}

// Read and written here rather than in a module of its own, unlike src/theme.ts and src/width.ts.
// Those two exist because a boot script in index.html reads their keys before React starts and
// because applying one writes an attribute on to the document element. This is one boolean that
// nothing outside this store touches, and guarded the same way they are, for the Node test
// environment that reaches this file through src/keys/commands.ts.
function readEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

function writeEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    // A webview with storage denied still spell checks, it just forgets between launches.
  }
}

export const useProofing = create<ProofingState>((set, get) => ({
  availability: "unknown",
  enabled: readEnabled(),
  ignored: new Set<string>(),
  revision: 0,
  target: null,

  ensureAvailable: () => {
    if (get().availability !== "unknown") return;
    set({ availability: "asking" });
    spellAvailable()
      .then((ok) => set({ availability: ok ? "ready" : "missing" }))
      .catch(() => set({ availability: "missing" }));
  },

  setEnabled: (enabled) =>
    set((s) => {
      if (s.enabled === enabled) return {};
      writeEnabled(enabled);
      return { enabled, target: null };
    }),

  toggle: () => get().setEnabled(!get().enabled),

  ignoreWord: (word) =>
    set((s) => {
      const ignored = new Set(s.ignored);
      ignored.add(word.toLowerCase());
      return { ignored };
    }),

  learnWord: async (word) => {
    try {
      await spellLearn(word);
      set((s) => ({ revision: s.revision + 1 }));
    } catch (e) {
      // Unlike the availability question above, this one the user asked for by pressing a button,
      // so it says when it did not happen.
      notify(`Could not learn that word: ${String(e)}`);
    }
  },

  openMenu: (target) => set({ target }),
  closeMenu: () => set((s) => (s.target === null ? {} : { target: null })),
}));
