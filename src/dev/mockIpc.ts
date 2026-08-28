// Serves the IPC surface from the dev fixture when the app is opened in a browser rather than in
// Tauri. This exists so the real UI can be driven and looked at, by a person or by Playwright,
// without a build of the Rust side and without pointing the app at real documents.
//
// It is reachable only when `import.meta.env.DEV` is true and `isTauri` is false, so it is absent
// from a production bundle and can never shadow the real backend inside the app.
//
// Writes mutate the fixture for the session, so creating a document and typing into it behaves
// the way it will on disk.
//
// `external` at the bottom is the other half: the world outside the app, for a test that needs a
// file to change while the app is looking at it. It mutates the fixture the way another program
// would, behind the app's back and without going through `file_write`, and hands back the exact
// `WatchEvent` payloads the Rust watcher would have emitted for what it did. Emitting them is the
// caller's job, because emitting means the Tauri event bus and this module has no opinion about
// where that comes from. src-tauri/tests/watch_payload.rs is what keeps those payloads honest.

import type {
  AssetResult,
  Backlink,
  FileNode,
  IndexStatus,
  MatchRange,
  QuickOpenHit,
  ReadResult,
  RootInfo,
  SearchHit,
  SpellIssue,
  WatchEvent,
  WriteResult,
} from "../ipc";
import {
  baseName,
  devEntries,
  devRoots,
  dirName,
  editableKind,
  extensionOf,
  joinPath,
  kindOf,
  resolveRelative,
  rootIdFor,
  titleOf,
  type DevEntry,
} from "./fixture";

const entries = new Map<string, DevEntry>(devEntries.map((e) => [e.path, { ...e }]));
const roots: RootInfo[] = devRoots.map((r) => ({ ...r }));

/** Roots with a watch running, so `external` can refuse to invent an event nobody subscribed to. */
const watching = new Set<string>();

/**
 * A modification time that is always newer than the last one handed out. `Date.now()` twice in the
 * same millisecond is two writes the app cannot tell apart, and telling them apart is the entire
 * mechanism behind conflict detection and the reload guard.
 */
let lastStamp = 0;
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Held writes, for a test that needs a buffer to stay dirty while something else touches disk. */
let writeGate: Promise<void> | null = null;
let openGate: (() => void) | null = null;

/**
 * A first launch, which the fixture otherwise has no way to show: it is seeded with two open
 * folders, so the empty state somebody new actually opens on was the one screen nobody could look
 * at. With this set there are no roots and the tree comes back empty.
 */
const firstRun = (): boolean => {
  try {
    return localStorage.getItem("margindocs-dev-empty") === "1";
  } catch {
    return false;
  }
};

function entryAt(path: string): DevEntry {
  const entry = entries.get(path);
  if (!entry) throw new Error(`no such file: ${path}`);
  return entry;
}

function rootFor(path: string): RootInfo | undefined {
  return roots.find((r) => path === r.path || path.startsWith(`${r.path}/`));
}

const relTo = (root: RootInfo, path: string): string => path.slice(root.path.length + 1);

function childrenOf(path: string): DevEntry[] {
  const prefix = `${path}/`;
  return [...entries.values()]
    .filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"))
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
    });
}

function nodeFor(entry: DevEntry): FileNode {
  const kind = kindOf(entry);
  return {
    path: entry.path,
    name: baseName(entry.path),
    kind,
    editable: editableKind(kind),
    modifiedMs: entry.modifiedMs,
    children: entry.dir ? childrenOf(entry.path).map(nodeFor) : [],
  };
}

/** Every descendant of a directory, the directory itself included, deepest last. */
function subtree(path: string): DevEntry[] {
  const prefix = `${path}/`;
  return [...entries.values()].filter((e) => e.path === path || e.path.startsWith(prefix));
}

/** `name` is a suggestion. A taken one gets a numbered suffix, the way the Rust side does it. */
function freePath(parent: string, name: string): string {
  const candidate = joinPath(parent, name);
  if (!entries.has(candidate)) return candidate;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const next = joinPath(parent, `${stem} ${n}${ext}`);
    if (!entries.has(next)) return next;
  }
}

function put(entry: DevEntry): DevEntry {
  entries.set(entry.path, entry);
  return entry;
}

/** Moves an entry and everything under it, which is the same operation for a rename and a move. */
function relocate(from: string, to: string): DevEntry {
  for (const entry of subtree(from)) {
    entries.delete(entry.path);
    entries.set(entry.path === from ? to : to + entry.path.slice(from.length), {
      ...entry,
      path: entry.path === from ? to : to + entry.path.slice(from.length),
    });
  }
  return entryAt(to);
}

