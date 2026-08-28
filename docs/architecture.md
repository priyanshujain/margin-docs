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

## Where a hand wrapped line lives

Most markdown in the world is hard wrapped: a paragraph is several lines in the file and one
paragraph on screen, and the author chose where those lines end. That choice is theirs and this
editor does not get to reflow it, so a soft line break survives the round trip as a real newline in
the paragraph's text rather than being folded into a space.

Keeping it takes three declarations that have to agree, and it is worth naming all three because
each one on its own looks like an optimisation somebody could remove. `src/markdown/parse.ts` puts
the newline in the text. `prose.css` draws a paragraph `pre-wrap` so it is on screen where the
author put it. `src/model/schema.ts` declares the paragraph `whitespace: "pre"`, and that is the one
that was missing: two libraries read that field and both of them rewrite the paragraph without it.
`prosemirror-view` reads it to decide how to parse the editor's own DOM back after a keystroke, and
at the default every soft wrap in the paragraph being typed into came back as a hard break, so one
character typed into a hand wrapped file put a backslash at the end of every line in that paragraph.
`prosemirror-transform` asks the same field before it joins two blocks, so Backspace between two
hand wrapped paragraphs rewrote the wraps in both.

The paragraph's parse rule says the opposite on purpose, and a rule's own answer outranks the
node's. Whitespace is significant in a paragraph this editor rendered, and meaningless in a `<p>`
off somebody else's web page, where the line endings are that page's source indentation and keeping
them would put breaks and runs of spaces through the middle of a pasted sentence.

Only a running editor can prove any of this: the fault is between the keystroke and the serializer,
and the serializer never saw it. `tests/bytes.spec.ts` is where that proof lives.

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

## Tables, maths and the rest of what the bridge learned to model

The first pass over the bridge modelled prose and left everything structural as a raw node. A GFM
table, a `$$` math block and a `<details>` toggle were all bytes the editor showed and refused to
touch. Modelling them is what turns those blocks from something the editor carries into something
it edits, and every one of them was built as the exact inverse of the writer that puts it back: the
first mdast row becomes header cells and the delimiter row's per column alignment is copied on to
every cell of that column, because markdown has no way to say that one cell is centred and the rest
of its column is not. That inverse relationship is the whole test: a construct is modelled only
where parsing it and writing it back is the identity, and the parser refuses everything else.

The refusals are the interesting half and they are all the same shape. A table row with more cells
than its header has no column to put them in, so there is no answer between dropping the cells and
inventing a column, and the block stays raw. A toggle whose summary does not survive being unescaped
and escaped again character for character stays raw. A math fence that runs to the end of the file
unclosed stays raw, because writing it back would invent the closing delimiter. So does a carriage
return anywhere inside any of the three, since remark reads a lone `\r` as a line ending and the
writer never puts one back. In every case the file keeps its exact bytes and the user gets an
editable monospace block instead of a rich one, which is the trade this project has always made.

Modelling a table does cost one thing, and it is on the record rather than hidden. The house style
writes a table with its cells padded out to the width of the column, and a table written compact by
hand is repadded by the save that settles the file. Nothing else about it moves, no cell content
changes, and the second save is byte identical, which is the same one time normalisation the house
style has always applied to a setext heading or a tilde fence. The alternative would be a `source`
attribute on the table node holding the author's spelling, and that cannot work: the schema is
frozen, and the editor rebuilds every node from JSON when it installs a document, so the node the
writer sees is never the node the parser made. `roundtrip.test.ts` names the two corpus files this
affects and asserts, cell by cell, that the padding is the only thing that changed.

## What the writer proves before it writes

mdast writes the tree, so escaping, fence lengths and list indentation are decided by the library
that read the file rather than by string concatenation. What mdast cannot decide is whether this
reader will hand the block back as the block the document holds, and several spellings turn on
exactly that. A url the file wrote bare should stay bare, not become `[https://x](https://x)` and
put a diff in front of somebody who edited a different paragraph. A code span or an equation the
file wrapped across two lines should keep its line ending rather than have it swapped for a space.
A `<summary>` should keep the line endings the file gave it. None of those is safe on the strength
of a regular expression here, because GFM's literal autolink grammar has more corners than one, and
every corner that was got wrong cost a destination.

