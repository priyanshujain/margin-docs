// What the updater is doing, plus the two preferences that sit next to it in the settings panel.
//
// The work itself is in src/update.ts, which is this store's sibling: checking, downloading and
// relaunching all cross the IPC boundary, and the handle `check()` hands back is a resource on the
// Rust side rather than a value, so it cannot be kept here beside the version string it arrived
// with. This file is only what the dialog and the settings panel read.
//
// `lastChecked` and `automatic` are read and written here rather than in a module of their own, the
// same way src/store/useProofing.ts keeps its two settings. Nothing outside this store touches
// either key, and the guard around localStorage is for the Node test environment, which reaches
// this file through src/keys/commands.ts.

import { create } from "zustand";

const CHECKED_KEY = "margindocs-update-checked";
const AUTOMATIC_KEY = "margindocs-update-automatic";

/**
 * "available" is an update the user has been shown and has not answered yet, which is the dialog
 * sitting open. "downloading" and "installing" are the two halves of what one press of Install does,
 * and they are separate because only the first of them has a number to draw.
 *
 * There is no "done": the last thing installing does is relaunch, so the successful end of this
 * union is the process going away.
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** The version on offer, not the one running. Null outside "available" and what follows it. */
  version: string | null;
  /** The release notes, as the release wrote them. Plain text, and shown as plain text. */
  notes: string | null;
  downloaded: number;
  /**
   * What the server said the whole download is, or null when it did not say. A server that sends no
   * content length leaves this null for the entire download, which the dialog draws as a bar with
   * no end rather than as nought percent forever.
   */
  total: number | null;
  error: string | null;
  /** Epoch milliseconds of the last check that actually reached the manifest. */
  lastChecked: number | null;
  automatic: boolean;

  begin: () => void;
  offer: (version: string, notes: string | null) => void;
  progress: (downloaded: number, total: number | null) => void;
  installing: () => void;
  failed: (message: string) => void;
  /** Back to nothing on screen, whether that is Later, Escape or a check that found nothing. */
  dismiss: () => void;
  markChecked: () => void;
  setAutomatic: (automatic: boolean) => void;
}

function readAutomatic(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(AUTOMATIC_KEY) !== "off";
  } catch {
    return true;
  }
}

function readChecked(): number | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CHECKED_KEY);
    if (raw === null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // A webview with storage denied still checks for updates, it just forgets when it last did.
  }
}

export const useUpdate = create<UpdateState>((set) => ({
  phase: "idle",
  version: null,
  notes: null,
  downloaded: 0,
  total: null,
  error: null,
  lastChecked: readChecked(),
  automatic: readAutomatic(),

  begin: () => set({ phase: "checking", error: null }),

  offer: (version, notes) =>
    set({ phase: "available", version, notes, downloaded: 0, total: null, error: null }),

  progress: (downloaded, total) => set({ phase: "downloading", downloaded, total }),

  installing: () => set({ phase: "installing" }),

  failed: (message) => set({ phase: "error", error: message }),

  dismiss: () =>
    set({ phase: "idle", version: null, notes: null, downloaded: 0, total: null, error: null }),

  markChecked: () => {
    const at = Date.now();
    write(CHECKED_KEY, String(at));
    return set({ lastChecked: at });
  },

  setAutomatic: (automatic) =>
    set((s) => {
      if (s.automatic === automatic) return {};
      write(AUTOMATIC_KEY, automatic ? "on" : "off");
      return { automatic };
    }),
}));
