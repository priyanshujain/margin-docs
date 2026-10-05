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

## Opening files from outside the app

The bundle registers `.md`, `.markdown`, `.mdown`, `.mkd` and `.mkdn` as documents Margin Docs can
edit, so Finder's Open With lists it. Each file opens in a window of its own without its folder.
Two actions in the command palette tie the installed app into the system, and both refuse to run
from a development build:

- **Make Margin Docs the Default Markdown App** asks macOS to open those extensions here. macOS may
  ask you to confirm. Finder's Get Info, Open with, Change All does the same by hand.
- **Install 'mdocs' Command in PATH** links `/usr/local/bin/mdocs` to the launcher inside the app
  (`Contents/Resources/bin/mdocs`), asking for an administrator password only when that folder is
  not writable. It will not replace a `mdocs` that belongs to something else. `mdocs notes.md`
  then opens one file. Updating the app in place keeps the link working; moving the app means
  installing the command again.

## Where the data lives

`~/Library/Application Support/studio.margin.docs/` on macOS. It holds nothing but the SQLite
index described in [architecture.md](architecture.md): the tables behind quick open, full text
search and the backlinks section it powers. It never holds a document or a copy of one, so deleting
the directory costs nothing except the time the app takes to walk your folder and rebuild the index
the next time you open one. Quick open and search go blank until that finishes; nothing else
notices.

## No credentials to provision

Unlike margin-calendar, there is no OAuth client to create and no `google-credentials.json` to drop
in the repo root before the app does anything useful. Margin Docs talks to no external service; the
only account it needs is the one already logged into the machine it is running on, to read and
write the folders you point it at. A fresh clone builds and runs immediately.
