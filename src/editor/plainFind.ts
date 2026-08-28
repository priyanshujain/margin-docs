// Find and replace over a plain string, for the .txt surface, kept in exactly the shape
// src/editor/search.ts keeps it for markdown: a query, a set of matches and a current index. The
// difference is where that state lives. A ProseMirror document carries it in a plugin, dispatched
// through transactions; a textarea has no plugin to carry anything, so PlainTextEditor.tsx keeps
// one of these in a ref and calls the functions below to move it forward.
//
// `buildRegex` is imported rather than reimplemented, which is the whole point: case sensitivity,
// whole word and the characters that get escaped are one rule, asked for twice, not two rules that
// could drift apart the day one of them changes.

import { buildRegex, type SearchMatch, type SearchOptions } from "./search";

export type { SearchMatch, SearchOptions };

export interface PlainSearchState {
  query: string;
  options: SearchOptions;
  matches: SearchMatch[];
  /** Zero based, into `matches`. */
  current: number;
}

export const EMPTY_PLAIN_SEARCH: PlainSearchState = {
  query: "",
  options: { caseSensitive: false, wholeWord: false },
  matches: [],
  current: 0,
};

function matchesOf(text: string, regex: RegExp): SearchMatch[] {
  const matches: SearchMatch[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    matches.push({ from: m.index, to: m.index + m[0].length });
    if (m.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return matches;
}

/**
 * A fresh state for a query, the same way search.ts's own `recompute` builds one: `desiredCurrent`
 * survives when it still lands on a match and is clamped back onto the list otherwise, which is
 * what keeps a still-running search where it was after the text it is searching changes under it.
 */
export function recomputePlainSearch(
  text: string,
  query: string,
  options: SearchOptions,
  desiredCurrent: number,
): PlainSearchState {
  const regex = buildRegex(query, options);
  if (!regex) return { ...EMPTY_PLAIN_SEARCH, query, options };
  const matches = matchesOf(text, regex);
  const current = matches.length ? Math.max(0, Math.min(desiredCurrent, matches.length - 1)) : 0;
  return { query, options, matches, current };
}

/**
 * Whether a query and its options are the same search already running. A find bar re-issues its
 * query on every render, and treating that as a new search would reset `current` to the first
 * match on every keystroke of navigation rather than only on an actual change of query.
 */
export function sameQuery(state: PlainSearchState, query: string, options: SearchOptions): boolean {
  return (
    state.query === query &&
    state.options.caseSensitive === options.caseSensitive &&
    state.options.wholeWord === options.wholeWord
  );
}

/** One match, replaced. Safe to call with the match's original offsets only when nothing else has
 * touched the string yet. */
export function replaceMatch(text: string, match: SearchMatch, replacement: string): string {
  return text.slice(0, match.from) + replacement + text.slice(match.to);
}

/** Every match, replaced back to front so an earlier match's offsets are never invalidated by a
 * later replacement changing the length of the string ahead of it. */
export function replaceAllMatches(
  text: string,
  matches: readonly SearchMatch[],
  replacement: string,
): string {
  let result = text;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    result = replaceMatch(result, matches[i], replacement);
  }
  return result;
}
