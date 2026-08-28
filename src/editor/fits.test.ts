// Every way into this editor, against every place an edit can go wrong.
//
// This file is a matrix and not a list of cases, and it is the third one. The first version pinned
// the insert commands one by one, and the gap moved to the two inserts nobody had listed. The
// second version enumerated the insert commands off the editor handle so a new one could not be
// added unlisted, and the gap moved again, out of the inserts entirely: a block conversion with the
// caret in a raw block reformatted the user's own bytes into escaped markdown, the Heading menu's
// Paragraph item deleted the callout around the caret along with its label, an ordinary Cmd+V split
// a table in two, and a drop had no handler at all. Every one of those is an entry point into the
// document that the enumeration did not think was one.
//
// So this version enumerates entry points, not commands, and it asks the running editor for them
// rather than being told:
//
//   every method on the editor handle, off `createCommands` itself;
//   every keyboard chord, off every extension's `addKeyboardShortcuts`;
//   every ProseMirror prop that can change a document, off every extension's plugins.
//
// The first three tests below are the completeness ones, and they are the point of the file. A
// method, a chord or a handler added anywhere in the editor fails them until somebody has said what
// it does in each of the places listed in CONTEXTS. The rest of the file is that answer, executed:
// each entry point runs in each context and the assertion is made on the BYTES, through the real
// serializer, because a command that leaves the tree slightly rearranged and the file the same is
// not what this is protecting and a command that leaves the tree looking sound and the file
// rewritten is exactly what it is.
//
// Two things are worth knowing about the fixtures. When a handler declines, ProseMirror's own
// behaviour is run in its place, because "our handler did nothing" and "nothing happened" are
// different sentences and the second one is the one that matters. And the toggle summary is a
// context whose caret ProseMirror never holds: the title is a node view's own editable island, so
// the selection stays in the body and every command here acts on the body. The extra refusal that
// island needs belongs to src/editor/blocks/toggle.ts and is tested there.
//
// WHAT THIS FILE GOT WRONG, and the reason for `dispatch` below.
//
// Every version of this file until this one asked a handler by name. It found the clipboard plugin
// by its key, called `handlePaste` on it, and asserted on what came back. That proves what the
// guard ANSWERS. It cannot prove that the running editor ever ASKS it, and the running editor did
// not: ProseMirror offers a paste to the plugins in order and takes the first answer that is not
// false, prosemirror-tables came ninth in that list and this app's guard came fifteenth, so a real
// Cmd+V over a rectangle of dragged cells was answered by the library and replaced the contents of
// every cell in the rectangle. The suite was green the whole time, on a handler nothing called.
// That is the fourth guard this project has shipped that nothing called, and the fourth test that
// checked the answer instead of the reach.
//
// So nothing below calls a handler. Everything goes through `dispatch`, which is
// EditorView.prototype.someProp, borrowed off the library rather than written again here, because
// the walk it does IS the question: the props the component puts on the view, then the direct
// plugins, then the state's plugins in order, first non-false answer wins. A guard in the wrong
// place answers nothing and the test fails on the bytes. Proven by running it: against the paste.ts
// this replaced, the cell rectangle tests below fail with four cells emptied.
//
// And what is NOT real here, said plainly rather than left to be discovered. This suite runs in
// node with no DOM, so there is no EditorView to construct and no keydown, drop or Cmd+V to send to
// one; `document` is undefined and prosemirror-view cannot be instantiated without it. What is real
// is the extension list the app builds, the plugin list TipTap collects from it, the dispatcher
// that walks it, the fallback ProseMirror runs when nobody claims, and the bytes at the end. What
// is simulated is the event object and the slice on it, which the DOM would otherwise have built,
// and `posAtCoords`, which a drop needs and which nothing here can hit test. Sending a real
// Cmd+V through a real view needs a browser, and this repository has one: tests/ drives the app in
// Chromium against the dev IPC mock. A paste over a dragged rectangle belongs there as well, and is
// named in the report rather than added here, because that directory is not this lane's to write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, getExtensionField } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Plugin, Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { dropPoint } from "@tiptap/pm/transform";
import { EditorView } from "@tiptap/pm/view";
import { parseMarkdown, serializeMarkdown } from "../markdown";
import { createCommands, createEditorProps, createFind } from "./Editor";
import { createEditorExtensions } from "./extensions";
import { pasteKey } from "./paste";
import type { EditorHandle } from "./index";

// The one part of a paste that leaves this process. Mocked so the paste is otherwise the real one:
// the same handler, the same guard, the same insert, and a record of whether any bytes were sent to
// be written, which is the half of an unguarded paste that puts an orphan file in somebody's
// assets/ folder.
const writes: string[] = [];
vi.mock("../api/files", () => ({
  assetWrite: (docPath: string, _bytes: number[], name: string) => {
    writes.push(`${docPath}:${name}`);
    return Promise.resolve({ path: `/notes/assets/${name}`, relPath: `assets/${name}` });
  },
}));

/** Lets a handler's own promise chain run, since neither the paste nor the image insert awaits it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Handle = Omit<EditorHandle, "active">;

function makeEditor(content: JSONContent, onError: (message: string) => void = () => {}): Editor {
  const editor = new Editor({
    element: null,
    injectCSS: false,
    extensions: createEditorExtensions({ documentPath: () => "/notes/a.md", onError }),
    content,
  });
  // TipTap only installs the extensions' ProseMirror plugins when it mounts a view, and there is no
  // DOM here to mount into. Swapping in a state built with them is what src/editor/Editor.tsx does
  // on every document it installs, so this is the same editor the app runs, minus the screen.
  editor.view.updateState(
    EditorState.create({ doc: editor.state.doc, plugins: editor.extensionManager.plugins }),
  );
  return editor;
}

/**
 * An editor holding a real file, and the bytes that file would be written back as.
 *
 * `onError` is the app's own toast channel, passed through rather than swallowed, because a guard
 * that refuses an edit and says nothing is a Cmd+V that looks broken. One test reads it.
 */
function open(source: string, onError: (message: string) => void = () => {}) {
  const parsed = parseMarkdown(source, "/notes/a.md");
  const editor = makeEditor(parsed.doc.toJSON(), onError);
  return { editor, written: () => serializeMarkdown(parsed, editor.state.doc) };
}

/** The position just inside the first node of this type, which is where the caret is put. */
function startOf(editor: Editor, name: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === name) found = pos + 1;
    return found === null;
  });
  if (found === null) throw new Error(`no ${name} in the fixture`);
  return found;
}

function caretIn(editor: Editor, name: string, offset = 0): void {
  const pos = startOf(editor, name) + offset;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos))),
  );
}

/** The rectangle of whole cells a drag across a table makes. */
function dragCells(editor: Editor): void {
  const table = editor.state.doc.firstChild;
  if (!table) throw new Error("no table in the fixture");
  const map = TableMap.get(table);
  const anchor = 1 + map.positionAt(0, 0, table);
  const head = 1 + map.positionAt(map.height - 1, map.width - 1, table);
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, anchor, head)),
  );
}

/** Toggles below the top level, which is the one place src/markdown/parse.ts can read one back. */
function nestedToggles(doc: ProseMirrorNode): number {
  let total = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === "toggle" && doc.resolve(pos).depth > 0) total += 1;
  });
  return total;
}

function count(doc: ProseMirrorNode, name: string): number {
  let total = 0;
  doc.descendants((node) => {
    if (node.type.name === name) total += 1;
  });
  return total;
}

/**
 * The breaks the file has to be able to hold.
 *
 * A hard break with nothing after it in its block has no markdown spelling and never survives a
 * save, which is fine and is not what this counts: it is the half typed line somebody is in the
 * middle of, and the next character they type makes it a real break. A break with content after it
 * is a line the user has finished, and one of those going missing on the way to disk is the editor
 * showing a save that did not happen.
 */
function heldBreaks(doc: ProseMirrorNode): number {
  let total = 0;
  doc.descendants((parent) => {
    parent.forEach((child, _offset, index) => {
      if (child.type.name === "hardBreak" && index < parent.childCount - 1) total += 1;
    });
  });
  return total;
}

// The families, which are what a context answers about rather than answering about forty entry
// points one at a time. Every entry point below declares one, and adding a family means filling in
// a column for every context: a new kind of edit cannot be added without somebody saying what it
// does in a raw block.
type Family =
  | "insertBlock"
  | "insertInline"
  | "mark"
  | "link"
  | "convert"
  | "deepHeading"
  | "paragraph"
  | "wrap"
  | "toggleBlock"
  | "unwrap"
  | "paste"
  | "drop"
  | "type"
  | "break"
  | "split"
  | "indent"
  | "check"
  | "table"
  | "language"
  | "focus";

/**
 * "refuse" is the FILE coming back byte identical, which is almost always the document coming back
 * unchanged as well and is the assertion either way, because the bytes are what this file protects.
 * The exception is written on the two rows that carry it: a hard break with nothing after it is a
 * construct the serializer writes as nothing, so in a block that cannot have anything after it the
 * key reaches the document and never reaches the file. "act" is the other half of the same rule,
 * and it is what keeps a guard that refuses everywhere from passing this file. "either" is a family
 * whose members disagree here, and every one of them is a place where ProseMirror's own answer
 * about what fits differs between two commands that do the same sort of thing; the universal checks
 * still apply to all of them.
 */
