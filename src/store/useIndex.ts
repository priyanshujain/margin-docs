// The SQLite index's own status: whether it is being built and how far it has gotten. The index
// itself lives in Rust (see docs/architecture.md); this store only ever reflects it, driven by the
// `index-progress` event that src/workspace.ts subscribes to and by the status a rebuild returns.

import { create } from "zustand";
import { indexRebuild } from "../api";
import type { IndexStatus } from "../ipc";

export type IndexPhase = "idle" | "indexing" | "ready" | "error";

interface IndexState {
  phase: IndexPhase;
  filesIndexed: number;
  total: number;
  error: string | null;

  start: () => Promise<void>;
  applyProgress: (filesIndexed: number, total: number) => void;
  reset: () => void;
}

export const useIndex = create<IndexState>((set) => ({
  phase: "idle",
  filesIndexed: 0,
  total: 0,
  error: null,

  start: async () => {
    set({ phase: "indexing", error: null });
    try {
      applyIndexStatus(await indexRebuild());
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  },
  applyProgress: (filesIndexed, total) => set({ phase: "indexing", filesIndexed, total }),
  reset: () => set({ phase: "idle", filesIndexed: 0, total: 0, error: null }),
}));

/**
 * Reflects one `IndexStatus`, whether it arrived on the event or as a command's return value.
 *
 * The DTO has no "ready": a finished pass is `idle` with a `lastIndexed`, and an index that has
 * never run is `idle` without one. The store keeps them apart because the two say different things
 * to a search box that just came back empty.
 */
export function applyIndexStatus(status: IndexStatus): void {
  const phase: IndexPhase =
    status.phase === "indexing"
      ? "indexing"
      : status.phase === "error"
        ? "error"
        : status.lastIndexed === null
          ? "idle"
          : "ready";
  useIndex.setState({
    phase,
    filesIndexed: status.indexed,
    total: status.total,
    error: status.error,
  });
}
