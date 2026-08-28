# Setup

## The Google OAuth client

The app talks to Google with its own OAuth desktop client, which is not in this repo and cannot
be. You need to make one before the app can connect to anything.

1. In the Google Cloud console, enable the Google Calendar API on a project.
2. On the OAuth consent screen, add the `https://www.googleapis.com/auth/calendar` scope. It is a
   sensitive scope, so an unverified client shows an interstitial and caps at 100 users. That is
   fine for personal use and matters the day this ships more widely.
3. Create an OAuth client ID of type **Desktop app**. That type permits the loopback redirect, and
   Google allows installed clients any loopback port, so there is nothing to register. This client
   is for macOS, Linux and Windows only; phones need their own, see [mobile.md](mobile.md).
4. Save the downloaded JSON as `google-credentials.json` in the repo root. It should match the
   shape of `google-credentials.example.json`: an `installed` object with `client_id`,
   `client_secret`, `auth_uri` and `token_uri`.

The real file is gitignored. The build embeds it when it is present and embeds the example when it
is not, so a fresh clone builds and then tells you at runtime that Google Calendar is not set up
yet, rather than failing to compile.

Building for a phone needs a second and third OAuth client, because Google will not accept a
desktop client from Android or iOS. That, and the toolchain, is in [mobile.md](mobile.md).

Refresh tokens never go to disk in plaintext and never into the SQLite database. They are sealed
with XChaCha20-Poly1305 in the app data directory, identically on all five platforms, by
`src-tauri/src/google/secrets.rs`. That file states what the encryption is worth where: on iOS and
Android the app sandbox is the real boundary and this is defence behind it, while on a desktop
anyone who can read your home directory can read the token. There is no OS credential store in the
picture and nothing will ever prompt you for keychain access.

## Building

```
pnpm install
pnpm tauri dev
```

`pnpm test` runs the frontend suites, `cargo test` inside `src-tauri` runs the Rust ones. Both
should be green before anything is considered done.

## Linux

Building needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`,
`libayatana-appindicator3-dev` and `libxdo-dev`. Build on the oldest baseline you intend to
support, which is Ubuntu 22.04 or Debian 12, because the resulting binary will not run on anything
older than the glibc it was linked against.

## Where the data lives

`~/Library/Application Support/studio.margin.calendar/` on macOS and
`~/.local/share/studio.margin.calendar/` on Linux. The bundle identifier is deliberately distinct
from margin's, so the two apps never share a directory. Deleting that directory resets the app;
the accounts reconnect and sync pulls everything back.
