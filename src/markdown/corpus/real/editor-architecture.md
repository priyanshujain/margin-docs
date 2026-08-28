# Architecture

Tauri 2, React 19, Vite, TypeScript and zustand on the front, Rust behind. Same stack as margin and
margin-calendar, which means the build and bundle setup, the token layer and the TipTap editor core
carry over from margin rather than being invented again, while the zustand and CSS conventions
carry over from margin-calendar, the newer and more disciplined of the two scaffolds.

The split is strict. Rust owns the filesystem: reading and writing documents, walking and watching
the tree, the SQLite index, moving files to the trash, and atomic writes. TypeScript owns
everything above that: the markdown bridge that turns file bytes into an editable document and
back, the WYSIWYG editor itself, and all rendering. Rust never parses markdown and TypeScript never
touches the filesystem directly; everything between the two crosses through the `dto.rs`/`ipc.ts`
contract described below.

## The markdown bridge

The bridge is built on `remark-parse` and `remark-stringify` through `unified`, not on
`@tiptap/markdown`, TipTap's own markdown extension. Two things rule that out. `@tiptap/markdown` is
built on `marked`, which has no frontmatter support, and frontmatter here is not optional: it has to
be parsed, hidden from the editor, and written back unchanged on every save. More fundamentally, a
`marked` AST does not carry source positions, while every node `remark-parse` produces carries a
`position` with byte offsets into the original file. That offset is the whole trick the rest of this
document depends on: when a piece of syntax has no model in the editor, the bridge does not
reconstruct its text from a generic AST node, it slices the exact bytes out of the original source
between `position.start.offset` and `position.end.offset` and carries that slice forward untouched.
Writing back byte identical is a property of the source string, not of the printer, and only an AST
that remembers where it came from can hand that string back.

## Callouts, toggles and unknown syntax

On disk a callout is a GitHub alert: a blockquote whose first line reads `[!NOTE]`, `[!WARNING]`,
`[!IMPORTANT]`, `[!TIP]` or `[!CAUTION]`. `remark-parse` hands back an ordinary `blockquote` node for
these, so a visitor walks the tree afterward, recognises the marker in the first child, tags the
node with its variant and strips the marker before the editor ever sees it. Serialization reverses
exactly that: re-emit the blockquote and put the marker back as its first line.

A toggle is `<details>` and `<summary>`, and remark does not parse HTML blocks into a tree at all;
it hands them back as opaque `html` nodes carrying raw text. The bridge looks for a matching
`details`/`summary` pair in that raw text, and where it finds one it lifts the summary and the body
into a toggle node the editor can open and close like a native control. A `details` block that does
not match that exact shape, nested oddly, missing a summary, carrying attributes the editor has no
model for, is left exactly as it was found. Everything else the parser cannot classify, an HTML
block that is not a details/summary pair, a construct remark itself does not model, a piece of
syntax nobody has written a visitor for yet, becomes a raw node under the rule in
[conventions.md](conventions.md): the literal source slice, editable as monospace text, written
back unchanged. Nothing is ever silently reformatted or dropped.

## The dto.rs and ipc.ts contract

Rust and TypeScript meet at exactly one seam: `src-tauri/src/dto.rs`, a set of
`#[serde(rename_all = "camelCase")]` structs, and its hand-written mirror `src/ipc.ts`. Both sides
are built against that shape rather than against each other, which is what lets the filesystem
layer and the markdown bridge be built independently of one another: the tree, the read and write
commands and the index queries only need their DTO agreed, not implemented, before anything above
them is built against a stand-in of the same shape. The file is frozen by convention: a command's
Rust body can change freely, but adding, renaming or retyping a field is a decision made once, in
both files, in the same change.

## The dev IPC mock

`pnpm dev` runs the Vite dev server on its own, with no Tauri process behind it and no
`window.__TAURI_INTERNALS__` for `@tauri-apps/api` to find. `src/ipc.ts` checks for that bridge and,
when it is absent, swaps in a mock implementation of the same command surface backed by an
in-memory fixture, rather than throwing or leaving the screen blank. That is what lets the
Playwright suite in `tests/` (`pnpm test:ui`) drive the real editor, the real store and the real
components in plain Chromium without a compiled Rust binary anywhere in the loop, and it is also
what makes iterating on the editor fast day to day: no Rust recompile between changes. The mock is
exactly as wide as `dto.rs`, never wider, so a command the mock cannot answer is a command that has
not been added to the contract yet, not a gap in the mock to be patched around.

## The SQLite index

SQLite through `rusqlite` with the `bundled` feature, so there is no system SQLite dependency, and
with FTS5 compiled in as a side effect of that same feature rather than a separate cargo flag. The
database lives in the app data directory, never inside any folder the user opened, and it is
derived state rather than a source of truth: every row is rebuilt from the markdown files on disk,
so deleting it costs nothing but the time to walk the open roots again. It is kept current by the
same `notify`/`notify-debouncer-full` watcher the tree uses, debounced because a git checkout or
another editor's save fires a burst of filesystem events for what is really one change. The index
answers three things a plain file tree cannot: quick open by filename and path on `Cmd+P`, full text
search across every open root on `Cmd+Shift+F`, and the backlinks section appended to a document,
a reverse lookup of every relative markdown link elsewhere that resolves to the file currently open.

## Order of work

The filesystem layer and the markdown bridge are the two things everything else depends on, and
neither is proven by the other, so the first milestone is Rust: roots, the tree, atomic read and
write, the watcher and trash, built from the start against a frozen `dto.rs` and `ipc.ts`, with the
dev IPC mock standing in for it on the TypeScript side. The second is the bridge itself: parsing,
the raw-node slicing that makes the round trip byte identical, frontmatter separation and
serialization, proven with round-trip tests before a single line of editor UI exists, because a
round-trip bug is obvious in a plain text diff and invisible once it is glued to a rich text view.
The third is the WYSIWYG editor: TipTap wired to the bridge, the sticky bottom toolbar, callouts,
toggles and image paste into `assets/`. The fourth is the SQLite index: the schema, the
watcher-driven indexer, quick open, full text search and backlinks. The fifth is the rest of the
shell: multiple roots open at once, the tree showing every file including the greyed-out ones that
open in the system default app, and settings and the updater.
