// The document surface, and the only place in the app that holds a TipTap instance.
//
// The autosave contract lives here as much as it does in the store, and it is a contract about
// what this component does NOT do. Opening a document installs a ProseMirror state and nothing
// else: no serializer runs, no write is scheduled, and `onChange` does not fire, because
// `view.updateState` is not a dispatched transaction and TipTap only emits `update` when a
// transaction actually changed the document. A file that is opened, read and closed is never
// written. Once the user types, `onChange` hands out the live ProseMirror node on every keystroke,
// which is cheap; turning that node into markdown happens once, later, on the shell's debounce.
//
// Ported from margin's editor/Editor.tsx. Margin keeps an EditorState per chapter because a book
// is many documents open at once; here there is one document at a time, so that cache collapses
// into a small path-keyed LRU whose only job is making a return to a recent file instant, with its
// undo history and its caret still where they were.

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorProps as ProseMirrorProps, EditorView } from "@tiptap/pm/view";
import type { CalloutKind, HeadingLevel, MarkdownDocument } from "../model/doc";
import { sourceDocument } from "../markdown";
import { currentAt, outlineOf, sameOutline, type OutlineEntry } from "../model/outline";
import { marks as markSpecs } from "../model/schema";
import type { MarkName } from "../model/schema";
import { notify } from "../store/useToast";
import { insertMath, insertMermaid, setCodeLanguage, tableCommand } from "./blocks";
import { createEditorExtensions } from "./extensions";
import { change, changeable, markable, place, placeable } from "./fits";
import { isolatingLine } from "./lines";
import { loadPosition, savePosition, type DocumentPosition } from "./positions";
import { searchStateOf, type SearchOptions } from "./search";
import type {
  BlockCommand,
  BlockKind,
  DocumentFind,
  DocumentOutline,
  EditorActiveState,
  EditorHandle,
  EditorProps,
  TableOp,
} from "./index";

// How much of the pane the caret is kept out of when the view scrolls it into sight. The toolbar
// pill is 44px tall (32px controls, 5px of padding, a 1px border) and sticks 22px above the bottom
// of the pane, so it covers the last 66px of it; a line of body prose on top of that means the
// caret's whole line clears the glass instead of sitting against it. Nothing overlaps the top,
// where the titlebar is a sibling above the scroller rather than floating over it, so the number
// there is breathing room and nothing more.
const CARET_KEEPOUT = { top: 24, right: 0, bottom: 98, left: 0 };

/** Enough that going back to what you were just looking at is instant, and not a document store. */
const CACHE_LIMIT = 8;

const EMPTY_CONTENT = { type: "doc", content: [{ type: "paragraph" }] };

const MARK_NAMES = Object.keys(markSpecs) as MarkName[];