So the writer proves rather than assumes, and it proves the same way every time: write the block
out, read it back with the pair the app opens files with, and compare. There are two ladders. The
outer one is about the block, and it has three rungs, from writing every line ending where the
document puts it, through handing the spans back to mdast, to writing the two a text node cannot
hold as `&#xA;` and `&#xD;`. The inner one is about a url and also has three, shortest first: the
url on its own, `<url>`, then `[url](url)`, which has no grammar left to get wrong. The last rung of
the outer ladder is written whether it verifies or not, because a document holding something
markdown cannot spell still has to be saved and the one thing that must not happen is a file that
gains bytes on every save for the rest of its life.

The comparison is against the ProseMirror node, not against the mdast tree the block was built
from, and that is the whole point of it. The two trees disagree in ways that mean nothing: remark
reads an item's `spread` off the blank lines inside it while the writer sets it from the list, and a
parser extension hangs its own fields on the nodes it made. Every one of those differences is a
comparison that fails on a block that is perfectly fine, and each one was a rung of this ladder
quietly switched off. The document is the thing that has to survive, so the document is what is
compared.

The comparison itself is by name, not by object. The block the writer built and the block it reads
back are bound to two different `Schema` instances over one set of specs, so every `NodeType` and
every `MarkType` in one is a different object from its twin in the other, and `Node.eq`, which
compares them by identity, answered "different" for every block it was ever given. That was the
whole ladder switched off at the top rung, and `src/document.ts` has the same comparison for the
same reason.

Two questions about a file are not questions about any block in it, and each has a check of its
own because the ladder cannot see either. The seam between two blocks is one: a blank line closes
every construct markdown has except a list, which carries on over one and swallows the block below,
so a list written next to preserved source is proved apart and respelled, with a wider item indent
or the other bullet, until it is.

Those respellings cover every raw block a file can hand over, because a file's own raw block starts
in the first three columns and column four is indented code. An edited one can be anything, and for
some of them no spelling exists at all: four spaces typed into a raw block below a list makes bytes
that no seam can hold, since they read back as a code block wherever they are put. So the seam has a
last resort. When a list beside a raw block has no spelling left, the raw block is written from the
bytes the file gave it and the edit does not reach disk that save. That is the one place this editor
knowingly drops something the user typed, and it is the right way round: the alternative measured on
the same file swallowed the list into the raw block and then moved bytes around inside somebody's
html on the save after. A raw block with no list beside it is written exactly as it always was.

Where the body starts is the other: `---` on the first line of a
file is not a rule, it is the opening delimiter of frontmatter, and everything down to the next one
stops being markdown. That check is asked only of a body whose first three characters could open a
delimiter, and only when the body really is at the first byte of the file. A body with frontmatter
coming in front of it was never in danger, and running the defence there did the damage it exists
to prevent, because the blank line it pushes the body down by is handed back as part of the
frontmatter and written again on the next save. `serializeMarkdown` is the one thing that knows
whether a prefix is coming, so it is what tells the body writer.

One inline shape has no spelling either, and the writer settles it rather than the editor. A hard
break is a line ending inside a block, and there is no line left for one to start at the end of a
block, so a break with nothing under it is written as nothing. It used to be written as a backslash
on a line of its own, which reads back as a literal backslash in the user's words: a character they
never typed. That answer is in the serializer and nowhere else on purpose, because the trailing
break has more than one way in. Shift+Enter at the end of a paragraph is the obvious one, and is
still allowed, since it is a line somebody is halfway through typing and the next character makes it
a real break. Deleting the text out from under a break that was legal where it was put is the other,
and no keystroke guard sees that one at all. The editor refuses only the level 1 and 2 heading,
where a trailing break also takes the setext underline with it, and that refusal is about the
marker, not about the backslash.

Reading costs about eight times what writing does, and this editor saves half a second after the
user stops typing, so neither ladder runs on a block that has nothing in it to get wrong. A block
reaches the outer one only when it holds a line ending somewhere markdown has no way to write one,
or bytes mdast did not choose, and it reaches the inner one only when it holds a url that could be
written short. On the real corpus and on a 200 KB document of ordinary prose that is no blocks at
all: a save is 24 ms and no reparse happens. The shape that pays is a document with a bare url in
every paragraph, which costs two trips through the parser per block. Measured in Chromium on three
large real files, a save is 26 ms for the 179 KB yt-dlp README, 56 ms for the 266 KB
opentelemetry-js changelog and 91 ms for the 251 KB node changelog, each byte identical on the
second save.

