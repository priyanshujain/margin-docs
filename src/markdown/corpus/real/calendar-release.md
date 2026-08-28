# Releasing

## Installing locally

`just install` builds the app for whatever machine you are sitting at and puts it where that
machine expects to find applications: `/Applications` on macOS, or the package manager on Linux.
It is the same command whether or not the app is already installed, so it doubles as the update.
On macOS it asks a running copy to quit first, because replacing a bundle under a live process
leaves it half old and half new. `just uninstall` reverses it and leaves the data directory alone.

The local build skips the dmg and builds only the `.app`, since nothing about copying a bundle
into place needs a disk image and building one is the slowest part of a mac bundle. That makes a
locally installed app slightly different from a released one, in that it is ad-hoc signed and has
no updater artifacts. It will not update itself. Rerun `just install`.

## Cutting a release

Releases are manual: run the **Release** workflow from the Actions tab. Leave the version empty to
bump the patch number, or give one to set it. The workflow bumps `tauri.conf.json`, `package.json`
and `Cargo.toml` together, commits that to main, tags it, and builds the tag rather than whatever
main happens to be by then.

It builds a universal macOS bundle and an x86_64 Linux one, and it publishes nothing until both
have landed. The last job downloads `latest.json` and refuses to take the release out of draft
unless `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64` are all in it. A half-populated
manifest is worse than no release: the updater would offer an update to the platforms that made it
and error on the ones that did not.

Linux builds on Ubuntu 22.04 on purpose. The bundle will not run on anything older than the glibc
it was linked against, and 22.04 is the baseline [setup.md](setup.md) commits to.

Windows is not built. The bundle targets in `tauri.conf.json` are the mac and Linux ones, and the
app has never claimed Windows. Adding it is a runner in the build matrix and `msi`/`nsis` in the
targets, at which point the publish gate wants `windows-x86_64` too.

Phones do not come from this pipeline at all. The store is their update channel, and what building
for one takes is in [mobile.md](mobile.md).

## Arch

Arch gets its own package, `margin-calendar-bin` on the AUR, pushed by the release workflow after
the manifest check passes. It is worth the extra moving part: the AppImage bundles Ubuntu's GTK
stack, and a bundled `libwayland-client` cannot talk to a current compositor, so on Hyprland the
AppImage silently falls back to Xwayland. The packaged build links against the system
`webkit2gtk-4.1` and runs as a native Wayland client.

It is a binary package by necessity rather than laziness. The Google OAuth client is embedded at
compile time from a file that is deliberately not in the repo, so anything built from source on
someone else's machine would run and then tell them Google Calendar is not set up. The PKGBUILD
therefore repackages the published `.deb`, whose payload is already a normal `/usr` tree.

`packaging/aur/PKGBUILD.in` is the template. The workflow fills in the version and the sha256 of
the artifact that was actually published, generates `.SRCINFO` with `makepkg` in an Arch container,
and pushes to `ssh://aur@aur.archlinux.org/margin-calendar-bin.git` using `AUR_SSH_PRIVATE_KEY`.
Without that secret the job renders the package, says so, and does not fail the release.

The `license=('custom')` line is a placeholder for the fact that this repo has no licence file at
all. Nothing stops the package publishing, but a package on the AUR that nobody has licensed is
worth fixing before anyone else builds on it.

## What the build needs

Three repository secrets, all already set:

- `GOOGLE_CREDENTIALS`, the contents of the real `google-credentials.json`. The build writes it to
  the repo root and `build.rs` embeds it. Without it the build quietly falls back to the example
  file and warns, which produces an app that runs and then says Google Calendar is not set up.
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which sign the updater
  artifacts. The public half is in `tauri.release.conf.json` and is baked into every build, so the
  private half can never be rotated without stranding everyone who has not updated yet. It lives
  in `~/.tauri/margin_calendar_updater.key` next to margin's; that copy and the password beside it
  are the only ones, so back them up somewhere that is not this machine.

The OAuth client secret ends up inside the shipped binary. That is how installed apps work and
Google does not treat it as confidential: an installed client cannot keep a secret, which is why
the flow uses PKCE and why the token exchange is safe without one.

## Updates

Installed copies check
`https://github.com/priyanshujain/margin-calendar/releases/latest/download/latest.json` and update
themselves from it. `--latest` on the publish step is what moves that pointer, so a release that
fails the manifest check stays a draft and no one is offered a broken update.