/** Blocks a cursor can be inside without them being what the toolbar should report. */
const PASS_THROUGH = new Set([
  "paragraph",
  "listItem",
  "taskItem",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

const REPORTED = new Set<string>([
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "toggle",
  "table",
  "mathBlock",
  "raw",
]);

interface Cached {
  state: EditorState;
  document: MarkdownDocument;
  scroll: number;
}

const listeners = new Set<() => void>();
let currentHandle: EditorHandle | null = null;
let currentFind: DocumentFind | null = null;
let currentOutline: DocumentOutline | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(): void {
  for (const listener of listeners) listener();
}

const handleSnapshot = () => currentHandle;
const findSnapshot = () => currentFind;
const outlineSnapshot = () => currentOutline;

/** The handle for the document currently on screen, or null when there is none. */
export function useEditorHandle(): EditorHandle | null {
  return useSyncExternalStore(subscribe, handleSnapshot, handleSnapshot);
}

/** Find and replace over the open document, for whatever draws the find bar. */
export function useDocumentFind(): DocumentFind | null {
  return useSyncExternalStore(subscribe, findSnapshot, findSnapshot);
}

/** The headings of the open document, for whatever draws the outline. */
export function useDocumentOutline(): DocumentOutline | null {
  return useSyncExternalStore(subscribe, outlineSnapshot, outlineSnapshot);
}

function reportContentError(error: unknown): void {
  notify(`Part of this document could not be read into the editor: ${String(error)}`);
}

function scrollerOf(editor: Editor): HTMLElement | null {
  const dom = editor.view.dom as HTMLElement;
  const pane = dom.closest(".editor-pane");
  if (pane instanceof HTMLElement) return pane;
  for (let el = dom.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return null;
}

/** Ticking a box is an edit like any other, so it goes through the view and dirties the buffer. */
function toggleTask(view: EditorView, item: Element): boolean {
  const $pos = view.state.doc.resolve(view.posAtDOM(item, 0));
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name !== "taskItem") continue;
    view.dispatch(
      view.state.tr.setNodeMarkup($pos.before(depth), undefined, {
        ...node.attrs,
        checked: !node.attrs.checked,
      }),
    );
    return true;
  }
  return false;
}

/**
 * The ProseMirror props this component installs directly on the view, as opposed to the ones an
 * extension contributes through `addProseMirrorPlugins`.
 *
 * Lifted out of the component and exported so that it can be enumerated. It is a third channel into
 * the document, alongside the editor handle and the extensions' own plugins, and it was the one
 * src/editor/fits.test.ts could not see: that file reads every extension's plugins and every
 * extension's keymap, and `editorProps` is neither. A `handlePaste` or a `handleKeyDown` added here
 * would be asked before any of them and answer for the whole document, unenumerated. The click
 * handler that is here today only flips a checkbox, which is the harmless case; the enumeration is
 * for the next one.
 */
export function createEditorProps(context: {
  editable: () => boolean;
  onOpenLink: (href: string) => void;
}): ProseMirrorProps {
  return {
    attributes: { class: "prose" },
    scrollThreshold: CARET_KEEPOUT,
    scrollMargin: CARET_KEEPOUT,
    handleClick: (view, _pos, event) => {
      const target = event.target as HTMLElement | null;
      // The checkbox is drawn by the list item's own ::before, so a click that lands on the item
      // itself rather than on the paragraph inside it is a click on the box.
      const item = target?.closest(".task-item");
      if (item && item === event.target && toggleTask(view, item)) {
        event.preventDefault();
        return true;
      }
      const anchor = target?.closest("a[href]");
      const href = anchor?.getAttribute("href");
      if (!href) return false;
      // A plain click puts the caret in the link text, which is the only way to edit it. Opening
      // is the modified click, or any click at all while the document is not editable.
      if (context.editable() && !event.metaKey && !event.ctrlKey) return false;
      event.preventDefault();
      context.onOpenLink(href);
      return true;
    },
  };
}

function enclosing(editor: Editor, names: readonly string[]): { name: string; pos: number } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (names.includes(name)) return { name, pos: $from.before(depth) };
  }
  return null;
}

/**
 * The document's active state, which is what the toolbar draws itself from.
 *
 * Exported for src/editor/active.test.ts and for nothing else. The four `can` fields below are the
 * pill's whole answer to a tool that cannot run where the caret is, and the way to prove they are
 * right is to ask them in the same places src/editor/fits.test.ts asks the commands.
 */
export function activeStateOf(editor: Editor): EditorActiveState {
  const marks = MARK_NAMES.filter((mark) => editor.isActive(mark));
  const { state } = editor;
  const { $from } = state.selection;
  // Asked separately from the walk below, because that walk stops at the innermost block it has a
  // name for and a cell selection's own position is not inside any of them. isActive answers for a
  // cursor in a cell, a selection across cells and the table selected whole, alike.
  const inTable = editor.isActive("table");
  const base = {
    marks,
    inTable,
    codeLanguage: null,
    // The four the pill greys a tool out on, and they are fits.ts's own questions rather than a
    // second reading of the schema here: the same predicate the command asks the moment it runs is
    // the one that decides whether the button offering it is dark. Anything else drifts, and a pill
    // that is wrong about what it can do is worse than one that says nothing.
    //
    // A mark and a block are each asked about one representative type. Only the fence and the raw
    // block name their marks in the frozen schema, and every block node in it is in the one group,
    // so a second type would be the same answer written twice.
    canMark: markable(state, state.schema.marks.strong),
    canPlace: placeable(state, state.schema.nodes.horizontalRule),
    canPlaceInline: placeable(state, state.schema.nodes.image),
    // `changeable` is what `change` refuses on, and the table is the half it cannot see: a caret in
    // a cell passes it, and then every conversion declines on its own because a cell holds inline
    // content and there is no block in it to convert. Coarse on purpose. The alternative is a trial
    // transaction per command per render, which would be a truer answer to a question nobody can
    // predict the shape of from looking at the screen.
    canConvert: !inTable && changeable(state),
  };

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    const name = node.type.name;
    if (PASS_THROUGH.has(name)) continue;
    if (name === "heading") {
      return { ...base, block: "heading", headingLevel: node.attrs.level as HeadingLevel, callout: null };
    }
    if (name === "callout") {
      return { ...base, block: "callout", headingLevel: null, callout: node.attrs.kind as CalloutKind };
    }
    if (name === "codeBlock") {
      const language = node.attrs.language as string | null;
      return { ...base, block: "codeBlock", headingLevel: null, callout: null, codeLanguage: language };
    }
    if (REPORTED.has(name)) {
      return { ...base, block: name as BlockKind, headingLevel: null, callout: null };
    }
  }

  return { ...base, block: "paragraph", headingLevel: null, callout: null };
}