type Outcome = "refuse" | "act" | "either";

interface Context {
  name: string;
  source: string;
  place: (editor: Editor) => void;
  outcome: Record<Family, Outcome>;
}

const TABLE = "| h1 | h2 |\n| -- | -- |\n| a  | b  |\n| c  | d  |\n";
const TOGGLE = "<details>\n<summary>My title</summary>\n\nhidden\n\n</details>\n";

const CONTEXTS: Context[] = [
  {
    name: "the caret in a table cell",
    source: TABLE,
    place: (editor) => caretIn(editor, "tableCell"),
    outcome: {
      insertBlock: "refuse",
      insertInline: "act",
      // A collapsed caret, so a mark command leaves a stored mark and no bytes. That is true of
      // every context here bar the two whose selection covers text.
      mark: "refuse",
      link: "act",
      convert: "refuse",
      deepHeading: "refuse",
      paragraph: "refuse",
      wrap: "refuse",
      toggleBlock: "refuse",
      unwrap: "refuse",
      paste: "act",
      drop: "refuse",
      type: "act",
      break: "refuse",
      split: "refuse",
      indent: "refuse",
      check: "refuse",
      table: "act",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "a dragged selection across table cells",
    source: TABLE,
    place: dragCells,
    outcome: {
      insertBlock: "refuse",
      insertInline: "refuse",
      mark: "act",
      link: "act",
      convert: "refuse",
      deepHeading: "refuse",
      paragraph: "refuse",
      wrap: "refuse",
      toggleBlock: "refuse",
      unwrap: "refuse",
      paste: "refuse",
      drop: "refuse",
      // A rectangle of whole cells is a selection of containers and not of text, so there is no
      // text for a character to replace and no one cell it belongs in. Left to ProseMirror it goes
      // to `Selection.replace`, which replaces every range in the selection: the letter lands in
      // the LAST cell of the rectangle and the other cells are emptied. Three keystrokes over a
      // dragged 2x2 body left four empty cells with "zqx" in the corner of them.
      type: "refuse",
      break: "refuse",
      split: "refuse",
      // Tab walks out of the last cell in the rectangle by making a row, which is
      // prosemirror-tables' own answer and is a row rather than a lost one; Shift-Tab from the
      // first cell has nowhere to walk to and does nothing.
      indent: "either",
      check: "refuse",
      table: "act",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "the caret inside a fenced code block",
    // Mid line, which is where a fence gets cut in two rather than merely pushed apart.
    source: "```js\nlet x = 1;\nlet y = 2;\n```\n",
    place: (editor) => caretIn(editor, "codeBlock", 2),
    outcome: {
      insertBlock: "refuse",
      insertInline: "refuse",
      mark: "refuse",
      link: "refuse",
      // A fence is not a raw block. Turning one into a paragraph or a list is a conversion the
      // user asked for and markdown can spell, and the toolbar has an item that says so.
      convert: "act",
      // Except into a heading deeper than level 2, which has no underlined spelling and so has
      // nowhere to put the second line of the fence.
      deepHeading: "refuse",
      paragraph: "act",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "refuse",
      type: "act",
      break: "act",
      split: "act",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "act",
      focus: "refuse",
    },
  },
  {
    name: "the caret inside a mermaid block",
    source: "```mermaid\ngraph TD\nA-->B\n```\n",
    place: (editor) => caretIn(editor, "codeBlock", 2),
    outcome: {
      insertBlock: "refuse",
      insertInline: "refuse",
      mark: "refuse",
      link: "refuse",
      convert: "act",
      // Except into a heading deeper than level 2, which has no underlined spelling and so has
      // nowhere to put the second line of the fence.
      deepHeading: "refuse",
      paragraph: "act",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "refuse",
      type: "act",
      break: "act",
      split: "act",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "act",
      focus: "refuse",
    },
  },
  {
    name: "the caret inside a raw block",
    source: '<div class="x">\nkeep me\n</div>\n',
    place: (editor) => caretIn(editor, "raw", 2),
    outcome: {
      insertBlock: "refuse",
      insertInline: "refuse",
      mark: "refuse",
      link: "refuse",
      convert: "refuse",
      deepHeading: "refuse",
      paragraph: "refuse",
      wrap: "refuse",
      toggleBlock: "refuse",
      unwrap: "refuse",
      // The three that are typing rather than a command. A raw block is shown as an editable
      // monospace field and the user is allowed to edit it: what it must never do is get
      // reformatted, wrapped, converted or split by something they aimed somewhere else.
      //
      // The paste is the one that changed, and it changed because "as text" was never enough. Both
      // payloads the matrix pastes carry a blank line, and a blank line is what ends an html block:
      // written into the middle of a preserved construct it is not that construct any more, so the
      // next open of the file has pieces of prose where the raw block was and the tree the test
      // looked at was the only place it still existed. A paste with no blank line in it still goes
      // in as text, which is the describe below this matrix.
      paste: "refuse",
      type: "act",
      break: "act",
      split: "act",
      drop: "refuse",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "the caret inside a callout",
    source: "> [!NOTE]\n> a note\n",
    place: (editor) => caretIn(editor, "callout", 2),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "refuse",
      link: "act",
      convert: "act",
      deepHeading: "act",
      // Already a paragraph, so there is nothing to convert and the honest answer is nothing. It
      // used to be TipTap's answer instead, which is to lift the block out of everything holding
      // it: the callout went, and the label with it.
      paragraph: "refuse",
      wrap: "act",
      // Whether a toggle may be here at all is src/editor/blocks/toggle.ts's answer and not this
      // layer's: a `<details>` inside a quote goes to disk as a `<details>` inside a `>` block and
      // comes back as a single raw block, which is a reason to refuse it that belongs to the file
      // that owns the node. What this layer promises either way is the two lines above: the
      // callout is still there afterwards and so is every raw block.
      toggleBlock: "either",
      unwrap: "act",
      paste: "act",
      drop: "act",
      type: "act",
      break: "act",
      split: "act",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "the caret inside a toggle",
    source: TOGGLE,
    place: (editor) => caretIn(editor, "toggle", 2),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "refuse",
      link: "act",
      convert: "act",
      deepHeading: "act",
      paragraph: "refuse",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "act",
      type: "act",
      break: "act",
      split: "act",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "the caret in a toggle summary",
    source: TOGGLE,
    // The title is the node view's own editable island and ProseMirror's selection is never in it:
    // it stays wherever it was in the body, which is what every command here then acts on. So this
    // is the toggle body's row, and it is here rather than folded into it because the summary is a
    // place a caret visibly is and a reader of this list will look for it.
    place: (editor) => caretIn(editor, "toggle", 2),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "refuse",
      link: "act",
      convert: "act",
      deepHeading: "act",
      paragraph: "refuse",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "act",
      type: "act",
      break: "act",
      split: "act",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "the caret in a nested list item",
    source: "- one\n  - two\n",
    place: (editor) => caretIn(editor, "bulletList", 6),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "refuse",
      link: "act",
      convert: "act",
      deepHeading: "act",
      paragraph: "act",
      // The list wraps disagree with the quote and the callout here, which is ProseMirror's answer
      // about what can hold a nested item and is the same answer it gave before there was a guard.
      wrap: "either",
      toggleBlock: "refuse",
      unwrap: "refuse",
      paste: "act",
      drop: "act",
      type: "act",
      break: "act",
      split: "act",
      // Tab is already as deep as it goes, Shift-Tab brings the item back out.
      indent: "either",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "a selection spanning two block types",
    source: "# Title\n\nprose\n",
    place: (editor) =>
      editor.view.dispatch(
        editor.state.tr.setSelection(
          TextSelection.create(editor.state.doc, 2, editor.state.doc.content.size - 1),
        ),
      ),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "act",
      link: "act",
      convert: "act",
      deepHeading: "act",
      paragraph: "act",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "act",
      // The selection starts in the heading and ends at the end of the prose under it, so the
      // break lands in the heading with nothing after it, and a heading that ends with a break is
      // a heading that goes to disk without its own marker. This row said "act" and was executed
      // and passed while the bytes went from "# Title\n\nprose\n" to "T\\\n\n": no "#", and the
      // backslash left in the user's word. See the describe at the end of the file.
      type: "act",
      break: "refuse",
      split: "act",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "an empty document",
    source: "",
    place: (editor) => caretIn(editor, "paragraph"),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "refuse",
      link: "act",
      convert: "act",
      deepHeading: "act",
      paragraph: "refuse",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "act",
      type: "act",
      // The break reaches the document and never reaches the file, which is the one place in this
      // matrix where those two answers differ. The block is empty, so the break has nothing after
      // it and can never have anything after it until the user types, and a break with nothing
      // after it has no markdown spelling: src/markdown/serialize.ts writes it as nothing rather
      // than as the backslash that used to go out and come back as a literal character in the
      // prose. So the bytes are the bytes, which is what this row asserts.
      break: "refuse",
      split: "refuse",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
  {
    name: "a document that is only frontmatter",
    source: "---\ntitle: x\n---\n",
    place: (editor) => caretIn(editor, "paragraph"),
    outcome: {
      insertBlock: "act",
      insertInline: "act",
      mark: "refuse",
      link: "act",
      convert: "act",
      deepHeading: "act",
      paragraph: "refuse",
      wrap: "act",
      toggleBlock: "act",
      unwrap: "refuse",
      paste: "act",
      drop: "act",
      type: "act",
      // Same as the empty document above, and for the same reason.
      break: "refuse",
      split: "refuse",
      indent: "refuse",
      check: "refuse",
      table: "refuse",
      language: "refuse",
      focus: "refuse",
    },
  },
];

/**
 * One thing a user can do that reaches the document.
 *
 * `command` and `chord` are what the completeness tests count: the name the editor handle offers a
 * method under, and the chord a keymap binds. An entry with neither is a ProseMirror prop, named in
 * PROPS below the same way.
 */
interface Entry {
  name: string;
  family: Family;
  command?: keyof Handle;
  chord?: string;
  /** A prop src/editor/Editor.tsx puts straight on the view, rather than one an extension gives. */
  viewProp?: string;
  run: (editor: Editor, handle: Handle) => void;
}

/**
 * What ProseMirror puts an event to, with the screen taken out of it.
 *
 * `someProp` is EditorView's own, borrowed rather than written again, and it is the only reason any
 * of this proves anything: it walks the props the component put on the view, then the direct
 * plugins, then the state's plugins in order, and stops at the first answer that is not false. That
 * walk is where four guards in this project's history have been shipped and never reached, so it is
 * the thing under test rather than a detail to model.
 *
 * The rest is the smallest object that walk touches. `posAtCoords` answers with the caret, because
 * a drop is aimed with a pointer and there is nothing here to point at, and `dispatch` goes to the
 * editor so that whatever a handler does lands on the document these tests then serialize.
 */
function viewOf(editor: Editor): EditorView {
  return {
    get state() {
      return editor.state;
    },
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
    directPlugins: [],
    _props: createEditorProps({ editable: () => true, onOpenLink: () => {} }),
    someProp: EditorView.prototype.someProp,
    posAtCoords: () => ({ pos: editor.state.selection.from, inside: -1 }),
    focus: () => {},
    dom: null,
    composing: false,
    dragging: null,
    editable: true,
  } as unknown as EditorView;
}

/** prosemirror-keymap decides what Mod means once, out of navigator.platform. Read the same way. */
const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "metaKey" : "ctrlKey";

/**
 * A chord, offered the way prosemirror-view's own keydown handler offers one.
 *
 * Not to the plugin list by hand: to `someProp`, which is what `editHandlers.keydown` calls, so the
 * binding that claims the key here is the binding that claims it in the app, a binding written
 * straight on the view included.
 */
function press(editor: Editor, chord: string): void {
  const parts = chord.split("-");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const event = {
    key,
    keyCode: key === "Enter" ? 13 : key === "Tab" ? 9 : key.toUpperCase().charCodeAt(0),
    ctrlKey: mods.includes("Ctrl") || (mods.includes("Mod") && MOD === "ctrlKey"),
    metaKey: mods.includes("Meta") || (mods.includes("Mod") && MOD === "metaKey"),
    altKey: mods.includes("Alt"),
    shiftKey: mods.includes("Shift"),
    preventDefault: () => {},
  } as unknown as KeyboardEvent;

  const view = viewOf(editor);
  view.someProp("handleKeyDown", (f) => f(view, event));
}

/**
 * Two paragraphs, open at both ends, which is the slice ProseMirror parses `<p>ONE</p><p>TWO</p>`
 * into and the shape that tears a table, a fence and a raw block open.
 */
function blockSlice(editor: Editor): Slice {
  const paragraph = (text: string) =>
    editor.schema.nodes.paragraph.create(null, editor.schema.text(text));
  return new Slice(Fragment.fromArray([paragraph("ONE"), paragraph("TWO")]), 1, 1);
}

/**
 * One line of text, open at both ends, which is the slice the clipboard produces for a fragment of
 * a line and the one shape that merges into whatever block it lands in.
 */
function textSlice(editor: Editor, value: string): Slice {
  return new Slice(
    Fragment.from(editor.schema.nodes.paragraph.create(null, editor.schema.text(value))),
    1,
    1,
  );
}

/** A clipboard carrying `text` and nothing else, which is what a Cmd+V of prose looks like. */
function clipboardOf(text: string): ClipboardEvent {
  return {
    clipboardData: {
      files: [],
      items: [],
      types: text ? ["text/plain", "text/html"] : ["text/html"],
      getData: () => text,
    },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
}

/**
 * A paste, dispatched the way prosemirror-view's `doPaste` dispatches one.
 *
 * The slice is built here rather than parsed out of an HTML string, because parsing one needs a
 * DOM; everything after that is the real path. The offer goes to `someProp`, so every plugin that
 * claims a paste is in the race and the one that wins here is the one that wins in the app, and
 * when nobody claims it the fallback below is what `doPaste` does next: ProseMirror does not refuse
 * a paste that does not fit, it replaces the selection with it and lets the document tear.
 */
function pasteSlice(editor: Editor, slice: Slice, event = clipboardOf("")): void {
  const view = viewOf(editor);
  if (view.someProp("handlePaste", (f) => f(view, event, slice))) return;
  editor.view.dispatch(editor.state.tr.replaceSelection(slice).scrollIntoView());
}

function paste(editor: Editor): void {
  pasteSlice(editor, blockSlice(editor));
}

/**
 * A drop, at the caret, dispatched the way prosemirror-view's own drop handler dispatches one,
 * fallback included: `dropPoint` first, which is ProseMirror looking for somewhere near the pointer
 * that the slice would fit, and the pointer's own position when it finds nowhere.
 */
function drop(editor: Editor): void {
  const view = viewOf(editor);
  const slice = blockSlice(editor);
  const event = { clientX: 0, clientY: 0, preventDefault: () => {} } as unknown as DragEvent;
  if (view.someProp("handleDrop", (f) => f(view, event, slice, false))) return;
  const at = view.posAtCoords({ left: 0, top: 0 })?.pos ?? editor.state.selection.from;
  const into = dropPoint(editor.state.doc, at, slice) ?? at;
  editor.view.dispatch(editor.state.tr.replaceRange(into, into, slice));
}

/**
 * A click in the document, offered the way the view offers one.
 *
 * The one edit behind it is the checkbox, and it is reached by hit testing the DOM: a click whose
 * target is the list item itself rather than the paragraph inside it is a click on the box the
 * item's own ::before draws. There is no DOM here, so what this proves is the other half, which is
 * that a click anywhere else in any of these blocks writes nothing. Ticking a box is covered by
 * Mod-Enter in the same family, which reaches the same attribute through the keyboard.
 */
function click(editor: Editor): void {
  const view = viewOf(editor);
  const event = { target: null, preventDefault: () => {} } as unknown as MouseEvent;
  view.someProp("handleClick", (f) => f(view, editor.state.selection.from, event));
}

/**
 * One printable character, offered the way prosemirror-view offers one.
 *
 * There are two routes and both end here. With an ordinary caret the browser mutates the DOM and
 * `readDOMChange` offers the character to `handleTextInput` before it dispatches; with a selection
 * that is not one text range inside one textblock, which is what a dragged rectangle of cells is,
 * `editHandlers.keypress` offers it and calls `preventDefault` whatever the answer. Neither one
 * refuses a character that has nowhere sensible to go: when nobody claims it, the fallback below is
 * theirs, and `tr.insertText` with no range is `Selection.replace`, which over a cell selection
 * replaces every range in it.
 *
 * The offer goes to `someProp` for the reason everything else in this file does: what is under test
 * is whether the running editor ASKS the guard, not what the guard answers.
 */
function type(editor: Editor, character: string): void {
  const view = viewOf(editor);
  const { $from, $to } = editor.state.selection;
  const deflt = () => editor.state.tr.insertText(character).scrollIntoView();
  const claimed = view.someProp("handleTextInput", (f) =>
    f(view, $from.pos, $to.pos, character, deflt),
  );
  if (claimed) return;
  editor.view.dispatch(deflt());
}

/** Cmd+Shift+V, which reads the clipboard itself rather than taking it off an event. */
function pastePlain(editor: Editor, text: string): void {
  vi.stubGlobal("navigator", {
    userAgent: "node",
    platform: "node",
    maxTouchPoints: 0,
    clipboard: { readText: () => Promise.resolve(text) },
  });
  press(editor, "Mod-Shift-v");
}

const ENTRIES: Entry[] = [
  { name: "focus", family: "focus", command: "focus", run: (_e, h) => h.focus() },
  { name: "toggleMark", family: "mark", command: "toggleMark", run: (_e, h) => h.toggleMark("strong") },
  { name: "setLink", family: "link", command: "setLink", run: (_e, h) => h.setLink("https://x.test") },
  { name: "setBlock(paragraph)", family: "paragraph", command: "setBlock", run: (_e, h) => h.setBlock("paragraph") },
  { name: "setBlock(bulletList)", family: "wrap", command: "setBlock", run: (_e, h) => h.setBlock("bulletList") },
  { name: "setBlock(orderedList)", family: "wrap", command: "setBlock", run: (_e, h) => h.setBlock("orderedList") },
  { name: "setBlock(taskList)", family: "wrap", command: "setBlock", run: (_e, h) => h.setBlock("taskList") },
  { name: "setBlock(blockquote)", family: "wrap", command: "setBlock", run: (_e, h) => h.setBlock("blockquote") },
  { name: "setBlock(codeBlock)", family: "convert", command: "setBlock", run: (_e, h) => h.setBlock("codeBlock") },
  { name: "setBlock(toggle)", family: "toggleBlock", command: "setBlock", run: (_e, h) => h.setBlock("toggle") },
  { name: "setHeading(2)", family: "convert", command: "setHeading", run: (_e, h) => h.setHeading(2) },
  { name: "setHeading(3)", family: "deepHeading", command: "setHeading", run: (_e, h) => h.setHeading(3) },
  { name: "setHeading(null)", family: "paragraph", command: "setHeading", run: (_e, h) => h.setHeading(null) },
  { name: "setCallout(warning)", family: "wrap", command: "setCallout", run: (_e, h) => h.setCallout("warning") },
  { name: "setCallout(null)", family: "unwrap", command: "setCallout", run: (_e, h) => h.setCallout(null) },
  { name: "insertRule", family: "insertBlock", command: "insertRule", run: (_e, h) => h.insertRule() },
  // A question rather than an edit, so its answer is "refuse" nowhere: it writes nothing anywhere.
  { name: "canInsertImage", family: "focus", command: "canInsertImage", run: (_e, h) => { h.canInsertImage(); } },
  { name: "insertImage", family: "insertInline", command: "insertImage", run: (_e, h) => h.insertImage("assets/shot.png", "shot") },
  { name: "insertTable", family: "insertBlock", command: "insertTable", run: (_e, h) => h.insertTable(2, 2) },
  { name: "tableCommand", family: "table", command: "tableCommand", run: (_e, h) => h.tableCommand("addRowAfter") },
  { name: "insertMath(display)", family: "insertBlock", command: "insertMath", run: (_e, h) => h.insertMath(true) },
  { name: "insertMath(inline)", family: "insertInline", command: "insertMath", run: (_e, h) => h.insertMath(false) },
  { name: "insertMermaid", family: "insertBlock", command: "insertMermaid", run: (_e, h) => h.insertMermaid() },
  { name: "setCodeLanguage", family: "language", command: "setCodeLanguage", run: (_e, h) => h.setCodeLanguage("ts") },

  { name: "Mod-Alt-1", family: "convert", chord: "Mod-Alt-1", run: (e) => press(e, "Mod-Alt-1") },
  { name: "Mod-Alt-2", family: "convert", chord: "Mod-Alt-2", run: (e) => press(e, "Mod-Alt-2") },
  { name: "Mod-Alt-3", family: "deepHeading", chord: "Mod-Alt-3", run: (e) => press(e, "Mod-Alt-3") },
  { name: "Mod-Alt-4", family: "deepHeading", chord: "Mod-Alt-4", run: (e) => press(e, "Mod-Alt-4") },
  { name: "Mod-Alt-5", family: "deepHeading", chord: "Mod-Alt-5", run: (e) => press(e, "Mod-Alt-5") },
  { name: "Mod-Alt-6", family: "deepHeading", chord: "Mod-Alt-6", run: (e) => press(e, "Mod-Alt-6") },
  { name: "Mod-Alt-0", family: "paragraph", chord: "Mod-Alt-0", run: (e) => press(e, "Mod-Alt-0") },
  { name: "Mod-Alt-c", family: "convert", chord: "Mod-Alt-c", run: (e) => press(e, "Mod-Alt-c") },
  { name: "Mod-Shift-7", family: "wrap", chord: "Mod-Shift-7", run: (e) => press(e, "Mod-Shift-7") },
  { name: "Mod-Shift-8", family: "wrap", chord: "Mod-Shift-8", run: (e) => press(e, "Mod-Shift-8") },
  { name: "Mod-Shift-9", family: "wrap", chord: "Mod-Shift-9", run: (e) => press(e, "Mod-Shift-9") },
  { name: "Mod-Shift-b", family: "wrap", chord: "Mod-Shift-b", run: (e) => press(e, "Mod-Shift-b") },
  { name: "Mod-b", family: "mark", chord: "Mod-b", run: (e) => press(e, "Mod-b") },
  { name: "Mod-i", family: "mark", chord: "Mod-i", run: (e) => press(e, "Mod-i") },
  { name: "Mod-e", family: "mark", chord: "Mod-e", run: (e) => press(e, "Mod-e") },
  { name: "Mod-Shift-x", family: "mark", chord: "Mod-Shift-x", run: (e) => press(e, "Mod-Shift-x") },
  { name: "Mod-Enter", family: "check", chord: "Mod-Enter", run: (e) => press(e, "Mod-Enter") },
  { name: "Shift-Enter", family: "break", chord: "Shift-Enter", run: (e) => press(e, "Shift-Enter") },
  { name: "Enter", family: "split", chord: "Enter", run: (e) => press(e, "Enter") },
  { name: "Tab", family: "indent", chord: "Tab", run: (e) => press(e, "Tab") },
  { name: "Shift-Tab", family: "indent", chord: "Shift-Tab", run: (e) => press(e, "Shift-Tab") },
  { name: "Mod-Shift-v", family: "paste", chord: "Mod-Shift-v", run: (e) => pastePlain(e, "ONE\n\nTWO") },

  { name: "handlePaste", family: "paste", run: (e) => paste(e) },
  { name: "handleDrop", family: "drop", run: (e) => drop(e) },
  // Typing, which was an entry point into every document in this editor and had no row until a
  // character typed over a dragged rectangle emptied four cells to write three letters.
  { name: "handleTextInput", family: "type", run: (e) => type(e, "z") },

  { name: "handleClick", family: "check", viewProp: "handleClick", run: (e) => click(e) },
];

/**
 * Every chord this editor binds, asked of the extensions themselves the way the extension manager
 * asks them when it builds the keymaps.
 */
function chordsOf(editor: Editor): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const extension of editor.extensionManager.extensions) {
    const context = {
      name: extension.name,
      options: extension.options,
      storage: editor.extensionStorage[extension.name as keyof typeof editor.extensionStorage],
      editor,
      type: null,
    };
    const shortcuts = getExtensionField<() => Record<string, unknown>>(
      extension,
      "addKeyboardShortcuts",
      context as never,
    );
    if (shortcuts) out[extension.name] = Object.keys(shortcuts()).sort();
  }
  return out;
}

/** And every ProseMirror prop, asked the same way. */
function propsOf(editor: Editor): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const extension of editor.extensionManager.extensions) {
    const context = {
      name: extension.name,
      options: extension.options,
      storage: editor.extensionStorage[extension.name as keyof typeof editor.extensionStorage],
      editor,
      type: null,
    };
    const plugins = getExtensionField<() => { props?: Record<string, unknown> }[]>(
      extension,
      "addProseMirrorPlugins",
      context as never,
    );
    if (!plugins) continue;
    const names = new Set<string>();
    for (const plugin of plugins()) for (const key of Object.keys(plugin.props ?? {})) names.add(key);
    if (names.size) out[extension.name] = Array.from(names).sort();
  }
  return out;
}

/**
 * The chords this editor binds that are not this layer's, and where each set comes from.
 *
 * They are recorded rather than executed because the file that binds one is the file that owns what
 * it does, and four of these arrive with libraries. What this list is for is the day one of them
 * changes: a chord appearing here that nobody has written down is an entry point into somebody's
 * document that nobody has looked at.
 */
const FOREIGN_CHORDS: Record<string, string[]> = {
  // TipTap's own core keymap: the deletions, select all, and the emacs-style cursor keys.
  keymap: [
    "Alt-Backspace",
    "Alt-Delete",
    "Alt-d",
    "Backspace",
    "Ctrl-Alt-Backspace",
    "Ctrl-a",
    "Ctrl-d",
    "Ctrl-e",
    "Ctrl-h",
    "Delete",
    "Enter",
    "Mod-Backspace",
    "Mod-Delete",
    "Mod-Enter",
    "Mod-a",
    "Shift-Backspace",
  ],
  // StarterKit's history, and the Cyrillic layout's own z and y.
  undoRedo: ["Mod-y", "Mod-z", "Mod-я", "Shift-Mod-z", "Shift-Mod-я"],
  // StarterKit's list backspace and delete handling.
  listKeymap: ["Backspace", "Delete", "Mod-Backspace", "Mod-Delete", "Tab"],
  // src/editor/blocks/tables.ts: the cell walk, and the two deletions inside a table.
  tables: ["Backspace", "Delete", "Shift-Tab", "Tab"],
  // src/editor/blocks/math.ts: Enter out of a formula field.
  mathRendering: ["Enter"],
};

/**
 * And the props, the same way. `handlePaste`, `handleDrop` and `handleDOMEvents` are in here more
 * than once, which is the thing worth knowing about them: whichever plugin is asked first answers,
 * so this layer's handler is not the only one a paste meets.
 */
const FOREIGN_PROPS: Record<string, string[]> = {
  editable: ["editable"],
  clipboardTextSerializer: ["clipboardTextSerializer"],
  focusEvents: ["handleDOMEvents"],
  tabindex: ["attributes"],
  // TipTap's own pair, which only flag that a paste or a drop is in progress.
  drop: ["handleDrop"],
  paste: ["handlePaste"],
  textDirection: ["attributes"],
  gapCursor: [
    "createSelectionBetween",
    "decorations",
    "handleClick",
    "handleDOMEvents",
    "handleKeyDown",
  ],
  undoRedo: ["handleDOMEvents"],
  placeholder: ["decorations"],
  searchHighlight: ["decorations"],
  // src/editor/linkPicker.ts, the `[[` picker. It owns Enter, the arrows and Escape while its list
  // is open, and closes itself when the view loses focus. It claims no `handleTextInput` on
  // purpose: at its priority that would put it in front of the table lane's typing guard below,
  // and reading the transaction after the fact gets the key precedence without taking that away.
  linkPicker: ["handleDOMEvents", "handleKeyDown"],
  // src/editor/proofing.ts. The decorations are the underlines; the two handlers open the menu over
  // one. Neither touches the document, so they are recorded here rather than given a row in the
  // matrix below.
  proofing: ["decorations", "handleClick", "handleDOMEvents"],
  toggles: ["nodeViews"],
  // prosemirror-tables, through src/editor/blocks/tables.ts, which is asked before this layer is.
  // `handleTextInput` is the exception in this list and the only entry in it that is this app's
  // own: it is the typing guard, and it lives with the table lane because a rectangle of dragged
  // cells is the whole of what it is about. src/editor/blocks/tables.test.ts pins its position in
  // the plugin list, which is the half of a guard this project keeps getting wrong.
  tables: [
    "attributes",
    "createSelectionBetween",
    "decorations",
    "handleDOMEvents",
    "handleKeyDown",
    "handlePaste",
    "handleTextInput",
    "handleTripleClick",
    "nodeViews",
  ],
  mathRendering: ["nodeViews"],
  codeHighlighting: ["decorations"],
  mermaidRendering: ["decorations", "nodeViews"],
};

/**
 * And the third channel, which is the one nothing here could see until it was lifted out of the
 * component: the props src/editor/Editor.tsx puts straight on the view.
 *
 * They are not an extension, so neither `chordsOf` nor `propsOf` above finds them, and a
 * `handlePaste` or a `handleKeyDown` written here is asked before every plugin in the editor and
 * answers for the whole document. What is here today is a click handler, and the only edit in it
 * is the checkbox, which is why the entry below is in the `check` family with Mod-Enter. Anything
 * that appears beside it has to be given a row.
 */
const OWN_VIEW_PROPS = ["attributes", "handleClick", "scrollMargin", "scrollThreshold"];

/** The ones among them that cannot change a document, and why each is safe to leave unexecuted. */
const INERT_VIEW_PROPS = [
  // A class on the editable element.
  "attributes",
  // Two numbers, in pixels, for how much of the pane the caret is kept clear of.
  "scrollMargin",
  "scrollThreshold",
];

/** What this layer owns, and what the matrix below therefore has to execute. */
const OWN_CHORDS = "shortcuts";
const OWN_PASTE = "clipboard";
/** And the one this layer owns that lives with a block lane, because it is a rule about a table. */
const OWN_TYPING = "tables";

/**
 * The events this layer's guard claims, and about which it has to be asked first.
 *
 * This is the invariant, not a list of what happens to be installed today. ProseMirror takes the
 * first answer that is not false, so a guard behind a library plugin that claims the same event is
 * a guard the program never asks, however right its answer is. That has already cost this project
 * four cells of somebody's table: prosemirror-tables answered a Cmd+V over a rectangle of dragged
 * cells and replaced the contents of every one of them, while the guard that refuses exactly that
 * sat six plugins further down with a passing test in front of it.
 *
 * The test below reads the plugin list the running editor built and compares positions in it, so
 * there is nothing here to keep up to date: a new plugin that claims a paste, an extension whose
 * priority is raised above this one's, or a reorder of src/editor/extensions.ts all fail it on the
 * day they happen rather than on the day somebody loses a table.
 */
const OWN_EVENTS = ["handlePaste", "handleDrop"] as const;

/** Where in the plugin list each plugin that claims `event` sits, first to last. */
function claimants(plugins: readonly Plugin[], event: (typeof OWN_EVENTS)[number]): number[] {
  return plugins.flatMap((plugin, index) => (plugin.props[event] ? [index] : []));
}

describe("the entry points, enumerated", () => {
  const editorFor = () => open("hello\n");

  it("covers every method the editor handle offers", () => {
    const { editor } = editorFor();
    const offered = Object.keys(createCommands(editor)).sort();
    const covered = Array.from(
      new Set(ENTRIES.map((entry) => entry.command).filter((key): key is keyof Handle => !!key)),
    ).sort();

    expect(offered).toEqual(covered);
    editor.destroy();
  });

  it("covers every chord this layer binds, and records every chord it does not", () => {
    const { editor } = editorFor();
    const chords = chordsOf(editor);

    const covered = Array.from(
      new Set(ENTRIES.map((entry) => entry.chord).filter((chord): chord is string => !!chord)),
    ).sort();
    expect(covered).toEqual([...chords[OWN_CHORDS], ...chords[OWN_PASTE]].sort());

    const foreign = Object.fromEntries(
      Object.entries(chords).filter(([name]) => name !== OWN_CHORDS && name !== OWN_PASTE),
    );
    expect(foreign).toEqual(FOREIGN_CHORDS);
    editor.destroy();
  });

  it("covers every handler this layer installs, and records every handler it does not", () => {
    const { editor } = editorFor();
    const props = propsOf(editor);

    // The entries above that are a plugin's prop rather than a method or a chord are these, and
    // there are no others. The click handler is the third kind and is checked by the test below it.
    // Two of the three are this layer's own clipboard plugin; the third is the typing guard, which
    // is the table lane's and is asserted by name below rather than being taken on trust.
    expect(props[OWN_PASTE]).toEqual(["handleDrop", "handlePaste"]);
    expect(props[OWN_TYPING]).toContain("handleTextInput");
    expect(
      ENTRIES.filter((entry) => !entry.command && !entry.chord && !entry.viewProp).map((entry) => entry.name),
    ).toEqual(["handlePaste", "handleDrop", "handleTextInput"]);

    const foreign = Object.fromEntries(
      Object.entries(props).filter(([name]) => name !== OWN_PASTE),
    );
    expect(foreign).toEqual(FOREIGN_PROPS);
    editor.destroy();
  });

  it("asks this layer's guard before any other plugin that claims the same event", () => {
    const { editor } = editorFor();
    const plugins = editor.state.plugins;
    const guard = plugins.findIndex((plugin) => plugin.spec.key === pasteKey);
    expect(guard).toBeGreaterThanOrEqual(0);

    for (const event of OWN_EVENTS) {
      const positions = claimants(plugins, event);
      // Named as well as ordered, so the failure says which plugin got in front rather than only
      // that a number moved. Both were true of the bug: index 9 rather than index 15, and the
      // plugin at index 9 was prosemirror-tables' selectingCells.
      expect([event, positions[0], positions.length > 0]).toEqual([event, guard, true]);
    }
    editor.destroy();
  });

  it("keeps those events off the view's own props, which are asked before every plugin", () => {
    // The one channel that outranks the plugin list entirely. A handlePaste written in
    // src/editor/Editor.tsx would answer before the guard and the test above would still pass,
    // because it compares plugins with plugins.
    const props = createEditorProps({ editable: () => true, onOpenLink: () => {} });
    expect(OWN_EVENTS.filter((event) => event in props)).toEqual([]);
  });

  it("covers every prop the component puts straight on the view", () => {
    const props = Object.keys(
      createEditorProps({ editable: () => true, onOpenLink: () => {} }),
    ).sort();
    expect(props).toEqual(OWN_VIEW_PROPS);

    const live = props.filter((name) => !INERT_VIEW_PROPS.includes(name));
    const covered = ENTRIES.filter((entry) => entry.viewProp).map((entry) => entry.viewProp);
    expect(live).toEqual(covered);
  });

  // The find bar is the second handle this editor publishes, and two of its seven methods write to
  // the document. It is not `createCommands`, so the matrix above does not reach it; what it gets
  // instead is this list and the describe at the end of the file, because a replace is a text edit
  // inside one textblock and not a block going anywhere, which is a much narrower question than the
  // forty entry points above have.
  it("covers every method the find handle offers", () => {
    const { editor } = editorFor();
    expect(Object.keys(createFind(editor)).sort()).toEqual([
      "clear",
      "focus",
      "next",
      "prev",
      // The two that write.
      "replaceAll",
      "replaceCurrent",
      "setQuery",
    ]);
    editor.destroy();
  });

  it("gives every entry point a family, and every context an answer for every family", () => {
    const families = new Set(ENTRIES.map((entry) => entry.family));
    for (const context of CONTEXTS) {
      for (const family of families) {
        expect([context.name, family, context.outcome[family]]).toEqual([
          context.name,
          family,
          expect.stringMatching(/^(refuse|act|either)$/),
        ]);
      }
    }
  });
});

describe.each(CONTEXTS)("with $name", (context) => {
  beforeEach(() => {
    writes.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ENTRIES)("$name", async (entry) => {
    const { editor, written } = open(context.source);
    const before = written();
    const doc = editor.state.doc;
    context.place(editor);
    const handle = createCommands(editor);

    entry.run(editor, handle);
    // The paste and the image insert both finish on a promise nobody awaits, so the document they
    // leave behind is a tick away rather than there when the call returns.
    await settle();

    const after = written();
    const outcome = context.outcome[entry.family];

    // The universal half, asked of every entry point in every context regardless of what its row
    // says, because these three are the ones nobody predicted the last three times.

    // A raw block is never created, destroyed or split. Its text can change, since it is an
    // editable field and typing in one is an edit like any other, but there is always exactly the
    // same number of them as there was.
    expect([entry.name, count(editor.state.doc, "raw")]).toEqual([entry.name, count(doc, "raw")]);

    // A callout or a toggle is never taken away by something that was not asked to take it away.
    // The two families that are asked to are the buttons marked with that wrapper: the Toggle
    // button pressed inside a toggle removes it, the Callout menu's own entry turns a callout back
    // into a quote. A list button is not one of those, and it used to be exempt here alongside
    // them: given a selection that started inside a toggle it lifted the toggle away and deleted
    // the title in its summary, which is text on screen that was never selected.
    if (entry.family !== "unwrap" && entry.family !== "toggleBlock") {
      const wrappers = (node: ProseMirrorNode) => count(node, "callout") + count(node, "toggle");
      expect([entry.name, wrappers(editor.state.doc) >= wrappers(doc)]).toEqual([entry.name, true]);
    }

    // And a toggle only ever sits among the document's own children, whatever put it there.
    // src/markdown/parse.ts pairs `<details>` at the top level of a file and nowhere else, so a
    // toggle one level in goes to disk as a `<details>` inside a container and comes back as a
    // single raw block: the bytes survive, and both constructs stop being editable. That is an
    // edit this editor cannot read back, so no entry point may produce one.
    expect([entry.name, nestedToggles(editor.state.doc)]).toEqual([entry.name, 0]);

    // And nothing on screen is a construct the file swallows. Written out and read back in, every
    // line break the user has finished is still there.
    const reread = parseMarkdown(after, "/notes/a.md");
    expect([entry.name, heldBreaks(reread.doc)]).toEqual([
      entry.name,
      heldBreaks(editor.state.doc),
    ]);

    // Then the row's own answer, on the bytes.
    if (outcome === "refuse") {
      expect([entry.name, after, writes]).toEqual([entry.name, before, []]);
    } else if (outcome === "act") {
      expect([entry.name, after === before]).toEqual([entry.name, false]);
    }

    editor.destroy();
  });
});

// Cmd+Shift+V in the places a paste has to be spelled differently, which is the same rule as the
// matrix above from the other side. A plain text paste is refused nowhere, because text is not a
// block and every one of these places holds text; what it must not do is arrive as paragraphs
// somewhere paragraphs tear the block open. It used to, and a fence pasted into came out as two
// fences with the pasted lines sitting between them as prose.
describe("pasting plain text", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes into a fenced code block as its own lines, leaving one fence", async () => {
    const { editor } = open("```sh\nrm -rf /\n```\n");
    caretIn(editor, "codeBlock", 2);

    pastePlain(editor, "one\ntwo");
    await settle();

    expect(count(editor.state.doc, "codeBlock")).toBe(1);
    expect(count(editor.state.doc, "paragraph")).toBe(0);
    expect(editor.state.doc.firstChild?.textContent).toBe("rmone\ntwo -rf /");
    editor.destroy();
  });

  it("goes into a table cell without splitting the table", async () => {
    const { editor } = open(TABLE);
    caretIn(editor, "tableCell");

    pastePlain(editor, "note");
    await settle();

    expect(count(editor.state.doc, "table")).toBe(1);
    expect(count(editor.state.doc, "paragraph")).toBe(0);
    editor.destroy();
  });

  it("does nothing over a dragged selection of cells, which it would otherwise empty", async () => {
    const { editor, written } = open(TABLE);
    const before = written();
    dragCells(editor);

    pastePlain(editor, "note");
    await settle();

    expect(written()).toBe(before);
    editor.destroy();
  });

  it("still arrives as paragraphs in prose, which is what it is for", async () => {
    const { editor } = open("hello\n");
    caretIn(editor, "paragraph", 5);

    pastePlain(editor, "one\n\ntwo");
    await settle();

    expect(count(editor.state.doc, "paragraph")).toBe(3);
    editor.destroy();
  });
});

