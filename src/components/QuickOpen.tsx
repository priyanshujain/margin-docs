// Cmd+P: every file the index knows about, across every open root, matched against the path it
// sits at relative to that root.
//
// The query lives in the store rather than here because the store is also what asks SQLite, and the
// two have to be able to disagree for a moment: the field shows the letter that was just typed
// while the index is still answering the word before it. What sits in between is the debounce
// below, so a typist crosses the IPC boundary once for a word rather than once for a letter.
//
// A slow answer landing after a fast one is already handled on the other side of that boundary, by
// the sequence number in src/store/useSearch.ts, and this file deliberately does not grow a second
// guard for the same race: two of them would have to agree forever, and the day they stopped the
// symptom would be a row from a query nobody can see any more.
//
// An empty field is not an empty palette. Cmd+P with nothing typed offers the documents this
// session has already been in, which is the other half of what people reach for the key for.

import { useEffect, useState } from "react";
import { useEscapeLayer } from "../escape";
import type { MatchRange } from "../ipc";
import { onCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { useDocument } from "../store/useDocument";
import { useIndex } from "../store/useIndex";
import { useSearch } from "../store/useSearch";
import { notify } from "../store/useToast";
import { useWorkspace, type WorkspaceRoot } from "../store/useWorkspace";
import { Palette, highlight, type PaletteRow, type PaletteStatus } from "./Palette";

/** Long enough that a word is one query rather than five, short enough that the pause between two
 * words already has an answer waiting in it. */
const DEBOUNCE_MS = 90;

/** How many already-visited documents an empty field offers before it stops being a shortlist. */
const RECENT_LIMIT = 8;

interface FileRow extends PaletteRow {
  path: string;
  name: string;
  /** The path relative to its root, whole, because that is the string the index counted its match
   * offsets against and a trimmed version of it would highlight the wrong characters. */
  where: string;
  ranges: readonly MatchRange[];
  /** The root's own name, or empty. Filled in only when more than one folder is open and the
   * relative path alone would be ambiguous between them, and empty for a root that was closed
   * while its answer was still in flight. */
  root: string;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

function relativeTo(path: string, roots: readonly WorkspaceRoot[]): string {
  for (const root of roots) {
    if (path.startsWith(`${root.path}/`)) return path.slice(root.path.length + 1);
  }
  return path;
}

export function QuickOpen() {
  const [open, setOpen] = useState(false);

  const query = useSearch((s) => s.quickOpenQuery);
  const setQuery = useSearch((s) => s.setQuickOpenQuery);
  const runQuickOpen = useSearch((s) => s.runQuickOpen);
  const hits = useSearch((s) => s.quickOpenHits);
  const phase = useSearch((s) => s.quickOpenPhase);
  const error = useSearch((s) => s.quickOpenError);
  const indexPhase = useIndex((s) => s.phase);
  const roots = useWorkspace((s) => s.roots);
  const select = useWorkspace((s) => s.select);
  const history = useDocument((s) => s.history);
  const openPath = useDocument((s) => s.path);
  const openDocument = useDocument((s) => s.open);

  useEffect(
    () =>
      onCommand("quick-open", () => {
        // The field starts empty every time and last time's rows go with it. `runQuickOpen("")` is
        // what clears them, and going through the store rather than reaching for the array directly
        // is also what bumps its sequence number, so an answer to the query this palette was closed
        // on cannot arrive inside the one it was just opened for.
        setQuery("");
        void runQuickOpen("");
        setOpen(true);
      }),
    [setQuery, runQuickOpen],
  );

  useEscapeLayer(open, () => setOpen(false));
  useKeyContext("overlay", open);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void runQuickOpen(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, runQuickOpen]);

  if (!open) return null;

  const choose = (path: string) => {
    // Selected as well as opened, so the tree, and every command that acts on the selection, agree
    // with the document that is now on screen. Opening a file from here and renaming it with the
    // next key otherwise renames whatever was last clicked in the sidebar.
    select(path);
    openDocument(path).catch((e) => notify(`Could not open: ${String(e)}`));
  };

  const searching = query.trim() !== "";

  const recent = () => {
    const seen = new Set<string>();
    const rows: FileRow[] = [];
    for (let i = history.length - 1; i >= 0 && rows.length < RECENT_LIMIT; i -= 1) {
      const path = history[i];
      // The document already on screen is not somewhere to go.
      if (path === openPath || seen.has(path)) continue;
      seen.add(path);
      rows.push({
        key: path,
        path,
        name: baseName(path),
        where: relativeTo(path, roots),
        ranges: [],
        root: "",
        run: () => choose(path),
      });
    }
    return rows;
  };

  const rows: FileRow[] = searching
    ? hits.map((hit) => ({
        key: hit.path,
        path: hit.path,
        name: hit.name,
        where: hit.relPath,
        ranges: hit.ranges,
        root: roots.length > 1 ? baseName(hit.rootPath) : "",
        run: () => choose(hit.path),
      }))
    : recent();

  const status = (): PaletteStatus => {
    if (phase === "error") {
      return { text: error ?? "The search index could not be read.", error: true };
    }
    if (!searching) {
      return {
        text: roots.length === 0 ? "Open a folder first." : "Type to find a file by name or path.",
      };
    }
    if (phase === "loading") return { text: "Searching…" };
    if (indexPhase === "indexing") return { text: "Still indexing. Try again in a moment." };
    return { text: "No file matches." };
  };

  return (
    <Palette
      label="Quick open"
      placeholder="Go to file"
      query={query}
      onQuery={setQuery}
      rows={rows}
      status={status()}
      onClose={() => setOpen(false)}
      renderRow={(row) => (
        <span className="palette-main" title={row.path}>
          <span className="palette-name">{row.name}</span>
          <span className="palette-where">{highlight(row.where, row.ranges)}</span>
          {row.root !== "" && <span className="palette-root">{row.root}</span>}
        </span>
      )}
    />
  );
}
