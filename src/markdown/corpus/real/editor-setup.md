# Setup

## Building

```
pnpm tauri dev
```

or `just dev`, which is the same command. `just test` is the gate: `pnpm test` for the frontend
suites and `cargo test` inside `src-tauri` for the Rust ones, both green before anything is
considered done. `just test-ui` runs the Playwright suite in `tests/` against the real UI in
Chromium, using the dev IPC mock described in [architecture.md](architecture.md) rather than a
built Tauri binary.

## Where the data lives

`~/Library/Application Support/studio.margin.docs/` on macOS. It holds nothing but the SQLite
index described in [architecture.md](architecture.md): the tables behind quick open, full text
search and the backlinks section it powers. It never holds a document or a copy of one, so deleting
the directory costs nothing except the time the app takes to walk your open folders and rebuild the
index the next time it starts. Quick open and search go blank until that finishes; nothing else
notices.

## No credentials to provision

Unlike margin-calendar, there is no OAuth client to create and no `google-credentials.json` to drop
in the repo root before the app does anything useful. Margin Docs talks to no external service; the
only account it needs is the one already logged into the machine it is running on, to read and
write the folders you point it at. A fresh clone builds and runs immediately.