function sameActive(a: EditorActiveState, b: EditorActiveState): boolean {
  return (
    a.block === b.block &&
    a.headingLevel === b.headingLevel &&
    a.callout === b.callout &&
    a.inTable === b.inTable &&
    a.codeLanguage === b.codeLanguage &&
    // The four the tools are drawn dark by. They are in here rather than left to follow the fields
    // above because one of them moves on its own: a drag across a rectangle of cells is refused
    // every insert, and it changes no block, no heading and no language, so a snapshot that did not
    // carry it would leave the pill lit over the one selection that has cost this project a table.
    a.canMark === b.canMark &&
    a.canPlace === b.canPlace &&
    a.canPlaceInline === b.canPlaceInline &&
    a.canConvert === b.canConvert &&
    a.marks.length === b.marks.length &&
    a.marks.every((mark, i) => b.marks[i] === mark)
  );
}

/**
 * The command half of the handle, built once per editor and shared by every published snapshot.
 *
 * Exported for src/editor/fits.test.ts and for nothing else: the shell gets the handle through
 * `useEditorHandle` and has no business building one. That test enumerates the keys of what this
 * returns and refuses to pass unless every insert among them has been proved to keep its hands off
 * a document it cannot insert into, which is the only way this file's own insert commands and the
 * block lanes' are held to the same rule.
 */
