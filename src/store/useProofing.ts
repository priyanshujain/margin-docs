// Proofing, as far as the app outside the editor is concerned: whether the machine has a checker at
// all, whether the user wants underlines, which words they have waved away this session, and which
// underline the menu is currently open over.
//
// Two checkers, one store. Spelling is the system's and grammar is Harper's, they are asked
// separately and can be turned on separately, but they share a decoration pipeline, a popover and
// this state, because from the reader's side they are one underline under one word.
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
import { grammarAvailable } from "../api/grammar";
import { spellAvailable, spellLearn } from "../api/spell";
import { notify } from "./useToast";

const KEY = "margindocs-spelling";
const GRAMMAR_KEY = "margindocs-grammar";

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
  /** What the checker flagged, which is also what "Learn Spelling" and "Ignore" are about. A word
   * for spelling and however much of the sentence Harper was talking about for grammar. */
  word: string;
  /** At most five, already trimmed by the editor. Can be empty: the system often knows a word is
   * wrong without knowing what was meant, and a grammar rule can see a sentence is wrong without
   * knowing how to fix it. */
  suggestions: readonly string[];
  /** Harper's category for the rule that fired and the sentence it wrote about it, and null when
   * this underline is a misspelling. It is what the popover shows above the suggestions, and it is
   * also what decides which items are offered: "Learn Spelling" teaches the Mac's dictionary a word
   * and has nothing to say about a phrase. */
  grammar: { kind: string; message: string } | null;
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
  /** The same question about the other checker, asked once per launch alongside it. Grammar is
   * Harper's and compiled in, so "missing" here means a build without it rather than a machine
   * without it, and it hides the setting rather than offering one that does nothing. */
  grammarAvailability: SpellAvailability;
  enabled: boolean;
  /** Grammar, which is a separate setting because it is a separate checker. A user who wants
   * spelling underlined and grammar left alone is not asking for anything strange. */
  grammar: boolean;
  /** Lower cased, and only for this run of the app. Ignoring is not learning and is not written
   * anywhere: the system checker owns the dictionary, and a word waved away in one sitting is not a
   * word the user has taught their Mac. Grammar shares the set and puts whole phrases in it, which
   * cannot collide with a word: nothing the spell checker flags has a space in it. */
  ignored: ReadonlySet<string>;
  revision: number;
  target: ProofTarget | null;

  ensureAvailable: () => void;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
  setGrammar: (enabled: boolean) => void;
  toggleGrammar: () => void;
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
function readSetting(key: string): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function writeSetting(key: string, enabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, enabled ? "on" : "off");
  } catch {
    // A webview with storage denied still spell checks, it just forgets between launches.
  }
}

export const useProofing = create<ProofingState>((set, get) => ({
  availability: "unknown",
  grammarAvailability: "unknown",
  enabled: readSetting(KEY),
  grammar: readSetting(GRAMMAR_KEY),
  ignored: new Set<string>(),
  revision: 0,
  target: null,

  // Both checkers, each guarded on its own answer rather than on the pair. They are asked together
  // today, so one guard would do; a guard that reads the wrong field is how the second checker ends
  // up stuck on "unknown" the first time somebody asks them apart.
  ensureAvailable: () => {
    if (get().availability === "unknown") {
      set({ availability: "asking" });
      spellAvailable()
        .then((ok) => set({ availability: ok ? "ready" : "missing" }))
        .catch(() => set({ availability: "missing" }));
    }
    if (get().grammarAvailability === "unknown") {
      set({ grammarAvailability: "asking" });
      grammarAvailable()
        .then((ok) => set({ grammarAvailability: ok ? "ready" : "missing" }))
        .catch(() => set({ grammarAvailability: "missing" }));
    }
  },

  setEnabled: (enabled) =>
    set((s) => {
      if (s.enabled === enabled) return {};
      writeSetting(KEY, enabled);
      return { enabled, target: null };
    }),

  toggle: () => get().setEnabled(!get().enabled),

  setGrammar: (enabled) =>
    set((s) => {
      if (s.grammar === enabled) return {};
      writeSetting(GRAMMAR_KEY, enabled);
      return { grammar: enabled, target: null };
    }),

  toggleGrammar: () => get().setGrammar(!get().grammar),

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