// An ordinary Cmd+V, which is the entry point that had no guard at all: this file's handler claimed
// image clipboards and returned false for everything else, and ProseMirror's own handler does not
// refuse a paste that does not fit. It splits what the caret was in and puts the pieces either side.
describe("pasting anything else", () => {
  it("goes into a table cell as text, leaving one table and every cell in it", () => {
    const { editor } = open(TABLE);
    caretIn(editor, "tableCell");

    paste(editor);

    expect(count(editor.state.doc, "table")).toBe(1);
    expect(count(editor.state.doc, "tableCell")).toBe(4);
    expect(editor.state.doc.textContent).toContain("ONE");
    editor.destroy();
  });

  it("goes into a fence as text, leaving one fence", () => {
    const { editor } = open("```js\nlet x = 1;\n```\n");
    caretIn(editor, "codeBlock", 2);

    paste(editor);

    expect(count(editor.state.doc, "codeBlock")).toBe(1);
    expect(count(editor.state.doc, "paragraph")).toBe(0);
    editor.destroy();
  });

  it("goes into a raw block as text, leaving one raw block holding every byte it had", () => {
    const { editor, written } = open('<div class="x">\nkeep me\n</div>\n');
    caretIn(editor, "raw", 2);

    // One line, so there is no blank line in it and the paste is an ordinary edit to an editable
    // field. The whole of the source, with the pasted text sitting in it where the caret was.
    // Split instead, the tail of it came back as a paragraph and the closing tag went to disk
    // escaped.
    pasteSlice(editor, textSlice(editor, "ONE"), clipboardOf("ONE"));

    expect(count(editor.state.doc, "raw")).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe('<dONEiv class="x">\nkeep me\n</div>');
    expect(written()).toBe('<dONEiv class="x">\nkeep me\n</div>\n');
    editor.destroy();
  });

  // The same paste with a blank line in it, which is the one this file used to let through and
  // call a success. It read as one afterwards: the tree still had a raw block in it holding every
  // byte, and this test asserted exactly that. The FILE did not. A blank line ends an html block,
  // so those bytes reopen as a heading, two paragraphs and a list, and the construct the block was
  // preserving is not in the document any more. Executed in Chromium against the paste.ts this
  // replaced, with a real Cmd+V of "# Pasted\n\n- one\n- two\n" into
  // `<Chart data={points} title="Sales" />`, that is exactly what the file came back as.
  it("is refused into a raw block when it carries a blank line, and says so", async () => {
    const messages: string[] = [];
    const { editor, written } = open("<Chart data={points} />\n", (m) => messages.push(m));
    const before = written();
    caretIn(editor, "raw", 8);

    pasteSlice(editor, blockSlice(editor), clipboardOf("ONE\n\nTWO"));
    await settle();

    expect(written()).toBe(before);
    expect(count(editor.state.doc, "raw")).toBe(1);
    expect(messages).toEqual(["A blank line cannot go inside a raw block, so nothing was pasted."]);
    editor.destroy();
  });

  // And a blank line is fine in the two blocks that do have something marking where they end.
  it("still carries a blank line into a fence and into a table cell", () => {
    const fence = open("```js\nlet x = 1;\n```\n");
    caretIn(fence.editor, "codeBlock", 2);
    pasteSlice(fence.editor, blockSlice(fence.editor), clipboardOf("ONE\n\nTWO"));
    expect(count(fence.editor.state.doc, "codeBlock")).toBe(1);
    expect(fence.editor.state.doc.firstChild?.textContent).toBe("leONE\n\nTWOt x = 1;");
    fence.editor.destroy();

    const table = open(TABLE);
    caretIn(table.editor, "tableCell");
    pasteSlice(table.editor, blockSlice(table.editor), clipboardOf("ONE\n\nTWO"));
    expect(count(table.editor.state.doc, "table")).toBe(1);
    expect(count(table.editor.state.doc, "tableCell")).toBe(4);
    expect(table.editor.state.doc.textContent).toContain("ONE");
    table.editor.destroy();
  });

  it("still arrives as paragraphs in prose, which is what it is for", () => {
    const { editor } = open("hello\n");
    caretIn(editor, "paragraph", 3);

    paste(editor);

    // Open at both ends, so the first pasted block joins the line it landed in and the last one
    // takes the rest of it: two paragraphs out of one, and not a paragraph either side of them.
    expect(count(editor.state.doc, "paragraph")).toBe(2);
    editor.destroy();
  });

  it("is refused outright where it would land on a rectangle of cells", () => {
    const { editor, written } = open(TABLE);
    const before = written();
    dragCells(editor);

    paste(editor);

    expect(written()).toBe(before);
    editor.destroy();
  });
});

