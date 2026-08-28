// Following a link out of a document.
//
// A relative link to another file is the only kind this app resolves itself, and it resolves it
// against the document that wrote it rather than against anything the shell knows: a markdown file
// is portable, and `](../reference/keyboard.md)` means the same thing here as it does in every
// other editor that folder is opened in. A document that opens this way is a navigation and goes
// into the same history the back and forward commands walk.
//
// Everything else is the system's: an http link goes to the browser, and a relative link to a file
// this editor does not open goes to whatever macOS opens it with. Nothing here writes anything, and
// a link to a file that is not there is a toast rather than a new file.

import { openUrl } from "@tauri-apps/plugin-opener";
import { openExternal } from "./api/roots";
import { isTauri } from "./ipc";
import { documentKindForPath } from "./model/doc";
import { useDocument } from "./store/useDocument";
import { notify } from "./store/useToast";

const dirName = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

const isAbsoluteUrl = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href);

/**
 * A link written by hand may hold a literal space; a link written by this app escapes one. Both
 * have to open the same file, so the href is decoded before it is resolved, and a percent sign
 * that is not a valid escape is left exactly as it was rather than throwing.
 */
function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * `href` as it sits in the file, resolved against the document that holds it. Null for anything
 * that is not a path: a bare fragment, a scheme, an empty string.
 */
export function resolveRelative(fromFile: string, href: string): string | null {
  if (!href || href.startsWith("#") || isAbsoluteUrl(href)) return null;
  const target = decodeTarget(href.split("#")[0].split("?")[0]);
  if (!target) return null;
  const parts = (target.startsWith("/") ? target : `${dirName(fromFile)}/${target}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * The inverse of `resolveRelative`: the href to write into `fromFile` so that it points at
 * `toFile`. Both are absolute paths.
 *
 * This is what the `[[` picker writes and what a move rewrites, and it is the one function in the
 * app that decides what a link between two documents looks like on disk. It never produces an
 * absolute path and never produces a bare filename that could be read as a scheme or a fragment: a
 * sibling comes back as `./thing.md` rather than `thing.md`, because the leading `./` is what
 * makes it unambiguous to every reader including this one.
 *
 * The result is percent-encoded only where it has to be. A space in a filename breaks a bare
 * markdown link, so it is escaped; nothing else is, because encoding a path that did not need it
 * makes the file worse to read for no gain.
 */
export function relativeFrom(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").filter(Boolean).slice(0, -1);
  const to = toFile.split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;

  const up = Array(from.length - shared).fill("..");
  const down = to.slice(shared);
  const parts = [...up, ...down];
  const href = up.length === 0 ? `./${parts.join("/")}` : parts.join("/");
  return href.replace(/ /g, "%20");
}

function toSystem(href: string): void {
  if (!isTauri) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  openUrl(href).catch(() => notify("Could not open that link"));
}

/** A click on a link inside the open document. */
export function openLink(href: string): void {
  const from = useDocument.getState().path;
  if (from === null) return;

  if (isAbsoluteUrl(href)) {
    toSystem(href);
    return;
  }
  // A bare fragment is a link into this document. There are no heading anchors yet, so following
  // one would be a guess, and guessing is worse than staying put.
  if (href.startsWith("#")) return;

  const target = resolveRelative(from, href);
  if (target === null) return;

  if (documentKindForPath(target) === null) {
    openExternal(target).catch((e) => notify(`Could not open ${target}: ${String(e)}`));
    return;
  }
  useDocument
    .getState()
    .open(target)
    .catch((e) => notify(`Could not open ${target}: ${String(e)}`));
}
