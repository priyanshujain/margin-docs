# Releasing

## Installing locally

`just install` builds the app for whatever machine you are sitting at and installs it where that
machine expects to find applications: `/Applications` (or `~/Applications` when `/Applications`
is not writable) on macOS, the package manager or an AppImage plus a desktop entry on Linux. It is
the same command whether or not the app is already installed, so it doubles as the update. On
macOS it asks a running copy to quit first, because replacing a bundle under a live process leaves
it half old and half new. `just uninstall` reverses it and leaves the data directory alone.

The local build skips the dmg and builds only the `.app` on macOS, or the `.deb` and the AppImage
on Linux, since nothing about copying a bundle into place needs a disk image and building one is
the slowest part of a mac bundle. That makes a locally installed app slightly different from a
released one: it is ad hoc signed and carries no updater artifacts, so it will not update itself.
Rerun `just install`.

## Cutting a release

Releases are manual: run the Release workflow from the Actions tab. Leave the version empty to
bump the patch number, or give one to set it. The workflow bumps `tauri.conf.json`, `package.json`
and `src-tauri/Cargo.toml` together, commits that to main, tags it, and builds the tag rather than
whatever main happens to be by then.

It builds one universal macOS bundle and publishes nothing until it has landed. The last job
downloads `latest.json` and refuses to take the release out of draft unless `darwin-aarch64` and
`darwin-x86_64` are both present in it. One universal build writes both of those keys, pointing
them at the same archive and the same signature, because an installed copy asks the manifest for
the architecture it is running on and never for a universal one. A half-populated manifest is worse
than no release at all: the updater would offer an update to the platforms that made it and error
on the ones that did not.

Linux is not built. It was until recently, because this pipeline was copied from margin-calendar,
which ships on Linux. This app does not, so the row and the manifest key it required are gone and
the release runs on one macOS runner.

Windows is not built. Nothing in `tauri.conf.json` targets it and the app has never claimed it.

## What the build needs

Two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
which sign the updater artifacts so an installed copy can tell a real update from anything else
offered at the same URL. The public half lives in `src-tauri/tauri.release.conf.json`, baked into
every build, so the private half can never be rotated without stranding everyone who has not
updated yet; back up the key and its password somewhere that is not the machine that generated
them. That file currently carries the placeholder `REPLACE_WITH_TAURI_SIGNER_PUBKEY`; generating
the real keypair and committing its public half in is a one-time step that has to happen before the
first signed release can go out.

Beyond the signing key there is nothing to provision. Margin Docs talks to no external API and
holds no OAuth client, unlike margin-calendar, so there are no other repository secrets and nothing
equivalent to a `google-credentials.json` to embed at build time.

## Updates

Installed copies check
`https://github.com/priyanshujain/margin-docs/releases/latest/download/latest.json` and update
themselves from it. `--latest` on the publish step is what moves that pointer, so a release that
fails the manifest check stays a draft and no one is offered a broken update.
