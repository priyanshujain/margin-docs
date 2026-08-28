// The IPC contract. Every type here mirrors a struct in src-tauri/src/dto.rs. Both sides are
// frozen once written: implementation modules add bodies, not fields.
//
// Typed per-command wrappers live in src/api/, grouped by domain.

import { invoke } from "@tauri-apps/api/core";

/** A Tauri build of any shape, phone included. There is a Rust backend behind this. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const isMobileOs =
  typeof navigator !== "undefined" &&
  (/android|iphone|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac and gives itself away only by having a touchscreen.
    (/ipad|macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/**
 * A Tauri build with a real window behind it: something to drag by its title bar, a maximize to
 * toggle, a close to intercept before it happens.
 *
 * The difference from `isTauri` is not cosmetic and this is not "am I in the app". `core:window:*`
 * sits in the desktop-only capability, so on a phone those commands are not no-ops, they are
 * refused, and calling one is a rejected IPC command rather than nothing happening.
 */
export const isDesktop = isTauri && !isMobileOs;

/**
 * The one window whose title bar has the traffic lights inside the page. `titleBarStyle: "Overlay"`
 * in tauri.conf.json is a macOS-only setting, so on Linux, Windows and every mobile build the
 * header has nothing to leave room for.
 */
export const isMacDesktop =
  isDesktop && typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

/**
 * True when there is a backend to answer a command: Tauri, or the dev fixture in a browser.
 * Data-loading actions gate on this. Anything touching a window API must gate on `isDesktop`
 * instead, and anything listening for a Tauri event on `isTauri`, because a phone emits those too.
 */
export const live = (): boolean => isTauri || import.meta.env.DEV;

/** The `menu-action` event, whose payload is one of these ids. Mirrors the ids built in lib.rs. */
export const MENU_ACTION_EVENT = "menu-action";

/** The `watch-event` event, whose payload is a `WatchEvent`. */
export const WATCH_EVENT = "watch-event";

/** The `index-progress` event, whose payload is an `IndexStatus`. */
export const INDEX_PROGRESS_EVENT = "index-progress";

/** The `pdf-warnings` event, whose payload is a `PdfWarning[]`. */
export const PDF_WARNINGS_EVENT = "pdf-warnings";

export type MenuAction =
  | "open-folder"
  | "new-doc"
  | "new-folder"
  | "save"
  | "close-folder"
  | "settings"
  | "find"
  | "find-in-files"
  | "quick-open"
  | "command-palette"
  | "toggle-sidebar"
  | "check-updates"
  | "report-issue"
  | "export-pdf"
  | "writing-proofread"
  | "writing-rewrite";

/**
 * One open folder. `id` is derived from the path, so it survives a relaunch and a root can be
 * addressed without carrying the path around.
 */
export interface RootInfo {
  id: string;
  path: string;
  /** The folder's own name, which is what the sidebar heading shows. */
  name: string;
  openedMs: number;
}

export type FileKind = "dir" | "markdown" | "text" | "other";

/**
 * A node in one root's tree, including the root itself. The whole tree is read in one go, so
 * `children` being empty means a directory is empty, never that it is unexplored.
 */
export interface FileNode {
  path: string;
  name: string;
  kind: FileKind;
  /**
   * True for markdown and .txt, the two kinds that open in the editor. A directory is not editable
   * either, so the greyed row in the tree is `kind === "other"` and not `!editable`. A greyed row
   * opens in the system default app.
   */
  editable: boolean;
  modifiedMs: number;
  children: FileNode[];
}

/**
 * `modifiedMs` is the timestamp the text was read at. Keep it and hand it back on write: it is
 * the only way to tell an unsaved buffer apart from a file something else has touched since.
 * Frontmatter is not split out here, because the editor parses it, hides it and writes it back.
 */
export interface ReadResult {
  path: string;
  text: string;
  modifiedMs: number;
}

export interface WriteResult {
  path: string;
  modifiedMs: number;
  /**
   * The file moved on from the timestamp the caller expected and nothing was written. Not an
   * error: the document is still open and still unsaved, and the user has to be asked which copy
   * wins.
   */
  conflict: boolean;
}

/**
 * Where a pasted image landed. `relPath` is what goes into the markdown link, relative to the
 * document that received the paste; `path` is absolute, which is what the tree needs.
 */
export interface AssetResult {
  path: string;
  relPath: string;
}

/** Payload of `watch-event`. `root` is a `RootInfo` id. */
export interface WatchEvent {
  root: string;
  path: string;
  kind: "created" | "modified" | "removed" | "renamed";
  /** Where the file was before a rename, null on every other kind. */
  oldPath: string | null;
}

