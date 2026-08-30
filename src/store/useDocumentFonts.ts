// What the open document is set in, remembered per file.
//
// Per file and not per app, which is the whole point of the feature: a set of meeting notes and a
// short story are not the same kind of page, and a preference that applies to both is the one the
// app already made in src/styles/tokens.css. The model is Google Docs', where the face belongs to
// the document rather than to the editor.
//
// Where it is kept, and why it is not the file
// --------------------------------------------
// A path to a `DocumentFonts`, in localStorage, beside the theme and the width. The obvious other
// home is the document's own frontmatter, and it is deliberately not used: src/model/doc.ts holds
// frontmatter as an opaque string precisely so that the app never re-emits somebody's YAML, and
// writing a key into it would mean parsing and re-serialising the one part of the file this editor
// promises not to touch. A font is also not content. `margin-docs-fonts: literata` committed into a
// repository is a line every other markdown tool has to ignore, and a diff on every document whose
// author tried a face and changed their mind.
//
// The cost is honest and worth stating: this is a preference on this machine, so the same file
// opened on another one, or after the app's storage is cleared, opens in the default pair. Nothing
// is lost when that happens, because a font is not text.
//
// A renamed or moved file loses its entry, for the same reason: the key is the path, and the app
// has no identity for a document other than where it lives.

import { create } from "zustand";
import {
  DEFAULT_FONTS,
  fontStack,
  fontsEqual,
  isFontRef,
  type DocumentFonts,
  type FontRef,
} from "../model/fonts";

const KEY = "margindocs-fonts";

/**
 * How many documents are remembered, most recently set first.
 *
 * A cap because this is a map that only ever grows: every document somebody tries a face on stays
 * in it forever otherwise, and localStorage is a few megabytes shared with everything else the app
 * keeps. Two hundred is far past the number of documents anybody sets a font on by hand, and the
 * entry that falls off the end is the one nobody has touched in the longest time.
 */
const LIMIT = 200;

type Stored = Record<string, DocumentFonts>;

/**
 * The map as it sits on disk, or an empty one.
 *
 * Guarded for the Node test environment and for a webview with storage denied, the same way
 * src/store/useProofing.ts guards its two booleans. Anything that is not a pair of `FontRef`s is
 * dropped rather than repaired: a preference written by a version that named its faces differently
 * is not worth guessing at, and the default pair is always a correct answer.
 */
function read(): Stored {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Stored = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { body, heading } = value as { body?: unknown; heading?: unknown };
      if (isFontRef(body) && isFontRef(heading)) out[path] = { body, heading };
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: Stored): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // A webview with storage denied still changes the face, it just forgets between launches.
  }
}

/**
 * Writes the two custom properties src/styles/prose.css sets the page from, and nothing else.
 *
 * The default pair removes them rather than restating the tokens.css values, so there is one place
 * that decides what an unset document looks like. Same shape as src/width.ts and src/theme.ts: a
 * setting is an attribute or a property on the root element, never a length or a family written
 * into a component.
 */
function apply(fonts: DocumentFonts): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (fontsEqual(fonts, DEFAULT_FONTS)) {
    root.style.removeProperty("--font-book");
    root.style.removeProperty("--font-heading");
    return;
  }
  root.style.setProperty("--font-book", fontStack(fonts.body));
  root.style.setProperty("--font-heading", fontStack(fonts.heading));
}

interface DocumentFontsState {
  /** What the open document is set in, or the default pair when nothing is open. */
  fonts: DocumentFonts;
  /** Which file `fonts` is about, so a write cannot land on the document that has since replaced
   * it. Null between a close and the next open. */
  path: string | null;

  /** Called when the open document changes, including to nothing. Applies what was remembered. */
  openFor: (path: string | null) => void;
  setFonts: (fonts: DocumentFonts) => void;
  setSlot: (slot: "body" | "heading", ref: FontRef) => void;
  reset: () => void;
}

export const useDocumentFonts = create<DocumentFontsState>((set, get) => ({
  fonts: DEFAULT_FONTS,
  path: null,

  openFor: (path) => {
    const fonts = path === null ? DEFAULT_FONTS : (read()[path] ?? DEFAULT_FONTS);
    apply(fonts);
    set({ fonts, path });
  },

  // Applied before it is stored, because the face on screen is the thing the user asked for and
  // storage is the part that is allowed to fail.
  setFonts: (fonts) => {
    const { path } = get();
    apply(fonts);
    set({ fonts });
    if (path === null) return;

    const map = read();
    // Reinserted rather than assigned in place, so the key order is least-recently-set first and
    // the trim below drops the right entries. A document set back to the default is removed
    // instead of stored: an entry that says "what everything else already says" is only there to
    // be evicted later.
    delete map[path];
    if (!fontsEqual(fonts, DEFAULT_FONTS)) map[path] = fonts;

    const paths = Object.keys(map);
    for (const stale of paths.slice(0, Math.max(0, paths.length - LIMIT))) delete map[stale];
    write(map);
  },

  setSlot: (slot, ref) => get().setFonts({ ...get().fonts, [slot]: ref }),

  reset: () => get().setFonts(DEFAULT_FONTS),
}));