const textFiles = (): DevEntry[] =>
  [...entries.values()].filter((e) => !e.dir && !e.binary && editableKind(kindOf(e)));

/** Subsequence match, the cheap kind quick open wants: every query character in order. */
function fuzzy(haystack: string, query: string): { score: number; ranges: MatchRange[] } | null {
  const lower = haystack.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, ranges: [] };
  const ranges: MatchRange[] = [];
  let at = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const found = lower.indexOf(character, at);
    if (found < 0) return null;
    // Runs read as a word and score far better than the same letters scattered over a path.
    score += found === previous + 1 ? 8 : 1;
    if (found > lower.lastIndexOf("/")) score += 4;
    const last = ranges[ranges.length - 1];
    if (last && last.end === found) last.end = found + 1;
    else ranges.push({ start: found, end: found + 1 });
    previous = found;
    at = found + 1;
  }
  return { score: score - Math.floor(haystack.length / 10), ranges };
}

/** A window of the line around the first match, so a long line does not fill the results list. */
function snippetAround(line: string, start: number, length: number) {
  const from = Math.max(0, start - 32);
  const head = from > 0 ? "…" : "";
  const body = line.slice(from, from + 160);
  const tail = from + 160 < line.length ? "…" : "";
  return {
    snippet: `${head}${body}${tail}`,
    range: { start: head.length + (start - from), end: head.length + (start - from) + length },
  };
}

/**
 * The whole vocabulary of the dev spell checker. Real spelling comes from the system and this is
 * only ever a stand-in for a browser, so the list is short on purpose: it holds the words someone
 * exercising the feature is likely to type at it and nothing else.
 */
const DEV_MISSPELLINGS: Record<string, string[]> = {
  teh: ["the", "then", "tea"],
  recieve: ["receive", "relieve"],
  seperate: ["separate", "desperate"],
  occured: ["occurred"],
  definately: ["definitely", "defiantly"],
  accomodate: ["accommodate"],
  wierd: ["weird", "wired"],
  begining: ["beginning"],
  neccessary: ["necessary"],
  publically: ["publicly"],
  writting: ["writing", "written"],
  markdwon: ["markdown"],
};

/** Words `spell_learn` was told about this session. The real checker teaches the whole machine. */
const devLearned = new Set<string>();

