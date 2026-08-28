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
downloads `latest.json` and refuses to take the release out of draft unless three things hold: the
version in the manifest is the version in the tag, `darwin-aarch64` and `darwin-x86_64` are both
present, and each of them has a signature as well as a url. One universal build writes both of
those keys, pointing them at the same archive and the same signature, because an installed copy
asks the manifest for the architecture it is running on and never for a universal one. A
half-populated manifest is worse than no release at all: the updater would offer an update to the
platforms that made it and error on the ones that did not. A manifest carrying the version before
this one is worse again, because it tells everybody the copy they are already running is the newest
there is, and an entry with an empty signature is an update every installed copy downloads and then
refuses.

Linux is not built. It was until recently, because this pipeline was copied from margin-calendar,
which ships on Linux. This app does not, so the row and the manifest key it required are gone and
the release runs on one macOS runner.

Windows is not built. Nothing in `tauri.conf.json` targets it and the app has never claimed it.

## What the build needs

Two repository secrets sign the updater artifacts, so that an installed copy can tell a real update
from anything else offered at the same URL: `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public half lives in
`src-tauri/tauri.release.conf.json`, baked into every build, so the private half can never be
rotated without stranding everyone who has not updated yet; back up the key and its password
somewhere that is not the machine that generated them.

That file currently carries the placeholder `REPLACE_WITH_TAURI_SIGNER_PUBKEY`, and the keypair
behind it does not exist yet. Making it is a one-time step, run once by whoever owns the repository
and never again:

```
pnpm tauri signer generate -w ~/.tauri/margin-docs.key
```

It asks for a password, writes the private key to that path and the public key beside it as
`margin-docs.key.pub`, and prints both. The public one replaces the placeholder in
`tauri.release.conf.json` and is committed. The private one is the contents of
`~/.tauri/margin-docs.key`, pasted into `TAURI_SIGNING_PRIVATE_KEY`, with its password in
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Neither the key file nor the password goes into the
repository.

Six more secrets codesign and notarize the bundle, and unlike the two above they are optional as
far as the workflow is concerned: with none of them set the build still runs, still publishes, and
produces an ad hoc signed app. `APPLE_CERTIFICATE` is the Developer ID Application certificate
exported from Keychain Access as a `.p12` and base64 encoded (`base64 -i certificate.p12`), with
the password it was exported under in `APPLE_CERTIFICATE_PASSWORD`. `APPLE_SIGNING_IDENTITY` is the
certificate's full name, which looks like `Developer ID Application: Your Name (TEAMID)`. The other
three are for notarization: `APPLE_ID` is the Apple account's email address, `APPLE_PASSWORD` is an
app-specific password made at appleid.apple.com rather than the account password itself, and
`APPLE_TEAM_ID` is the ten character team identifier.

Those six are all or nothing. A repository with a certificate but no notarization credentials fails
the build rather than warning, because a signed bundle that has not been notarized is one Gatekeeper
refuses on any machine that has not seen it before, and finding that out from a user is worse than
finding it out from a red run.

The bundle asks for the hardened runtime, which notarization requires, and for no entitlements at
all. That is worth a sentence because it nearly went the other way. Deleting a document goes to the
Trash through the `trash` crate, whose macOS default is to ask Finder over an Apple event, and the
hardened runtime blocks an Apple event unless the bundle carries
`com.apple.security.automation.apple-events` and the user agrees to a permission prompt about
controlling Finder. `src-tauri/src/fs.rs` asks for `trashItemAtURL:` instead, which needs none of
that. The cost is Put Back, which the Finder method leaves on the file and this one does not; the
file is still in the Trash and can still be dragged out of it.

Beyond signing there is nothing to provision. Margin Docs talks to no external API and holds no
OAuth client, unlike margin-calendar, so there are no other repository secrets and nothing
equivalent to a `google-credentials.json` to embed at build time.

## Updates

Installed copies check
`https://github.com/priyanshujain/margin-docs/releases/latest/download/latest.json` and update
themselves from it. `--latest` on the publish step is what moves that pointer, so a release that
fails the manifest check stays a draft and no one is offered a broken update. The app checks that
URL once a day in the background and on the Check for Updates menu item, and either way what
happens next is a dialog rather than an install: the version, the release notes, the download with
a progress bar, and Later as a real answer.

Self-update does not work yet, and it will not until there is an Apple Developer ID certificate.
This is not a gap in the workflow, which is wired for one, or in the app, which is wired for the
whole flow. It is macOS: an update replaces the installed bundle with the downloaded one, and the
system will not let an ad hoc signed bundle take the place of a signed one, nor run a replacement
whose signature does not match what was there before. Every build this repository can currently
produce is ad hoc signed, so every self-update attempt ends in a bundle the system refuses to
launch. Until the certificate exists, updates are something to install by hand, and the honest
version of the feature is that the app will find the update, show it, download it, and fail on the
last step.

There is a second thing gated behind the same certificate. The build is not notarized either, so a
copy downloaded from the releases page is quarantined by the browser and refused on first launch
with the message about an unidentified developer. Both problems have the one fix.
