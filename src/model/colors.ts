// The two colour palettes, and the one shape a colour is ever written in.
//
// The set is closed and there is no free picker, which is the same decision the callout kinds and
// the fence languages already made: a value the user can type is a value the file can hold and the
// editor cannot draw, and eight of each is enough for what colour is actually for, which is telling
// three or four things in a document apart from one another.
//
// Every hex here is a literal and the same literal in both themes, because it is written into the
// user's file and a file does not have a theme. That rules out the obvious palette. A pale
// highlighter yellow is unreadable under the dark theme's ink, and a deep ink blue disappears into
// the dark theme's paper, so both rows sit in the middle instead: a text colour is near enough the
// luminance where its contrast against #fcfbf7 and against #1d1a16 is the same number, which is
// about 4:1 either way and is the most a single value can carry, and a highlight is at the matching
// point between the two inks that sit on it, which is about 3.9:1 on paper and 3.3:1 in the dark.
// Lifting either row towards the colour it "should" be costs the other theme more than it buys.

export interface DocumentColor {
  /** What the swatch's tooltip says. One word: the popover is two rows of nine in a 632px pill. */
  label: string;
  /** Lower case, six digits. Exactly the spelling src/markdown writes and reads back. */
  hex: string;
}

/** Colour for the text itself, written `<span style="color: #rrggbb">`. */
export const TEXT_COLORS: readonly DocumentColor[] = [
  { label: "Red", hex: "#c4453a" },
  { label: "Orange", hex: "#b8622a" },
  { label: "Amber", hex: "#9a7b1e" },
  { label: "Green", hex: "#4f8b45" },
  { label: "Teal", hex: "#2f8a83" },
  { label: "Blue", hex: "#4079c0" },
  { label: "Violet", hex: "#8a68c6" },
  { label: "Magenta", hex: "#bb4f8e" },
];

/** Colour behind the text, written `<mark style="background-color: #rrggbb">`. */
export const HIGHLIGHT_COLORS: readonly DocumentColor[] = [
  { label: "Amber", hex: "#977927" },
  { label: "Ochre", hex: "#ad6f36" },
  { label: "Rose", hex: "#bf625d" },
  { label: "Moss", hex: "#5d8844" },
  { label: "Teal", hex: "#3a8982" },
  { label: "Blue", hex: "#5580b2" },
  { label: "Violet", hex: "#886fc2" },
  { label: "Plum", hex: "#ab688d" },
];

/**
 * The only colour this app writes, reads or renders: a hash, six lower case hex digits, nothing
 * else.
 *
 * Deliberately not a check that the value is in one of the two lists above. The palette is this
 * release's opinion and can grow; the spelling is the promise the round trip is made of, and a file
 * carrying a colour a later version of this app added has to keep working here rather than losing
 * it. What is refused is a colour with no spelling at all, `red`, `#ABC`, `rgb(1,2,3)`, because
 * writing one of those into the file would produce bytes this reader hands back as something else.
 */
const COLOR_HEX = /^#[0-9a-f]{6}$/;

export function isDocumentColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_HEX.test(value);
}