export async function mockCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const a = (args ?? {}) as Record<string, never>;
  switch (command) {
    case "roots_list":
      return (firstRun() ? [] : roots) as unknown as T;

    case "root_open": {
      const path = a.path as unknown as string;
      const existing = roots.find((r) => r.path === path);
      if (existing) return existing as unknown as T;
      const opened: RootInfo = {
        id: rootIdFor(path),
        path,
        name: baseName(path),
        openedMs: Date.now(),
      };
      roots.push(opened);
      if (!entries.has(path)) {
        put({ path, dir: true, text: "", binary: false, modifiedMs: Date.now() });
      }
      return opened as unknown as T;
    }

    case "root_close": {
      const id = a.rootId as unknown as string;
      const at = roots.findIndex((r) => r.id === id);
      if (at >= 0) roots.splice(at, 1);
      return undefined as T;
    }

    case "tree_read": {
      const root = roots.find((r) => r.id === (a.rootId as unknown as string));
      if (!root) throw new Error(`no such root: ${a.rootId as unknown as string}`);
      return nodeFor(entryAt(root.path)) as unknown as T;
    }

    case "reveal_in_finder":
    case "open_external":
      // Nothing to hand a file to in a browser tab, so say so rather than looking broken.
      console.info(`dev mock: ${command} ${a.path as unknown as string}`);
      return undefined as T;

    case "file_read": {
      const entry = entryAt(a.path as unknown as string);
      if (entry.dir || entry.binary) throw new Error(`not a text file: ${entry.path}`);
      return {
        path: entry.path,
        text: entry.text,
        modifiedMs: entry.modifiedMs,
      } satisfies ReadResult as unknown as T;
    }

    case "file_write": {
      // Held only when a test has asked for it, so a buffer can be observed dirty while something
      // outside the app changes the same file.
      if (writeGate) await writeGate;
      const entry = entryAt(a.path as unknown as string);
      const expected = a.expectedModifiedMs as unknown as number | undefined;
      if (typeof expected === "number" && expected !== entry.modifiedMs) {
        return {
          path: entry.path,
          modifiedMs: entry.modifiedMs,
          conflict: true,
        } satisfies WriteResult as unknown as T;
      }
      entry.text = a.text as unknown as string;
      entry.modifiedMs = stamp();
      return {
        path: entry.path,
        modifiedMs: entry.modifiedMs,
        conflict: false,
      } satisfies WriteResult as unknown as T;
    }

    case "file_create": {
      const path = freePath(a.parentPath as unknown as string, a.name as unknown as string);
      return nodeFor(
        put({ path, dir: false, text: "", binary: false, modifiedMs: stamp() }),
      ) as unknown as T;
    }

    case "file_folder_create": {
      const path = freePath(a.parentPath as unknown as string, a.name as unknown as string);
      return nodeFor(
        put({ path, dir: true, text: "", binary: false, modifiedMs: stamp() }),
      ) as unknown as T;
    }

    case "file_rename": {
      const from = a.path as unknown as string;
      return nodeFor(
        relocate(from, freePath(dirName(from), a.name as unknown as string)),
      ) as unknown as T;
    }

    case "file_move": {
      const from = a.path as unknown as string;
      const to = freePath(a.destDir as unknown as string, baseName(from));
      return nodeFor(relocate(from, to)) as unknown as T;
    }

    case "file_duplicate": {
      const source = entryAt(a.path as unknown as string);
      const ext = extensionOf(source.path);
      const stem = ext ? baseName(source.path).slice(0, -(ext.length + 1)) : baseName(source.path);
      const path = freePath(dirName(source.path), ext ? `${stem} copy.${ext}` : `${stem} copy`);
      return nodeFor(put({ ...source, path, modifiedMs: stamp() })) as unknown as T;
    }

    case "file_trash": {
      for (const entry of subtree(a.path as unknown as string)) entries.delete(entry.path);
      return undefined as T;
    }

    case "asset_write": {
      const folder = joinPath(dirName(a.docPath as unknown as string), "assets");
      if (!entries.has(folder)) {
        put({ path: folder, dir: true, text: "", binary: false, modifiedMs: stamp() });
      }
      const path = freePath(folder, (a.name as unknown as string) || "image.png");
      put({ path, dir: false, text: "", binary: true, modifiedMs: stamp() });
      return {
        path,
        relPath: `assets/${baseName(path)}`,
      } satisfies AssetResult as unknown as T;
    }

    case "watch_start":
      watching.add(a.rootId as unknown as string);
      return undefined as T;

    case "watch_stop":
      watching.delete(a.rootId as unknown as string);
      return undefined as T;

    case "index_rebuild":
    case "index_status": {
      const total = textFiles().length;
      return {
        phase: "idle",
        indexed: total,
        total,
        lastIndexed: Date.now(),
        error: null,
        message: null,
      } satisfies IndexStatus as unknown as T;
    }

    case "search_quick_open": {
      const query = a.query as unknown as string;
      const limit = (a.limit as unknown as number) ?? 30;
      const hits: QuickOpenHit[] = [];
      for (const entry of textFiles()) {
        const root = rootFor(entry.path);
        if (!root) continue;
        const relPath = relTo(root, entry.path);
        const match = fuzzy(relPath, query);
        if (!match) continue;
        hits.push({
          path: entry.path,
          name: baseName(entry.path),
          root: root.id,
          relPath,
          score: match.score,
          ranges: match.ranges,
        });
      }
      return hits.sort((x, y) => y.score - x.score).slice(0, limit) as unknown as T;
    }

    case "search_text": {
      const query = (a.query as unknown as string) ?? "";
      const limit = (a.limit as unknown as number) ?? 100;
      const needle = query.toLowerCase();
      const hits: SearchHit[] = [];
      if (!needle.trim()) return [] as unknown as T;
      for (const entry of textFiles()) {
        const root = rootFor(entry.path);
        if (!root) continue;
        const title = titleOf(entry.path, entry.text);
        entry.text.split("\n").forEach((line, index) => {
          const at = line.toLowerCase().indexOf(needle);
          if (at < 0 || hits.length >= limit) return;
          const { snippet, range } = snippetAround(line, at, needle.length);
          hits.push({
            path: entry.path,
            root: root.id,
            title,
            line: index + 1,
            snippet,
            ranges: [range],
          });
        });
      }
      return hits.slice(0, limit) as unknown as T;
    }

    case "backlinks_for": {
      const target = a.path as unknown as string;
      const found: Backlink[] = [];
      for (const entry of textFiles()) {
        if (entry.path === target || kindOf(entry) !== "markdown") continue;
        const lines = entry.text.split("\n");
        const line = lines.find((text) =>
          [...text.matchAll(/\]\(([^)\s]+)\)/g)].some(
            (m) => resolveRelative(entry.path, m[1]) === target,
          ),
        );
        if (line === undefined) continue;
        found.push({
          path: entry.path,
          title: titleOf(entry.path, entry.text),
          snippet: line.trim(),
        });
      }
      return found as unknown as T;
    }

    // Spelling in a browser is not the system checker and cannot be: NSSpellChecker is not
    // reachable from a page. What it is instead is a fixed list of misspellings, which is enough to
    // put a real underline under a real word and open a real menu of suggestions over it. A dev
    // fixture that flagged every word it did not recognise would need a dictionary, and shipping
    // one here to exercise a feature whose whole point is not shipping one would be absurd.
    case "spell_available":
      return true as unknown as T;

    case "spell_check": {
      const text = (a.text as unknown as string) ?? "";
      const issues: SpellIssue[] = [];
      for (const match of text.matchAll(/[\p{L}']+/gu)) {
        const word = match[0];
        const guesses = DEV_MISSPELLINGS[word.toLowerCase()];
        if (guesses === undefined || devLearned.has(word.toLowerCase())) continue;
        issues.push({
          start: match.index,
          end: match.index + word.length,
          word,
          // Matching the case of what was typed, because a suggestion that comes back lower case
          // for a word opening a sentence is a correction the user then has to correct.
          suggestions: guesses.map((guess) =>
            word[0] === word[0].toUpperCase() ? guess[0].toUpperCase() + guess.slice(1) : guess,
          ),
        });
      }
      return issues as unknown as T;
    }

    case "spell_learn":
      devLearned.add((a.word as unknown as string).toLowerCase());
      return undefined as T;

    case "spell_unlearn":
      devLearned.delete((a.word as unknown as string).toLowerCase());
      return undefined as T;

    default:
      throw new Error(`dev mock has no handler for ${command}`);
  }
}

