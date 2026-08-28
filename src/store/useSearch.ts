// Two independent searches sharing one store: quick open by filename and path (Cmd+P) and full
// text across every open root (Cmd+Shift+F). Both read the SQLite index in Rust through
// src/api/index.ts (see docs/architecture.md); the query setters are plain local state.

import { create } from "zustand";
import { searchQuickOpen, searchText } from "../api";
import type { MatchRange } from "../ipc";
import { useWorkspace } from "./useWorkspace";

export type QuickOpenPhase = "idle" | "loading" | "error";
export type FullTextPhase = "idle" | "loading" | "error";

/** A palette shows about a dozen rows; asking for more only makes the index work harder. */
const QUICK_OPEN_LIMIT = 30;
const FULL_TEXT_LIMIT = 200;

/**
 * Typing outruns the index. A response is applied only if nothing newer has been asked for since,
 * so a slow answer to `re` never lands on top of a fast answer to `readme`.
 */
let quickOpenSeq = 0;
let fullTextSeq = 0;

export interface QuickOpenHit {
  path: string;
  name: string;
  rootPath: string;
  /** The path relative to its root, which is the string the row shows. */
  relPath: string;
  /** Half-open character offsets into `relPath`, for highlighting. */
  ranges: MatchRange[];
}

export interface FullTextHit {
  path: string;
  /** The document's title, from its first heading or its filename, as the index recorded it. */
  title: string;
  line: number;
  excerpt: string;
  /** Half-open character offsets into `excerpt`, for highlighting. */
  ranges: MatchRange[];
}

interface SearchState {
  quickOpenQuery: string;
  quickOpenHits: QuickOpenHit[];
  quickOpenPhase: QuickOpenPhase;
  quickOpenError: string | null;

  fullTextQuery: string;
  fullTextHits: FullTextHit[];
  fullTextPhase: FullTextPhase;
  fullTextError: string | null;

  setQuickOpenQuery: (query: string) => void;
  runQuickOpen: (query: string) => Promise<void>;
  setFullTextQuery: (query: string) => void;
  runFullText: (query: string) => Promise<void>;
  reset: () => void;
}

const rootPathFor = (rootId: string): string =>
  useWorkspace.getState().roots.find((r) => r.id === rootId)?.path ?? "";

export const useSearch = create<SearchState>((set) => ({
  quickOpenQuery: "",
  quickOpenHits: [],
  quickOpenPhase: "idle",
  quickOpenError: null,

  fullTextQuery: "",
  fullTextHits: [],
  fullTextPhase: "idle",
  fullTextError: null,

  setQuickOpenQuery: (query) => set({ quickOpenQuery: query }),
  runQuickOpen: async (query) => {
    const seq = (quickOpenSeq += 1);
    if (query.trim() === "") {
      set({ quickOpenHits: [], quickOpenPhase: "idle", quickOpenError: null });
      return;
    }
    set({ quickOpenPhase: "loading", quickOpenError: null });
    try {
      const hits = await searchQuickOpen(query, QUICK_OPEN_LIMIT);
      if (seq !== quickOpenSeq) return;
      set({
        quickOpenHits: hits.map((hit) => ({
          path: hit.path,
          name: hit.name,
          rootPath: rootPathFor(hit.root),
          relPath: hit.relPath,
          ranges: hit.ranges,
        })),
        quickOpenPhase: "idle",
      });
    } catch (e) {
      if (seq !== quickOpenSeq) return;
      set({ quickOpenPhase: "error", quickOpenError: String(e), quickOpenHits: [] });
    }
  },
  setFullTextQuery: (query) => set({ fullTextQuery: query }),
  runFullText: async (query) => {
    const seq = (fullTextSeq += 1);
    if (query.trim() === "") {
      set({ fullTextHits: [], fullTextPhase: "idle", fullTextError: null });
      return;
    }
    set({ fullTextPhase: "loading", fullTextError: null });
    try {
      const hits = await searchText(query, FULL_TEXT_LIMIT);
      if (seq !== fullTextSeq) return;
      set({
        fullTextHits: hits.map((hit) => ({
          path: hit.path,
          title: hit.title,
          line: hit.line,
          excerpt: hit.snippet,
          ranges: hit.ranges,
        })),
        fullTextPhase: "idle",
      });
    } catch (e) {
      if (seq !== fullTextSeq) return;
      set({ fullTextPhase: "error", fullTextError: String(e), fullTextHits: [] });
    }
  },
  reset: () => {
    quickOpenSeq += 1;
    fullTextSeq += 1;
    set({
      quickOpenQuery: "",
      quickOpenHits: [],
      quickOpenPhase: "idle",
      quickOpenError: null,
      fullTextQuery: "",
      fullTextHits: [],
      fullTextPhase: "idle",
      fullTextError: null,
    });
  },
}));