// Cmd+V over a rectangle of cells dragged out with the mouse, which is where the guard above was
// correct and unreachable for a whole milestone.
//
// The document, the drag and the payloads are the ones the bug was reported with. Executed against
// the paste.ts this replaced, every case here fails the same way: prosemirror-tables answers the
// paste six plugins ahead of the guard and puts the payload into every cell of the rectangle, so
// the file comes back as "| zzz | zzz |\n| zzz | zzz |" and one, two, three and four are gone.
//
// The last two are the other half of the same rule, because a guard that refused every paste made
// over a table would pass everything above it. Cells copied out of a table and pasted into one are
// prosemirror-tables' own edit and it is still asked for them, and a paste into a single cell is
// still a paste.
describe("pasting over a dragged rectangle of table cells", () => {
  const DRAGGED = "| aa | bb |\n| --- | --- |\n| one | two |\n| three | four |\n\ntail\n";

  /** From the first body cell to the last, which is one drag with the mouse. */
  function dragBody(editor: Editor): void {
    const table = editor.state.doc.firstChild;
    if (!table) throw new Error("no table in the fixture");
    const map = TableMap.get(table);
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(
          editor.state.doc,
          1 + map.positionAt(1, 0, table),
          1 + map.positionAt(map.height - 1, map.width - 1, table),
        ),
      ),
    );
  }

  const text = (editor: Editor, value: string) =>
    new Slice(
      Fragment.from(editor.schema.nodes.paragraph.create(null, editor.schema.text(value))),
      1,
      1,
    );

  const PAYLOADS: Array<[string, (editor: Editor) => Slice, ClipboardEvent]> = [
    ["one word", (editor) => text(editor, "zzz"), clipboardOf("zzz")],
    ["two blocks", (editor) => blockSlice(editor), clipboardOf("ONE\n\nTWO")],
    [
      "two lines",
      (editor) =>
        new Slice(
          Fragment.from(
            editor.schema.nodes.paragraph.create(null, [
              editor.schema.text("ONE"),
              editor.schema.nodes.hardBreak.create(),
              editor.schema.text("TWO"),
            ]),
          ),
          1,
          1,
        ),
      clipboardOf("ONE\nTWO"),
    ],
    // No text and no html on the clipboard is what an image-only copy looks like by the time it
    // reaches a handler, and an empty slice is the one prosemirror-tables empties a rectangle over
    // without putting anything anywhere at all.
    ["nothing but an image", () => Slice.empty, clipboardOf("")],
  ];

  it.each(PAYLOADS)("leaves every cell alone: %s", (_name, build, event) => {
    const { editor, written } = open(DRAGGED);
    const before = written();
    dragBody(editor);

    pasteSlice(editor, build(editor), event);

    expect(written()).toBe(before);
    expect(editor.state.doc.textContent).toContain("three");
    editor.destroy();
  });

  it("still lets prosemirror-tables lay copied cells over the rectangle", () => {
    const { editor } = open(DRAGGED);
    dragBody(editor);
    const cell = (value: string) =>
      editor.schema.nodes.tableCell.create(
        null,
        editor.schema.nodes.paragraph.create(null, editor.schema.text(value)),
      );
    const row = editor.schema.nodes.tableRow.create(null, Fragment.fromArray([cell("P"), cell("Q")]));

    pasteSlice(editor, new Slice(Fragment.from(row), 0, 0));

    expect(editor.state.doc.textContent).toContain("P");
    expect(count(editor.state.doc, "tableCell")).toBe(4);
    editor.destroy();
  });

  it("still pastes into one cell with an ordinary caret in it", () => {
    const { editor } = open(DRAGGED);
    caretIn(editor, "tableCell");

    pasteSlice(editor, blockSlice(editor));

    expect(count(editor.state.doc, "table")).toBe(1);
    expect(count(editor.state.doc, "tableCell")).toBe(4);
    expect(editor.state.doc.textContent).toContain("ONE");
    editor.destroy();
  });
});