export function createCommands(editor: Editor): Omit<EditorHandle, "active"> {
  // Nothing for fits.ts to guard here, and that is a claim rather than an oversight: this only ever
  // adds or removes a mark, and ProseMirror already declines a mark the block does not allow. The
  // Link tool needs its guard because it can insert the url as text and the text lands whether the
  // mark can or not; a swatch inserts nothing. `extendMarkRange` is what makes a caret sitting
  // inside a coloured phrase recolour that phrase instead of opening a second one beside it.
  const setColor = (mark: "textColor" | "highlight", color: string | null) => {
    const chain = editor.chain().focus().extendMarkRange(mark);
    if (color === null) chain.unsetMark(mark).run();
    else chain.setMark(mark, { color }).run();
  };

  const setCallout = (kind: CalloutKind | null) => {
    const found = enclosing(editor, ["callout", "blockquote"]);
    if (kind === null) {
      if (found?.name !== "callout") return;
      change(editor, "unwrap", (chain) =>
        chain.command(({ tr, state, dispatch }) => {
          if (dispatch) tr.setNodeMarkup(found.pos, state.schema.nodes.blockquote, {});
          return true;
        }),
      );
      return;
    }
    if (found) {
      change(editor, "wrap", (chain) =>
        chain.command(({ tr, state, dispatch }) => {
          if (dispatch) tr.setNodeMarkup(found.pos, state.schema.nodes.callout, { kind });
          return true;
        }),
      );
      return;
    }
    change(editor, "wrap", (chain) => chain.wrapIn("callout", { kind }));
  };

  return {
    focus: () => {
      editor.commands.focus();
    },

    // The paper under the page, which is most of the pane for most documents and was not part of
    // the editable at all: a press there focused nothing, so the caret stayed where it was and the
    // document lost the keyboard. The shell claims that region and sends it here.
    //
    // An empty paragraph already at the end is landed in rather than added to, so holding the
    // pointer down on the blank sheet does not stack empty blocks up under the document. Anything
    // else and one is made, which is the only way there is to type after a table, a rule, a picture
    // or a fence that ends the file. It is nothing to the serializer, so the file gains no byte for
    // it, and src/editor/fits.test.ts asserts exactly that in every hostile context in the editor.
    focusEnd: () => {
      const paragraph = editor.schema.nodes.paragraph;
      editor
        .chain()
        .focus()
        .command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          const end = tr.doc.content.size;
          const last = tr.doc.lastChild;
          if (last?.type === paragraph && last.content.size === 0) {
            tr.setSelection(TextSelection.create(tr.doc, end - 1));
            return true;
          }
          const index = tr.doc.childCount;
          if (!tr.doc.canReplaceWith(index, index, paragraph)) return true;
          tr.insert(end, paragraph.create());
          tr.setSelection(TextSelection.create(tr.doc, end + 1));
          return true;
        })
        .run();
    },

    toggleMark: (mark) => {
      editor.chain().focus().toggleMark(mark).run();
    },

    setTextColor: (color) => {
      setColor("textColor", color);
    },

    setHighlight: (color) => {
      setColor("highlight", color);
    },

    // With a collapsed caret and no link under it the url goes in as TEXT and is marked
    // afterwards, and the text lands whether the mark can or not: in a fence or a raw block, where
    // the schema allows no marks at all, that is the url typed into somebody's code. Asked of the
    // mark rather than of the block, so it is the same question in both places and in whatever
    // block comes next. The two chains below only add a mark, which ProseMirror already declines
    // to do where the schema says no.
    setLink: (href, title = null) => {
      if (href === null) {
        editor.chain().focus().extendMarkRange("link").unsetMark("link").run();
        return;
      }
      if (editor.state.selection.empty && !editor.isActive("link")) {
        if (!markable(editor.state, editor.schema.marks.link)) return;
        if (!placeable(editor.state, editor.schema.nodes.text)) return;
        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href, title } }] })
          .run();
        return;
      }
      editor.chain().focus().extendMarkRange("link").setMark("link", { href, title }).run();
    },

    // The conversions, and the other half of what fits.ts guards. `place` is for a command that
    // adds a node; these change or rewrap the block the caret is already in, which is the question
    // `change` answers: a raw block refuses all of them, because a conversion writes its preserved
    // source back out as escaped markdown and a wrap writes it back out prefixed, and a conversion
    // that would take a callout or a toggle away with it is thrown out rather than dispatched. A
    // conversion added here that does not go through `change` fails src/editor/fits.test.ts.

    setBlock: (block: BlockCommand) => {
      switch (block) {
        case "paragraph":
          change(editor, "convert", (chain) => chain.clearNodes().setNode("paragraph"));
          return;
        case "bulletList":
          change(editor, "wrap", (chain) => chain.toggleList("bulletList", "listItem"));
          return;
        case "orderedList":
          change(editor, "wrap", (chain) => chain.toggleList("orderedList", "listItem"));
          return;
        case "taskList":
          change(editor, "wrap", (chain) => chain.toggleList("taskList", "taskItem"));
          return;
        case "blockquote":
          change(editor, "wrap", (chain) => chain.toggleWrap("blockquote"));
          return;
        case "codeBlock":
          change(editor, "convert", (chain) => chain.toggleNode("codeBlock", "paragraph"));
          return;
        case "toggle":
          // "unwrap" because this is the toggle's own button: pressed inside one it takes that
          // toggle away, summary and all, which is what the user pressed it for.
          change(editor, "unwrap", (chain) => chain.toggleWrap("toggle"));
      }
    },

    // The line the selection is on is cut out of a wrapped block first, so a heading asked for on
    // one line of a hand wrapped paragraph is that line and not the paragraph. src/editor/lines.ts
    // says when that applies; here it is one step of the same chain, so the guard behind `change`
    // judges the cut and the conversion together and one Cmd+Z takes back both.
    setHeading: (level) => {
      const { heading, paragraph } = editor.schema.nodes;
      if (level === null) {
        change(editor, "convert", (chain) => chain.command(isolatingLine(paragraph)).setNode("paragraph"));
      } else {
        change(editor, "convert", (chain) =>
          chain.command(isolatingLine(heading, { level })).setNode("heading", { level }),
        );
      }
    },

    setCallout,

    // Every one of these goes through `place`, which is the guard and the insert in one call, for
    // the reason written out in fits.ts: with the caret in a table cell an unguarded insert splits
    // the table around the new node and leaves a row with no cells in it, which is a table the
    // serializer writes back as three blank lines, and in a fence or a raw block it cuts the user's
    // own bytes in half and writes the remainder out as prose. An insert added here that does not
    // go through `place` fails src/editor/fits.test.ts, which is the point of that file.

    // The caret is kept off the rule by the same chain that makes it, the way the table below puts
    // it in its first cell. A rule is a leaf, so an insert leaves it selected whole, and a selected
    // node is a node the next character typed replaces: in an empty document, where pressing the
    // tool and then typing is the only thing there is to do next, the character landed where the
    // rule had been and the rule was gone. It looked wrong before it was typed over as well, since
    // a rule under the node selection wash is a black bar rather than a hairline.
    //
    // There are two ways to it and the empty block takes the first. Putting the rule in front of
    // the block the caret is in rather than over it is what the "--- " rule in
    // src/editor/shortcuts.ts already does, and it leaves the caret in a block that is still there
    // to hold it. The second is for every other selection, where the insert splits the block and
    // the caret goes to whatever is under the rule, made if the rule now ends the document.
    //
    // The two lines after the first insert are Chromium's, not ProseMirror's, and they are here
    // because of what they were measured doing. prosemirror-view writes the DOM selection only when
    // it differs from the one the browser is already reporting, and after this insert it does not:
    // the empty paragraph keeps its element and the caret keeps (p, 0). What Chromium keeps behind
    // that is an editing position, and its editing position was still "the start of the editable",
    // which is no longer inside that paragraph now that a rule has been put in front of it. So the
    // first character typed after the tool went in above the rule. Dropping the range and asking
    // the view for the selection again is what makes prosemirror-view write it, and the character
    // then lands under the rule where the caret is drawn. Measured in an empty document both ways
    // round; every other shape of selection was correct without it.
    insertRule: () => {
      const rule = editor.schema.nodes.horizontalRule;
      const { $from, empty } = editor.state.selection;
      const emptyBlock =
        empty && $from.parent.isTextblock && $from.parent.content.size === 0 && $from.depth > 0;
      // Asked of the block's parent rather than assumed, because a list item opens with a paragraph
      // and cannot take a rule in front of that first one; there the split below is the right way
      // in, and this one would leave an empty paragraph over the rule to satisfy the item's shape.
      const room =
        emptyBlock && $from.node(-1).canReplaceWith($from.index(-1), $from.index(-1), rule);
      if (room) {
        const made = place(editor, rule, (chain) =>
          chain.command(({ tr, dispatch }) => {
            if (dispatch) tr.insert($from.before(), rule.create());
            return true;
          }),
        );
        // `isInitialized` is asked because it is TipTap's own answer to "is there a view", and
        // there is not one in src/editor/fits.test.ts, which builds an editor with no element and
        // drives every entry point in this file through it. `editor.view` is a proxy there that
        // stubs `dispatch` and `state` and throws for anything else, `dom` included.
        if (made && editor.isInitialized) {
          editor.view.dom.ownerDocument.getSelection()?.removeAllRanges();
          editor.view.focus();
        }
        return;
      }
      place(editor, rule, (chain) =>
        chain.insertContent({ type: "horizontalRule" }).command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          const after = tr.selection.to;
          const $after = tr.doc.resolve(after);
          const paragraph = tr.doc.type.schema.nodes.paragraph;
          const index = $after.index();
          // A rule that ends the document has nothing under it to hold a caret, so one is made.
          // src/editor/blocks/tables.ts does the same under a table and for the same reason: an
          // empty paragraph is nothing to the serializer, so the file gains no byte for it, and the
          // alternative is a gap cursor nobody recognises as a place to type.
          if (!$after.nodeAfter && $after.parent.canReplaceWith(index, index, paragraph)) {
            tr.insert(after, paragraph.create());
          }
          tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
          return true;
        }),
      );
    },

    // The same guard the insert below runs, asked on its own, because the Insert image tool has to
    // write the picture into the assets folder before it has a path to insert and a refusal after
    // that write is an orphan file beside somebody's document. src/editor/paste.ts asks this same
    // question before it sends any bytes; the toolbar had no way to.
    canInsertImage: () => placeable(editor.state, editor.schema.nodes.image),

    // And it still says so when it refuses, for the caller that asks afterwards anyway.
    insertImage: (src, alt = null) => {
      const placed = place(editor, editor.schema.nodes.image, (chain) =>
        chain.insertContent({ type: "image", attrs: { src, alt, title: null } }),
      );
      if (!placed) notify("An image cannot go where the cursor is.");
    },

    insertTable: (rows, columns) => {
      const table = editor.schema.nodes.table;
      const cells = (type: string) =>
        Array.from({ length: Math.max(1, columns) }, () => ({ type }));
      const body = Array.from({ length: Math.max(0, rows - 1) }, () => ({
        type: "tableRow",
        content: cells("tableCell"),
      }));
      const searchFrom = Math.max(0, editor.state.selection.$from.pos - 1);

      place(editor, table, (chain) =>
        chain
          .insertContent({
            type: "table",
            content: [{ type: "tableRow", content: cells("tableHeader") }, ...body],
          })
          // The insert leaves the caret past the table, so the first thing typed lands under it
          // rather than in it, and the toolbar goes on reading active.inTable as false while a
          // table is on screen. Same transaction as the insert, so it is one undo and not two.
          .command(({ tr, dispatch }) => {
            if (!dispatch) return true;
            let found: number | null = null;
            tr.doc.nodesBetween(searchFrom, tr.doc.content.size, (node, pos) => {
              if (found !== null) return false;
              if (node.type === table) found = pos;
              return found === null;
            });
            // A table, its first row and its first cell are one position each, so three in is the
            // first place text can go.
            if (found !== null) tr.setSelection(TextSelection.create(tr.doc, found + 3));
            return true;
          }),
      );
    },

    // The four below are the block lanes' own commands, and this is the whole of the wiring: each
    // one lives with the extension that gives its block behaviour, in src/editor/blocks/, so that
    // tables, code, math and mermaid are worked on without four hands in this file. They return
    // false where they have nothing to act on, which is a button pressed in the wrong place and
    // means nothing happens.

    tableCommand: (op: TableOp) => {
      tableCommand(editor, op);
    },

    insertMath: (display: boolean) => {
      insertMath(editor, display);
    },

    insertMermaid: () => {
      insertMermaid(editor);
    },

    setCodeLanguage: (language: string | null) => {
      setCodeLanguage(editor, language);
    },
  };
}

