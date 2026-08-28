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
is exactly the kind of silent state the file contract above is trying to rule out. Multiple roots
open at once is about how much of the disk you can see; one document open at a time is about how
much of it you are allowed to be quietly changing.

## Visual language

Lifted from margin unchanged, the same way margin-calendar's is: warm paper surfaces, ink and two
softer ink tones, hairline borders, a four-step type scale, three radii, one easing curve, light and
dark driven by `data-theme` on the root. Margin Docs adds nothing to that layer; it is a sibling
application, not a new visual identity, and the token file is the proof of that rather than a
description of it.