/**
 * The world outside the app: what another program does to the folder while it is open.
 *
 * Every function here mutates the fixture directly rather than going through `mockCall`, which is
 * the point. A change made this way has not been through `file_write`, so nothing has registered a
 * self-write against it and nothing has told the open document its file moved on: it is a change
 * the app can only find out about from a watch event, exactly like a change made by vim or by a
 * git checkout.
 *
 * The return value is the `WatchEvent` list the Rust watcher would have emitted for that change,
 * in the order it would have emitted them. A rename is two events and not one, because FSEvents
 * describes the two ends as unrelated and src-tauri/src/watch.rs reports what it is told; see
 * `a_rename_is_reported_at_both_ends` in src-tauri/tests/watch.rs.
 *
 * A change to a root with no watch running is an error rather than an event. Nothing outside a
 * watched folder is reported to anybody, so a test that gets an event out of this has also proved
 * that opening the folder started the watch.
 */
function watchEventFor(
  path: string,
  kind: WatchEvent["kind"],
  oldPath: string | null = null,
): WatchEvent {
  const root = rootFor(path);
  if (!root) throw new Error(`no open root owns ${path}`);
  if (!watching.has(root.id)) throw new Error(`no watch is running on ${root.path}`);
  return { root: root.id, path, kind, oldPath };
}

export const external = {
  /** Another program rewrites the file. New bytes, new modification time. */
  write(path: string, text: string): WatchEvent[] {
    const entry = entryAt(path);
    entry.text = text;
    entry.modifiedMs = stamp();
    return [watchEventFor(path, "modified")];
  },

  /**
   * The same bytes, a newer modification time: `touch`, a git checkout that restores what was
   * already there, a backup tool. The watcher cannot tell this from a real edit and reports it as
   * one, which is why the app compares bytes and not just timestamps.
   */
  touch(path: string): WatchEvent[] {
    entryAt(path).modifiedMs = stamp();
    return [watchEventFor(path, "modified")];
  },

  /** An event with nothing behind it, for proving what the app does with a change that is not one. */
  signal(path: string, kind: WatchEvent["kind"]): WatchEvent[] {
    return [watchEventFor(path, kind)];
  },

  remove(path: string): WatchEvent[] {
    entryAt(path);
    const event = watchEventFor(path, "removed");
    for (const entry of subtree(path)) entries.delete(entry.path);
    return [event];
  },

  rename(from: string, to: string): WatchEvent[] {
    relocate(from, to);
    return [watchEventFor(from, "removed"), watchEventFor(to, "created")];
  },

  /** What is actually on disk now, for asserting that the app has written nothing it should not. */
  read(path: string): string | null {
    const entry = entries.get(path);
    return entry && !entry.dir ? entry.text : null;
  },

  exists(path: string): boolean {
    return entries.has(path);
  },

  /**
   * Holds every `file_write` until `resumeWrites`. A save that cannot land is how a test keeps a
   * buffer dirty for as long as it needs to, instead of racing the 500ms autosave.
   */
  pauseWrites(): void {
    if (writeGate) return;
    writeGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
  },

  resumeWrites(): void {
    openGate?.();
    writeGate = null;
    openGate = null;
  },
};
