// A dev-only folder of documents, held in memory. It exists so the real UI can be opened in a
// plain browser with no Tauri behind it, by a person or by Playwright, without pointing the app at
// anybody's actual files.
//
// It is shaped like a folder somebody would really have rather than three files called test.md,
// because every interesting case in this app is a case the tree has to render: nesting several
// levels deep, a .txt that is editable, a .png that is not, an assets folder beside a document,
// frontmatter, a callout, a table, a toggle, a code block, and relative links between documents
// so backlinks have something to find.
//
// Anchored to the current time at load, so the tree never shows a modified date from last year.

import type { FileKind, RootInfo } from "../ipc";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const now = Date.now();

/** One file or directory. `text` is empty for a directory and for anything binary. */
export interface DevEntry {
  path: string;
  dir: boolean;
  text: string;
  /** Not a text file. Greyed in the tree, opened by the system, refused by `file_read`. */
  binary: boolean;
  modifiedMs: number;
}

export const HANDBOOK = "/Users/you/Documents/Handbook";
export const SCRATCH = "/Users/you/Documents/Scratch";

/** Stable for a given path, the way the Rust side derives a root id from the folder it opened. */
export const rootIdFor = (path: string): string =>
  path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const devRoots: RootInfo[] = [
  { id: rootIdFor(HANDBOOK), path: HANDBOOK, name: "Handbook", openedMs: now - 6 * DAY },
  { id: rootIdFor(SCRATCH), path: SCRATCH, name: "Scratch", openedMs: now - 2 * HOUR },
];

const readme = `---
title: Handbook
updated: 2026-02-11
tags: [team, reference]
---

# Handbook

Everything the team needs, in one folder, in plain markdown. Nothing here is generated and nothing
here needs an account to read.

Start with [Getting started](guides/getting-started.md). Skim [Writing](guides/writing.md) before
you open your first pull request, and keep the
[keyboard reference](reference/keyboard.md) somewhere you can see it.

## What lives where

Guides are the things you read once. The reference is the thing you come back to. Anything under
\`archive/\` is kept because deleting it would lose the argument, not because it is still true.
`;

const gettingStarted = `---
title: Getting started
tags: [onboarding]
---

# Getting started

Clone the repository and run the app once before you change anything. It is much easier to read a
diff when you have seen the thing the diff is about.

\`\`\`sh
git clone git@github.com:example/handbook.git
cd handbook
pnpm install
pnpm dev
\`\`\`

> [!NOTE]
> The first run builds the search index. On a folder this size it takes a second or two, and quick
> open stays empty until it finishes.

## Your editor

Any editor is fine. Two settings are not optional: trim trailing whitespace, and end every file
with a newline. Without them every pull request carries noise nobody wrote.

> [!WARNING]
> Do not edit anything under \`archive/\`. Those documents are kept as a record and a change there
> will not be reviewed.

When something is bound to a key, [the keyboard reference](../reference/keyboard.md) is the list.
`;

const writing = `---
title: Writing
---

# Writing

Short sentences. Say the thing, then stop. If a paragraph is doing two jobs, it is two paragraphs.

## What the editor does with what you type

| You write | On disk | In the editor |
| --- | --- | --- |
| A note | \`> [!NOTE]\` | a tinted block with a title |
| A toggle | \`<details>\` | a disclosure arrow |
| A link | \`[text](path.md)\` | underlined, click to follow |
| A table | pipes and dashes | a real table with a header row |

The file on disk stays plain markdown. Anything the editor cannot model is left exactly as it was
found and shown as a raw block you can still edit.

<details>
<summary>House style, the short version</summary>

No em dashes. No exclamation marks. Do not start a sentence with "Basically". If you catch
yourself writing "simply", delete it and read the sentence again.

</details>

## Before you open a pull request

Read it out loud once. Then read [Getting started](getting-started.md) if you have not, because
half of what gets flagged in review is covered there already, and check the
[handbook index](../README.md) still points at your new page.
`;

const keyboard = `---
title: Keyboard reference
---

# Keyboard reference

| Key | Does |
| --- | --- |
| \`Cmd P\` | Quick open, fuzzy match on the whole path |
| \`Cmd Shift F\` | Search the text of every open folder |
| \`Cmd S\` | Save |
| \`Cmd N\` | New document, in the selected folder |
| \`Cmd O\` | Open a folder |
| \`Cmd \\\` | Show or hide the sidebar |
| \`Cmd B\` | Bold |
| \`Cmd K\` | Command palette |

Nothing here is configurable yet. If a key is wrong for you, say so and it can move.
`;

