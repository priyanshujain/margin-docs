// The updater, from the frontend's side: asking whether there is one, downloading it with progress
// somebody can watch, and relaunching without losing an edit made half a second ago.
//
// `relaunch()` does not go through the window close handler that protects a dirty buffer, so
// anything here that relaunches flushes a pending save first.
//
// Everything Tauri-shaped lives here and the state it produces lives in src/store/useUpdate.ts,
// which is what the dialog and the settings panel read. The one thing that cannot go in that store
// is `offered` below: the value `check()` hands back is a resource handle, a number with a download
// behind it on the Rust side, so it is held here for as long as the dialog is open and closed when
// the dialog is not.

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { flushPendingSave } from "./document";
import { isDesktop, isTauri } from "./ipc";
import { useUpdate } from "./store/useUpdate";
import { notify } from "./store/useToast";

/**
 * A dev build has no `plugins.updater` in tauri.conf.json, so the plugin is never registered and
 * `check()` fails with a raw plugin error. That is a sentence about the build, not a fault, and it
 * reads as one.
 */
const NOT_ENABLED = "Updates are not enabled in this build.";

/** How stale the last check has to be before an automatic one is worth making on launch. */
const AUTOMATIC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long after launch the automatic check waits. The first paint, the session restore and the
 * first index pass all want the main thread and the network before anything asks GitHub a question
 * nobody has asked for.
 */
const LAUNCH_DELAY_MS = 6_000;

let offered: Update | null = null;

/**
 * Whether a rejection means "this build has no updater in it" rather than "the check failed".
 *
 * src-tauri/src/lib.rs registers the plugin only when the config it needs is present, so in a dev
 * build there is nothing behind `plugin:updater|check` and Tauri rejects it from its own plugin
 * store: `PluginStore::extend_api` formats exactly `plugin updater not found`. The ACL arrives at
 * the same fact from the other side, ending its longer sentence with `Plugin not found`, for a
 * build whose capability no longer grants `updater:default`. Both mean the same thing to somebody
 * looking at the screen and neither is theirs to act on, so both become the one sentence above.
 *
 * Matched against the exact strings rather than against the word "updater", which also appears in
 * every ordinary failure this function has to let through: a bad signature, an unreachable endpoint
 * and a malformed manifest all name the plugin in their message.
 */
function updaterMissing(e: unknown): boolean {
  const message = String(e);
  return message === "plugin updater not found" || message.endsWith("Plugin not found");
}

async function runCheck(quiet: boolean): Promise<void> {
  // The updater and the process plugin are both desktop-only, in lib.rs and in the capability, so
  // on a phone and in a browser this is a fact about the build rather than a command that failed.
  if (!isDesktop) {
    if (!quiet) notify(NOT_ENABLED);
    return;
  }
  // Anything other than idle is a check already running or a dialog already answering the last one.
  if (useUpdate.getState().phase !== "idle") return;

  useUpdate.getState().begin();
  try {
    const update = await check();
    useUpdate.getState().markChecked();
    if (!update) {
      useUpdate.getState().dismiss();
      if (!quiet) notify("Margin Docs is up to date");
      return;
    }
    offered = update;
    useUpdate.getState().offer(update.version, update.body ?? null);
  } catch (e) {
    useUpdate.getState().dismiss();
    if (quiet) return;
    notify(updaterMissing(e) ? NOT_ENABLED : `Could not check for updates: ${String(e)}`);
  }
}

/**
 * The `check-updates` command, and the button in the settings panel. Says something either way:
 * somebody who pressed it is owed an answer even when the answer is that there is nothing to do.
 */
export async function checkForUpdates(): Promise<void> {
  await runCheck(false);
}

/**
 * The same check, made on the app's own initiative and saying nothing unless there is an update to
 * show. Off entirely when the user has turned the preference off, and skipped when the last check
 * is recent enough that another one would only be noise.
 *
 * Returns its own cancel, so a shell that unmounts before the delay is up does not leave a check
 * behind it.
 */
export function startUpdateChecks(): () => void {
  const { automatic, lastChecked } = useUpdate.getState();
  if (!isDesktop || !automatic) return () => {};
  if (lastChecked !== null && Date.now() - lastChecked < AUTOMATIC_INTERVAL_MS) return () => {};
  const timer = window.setTimeout(() => void runCheck(true), LAUNCH_DELAY_MS);
  return () => window.clearTimeout(timer);
}

/**
 * Downloads the update the dialog is showing and restarts into it.
 *
 * The progress callback is the whole reason this is not one line: `downloadAndInstall` reports
 * every chunk and the dialog draws them, so a hundred megabytes over a slow connection is a bar
 * moving rather than an app that has stopped answering.
 *
 * Nothing runs after `relaunch()`, which is why the flush is in front of it. The window close
 * handler in src/App.tsx is what normally saves a buffer half a second old, and a relaunch does not
 * go anywhere near it.
 */
export async function installUpdate(): Promise<void> {
  const update = offered;
  if (update === null) return;

  let downloaded = 0;
  let total: number | null = null;
  useUpdate.getState().progress(0, null);
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        useUpdate.getState().progress(0, total);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        useUpdate.getState().progress(downloaded, total);
      } else {
        // The bytes are in and the bundle is being swapped over. There is no number for this part
        // and it is not instant, so it is a phase rather than a bar sitting full.
        useUpdate.getState().installing();
      }
    });
    offered = null;
    await flushPendingSave();
    await relaunch();
  } catch (e) {
    useUpdate.getState().failed(String(e));
  }
}

/** Later, Escape, or the close button. The handle goes with the dialog. */
export function dismissUpdate(): void {
  const update = offered;
  offered = null;
  useUpdate.getState().dismiss();
  if (update !== null) void update.close().catch(() => {});
}

/**
 * What the running bundle says its version is, which is the number the updater compares against the
 * manifest. Asked of Tauri rather than read out of package.json so that the settings panel cannot
 * disagree with the app it is inside. Null in a browser, where there is no bundle to ask.
 */
export async function appVersion(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    return await getVersion();
  } catch {
    return null;
  }
}