// A drop, which had no handler at all and so went to the same ProseMirror default with the same
// result, at whatever position the pointer happened to be over.
describe("dropping blocks", () => {
  it("is refused in a fence, a raw block and a cell, and the dragged content stays where it was", () => {
    for (const [source, node] of [
      ["```js\nlet x = 1;\n```\n", "codeBlock"],
      ['<div class="x">\nkeep me\n</div>\n', "raw"],
      [TABLE, "tableCell"],
    ] as const) {
      const { editor, written } = open(source);
      const before = written();
      caretIn(editor, node, 2);

      drop(editor);

      expect([node, written()]).toEqual([node, before]);
      editor.destroy();
    }
  });

  it("still lands in prose, which is what it is for", () => {
    const { editor } = open("hello\n");
    caretIn(editor, "paragraph", 3);

    drop(editor);

    expect(count(editor.state.doc, "paragraph")).toBe(2);
    editor.destroy();
  });
});

// The third way a node gets placed, after a button and the clipboard: typing the markdown for it.
//
// "--- " is the one typing rule that inserts a node beside the caret rather than wrapping the block
// the caret is in or changing what that block is. Those two are operations ProseMirror refuses on
// its own when the result would not fit, which is why "# " and "- " in a table cell have always
// come out as the characters that were typed. An insert has no such refusal in it, so this rule
// fired everywhere, and in a cell `tr.insert` cut the table in two around the rule and left a row
// of empty cells where the text had been.
//
// A fence and a raw block are not in here because TipTap's own input rule loop declines outright in
// any block whose spec says `code`, and both of these do. That is the library's guarantee rather
// than this app's, so it is pinned once at the end rather than assumed everywhere.
describe('typing "--- "', () => {
  /**
   * The characters put to the plugins one at a time, the way typing reaches them.
   *
   * The last argument is what the view itself passes: the transaction that puts the character in
   * when nobody claims it. Nothing here calls it, and neither does TipTap's rule plugin, but a rule
   * that declines has to leave that fallback to run, so it is the same one dispatched below.
   */
  const type = (editor: Editor, text: string): void => {
    for (const character of text) {
      const { from, to } = editor.state.selection;
      const plain = () => editor.state.tr.insertText(character, from, to);
      let handled = false;
      for (const plugin of editor.state.plugins) {
        const handler = plugin.props?.handleTextInput;
        if (handler && handler.call(plugin, editor.view, from, to, character, plain)) {
          handled = true;
          break;
        }
      }
      if (!handled) editor.view.dispatch(plain());
    }
  };

  it("stays as three characters of text in a table cell", () => {
    const { editor } = open(TABLE);
    caretIn(editor, "tableCell");

    type(editor, "--- ");

    // One table, every cell still where it was, and no rule anywhere. In GFM "--- " in a cell is
    // the text "--- " anyway, so the characters staying put is also the right file.
    expect(count(editor.state.doc, "table")).toBe(1);
    expect(count(editor.state.doc, "horizontalRule")).toBe(0);
    expect(editor.state.doc.firstChild?.textContent).toContain("--- a");
    editor.destroy();
  });

  it("is still a rule in a list item, which is where it has always worked", () => {
    const { editor } = open("- one\n- two\n");
    caretIn(editor, "listItem");

    type(editor, "--- ");

    // The other half of the same rule: a guard that refused everywhere would pass the test above.
    expect(count(editor.state.doc, "horizontalRule")).toBe(1);
    editor.destroy();
  });

  it("is still a rule in ordinary prose", () => {
    const { editor } = open("hello\n\nworld\n");
    caretIn(editor, "paragraph", 5);
    // Not at the start of the block, so the rule is not what fires. A new empty paragraph is.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.splitBlock();
    type(editor, "--- ");

    expect(count(editor.state.doc, "horizontalRule")).toBe(1);
    editor.destroy();
  });

  it("is left to the library to decline inside a fence, which is where it declines", () => {
    const { editor } = open("```js\nlet x = 1;\n```\n");
    caretIn(editor, "codeBlock", 2);

    type(editor, "--- ");

    expect(count(editor.state.doc, "codeBlock")).toBe(1);
    expect(count(editor.state.doc, "horizontalRule")).toBe(0);
    expect(editor.state.doc.firstChild?.textContent).toBe("le--- t x = 1;");
    editor.destroy();
  });
});