## The block lanes

A node's shape is in the frozen schema and is turned into a TipTap extension mechanically. What a
node does, its ProseMirror plugins, its node views, its keymap and its input rules, is not derivable
from a shape and does not belong on a generated extension, so each of the five blocks with real
behaviour is one extension in one file, listed once in a registry that the extension list spreads
without knowing what is in it. Tables, syntax highlighting, maths, mermaid and toggles are then five
files that can be worked on at once, each exporting its extension and whatever commands the editor
handle delegates to when a toolbar button is pressed.

The toggle is the one whose behaviour is mostly outside ProseMirror. It is a real `<details>`, and
its summary row is chrome rather than content: the row is declared not editable, the title inside it
is declared editable again, and every keystroke in that island is turned into an ordinary
transaction that writes the `summary` attribute. Native disclosure is cancelled and `open` is
written by a command for the same reason, since both of those are bytes in the file and a browser
flipping an attribute behind the document's back is a title or a state the next save has to guess
at. Cancelling the click is not the whole of it either: a disclosure is a control, so the browser
works one from the keyboard too and sends the row a click for every space typed anywhere inside it,
which was every other space in a title flipping the toggle and writing `open` to disk. The flip asks
for a pointer press, or for the row itself holding the keyboard, and takes nothing else as consent.

Being chrome has a second consequence that reaches further than the node. A caret in the title is
not in the document at all, so ProseMirror's selection stays wherever it last was, and a toolbar
button pressed while a title is being typed runs its command against a paragraph the user is not
looking at. Rather than give the title a selection, which makes Horizontal rule and Insert image
replace or split the toggle, the file refuses: a transaction that changes the document is thrown out
while a title holds the caret, bar the two the title's own surface makes, and the caret is put back
in the title on the frame after TipTap's own focus lands. The toolbar draws itself disabled for the
same condition, read off the page rather than off a transaction, because clicking into a title
dispatches none.

And a toggle only ever sits among the document's own children, because that is the only place the
bridge pairs one. A `<details>` inside a quote or a list item goes to disk as a `<details>` inside
that container and comes back as a single raw block: the bytes survive, and both constructs stop
being editable. So a transaction that puts a toggle below the top level is refused, and the ranges
it is asked about are widened to the whole top level block first, since a wrap rewrites only the two
markers it puts either side and the thing it moved a level down is in the gap between them.

The order in that registry is load bearing rather than alphabetical. ProseMirror resolves a node
view first plugin wins by node name and gives a node view constructor no way to decline, and a
mermaid diagram is not a node of its own but a code block whose language happens to be `mermaid`. So
mermaid owns the code block node view outright and draws an ordinary fence for every other language,
while the highlighter contributes decorations only, which is what it wanted anyway: highlighting is
inherently a decoration and never a transaction that touches the text.

Two rules cut across all five. A command that has nothing to act on where the cursor is returns
false and does nothing, which is what a button pressed in the wrong place should do. And anything
that puts a node in the document asks first whether a node can go there at all: a table cell holds
inline content and is isolating, and ProseMirror asked to insert a block into one will split the
table around it and leave a row with no cells behind, which is a table the writer turns into three
blank lines. A fence and a raw block are the same question from the other side, since both hold
bytes that are the user's and an insert cuts them in half.

That guard is `src/editor/fits.ts`, and it now answers two questions rather than one, because the
first one turned out to be half the problem.

The first is about a node: can this thing go here. `fits` answers for one position and is the rule
itself. `placeable` asks it for a whole selection, which is the question a command actually has: a
selection has two ends, and a rectangle of table cells dragged out has neither of them anywhere a
caret would be, so it is refused outright whatever the type. An inline formula fits a cell perfectly
happily, which is right for a caret and catastrophic for a drag, and that gap is how one insert
emptied six cells of somebody's table. `place` is the guard and the insert in one call, so a command
written through it has no insert in it to forget to guard.

