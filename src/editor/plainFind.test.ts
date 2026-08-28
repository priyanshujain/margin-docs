// The matching and replacing plainFind.ts does, in isolation from the textarea it drives. Whether
// a query actually reaches the DOM and scrolls something into view is what tests/smoke.spec.ts
// proves; this file is only about the same case sensitivity, whole word and offset rules search.ts
// already has, since the point of sharing buildRegex is that the two never disagree.

import { describe, expect, it } from "vitest";
import {
  EMPTY_PLAIN_SEARCH,
  recomputePlainSearch,
  replaceAllMatches,
  replaceMatch,
  sameQuery,
} from "./plainFind";

const OPTS = { caseSensitive: false, wholeWord: false };

describe("recomputePlainSearch", () => {
  it("finds every occurrence, case insensitively by default", () => {
    const state = recomputePlainSearch("Cat cat CAT scatter", "cat", OPTS, 0);
    expect(state.matches).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 },
      { from: 13, to: 16 },
    ]);
    expect(state.current).toBe(0);
  });

  it("respects case sensitivity when asked", () => {
    const state = recomputePlainSearch("Cat cat CAT", "cat", { caseSensitive: true, wholeWord: false }, 0);
    expect(state.matches).toEqual([{ from: 4, to: 7 }]);
  });

  it("respects whole word", () => {
    const state = recomputePlainSearch("cat scatter cat", "cat", { caseSensitive: false, wholeWord: true }, 0);
    expect(state.matches).toEqual([
      { from: 0, to: 3 },
      { from: 12, to: 15 },
    ]);
  });

  it("clamps a desired current back onto a shorter match list", () => {
    const state = recomputePlainSearch("one", "one", OPTS, 5);
    expect(state.current).toBe(0);
  });

  it("returns the empty state for an empty query", () => {
    expect(recomputePlainSearch("anything", "", OPTS, 0)).toEqual({ ...EMPTY_PLAIN_SEARCH, query: "", options: OPTS });
  });

  it("escapes regex special characters in the query", () => {
    const state = recomputePlainSearch("a.b a.b axb", "a.b", OPTS, 0);
    expect(state.matches).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });
});

describe("sameQuery", () => {
  it("is true only when the query and both options match", () => {
    const state = recomputePlainSearch("abc", "a", OPTS, 0);
    expect(sameQuery(state, "a", OPTS)).toBe(true);
    expect(sameQuery(state, "b", OPTS)).toBe(false);
    expect(sameQuery(state, "a", { caseSensitive: true, wholeWord: false })).toBe(false);
    expect(sameQuery(state, "a", { caseSensitive: false, wholeWord: true })).toBe(false);
  });
});

describe("replaceMatch and replaceAllMatches", () => {
  it("replaces a single match without touching the rest of the string", () => {
    const text = "one two three";
    expect(replaceMatch(text, { from: 4, to: 7 }, "TWO")).toBe("one TWO three");
  });

  it("replaces every match back to front so offsets never shift under it", () => {
    const text = "cat cat cat";
    const matches = recomputePlainSearch(text, "cat", OPTS, 0).matches;
    expect(replaceAllMatches(text, matches, "dog")).toBe("dog dog dog");
  });

  it("replaces correctly even when the replacement is a different length", () => {
    const text = "a-a-a";
    const matches = recomputePlainSearch(text, "a", OPTS, 0).matches;
    expect(replaceAllMatches(text, matches, "bb")).toBe("bb-bb-bb");
  });
});