// A selection that reaches a whole toggle, which is the one shape the matrix above has no context
// for: every context in it puts a caret somewhere, and what these need is two ends either side of a
// node the editor draws as a control rather than as text.
//
// Both are one drag and one button press. Dragging from the first line of a toggle's body down into
// the paragraph under it and pressing Bulleted list lifted the toggle away and took the title in its
// summary with it, which is text on screen that was never selected and is not in the file
// afterwards. Pressing Quote or a callout on the same selection kept the toggle and put it inside
// the quote, and a `<details>` inside a `>` block is a `<details>` the bridge cannot pair: the next
// open of the file has one raw block where the toggle and the quote used to be.
//
// The answer to both is the same and it is nothing. There is no spelling for either result, so
// there is no edit to offer.
describe("a wrap over a whole toggle", () => {
  const NEIGHBOUR = `${TOGGLE}\nafter\n`;

  /** From inside the toggle's body to the end of the block after it, which is one drag. */
  function dragOutOfToggle(editor: Editor): void {
    const doc = editor.state.doc;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(doc, startOf(editor, "paragraph"), doc.content.size - 1),
      ),
    );
  }

  const WRAPS: Array<[string, (handle: Handle) => void]> = [
    ["Bulleted list", (handle) => handle.setBlock("bulletList")],
    ["Numbered list", (handle) => handle.setBlock("orderedList")],
    ["Task list", (handle) => handle.setBlock("taskList")],
    ["Quote", (handle) => handle.setBlock("blockquote")],
    ["Callout", (handle) => handle.setCallout("warning")],
  ];

  it.each(WRAPS)("%s over a selection dragged out of a toggle does nothing", (_name, run) => {
    const { editor, written } = open(NEIGHBOUR);
    const before = written();
    dragOutOfToggle(editor);

    run(createCommands(editor));

    expect(written()).toBe(before);
    expect(count(editor.state.doc, "toggle")).toBe(1);
    expect(nestedToggles(editor.state.doc)).toBe(0);
    editor.destroy();
  });

  it.each(WRAPS)("%s over the toggle selected whole does nothing", (_name, run) => {
    const { editor, written } = open(TOGGLE);
    const before = written();
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)),
    );

    run(createCommands(editor));

    expect(written()).toBe(before);
    expect(count(editor.state.doc, "toggle")).toBe(1);
    expect(nestedToggles(editor.state.doc)).toBe(0);
    editor.destroy();
  });

  // The other half, because a guard that refused everywhere would pass everything above.
  it("still wraps the block inside a toggle, and still unwraps the toggle itself", () => {
    const quoted = open(TOGGLE);
    caretIn(quoted.editor, "toggle", 2);
    createCommands(quoted.editor).setBlock("blockquote");
    expect(quoted.written()).toBe(
      "<details open>\n<summary>My title</summary>\n\n> hidden\n\n</details>\n",
    );
    quoted.editor.destroy();

    const lifted = open(TOGGLE);
    caretIn(lifted.editor, "toggle", 2);
    createCommands(lifted.editor).setBlock("toggle");
    expect(lifted.written()).toBe("hidden\n");
    lifted.editor.destroy();
  });
});