The second is about a command: may this edit happen here at all. Nothing asked that for two
milestones, and a block conversion is where it showed: `setNode` asks whether the new type fits and
never asks what the old block was, so the Heading tool rewrote a raw block's own bytes as escaped
markdown, and the Paragraph item, which TipTap answers by lifting once the block is already a
paragraph, deleted the callout around the caret along with its label. `change` is that half. It
refuses over a raw block outright, and otherwise it builds the transaction without dispatching it,
looks at what it did, and throws it away when a callout or a toggle that was there is gone, or when
a finished line break has landed somewhere the file swallows. Answering on the finished transaction
rather than on the command is the point: there is no list here of which commands lift, so a command
that starts lifting in a later TipTap is refused on the day it does. Its one exemption is the button
that names the wrapper, since the Toggle button pressed inside a toggle is meant to remove it.
`markable` and `breakable` are the same shape for the Link tool and for Shift+Enter.

Four things reach these guards from outside the toolbar. A pasted image asks before the bytes are
sent to be written, so a paste that cannot land leaves nothing in the assets folder, and again after
the write returns, because the caret is the user's during a round trip to disk; the Insert image
tool asks the same question through `canInsertImage`, since it has to write the picture before it
has a path to insert. A plain text paste is not refused anywhere, since text goes everywhere, but
where paragraphs would tear the block open it arrives as text instead, and a drop of blocks where
blocks do not fit is refused outright. And "--- " typed at the start of a line is the one typing
rule that inserts a node beside the caret rather than wrapping or retyping the block the caret is
in, so it is the one typing rule that has to ask; the others are operations ProseMirror declines on
its own.

`src/editor/fits.test.ts` is what holds all of that together, and it enumerates rather than lists.
It asks the running editor for its entry points: every method on the editor handle, off
`createCommands`; every method on the find handle, off `createFind`; every chord, read off every
extension's `addKeyboardShortcuts` the way the extension manager reads them; every ProseMirror prop,
read off every extension's plugins; and every prop the component puts straight on the view, off
`createEditorProps`. That last channel is neither an extension nor a handle and was invisible to the
enumeration until it was lifted out of the component, which is exactly the shape of gap this file
exists for. Each entry declares a family and each hostile context answers for every family, so a new
family forces a column and a new context forces a row, both at compile time. Three checks then apply
to every cell whatever its row says: the number of raw blocks is unchanged, no callout or toggle is
lost by anything not asked to lose one, and no toggle ends up below the top level.

Nothing in that file calls a handler. Every entry point goes through `EditorView.prototype.someProp`,
borrowed off prosemirror-view rather than modelled here, because the walk it does is the question:
the props the component put on the view, then the direct plugins, then the state's plugins in order,
first answer that is not false. Calling a guard by name and asserting what it answers proves nothing
about whether the running program asks it, and four guards in this project's history were shipped
with a green test of exactly that shape. What the unit suite still cannot do is construct a view at
all, because vitest runs in node with no DOM, so the event object and the parsed slice are built by
hand there. `tests/clipboard.spec.ts` is the other half: a real `EditorView` in Chromium, a real
mouse drag across a rectangle of cells, a real Cmd+V off the system clipboard, and assertions only
about what is on screen afterwards. It is the only place in the repository where the whole chain
from a key to a byte is real.

Where a guard sits in the plugin list is part of the guard. ProseMirror offers an event to the
plugins in order and takes the first answer that is not false, and prosemirror-tables installs a
paste handler that claims every paste made while a rectangle of cells is up, replacing the content
of every cell in the rectangle with whatever the slice holds. It sat at index nine and this app's
clipboard plugin sat at fifteen, so for two rounds the app's paste guard was written, documented,
unit tested and asked about nothing. One word on the clipboard replaced six cells; an image, which
carries no HTML for ProseMirror to parse and so arrives as the empty slice, emptied them. The
clipboard extension now declares a priority above every other extension in the tree, which puts it
at the head of the list whatever order the extension file lists things in, and being first is
asserted rather than believed: `src/editor/fits.test.ts` reads the built plugin list, computes the
index of every plugin claiming a paste or a drop, and fails if anything is in front. Being first
also means standing aside deliberately, for the one paste the library does better: cells copied out
of a table and pasted into one, recognised with prosemirror-tables' own predicate rather than a
reimplementation of it. Emptying cells is a real thing to want and it is Backspace.

