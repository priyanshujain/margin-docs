# Design

Margin Docs is a local first WYSIWYG editor for the plain markdown files already on your disk,
macOS only. It exists because the documents that actually matter, notes, specs, journals, project
READMEs, already live as files in folders you control, readable by every other tool you own and
tracked by git if you want that, while the editors that are pleasant to write prose in tend to
belong to a browser tab and own the content themselves: a database, a proprietary block format, a
folder of the app's own metadata sitting next to your text. Margin Docs starts from the file and
refuses to add a second copy of the content anywhere. The SQLite index it keeps is deliberately
disposable (see [architecture.md](architecture.md)), because the moment an index is required for a
file to mean anything, the file has quietly stopped being the truth.

## The file contract

Nothing is written into a user's folders except the markdown file itself and the images pasted into
the `assets/` folder beside it. Opening a file never writes it: reading it into the editor, looking
at it, and closing it again leaves the bytes on disk exactly as they were. This is a promise to the
user before it is an implementation detail, which is why [conventions.md](conventions.md) turns it
into a rule with a test behind it rather than an intention.

## Why there is no slash menu and no drag handles

Full WYSIWYG means markdown syntax is never visible, but it does not mean the editor secretly
models the document as a stack of blocks you assemble one command at a time. A slash menu and a
drag handle both come from that block-based idea of a document, and a markdown file is not one: it
is prose with headings, lists and the occasional table, written top to bottom the way you would
type it into any text editor. Reaching for a menu to insert a callout is slower than typing the
paragraph and toggling it from the toolbar, and a drag handle implies blocks are things you
rearrange as objects, which is a different mental model from writing, and the wrong one for a tool
whose whole pitch is that the file underneath stays exactly as legible as it always was.

## Why the toolbar is a permanent pill at the bottom

A toolbar that appears only on selection hides its own existence until you have already selected
something, which is backwards for someone who does not yet know a feature is there. A toolbar
fixed to the top competes with the title and the frontmatter for the same strip of attention a
document opens with. The pill at the bottom is a stable landmark instead: always in the same place,
never jumping to follow the selection, out of the way of what you are reading, and close to where a
trackpad or a thumb already is.

## Why the filename and the H1 are unrelated

A markdown file's identity outside this app is its path. Git tracks it by path, every other editor
opens it by path, and a relative link from another document points at that path, not at whatever
the first heading happens to say today. Treating the H1 as the filename, the way some note apps do,
means every edit to a title is secretly a rename, and a rename nothing else agreed to breaks every
link that pointed at the old path and confuses git into showing a delete and an add instead of an
edit. Margin Docs keeps the two separate and never renames a file behind the user's back: the H1 is
content, the filename is identity, and conflating them only looks harmless until real folders and
real links are involved.

## Why one document at a time

One editor instance, one parsed frontmatter, one set of raw nodes, one dirty flag. A tab bar would
let a document sit half-edited in the background, invisible, while attention moved elsewhere, which
is exactly the kind of silent state the file contract above is trying to rule out. The open folder
is about how much of the disk you can see; one document open at a time is about how much of it you
are allowed to be quietly changing.

## Why one folder at a time, and why a launch opens on a list

The shell used to hold several folders at once, stacked as separate trees down one sidebar, and put
every one of them back on the next launch. Both halves were wrong in the same way. Two projects in
one sidebar means every command that acts on a folder has to ask which one, so New Document, Close
Folder and Find in Files each grew a guess or a refusal about a question the person reading the
screen already knew the answer to. And a window that comes back holding last week's project is a
window you have to close something in before you can start today's.

So the model is a code editor's: one project open, and the way out of it is the way back in.
Closing the folder puts the start screen back, which is the list of folders this app has opened,
most recent first, and picking one off it replaces whatever was there. Rust still holds roots as a
list and does not have to change for any of this; what changed is that the window models one of
them.

The cost is real and worth naming. Two folders cannot be searched at once, and a relative link from
a document in one folder to a document in another is a link the sidebar cannot follow. Both were
already true of anything outside the folders that happened to be open, and neither is worth what
the sidebar was paying for them.

## Why the outline is a rail in the margin and not a panel in the sidebar

The headings of the open document are drawn the way Notion draws them: a column of short ticks at
the right edge of the page, one per heading, longer for a section and shorter for what sits under
it, the one the reader is in darker than the rest. Putting the pointer on the ticks turns them into
the titles, in a small list in the same corner, and a click on a title puts the caret in that
heading with the heading at the top of the pane. The list closes when the pointer leaves. On a
keyboard the rail is one tab stop and the arrows walk the list; on a finger a tap pins it and a tap
elsewhere lets it go.

It is not a section of the sidebar, and the first version was. The sidebar is the folder, and the
outline is the document: a list of sections under a list of files reads as more files, takes a
share of a column that is already short on tall trees, and is on screen whether or not anybody is
looking for it. The margin the sheet leaves beside the measure costs nothing, the ticks say
"this document has sections" and no more until asked, and the answer arrives under the pointer
where the question was put. The toggle that hides the rail exists for a window too narrow to have a
margin, and it is remembered.

Which tick is the reader's is measured against the pane rather than taken from the caret: the last
heading that has scrolled into the top third of the pane, or the last of all once the pane is at its
end. The rail is looked at while scrolling through a document, and the caret can be pages away from
what is on screen. The rows themselves are read off the editor's live tree on every change rather
than off the file, so they are true of the document a keystroke ago, and each carries a position in
that tree rather than its words, which is what lets two sections share a title.

Only the document's own children are in it. A heading inside a quote or a callout is a heading in
somebody else's block, one inside a list is a list item wearing a hat, and one inside a toggle is
text the toggle may be hiding, so jumping to it would land the caret somewhere the page does not
show. The indent is by the headings above a row rather than by its level number, so a document that
starts at `##` does not start one step in and a skipped level is one step rather than two. An empty
heading is left out until it says something, and a document with no headings has no rail, since a
rail of nothing is a mark on the page for no reason.

## Visual language

Lifted from margin unchanged, the same way margin-calendar's is: warm paper surfaces, ink and two
softer ink tones, hairline borders, a four-step type scale, three radii, one easing curve, the
palette driven by `data-theme` on the root. Margin Docs adds nothing to that layer; it is a sibling
application, not a new visual identity, and the token file is the proof of that rather than a
description of it.

What it does add is more palettes to swap in there. Beside margin's own light and dark, whose values
are untouched, `src/styles/themes.css` holds a sepia, a cool near white, a warm high contrast light,
a flat charcoal and a deep blue black with one saturated accent. None of them is a second design:
each is the same thirty five variables with different values, and a palette that leaves one out does
not fail loudly, it inherits a colour from the light one and looks wrong in a corner nobody opens,
which is why `src/theme.test.ts` reads the stylesheets rather than trusting whoever added the last
one. Choosing is done in Settings, from a grid of tiles each drawn in the palette it is offering,
and it applies on the click rather than behind a save button, because a colour is a thing you judge
by looking at it. "Match system" resolves `prefers-color-scheme` to whichever light and dark palette
were last chosen, and that media query is the only one in the app allowed near a colour. The title
bar has no sun and moon on it any more: two palettes fit on one button and seven do not.