// Shift+Enter, which is the one key in this editor whose answer is the serializer's rather than the
// schema's, and the one place a break costs more than the break.
//
// A break is written as a backslash and a line ending. A level 1 or 2 heading can hold one because
// those two have an underlined spelling and the underline goes under the heading's LAST line, so a
// break in the middle of `# Title` is a real two line heading that reads back as itself. A break at
// the END of one has no last line under it: mdast writes no underline, the file gets `Title\` where
// the heading was, and the next open of it has a paragraph whose text ends in a backslash. The
// marker is gone and a character the user never typed is in their words.
//
// Reported as needing a two block selection and as healing itself on the next keystroke. Neither is
// true, and both were checked by running it. One click into the H1, End, Shift+Enter and nothing
// else turned "# Title\n\nprose here\n" into "Title\\\n\n\n\nprose here\n", and typing one more
// character after that gives "Title\\\nx\n=\n\nprose here\n", which is a heading again with the
// backslash now inside its text.
describe("breaking a line at the end of a heading", () => {
  /** The caret at the very end of the document's first block, which is one click and one End. */
  function caretAtEndOfFirstBlock(editor: Editor): void {
    const first = editor.state.doc.firstChild;
    if (!first) throw new Error("no block in the fixture");
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(first.nodeSize - 1)),
      ),
    );
  }

  const HEADINGS = [
    ["a level 1 heading", "# Title\n\nprose here\n"],
    ["a level 2 heading", "## Sub\n\nprose here\n"],
  ] as const;

  it.each(HEADINGS)("writes nothing at the end of %s", (_name, source) => {
    const { editor, written } = open(source);
    const before = written();
    caretAtEndOfFirstBlock(editor);

    press(editor, "Shift-Enter");

    expect(written()).toBe(before);
    // And the heading is still a heading in the document, not only in the file: the key is claimed
    // rather than declined, because a Shift+Enter handed back to the browser puts a <br> in by
    // itself and the document would carry a break the file cannot spell either way.
    expect(count(editor.state.doc, "hardBreak")).toBe(0);
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    editor.destroy();
  });

  it("writes nothing when the selection ends at the end of the block after the heading", () => {
    const { editor, written } = open("# Title\n\nprose\n");
    const before = written();
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, 2, editor.state.doc.content.size - 1),
      ),
    );

    press(editor, "Shift-Enter");

    // The break would land in the heading with the whole selection deleted from under it, so there
    // is nothing after it there either. This wrote "T\\\n\n" and lost both blocks.
    expect(written()).toBe(before);
    editor.destroy();
  });

  // The other half, because a guard that refused every break in every heading would pass all three
  // of the above and would also be wrong: a two line heading is a thing markdown can write and this
  // editor can show, and refusing to make one is refusing an edit the file can hold.
  it("still breaks a level 1 or 2 heading in the middle, and the file reads back the same", () => {
    for (const [source, expected] of [
      ["# Title\n\nprose\n", "Ti\\\ntle\n===\n\nprose\n"],
      ["## Title\n\nprose\n", "Ti\\\ntle\n---\n\nprose\n"],
    ] as const) {
      const { editor, written } = open(source);
      caretIn(editor, "heading", 2);

      press(editor, "Shift-Enter");

      expect([source, written()]).toEqual([source, expected]);
      const reread = parseMarkdown(written(), "/notes/a.md");
      expect([source, reread.doc.toJSON()]).toEqual([source, editor.state.doc.toJSON()]);
      editor.destroy();
    }
  });

  it("still breaks a line at the end of a paragraph, which is what the key is for", () => {
    const { editor } = open("hello\n");
    caretAtEndOfFirstBlock(editor);

    press(editor, "Shift-Enter");

    expect(count(editor.state.doc, "hardBreak")).toBe(1);
    editor.destroy();
  });
});