/**
 * The find bar's own handle, which is the second surface this file publishes and the other place a
 * command can reach the document from outside the editor layer.
 *
 * Exported for src/editor/fits.test.ts for the same reason `createCommands` is: two of these seven
 * write to the document, and a handle nothing enumerates is a handle a method gets added to without
 * anybody saying where it may run.
 */
export function createFind(editor: Editor): Omit<DocumentFind, "state"> {
  return {
    setQuery: (query: string, options: SearchOptions) => {
      editor.commands.setSearch(query, options);
    },
    clear: () => {
      editor.commands.clearSearch();
    },
    next: () => {
      editor.commands.findNext();
    },
    prev: () => {
      editor.commands.findPrev();
    },
    replaceCurrent: (text: string) => {
      editor.commands.replaceCurrent(text);
    },
    replaceAll: (text: string) => {
      editor.commands.replaceAllInDocument(text);
    },
    focus: () => {
      editor.commands.focus();
    },
  };
}

/**
 * The view, or null while the editor has none. TipTap answers any question put to an unmounted
 * editor's view by throwing, and its own focus command asks with the same try; the only caller that
 * ever gets null is a headless editor in a test, which has no page to scroll.
 */
function mountedView(editor: Editor): EditorView | null {
  try {
    return editor.view.dom ? editor.view : null;
  } catch {
    return null;
  }
}