There is no table op for the header row for a related reason. GFM has exactly one header row, it is
the first one, and there is no spelling for a table without one, so a toggle would offer an edit the
file cannot hold and the next open would silently take back. The same rule is why a new formula is
created holding a placeholder rather than nothing: an empty formula is `$$$$` on disk, which reads
back as four characters of text, so a box the editor draws and the file cannot hold is a box that
disappears on the next save.

Not every change to the document is a change to the file, and the block layer is where that first
became true. Dragging a column edge writes a width on to every cell in the column, which is a real
ProseMirror transaction and marks the buffer dirty, and GFM has nowhere at all to put a column
width. Sniffing for that particular transaction would be fragile, so the question is asked of two
trees instead: a walk comparing type, text, marks, child count and attributes, skipping the handful
of attributes the serializer never reads. It short circuits on identity, which is every subtree a
transaction did not visit, so it costs nothing per keystroke. The allowlist is deliberately short
and each entry has its reason written beside it, because an attribute wrongly called insignificant
is a user edit that never gets saved.

Types are compared by name and marks by name and attributes, never by object, and that is not a
shortcut. The two trees this walk is handed are never built on the same schema: the disk side comes
off the bridge, which parses against the frozen schema, and the live side is bound to the schema
TipTap generates from those same specs and which the editor rebinds every opened document on to.
Two instances over one set of specs means every type object in one differs from its twin in the
other, so `a.type !== b.type` and `Mark.sameSet` were both true of every pair this function had
ever been given, and everything behind them, the attribute allowlist included, was unreachable.
Name is also the right thing to compare rather than a way around that: the serializer dispatches on
`node.type.name` and `mark.type.name` and reads nothing else off a type.

Which two trees is the part that had to be got right twice. Asking whether this keystroke changed
anything since the last one makes dirty a count of transactions rather than a fact about the file:
the answer can only ever go up, so an edit and its undo inside one debounce still wrote, and on a
hand written file the save path's own byte comparison cannot catch it, since that file's serialized
bytes differ from its own bytes from the moment it opens. So `src/document.ts` keeps `diskDoc`
beside `diskText`, the tree whose serialization is the bytes currently on disk, and
`differsFromDisk` asks the question of that rather than of the previous keystroke. The two move
together through one function, so they cannot drift into one guard sending a write and the other
holding it back. Behind that the save path still serializes and compares the result against the
bytes it last saw on disk, which catches an edit that really did happen and really did come out
identical. Between them they are what stops a gesture that moved a line on screen, or a typo typed
and taken back, from putting a whole file diff in somebody's git status.

## Mermaid, and what is not in the main bundle

Mermaid is about 700kB before its per diagram chunks, which are several megabytes between them, and
almost no document has a diagram in it. It is imported dynamically the first time a diagram is
actually drawn, not when one is merely present with the caret inside it, so the library is a chunk
of its own and the main bundle contains none of it. Rendering is asynchronous, so the node view
draws the fence first and swaps the SVG in when it arrives, and it does that without dispatching a
transaction: nothing mermaid does reaches the document, and a diagram that fails to parse stays as
the code the user typed with the parser's complaint beside it. Nothing it needs is fetched over the
network, which matters because the app runs under a strict CSP with no `connect-src` for anything
but the Tauri IPC. KaTeX is the opposite trade and is bundled outright, since a formula is small,
common, and has to render synchronously; its fonts are emitted as files rather than inlined, because
the CSP's `font-src` is `self` and refuses the `data:` URI a small enough font would otherwise
become.

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

That fixture is also how a test reads what a save actually wrote. `tests/disk.ts` puts the shim and
the fixture behind one import, and `tests/bytes.spec.ts` uses it to type one character into a
running editor and then ask the file what happened. Every data loss bug this project has had lived
between the keystroke and the serializer, where a unit test that builds a document by hand cannot
see it, so that suite is deliberately about bytes and deliberately short: one test per way the app
has been caught rewriting something nobody touched.

The corpus under `src/markdown/corpus/` is globbed by folder rather than by a list of folder names,
so a fixture written for one test is inside every sweep the moment it is added. That is the whole
reason a sweep is worth having, and naming folders meant the twenty hardest files in the corpus sat
outside four of the gates that were supposed to cover them.

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