// Find and replace, which reaches the document through a handle of its own rather than through the
// forty entry points above.
//
// A replace is `tr.insertText` over one match, so it cannot put a block anywhere, take a wrapper
// away or nest a toggle, and the matrix's questions are not its questions. The one it does have is
// the serializer's: a replacement is whatever the user typed into the bar, so it can put a line
// ending in a place markdown has nowhere to write one. Each of these is asserted on the bytes and
// on the bytes being the same document again on the next save.
describe("replacing text", () => {
  const REPLACEMENTS = ["ZZ", "ZZ\nYY"];

  const PLACES: Array<[string, string, string, string[]]> = [
    ["a raw block", '<div class="x">\nkeep me\n</div>\n', "keep", ['<div class="x">\nZZ me\n</div>\n', '<div class="x">\nZZ\nYY me\n</div>\n']],
    // The newline becomes the space a GFM row can hold, and the row is written at whatever width
    // its own cells come to.
    ["a table cell", "| h1 | h2 |\n| -- | -- |\n| aa | b  |\n", "aa", ["| h1 | h2 |\n| - | - |\n| ZZ | b |\n", "| h1 | h2 |\n| - | - |\n| ZZ YY | b |\n"]],
    ["a fence", "```js\nlet x = 1;\n```\n", "let", ["```js\nZZ x = 1;\n```\n", "```js\nZZ\nYY x = 1;\n```\n"]],
    // A heading is one line and this one is too deep for the underlined spelling, so the line
    // ending goes out as the character reference of itself rather than taking the marker with it.
    ["a deep heading", "#### deep heading\n", "deep", ["#### ZZ heading\n", "#### ZZ&#xA;YY heading\n"]],
    ["a toggle body", TOGGLE, "hidden", ["<details open>\n<summary>My title</summary>\n\nZZ\n\n</details>\n", "<details open>\n<summary>My title</summary>\n\nZZ\nYY\n\n</details>\n"]],
  ];

  it.each(PLACES)("keeps %s writable, whatever the replacement holds", (_name, source, query, expected) => {
    REPLACEMENTS.forEach((replacement, index) => {
      const { editor, written } = open(source);
      const find = createFind(editor);
      find.setQuery(query, { caseSensitive: false, wholeWord: false });
      find.replaceAll(replacement);

      const after = written();
      expect([replacement, after]).toEqual([replacement, expected[index]]);

      // And the file is the same file on the save after it, which is what a spelling with no
      // reader behind it fails: the block would come back as something else and grow every time.
      const reread = parseMarkdown(after, "/notes/a.md");
      expect([replacement, serializeMarkdown(reread, reread.doc)]).toEqual([replacement, after]);
      expect([replacement, count(reread.doc, "raw")]).toEqual([replacement, count(editor.state.doc, "raw")]);
      editor.destroy();
    });
  });
});