const retro = `---
title: 2024 retro
archived: true
---

# 2024 retro

Kept for the record. Most of this is out of date and none of it should be edited.

## What went well

Shipping small and often. The three week gap in July is the only stretch nobody enjoyed, and it
was the week the build broke twice.

## What did not

Documentation drifted from the code for most of the second half of the year, which is the reason
this folder exists at all.
`;

const notes = `Scratch notes, not markdown, still editable.

Ask about the archive folder. Nobody seems to know who owns it.
Chase the design review before Thursday.
The index rebuild takes longer than it should on the big folder.
`;

const inbox = `# Inbox

Things that have not found a home yet.

- Move the keyboard reference into the guides folder, or do not, but decide.
- A callout for "deprecated" would be useful.
- Check whether the .txt files should be indexed too.
`;

const todo = `Buy a new keyboard
Reply to the design review thread
Rebuild the index after the folder move
`;

/**
 * A one pixel PNG. The point of it is the tree row, not the image: it proves a file the editor
 * will not open is greyed and hands itself to the system instead.
 */
export const devPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const dir = (path: string, modifiedMs: number): DevEntry => ({
  path,
  dir: true,
  text: "",
  binary: false,
  modifiedMs,
});

const file = (path: string, text: string, modifiedMs: number): DevEntry => ({
  path,
  dir: false,
  text,
  binary: false,
  modifiedMs,
});

export const devEntries: DevEntry[] = [
  dir(HANDBOOK, now - 20 * MINUTE),
  file(`${HANDBOOK}/README.md`, readme, now - 20 * MINUTE),
  dir(`${HANDBOOK}/guides`, now - 3 * HOUR),
  file(`${HANDBOOK}/guides/getting-started.md`, gettingStarted, now - 3 * HOUR),
  file(`${HANDBOOK}/guides/writing.md`, writing, now - 2 * DAY),
  dir(`${HANDBOOK}/reference`, now - 5 * DAY),
  file(`${HANDBOOK}/reference/keyboard.md`, keyboard, now - 5 * DAY),
  dir(`${HANDBOOK}/reference/assets`, now - 5 * DAY),
  {
    path: `${HANDBOOK}/reference/assets/diagram.png`,
    dir: false,
    text: "",
    binary: true,
    modifiedMs: now - 5 * DAY,
  },
  dir(`${HANDBOOK}/archive`, now - 200 * DAY),
  dir(`${HANDBOOK}/archive/2024`, now - 200 * DAY),
  file(`${HANDBOOK}/archive/2024/retro.md`, retro, now - 200 * DAY),
  file(`${HANDBOOK}/notes.txt`, notes, now - 45 * MINUTE),
  dir(SCRATCH, now - 90 * MINUTE),
  file(`${SCRATCH}/inbox.md`, inbox, now - 90 * MINUTE),
  file(`${SCRATCH}/todo.txt`, todo, now - 8 * HOUR),
];

export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export const dirName = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

export const joinPath = (parent: string, name: string): string =>
  parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;

export const extensionOf = (path: string): string => {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function kindOf(entry: DevEntry): FileKind {
  if (entry.dir) return "dir";
  const ext = extensionOf(entry.path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt") return "text";
  return "other";
}

export const editableKind = (kind: FileKind): boolean => kind === "markdown" || kind === "text";

/** Frontmatter title first, then the first heading, then the filename. What the Rust index does. */
export function titleOf(path: string, text: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  const titled = front && /^title:\s*(.+)$/m.exec(front[1]);
  if (titled) return titled[1].trim().replace(/^["']|["']$/g, "");
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading) return heading[1].trim();
  return baseName(path);
}

/** Resolves `](../thing.md)` against the document that wrote it. Null for anything not local. */
export function resolveRelative(fromFile: string, target: string): string | null {
  if (!target || /^[a-z]+:/i.test(target) || target.startsWith("#")) return null;
  const clean = target.split("#")[0].split("?")[0];
  if (!clean) return null;
  const parts = clean.startsWith("/") ? clean.split("/") : `${dirName(fromFile)}/${clean}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
