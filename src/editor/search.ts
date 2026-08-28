// Find and replace inside the open document, as decorations rather than as marks: a highlight is
// something the view draws, not something the file remembers. Nothing in this module can reach the
// document's content, so a search can never dirty a buffer or change what a save would write.
//
// Ported from margin's editor/search.ts. The only change of substance is the name of the last
// command: margin replaces across a chapter because a chapter is the unit it has, and here the
// unit is the whole document.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchState {
  query: string;
  options: SearchOptions;
  matches: SearchMatch[];
  current: number;
  decorations: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>("search");

const EMPTY: SearchState = {
  query: "",
  options: { caseSensitive: false, wholeWord: false },
  matches: [],
  current: 0,
  decorations: DecorationSet.empty,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let pattern = escapeRegExp(query);
  if (options.wholeWord) pattern = `\\b${pattern}\\b`;
  try {
    return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

export function findMatches(doc: PMNode, regex: RegExp): SearchMatch[] {
  const matches: SearchMatch[] = [];
  let runText = "";
  let runStart = 0;
  const flush = () => {
    if (!runText) return;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(runText)) !== null) {
      const from = runStart + m.index;
      matches.push({ from, to: from + m[0].length });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    runText = "";
  };
  doc.descendants((node, pos) => {
    if (node.isText) {
      if (!runText) runStart = pos;
      runText += node.text ?? "";
    } else {
      flush();
    }
    return true;
  });
  flush();
  return matches;
}

function buildDecorations(doc: PMNode, matches: SearchMatch[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? "search-match search-match-current" : "search-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

function recompute(
  doc: PMNode,
  query: string,
  options: SearchOptions,
  desiredCurrent: number,
): SearchState {
  const regex = buildRegex(query, options);
  if (!regex) return { ...EMPTY, query, options };
  const matches = findMatches(doc, regex);
  const current = matches.length ? Math.max(0, Math.min(desiredCurrent, matches.length - 1)) : 0;
  return { query, options, matches, current, decorations: buildDecorations(doc, matches, current) };
}

function scrollMatchIntoView(view: EditorView, match: SearchMatch): void {
  const { node } = view.domAtPos(match.from);
  const el = node.nodeType === Node.TEXT_NODE ? (node as Text).parentElement : (node as HTMLElement);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** What a find bar reads to say "3 of 12". */
export function searchStateOf(state: EditorState): SearchState | null {
  return searchKey.getState(state) ?? null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    search: {
      setSearch: (query: string, options: SearchOptions) => ReturnType;
      clearSearch: () => ReturnType;
      findNext: () => ReturnType;
      findPrev: () => ReturnType;
      goToMatch: (index: number) => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAllInDocument: (replacement: string) => ReturnType;
    };
  }
}

export const SearchHighlight = Extension.create({
  name: "searchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => EMPTY,
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(searchKey) as
              | { type: "search"; query: string; options: SearchOptions }
              | { type: "nav"; current: number }
              | { type: "clear" }
              | undefined;
            if (meta?.type === "search") {
              // Asking again for the search that is already running is a no-op rather than a
              // reset. A find bar re-issues its query whenever anything about it re-renders, and
              // recomputing from zero there would drag the user back to the first match every
              // time they stepped to the next one.
              if (
                meta.query === value.query &&
                meta.options.caseSensitive === value.options.caseSensitive &&
                meta.options.wholeWord === value.options.wholeWord
              ) {
                return value;
              }
              return recompute(newState.doc, meta.query, meta.options, 0);
            }
            if (meta?.type === "nav" && value.matches.length) {
              const current =
                ((meta.current % value.matches.length) + value.matches.length) %
                value.matches.length;
              return {
                ...value,
                current,
                decorations: buildDecorations(newState.doc, value.matches, current),
              };
            }
            if (meta?.type === "clear") {
              return { ...EMPTY };
            }
            if (tr.docChanged && value.query) {
              return recompute(newState.doc, value.query, value.options, value.current);
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return searchKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSearch:
        (query, options) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { type: "search", query, options }));
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { type: "clear" }));
          return true;
        },
      findNext:
        () =>
        ({ state, dispatch, view, tr }) => {
          const s = searchKey.getState(state);
          if (!s || !s.matches.length) return false;
          const current = (s.current + 1) % s.matches.length;
          if (dispatch) dispatch(tr.setMeta(searchKey, { type: "nav", current }));
          scrollMatchIntoView(view, s.matches[current]);
          return true;
        },
      findPrev:
        () =>
        ({ state, dispatch, view, tr }) => {
          const s = searchKey.getState(state);
          if (!s || !s.matches.length) return false;
          const current = (s.current - 1 + s.matches.length) % s.matches.length;
          if (dispatch) dispatch(tr.setMeta(searchKey, { type: "nav", current }));
          scrollMatchIntoView(view, s.matches[current]);
          return true;
        },
      goToMatch:
        (index) =>
        ({ state, dispatch, view, tr }) => {
          const s = searchKey.getState(state);
          if (!s || !s.matches.length) return false;
          const current = ((index % s.matches.length) + s.matches.length) % s.matches.length;
          if (dispatch) dispatch(tr.setMeta(searchKey, { type: "nav", current }));
          scrollMatchIntoView(view, s.matches[current]);
          return true;
        },
      replaceCurrent:
        (replacement) =>
        ({ state, dispatch, view, tr }) => {
          const s = searchKey.getState(state);
          if (!s || !s.matches.length) return false;
          const m = s.matches[s.current];
          if (dispatch) {
            tr.insertText(replacement, m.from, m.to);
            dispatch(tr);
            const ns = searchKey.getState(view.state);
            if (ns && ns.matches.length) scrollMatchIntoView(view, ns.matches[ns.current]);
          }
          return true;
        },
      replaceAllInDocument:
        (replacement) =>
        ({ state, dispatch, tr }) => {
          const s = searchKey.getState(state);
          if (!s || !s.matches.length) return false;
          if (dispatch) {
            for (let i = s.matches.length - 1; i >= 0; i--) {
              const m = s.matches[i];
              tr.insertText(replacement, m.from, m.to);
            }
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
