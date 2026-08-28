# Conventions

This project is a sibling to `../margin` and `../margin-calendar` and follows their conventions
deliberately rather than inventing new ones. When something here is unclear, the answer is almost
always "do what margin does" for the editor, the token layer and the visual language, and "do what
margin-calendar does" for the scaffold underneath: the store, the CSS rules and the shape of the
IPC boundary.

## Rust

`Result<T, String>` everywhere. No `anyhow`, no custom error enums.

DTOs crossing the IPC boundary live in `src-tauri/src/dto.rs` and are marked
`#[serde(rename_all = "camelCase")]`. That file is the contract and is frozen: implementation
modules add bodies, not fields. Its mirror is `src/ipc.ts`.

Every write to a document is atomic: write to a temp file beside it, flush, then rename over the
original. A crash or a full disk must never leave a half-written file sitting where the user's file
used to be. Deletions go through the `trash` crate, never `fs::remove_file`, since these are the
user's own files and this app does not get to be the reason one of them is gone for good.

Comments are rare and explain why, never what.

## TypeScript

One zustand store per domain in `src/store/`. No middleware. One selector call per field
(`useThing((s) => s.field)`, never a destructured object), actions as inline arrow properties, and
`set((s) => ...)` returning `{}` to no-op.

Async actions use a string phase union, never boolean loading flags. Errors stringify with
`String(e)` and surface as a toast.

Side effects that touch disk, the DOM or Tauri live in a sibling module, never inside the store.

Typed IPC wrappers live in `src/api/`, one module per domain, one thin function per command,
mirroring `dto.rs` field for field.

## Markdown

The serializer has one house style, fixed in one place under `src/markdown/` and never varied per
document or per call site: one heading style, one list marker, one rule for when a link gets angle
brackets. A file saved twice with no edits in between produces byte-identical output, and a file
opened and then closed with no edits is never written at all.

No markdown construct is ever dropped on a round trip. Anything the editor cannot model, rather
than being reformatted into the nearest thing it understands or silently discarded, becomes a raw
node: the exact source bytes, preserved and shown as an editable monospace block. Losing a
construct silently is worse than never having supported it, because the loss is invisible until the
file is opened somewhere else and the diff shows a missing paragraph.

The editor never writes a file the user has not edited. Opening a document, looking at it,
switching away from it and closing the app again must leave the file on disk untouched, and that is
worth an actual round-trip test rather than an assumption.

## CSS

Flat kebab-case class names, not BEM. State is a `data-*` attribute, never an `is-` class.

Every colour, radius and size goes through a token in `src/styles/tokens.css`. If a value is not in
there, add a token rather than a literal.

Dark mode is `data-theme` on `<html>`, with both palettes defining an identical variable set. Never
a media query for theme.

Transitions name explicit properties and use `var(--ease)`. Never `transition: all`.

## Icons

Inline Feather-style 24x24 stroke `d` strings passed to `<Icon d={...} />`. There is no icon set
and no registry, and there will not be one.

## Storage keys

Anything in `localStorage` is prefixed `margindocs-`, following margin and margin-calendar's own
prefixes.

## Never

No CSS framework, no component library, no router, no zustand middleware, no directory trees in any
document, and no em dashes or en dashes anywhere, including code comments.