/**
 * The outline's own handle, which is the third surface this file publishes and the one with
 * nothing in it that writes.
 *
 * Exported for src/editor/fits.test.ts for the same reason `createFind` is: a handle nothing
 * enumerates is a handle a method gets added to without anybody saying what it may do to the
 * document, and what this one may do is move the caret and nothing else.
 */
export function createOutline(editor: Editor): Pick<DocumentOutline, "reveal"> {
  return {
    reveal: (pos: number) => {
      const { doc } = editor.state;
      // The entries are republished on every change, so a stale position is at most a keystroke
      // old, but a keystroke is enough to turn the start of a heading into the middle of a
      // paragraph and the caret does not go somewhere the row never named.
      const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null;
      if (node?.type.name !== "heading") return;

      // Into the heading rather than merely on to the screen, which is what makes the click a
      // navigation the keyboard can carry on from: the next thing typed lands in the section that
      // was asked for. The scroll is done by hand below, so it is turned off here.
      editor.chain().setTextSelection(pos + 1).focus(undefined, { scrollIntoView: false }).run();

      // The heading goes to the top of the pane and not merely into view, since what was asked
      // for is the section under it. The same clearance the caret gets, for the same reason.
      const view = mountedView(editor);
      if (!view) return;
      const scroller = scrollerOf(editor);
      const dom = view.nodeDOM(pos);
      if (!scroller || !(dom instanceof HTMLElement)) return;
      const top =
        dom.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        CARET_KEEPOUT.top;
      scroller.scrollTop = Math.max(0, top);
    },
  };
}

