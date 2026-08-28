// Cmd+Shift+F: the text inside every file in every open root, which is the one question the file
// tree and the find bar between them cannot answer. The bar in src/components/FindBar.tsx searches
// the one document that is open; this searches the ones that are not.
//
// Same debounce and the same reason as quick open, a little longer because a full text query reads
// the whole corpus rather than one column of paths, and the same deliberate absence of a second
// guard around the race: the sequence number in src/store/useSearch.ts already refuses an answer
// that has been overtaken.
//
// A row opens the document it found the line in, and stops there. Putting the caret on the line
// itself would need a way to say "open this file at line 42", and the editor's public surface in
// src/editor/index.ts has no such thing, so the honest version of this today is the file open at
// the top rather than a jump built out of a DOM query behind the editor's back.

import { useEffect, useState } from "react";
import { useEscapeLayer } from "../escape";
import type { MatchRange } from "../ipc";
import { onCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { useDocument } from "../store/useDocument";
import { useIndex } from "../store/useIndex";
import { useSearch } from "../store/useSearch";
import { notify } from "../store/useToast";
import { useWorkspace } from "../store/useWorkspace";
import { Palette, highlight, type PaletteRow, type PaletteStatus } from "./Palette";

/** Longer than quick open's: this one reads the text of every file rather than their paths. */
const DEBOUNCE_MS = 140;

interface HitRow extends PaletteRow {
  title: string;
  /** One based, and counted over the file as it sits on disk, frontmatter included. */
  line: number;
  excerpt: string;
  ranges: readonly MatchRange[];
  path: string;
}

export function FindInFiles() {
  const [open, setOpen] = useState(false);

  const query = useSearch((s) => s.fullTextQuery);
  const setQuery = useSearch((s) => s.setFullTextQuery);
  const runFullText = useSearch((s) => s.runFullText);
  const hits = useSearch((s) => s.fullTextHits);
  const phase = useSearch((s) => s.fullTextPhase);
  const error = useSearch((s) => s.fullTextError);
  const indexPhase = useIndex((s) => s.phase);
  const roots = useWorkspace((s) => s.roots);
  const select = useWorkspace((s) => s.select);
  const openDocument = useDocument((s) => s.open);

  useEffect(
    () =>
      onCommand("find-in-files", () => {
        // Empty field, and last time's rows cleared through the store so its sequence number moves
        // with them. See the same lines in QuickOpen.tsx.
        setQuery("");
        void runFullText("");
        setOpen(true);
      }),
    [setQuery, runFullText],
  );

  useEscapeLayer(open, () => setOpen(false));
  useKeyContext("overlay", open);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void runFullText(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, runFullText]);

  if (!open) return null;

  const choose = (path: string) => {
    select(path);
    openDocument(path).catch((e) => notify(`Could not open: ${String(e)}`));
  };

  const searching = query.trim() !== "";

  // A file can answer on several lines, so the path alone is not a key.
  const rows: HitRow[] = hits.map((hit, index) => ({
    key: `${hit.path}:${hit.line}:${index}`,
    title: hit.title,
    line: hit.line,
    excerpt: hit.excerpt,
    ranges: hit.ranges,
    path: hit.path,
    run: () => choose(hit.path),
  }));

  const status = (): PaletteStatus => {
    if (phase === "error") {
      return { text: error ?? "The search index could not be read.", error: true };
    }
    if (!searching) {
      return {
        text:
          roots.length === 0 ? "Open a folder first." : "Type to search every folder that is open.",
      };
    }
    if (phase === "loading") return { text: "Searching…" };
    if (indexPhase === "indexing") return { text: "Still indexing. Try again in a moment." };
    return { text: "Nothing in these folders says that." };
  };

  return (
    <Palette
      label="Find in files"
      placeholder="Search every open folder"
      query={query}
      onQuery={setQuery}
      rows={rows}
      status={status()}
      onClose={() => setOpen(false)}
      renderRow={(row) => (
        <span className="palette-stack" title={row.path}>
          <span className="palette-main">
            <span className="palette-name">{row.title}</span>
            <span className="palette-line">{row.line}</span>
          </span>
          <span className="palette-snippet">{highlight(row.excerpt, row.ranges)}</span>
        </span>
      )}
    />
  );
}