/**
 * Progress of the SQLite index, which lives in the app data directory and never in a user folder.
 */
export interface IndexStatus {
  phase: "idle" | "indexing" | "error";
  indexed: number;
  total: number;
  /** Epoch milliseconds of the last completed pass. */
  lastIndexed: number | null;
  error: string | null;
  message: string | null;
}

/** Payload of `index-progress`. */
export type IndexProgress = IndexStatus;

/**
 * Half-open offsets into whichever string the hit says they belong to, for highlighting.
 *
 * The unit is a UTF-16 code unit, so these index a JavaScript string directly and `slice` is the
 * whole of drawing a highlight. The Rust side works in code points and converts once on the way
 * out, because the two agree everywhere in the BMP and part company by one per emoji.
 *
 * `SpellIssue` is in code points instead, and that is not an inconsistency: its offsets address a
 * ProseMirror document, which counts code points, and this one addresses a string.
 */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * One quick-open result. `ranges` index into `relPath`, which is also what the row shows, so a
 * match on a folder name can be highlighted where it actually was.
 */
export interface QuickOpenHit {
  path: string;
  name: string;
  root: string;
  relPath: string;
  score: number;
  ranges: MatchRange[];
}

/**
 * One full text result. `line` is one-based and counted over the file as it sits on disk,
 * frontmatter included, so jumping to it lands in the right place. `ranges` index into `snippet`.
 */
export interface SearchHit {
  path: string;
  root: string;
  title: string;
  line: number;
  snippet: string;
  ranges: MatchRange[];
}

/**
 * A document that links here, shown at the end of the document it points at. Links between
 * documents are relative markdown links, so a backlink is a resolved `](../thing.md)` and nothing
 * more.
 */
export interface Backlink {
  path: string;
  title: string;
  snippet: string;
}

/**
 * One misspelling in a run of text handed to the checker.
 *
 * `start` and `end` are half-open offsets in characters, which is what ProseMirror counts in, so a
 * range can be turned into a decoration without any conversion on this side. The Rust side is the
 * only place that knows AppKit answers in UTF-16.
 *
 * `suggestions` can be empty. The system checker often knows a word is wrong without knowing what
 * was meant, and an issue with no menu is still an issue worth underlining.
 */
export interface SpellIssue {
  start: number;
  end: number;
  word: string;
  suggestions: string[];
}

/**
 * An image the PDF exporter has to put on a page.
 *
 * `data` present means the bytes travel with the request, base64 encoded, which is the only way a
 * mermaid diagram can arrive: it is rendered to SVG here and there is no file behind it. `data`
 * absent means the backend reads the file at `path` itself, which is what an ordinary
 * `![](photo.jpg)` is and what most images are, because base64 encoding a folder of photographs
 * through the IPC boundary costs a third again in bytes for files the backend can already open.
 *
 * A path read this way is checked against the open roots on the Rust side, because a link in a
 * document is untrusted input.
 */
export interface ImageInput {
  /** How the Typst source refers to it, which is also the key the file resolver answers on. */
  path: string;
  data: string | null;
}

/**
 * Something the exporter worked around rather than something it refused to do. Payload of
 * `pdf-warnings`, which is how these travel: a compile answers with raw bytes and has nowhere to
 * put a second value.
 *
 * `count` is here because the alternative is forty toasts. A document with forty formulas that
 * would not typeset has one problem, not forty.
 */
export interface PdfWarning {
  kind: "math" | "image" | "typst";
  message: string;
  count: number;
}

/**
 * One grammar problem in a run of text handed to the checker.
 *
 * `start` and `end` are half-open offsets in characters, for the same reason `SpellIssue` gives:
 * they address a ProseMirror document and ProseMirror counts code points. Harper counts that way
 * too, so this path has no conversion in it at all.
 *
 * `kind` is Harper's own name for the rule that fired, which the popover shows above the message
 * so a correction can be judged before it is taken. `suggestions` can be empty.
 */
export interface GrammarIssue {
  start: number;
  end: number;
  kind: string;
  message: string;
  suggestions: string[];
}

/**
 * In Tauri this is `invoke`. Opened in a browser during development it is served from the dev
 * fixture instead, so the real UI can be driven and looked at without a build of the Rust side
 * and without touching anybody's documents. The branch is compiled out of a production bundle,
 * and `isTauri` means it can never shadow the real backend inside the app.
 */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV && !isTauri) {
    return import("./dev/mockIpc").then((m) => m.mockCall<T>(command, args));
  }
  return invoke<T>(command, args);
}