export function DocumentEditor({
  document,
  onChange,
  onOpenLink,
  editable = true,
}: EditorProps): ReactElement {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const documentRef = useRef(document);
  documentRef.current = document;
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const cache = useRef(new Map<string, Cached>());
  const host = useRef<Editor | null>(null);
  const installed = useRef<MarkdownDocument | null>(null);
  const position = useRef<DocumentPosition | null>(null);
  const scrollToken = useRef(0);
  const publish = useRef<(() => void) | null>(null);

  const extensions = useMemo(
    () =>
      createEditorExtensions({
        documentPath: () => documentRef.current.path,
        onError: notify,
      }),
    [],
  );

  const editor = useEditor({
    extensions,
    // Empty on purpose: the layout effect below installs the document through the one code path
    // that also restores the caret and reports a document the schema cannot hold.
    content: EMPTY_CONTENT,
    editable,
    immediatelyRender: false,
    enableContentCheck: true,
    editorProps: createEditorProps({
      editable: () => editableRef.current,
      onOpenLink: (href) => onOpenLinkRef.current(href),
    }),
    onContentError: ({ error }) => reportContentError(error),
    onUpdate: ({ editor }) => onChangeRef.current(editor.state.doc),
  });

  const applyScroll = (ed: Editor, top: number) => {
    const scroller = scrollerOf(ed);
    if (!scroller) return;
    const token = (scrollToken.current += 1);
    const apply = () => {
      if (scrollToken.current === token) scroller.scrollTop = top;
    };
    apply();
    requestAnimationFrame(apply);
    // Web fonts land after the first paint and change every line's height under the caret with
    // them, so the offset that was right a moment ago is wrong once Literata arrives.
    window.document.fonts?.ready.then(apply).catch(() => {});
  };

  const buildState = (ed: Editor, source: MarkdownDocument): EditorState => {
    const base = ed.view.state;
    try {
      // The bridge builds its tree against src/model/schema.ts and TipTap builds an identical one
      // of its own from the same specs, so the node has to be rebound before it can be edited.
      const doc = ed.schema.nodeFromJSON(source.doc.toJSON());
      doc.check();
      return EditorState.create({ doc, plugins: base.plugins });
    } catch (error) {
      reportContentError(error);
      // Never an empty document. `check` answers for the whole tree, so one text node the schema
      // will not hold used to blank the file on screen, and the file on screen is what the next
      // keystroke saves: the debounce would then write those few characters over the bytes on
      // disk. The file's own source, in one raw block, is a document that always passes and that
      // a save writes back verbatim, so the worst case is a document shown as source rather than
      // a document destroyed.
      try {
        const doc = ed.schema.nodeFromJSON(sourceDocument(source).toJSON());
        doc.check();
        return EditorState.create({ doc, plugins: base.plugins });
      } catch (fallback) {
        reportContentError(fallback);
        return EditorState.create({ schema: base.schema, plugins: base.plugins });
      }
    }
  };

  const remember = (path: string, entry: Cached) => {
    cache.current.delete(path);
    cache.current.set(path, entry);
    for (const stale of Array.from(cache.current.keys()).slice(0, cache.current.size - CACHE_LIMIT)) {
      cache.current.delete(stale);
    }
  };

  const stash = (ed: Editor, source: MarkdownDocument) => {
    const scroll = scrollerOf(ed)?.scrollTop ?? 0;
    const { from, to } = ed.state.selection;
    remember(source.path, { state: ed.view.state, document: source, scroll });
    savePosition(source.path, { from, to, scroll });
  };

  const install = (ed: Editor, source: MarkdownDocument, focus: boolean) => {
    const cached = cache.current.get(source.path);
    // Reusable when it is the same object, or a fresh read of a file whose bytes have not moved
    // since that state was built. Anything else and the file is the newer copy, so the cached
    // tree goes: an instant reopen is not worth showing somebody yesterday's document.
    const entry =
      cached && (cached.document === source || cached.document.source === source.source)
        ? cached
        : null;
    if (entry) {
      ed.view.updateState(entry.state);
      if (focus) ed.commands.focus(undefined, { scrollIntoView: false });
      applyScroll(ed, entry.scroll);
    } else {
      ed.view.updateState(buildState(ed, source));
      const saved = loadPosition(source.path);
      const size = ed.state.doc.content.size;
      const selection = saved ? { from: Math.min(saved.from, size), to: Math.min(saved.to, size) } : 0;
      const chain = ed.chain().setTextSelection(selection);
      if (focus) chain.focus(undefined, { scrollIntoView: false });
      chain.run();
      remember(source.path, { state: ed.view.state, document: source, scroll: saved?.scroll ?? 0 });
      applyScroll(ed, saved?.scroll ?? 0);
    }
    position.current = null;
    publish.current?.();
  };

  useLayoutEffect(() => {
    if (!editor) return;
    // A new editor instance, which React's strict double mount produces, cannot be handed states
    // built against the old one's plugins, and it has nothing installed in it yet whatever the
    // last document was.
    const carried = host.current === editor;
    if (!carried) cache.current.clear();
    const previous = carried ? installed.current : null;
    if (previous === document) return;
    if (previous) stash(editor, previous);
    install(editor, document, !previous || previous.path !== document.path);
    installed.current = document;
    host.current = editor;
    // The document is installed by identity, not by field: a new object is a different file or a
    // reload from disk, and a keystroke is neither.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, document]);

  useEffect(() => {
    if (!editor) return;
    // Not setEditable(value): its default emits an `update` with no transaction behind it, which
    // would reach onChange and mark a document dirty that nobody has typed into.
    editor.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    const commands = createCommands(editor);
    const find = createFind(editor);
    const outline = createOutline(editor);
    const scroller = scrollerOf(editor);
    let active = activeStateOf(editor);
    // The tree the entries were read from, so a transaction that only moved the selection reads
    // nothing, and one that typed under the last heading reads and then publishes nothing.
    let outlined: ProseMirrorNode | null = null;
    let entries: readonly OutlineEntry[] = [];
    let frame = 0;
    currentHandle = { active, ...commands };
    currentFind = { state: { count: 0, current: 0 }, ...find };
    currentOutline = { entries, current: null, ...outline };

    // Which heading the reader is in is a question about the screen and not about the tree, so it
    // is measured rather than read: each heading's top against the pane's, and whether the pane
    // has reached its end. The caret would be the wrong answer, since the rail is looked at while
    // scrolling and the caret can be pages away from what is on screen.
    const locate = (): number | null => {
      const view = mountedView(editor);
      if (!view || !scroller) return null;
      const paneTop = scroller.getBoundingClientRect().top;
      const tops = entries.map((entry) => {
        const dom = view.nodeDOM(entry.pos);
        return dom instanceof HTMLElement ? dom.getBoundingClientRect().top - paneTop : Infinity;
      });
      // A pane that cannot scroll is not at its end, it is at its only position.
      const scrollable = scroller.scrollHeight - scroller.clientHeight > 1;
      const atEnd =
        scrollable && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      return currentAt(tops, scroller.clientHeight, atEnd);
    };

    /** True when a new snapshot went out, so a scroll that changed nothing announces nothing. */
    const publishOutline = (under: number | null): boolean => {
      if (
        currentOutline !== null &&
        currentOutline.entries === entries &&
        currentOutline.current === under
      ) {
        return false;
      }
      currentOutline = { entries, current: under, ...outline };
      return true;
    };

    const push = () => {
      const next = activeStateOf(editor);
      if (!sameActive(active, next)) {
        active = next;
        currentHandle = { active, ...commands };
      }
      const search = searchStateOf(editor.state);
      const count = search?.matches.length ?? 0;
      const current = search?.current ?? 0;
      if (currentFind === null || currentFind.state.count !== count || currentFind.state.current !== current) {
        currentFind = { state: { count, current }, ...find };
      }
      if (editor.state.doc !== outlined) {
        outlined = editor.state.doc;
        const read = outlineOf(outlined);
        if (!sameOutline(entries, read)) entries = read;
        publishOutline(locate());
      }
      announce();
    };

    // Scrolling moves the reader and nothing else, so it is the one thing here that republishes a
    // snapshot with no transaction behind it. One measurement a frame, however fast the wheel.
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (publishOutline(locate())) announce();
      });
    };

    publish.current = push;
    push();
    editor.on("transaction", push);
    scroller?.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", onScroll);
      editor.off("transaction", push);
      publish.current = null;
      currentHandle = null;
      currentFind = null;
      currentOutline = null;
      announce();
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const scroller = scrollerOf(editor);
    let timer: ReturnType<typeof setTimeout>;

    const write = () => {
      const source = installed.current;
      if (source && position.current) savePosition(source.path, position.current);
    };

    const persist = () => {
      const { from, to } = editor.state.selection;
      const scroll = scroller?.scrollTop ?? 0;
      position.current = { from, to, scroll };
      const entry = installed.current ? cache.current.get(installed.current.path) : undefined;
      if (entry) entry.scroll = scroll;
      clearTimeout(timer);
      timer = setTimeout(write, 400);
    };

    editor.on("selectionUpdate", persist);
    scroller?.addEventListener("scroll", persist, { passive: true });

    return () => {
      clearTimeout(timer);
      editor.off("selectionUpdate", persist);
      scroller?.removeEventListener("scroll", persist);
      write();
    };
  }, [editor]);

  return <EditorContent editor={editor} className="editor-host" />;
}
