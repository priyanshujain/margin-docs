# Conventions

This project is a sibling to `../margin` and follows its conventions deliberately rather than
inventing new ones. When something here is unclear, the answer is almost always "do what margin
does", and the file to look at is named below.

## Rust

`Result<T, String>` everywhere. No `anyhow`, no custom error enum except `google::api::ApiError`,
which exists only because the sync engine has to distinguish a 410 and a 412 from everything else.

DTOs crossing the IPC boundary live in `src-tauri/src/dto.rs` and are marked
`#[serde(rename_all = "camelCase")]`. That file is the contract and is frozen: implementation
modules add bodies, not fields. Its mirror is `src/ipc.ts`.

Read Google's responses through `google::auth::read_json`, which takes the body to a `String`
first so the error payload survives into the message. Ported from `margin/src-tauri/src/gdrive.rs:286`.

Heavy synchronous work goes behind `#[tauri::command(async)]` on a synchronous fn, which is
margin's `pdf.rs:90` trick for getting off the main thread without hand-writing `spawn_blocking`.

Comments are rare and explain why, never what. Match the density in `lib.rs`.

## TypeScript

One zustand store per domain in `src/store/`. No middleware. One selector call per field
(`useThing((s) => s.field)`, never a destructured object), actions as inline arrow properties, and
`set((s) => ...)` returning `{}` to no-op. See `margin/src/store/useBackup.ts`.

Async actions use a string phase union (`"idle" | "syncing" | "error"`), never boolean loading
flags. Errors stringify with `String(e)` and surface as a toast.

Side effects that touch disk, the DOM or Tauri live in a sibling module, never inside the store.

The OAuth connect flow reuses the promise-holding-its-own-resolver pattern from
`margin/src/store/useBackup.ts:70`: `connect()` returns a promise whose `resolve` is stashed in
state for a later Tauri event to settle.

Typed IPC wrappers live in `src/api/`, one module per domain, one thin function per command. They
are already written; add bodies to Rust, not new wrappers.

## CSS

Flat kebab-case class names, not BEM. State is a `data-*` attribute, never an `is-` class.

Every colour, radius and size goes through a token in `src/styles/tokens.css`. If a value is not
in there, add a token rather than a literal.

Dark mode is `data-theme` on `<html>`, with both palettes defining an identical variable set.
Never a media query for theme.

Transitions name explicit properties and use `var(--ease)`. Never `transition: all`.

Responsiveness is JS-driven through `useCompact()`, which writes `data-compact` on the root.
Style against that attribute rather than adding media queries.

`usePhone()` and `useTouch()` write `data-phone` and `data-touch` the same way, and they answer
different questions. `data-phone` is a window too narrow for the desktop chrome and it governs
layout; `data-touch` is a coarse pointer and it governs interaction. A tablet is touch and not a
phone, a narrow desktop window is a phone and not touch, and treating either as a proxy for the
other is how a hover-only control ends up unreachable. Both are also set by the boot script in
`index.html`, so the first paint is already the right shape.

A rule that reads "you cannot hover here" belongs on `data-touch`. A rule that reads "there is no
room for this" belongs on `data-phone` or `data-compact`.

The one exception is the event block, which uses a container query on its own inline size. That is
deliberate: `data-compact` describes the window, but what decides how many lines of a title fit is
the block's own width, and in a three-deep overlap cluster that is a quarter of a column. Nothing
else may reach for a container query without the same kind of reason.

Overlays follow margin's `.overlay` and `.panel` idiom, already in `app.css`, and every one of
them registers with `useEscapeLayer` from `src/escape.ts` so Escape unwinds the layers in order.

## Icons

Inline Feather-style 24x24 stroke `d` strings passed to `<Icon d={...} />`. There is no icon set
and no registry, and there will not be one. An icon-only button always carries a `title` with its
shortcut written in real glyphs.

## Storage keys

Anything in `localStorage` is prefixed `margincal-`, following margin's convention in `theme.ts`
and `panes.ts`. Keys read before first paint are restored by the blocking IIFE in `index.html`.

## Never

No CSS framework, no component library, no router, no zustand middleware, no directory trees in
any document, and no em dashes anywhere including code comments.
