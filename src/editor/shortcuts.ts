// Everything the keyboard does inside a document: the chords, and the typing rules that turn
// markdown as you type it into the thing it means.
//
// Both live here rather than on the generated node extensions in extensions.ts, because those are
// mechanically derived from the schema in src/model/schema.ts and have no behaviour of their own.
// This is the one file to read to know what a key does.
//
// The typing rules are not a markdown syntax mode. Nothing they produce leaves syntax on screen:
// "## " becomes a heading and the hashes are gone, "**bold**" becomes bold and the stars are gone.
// That is the same WYSIWYG promise the rest of the editor makes, arrived at from the keyboard.
//
// Cmd+K is deliberately absent. src/keys/bindings.ts binds it globally to the command palette from
// a capture-phase listener, so a link shortcut on that chord would never see the key. Links are a
// toolbar control.

import {
  Extension,
  InputRule,
  markInputRule,
  nodeInputRule,
  textblockTypeInputRule,
  wrappingInputRule,
} from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { isInTable } from "@tiptap/pm/tables";
import { HEADING_LEVELS } from "../model/schema";
import type { MarkName } from "../model/schema";
import { breakable, change, fits } from "./fits";

const STAR_BOLD = /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/;
const UNDERSCORE_BOLD = /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))$/;
const STAR_ITALIC = /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/;
const UNDERSCORE_ITALIC = /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/;
const STRIKETHROUGH = /(?:^|\s)(~~(?!\s+~~)((?:[^~]+))~~(?!\s+~~))$/;
const CODE = /(^|[^`])`([^`]+)`(?!`)$/;

const BULLET = /^\s*([-+*])\s$/;
const ORDERED = /^(\d+)\.\s$/;
const QUOTE = /^\s*>\s$/;
const FENCE = /^```([a-zA-Z0-9_+-]+)?[\s\n]$/;
const RULE = /^(?:---|\*\*\*|___)\s$/;
const HEADING = /^(#{1,6})\s$/;
const CHECKBOX = /^\s*\[([ xX])\]\s$/;

/**
 * "- [ ] " inside a list. The bullet rule has already fired on the dash by the time the box is
 * typed, so this converts the item that is now there rather than wrapping a paragraph.
 */
function checkboxRule(editor: Editor): InputRule {
  return new InputRule({
    find: CHECKBOX,
    handler: ({ state, range, match, chain }) => {
      const checked = match[1].toLowerCase() === "x";
      const taskItem = editor.schema.nodes.taskItem;
      const taskList = editor.schema.nodes.taskList;
      const $from = state.doc.resolve(range.from);

      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const item = $from.node(depth);
        if (item.type.name !== "listItem" && item.type.name !== "taskItem") continue;
        const itemPos = $from.before(depth);
        const list = $from.node(depth - 1);
        const listPos = $from.before(depth - 1);
        chain()
          .deleteRange(range)
          .command(({ tr }) => {
            tr.setNodeMarkup(itemPos, taskItem, { checked });
            // A list of one becomes a task list outright; a list that still holds plain items
            // stays what it is, which the schema allows and the bridge writes back as a mixed
            // list rather than reformatting the items that were not touched.
            if (list.type.name === "bulletList" && list.childCount === 1) {
              tr.setNodeMarkup(listPos, taskList, list.attrs);
            }
            return true;
          })
          .run();
        return;
      }

      chain().deleteRange(range).wrapInList(taskList).run();
    },
  });
}

/**
 * "--- " as a horizontal rule, and as three characters of text where a rule cannot go.
 *
 * The third way a node gets placed in this document, after the toolbar and the clipboard, and the
 * one the guard in fits.ts had not been wired into. The other typing rules ask a question of their
 * own before they fire, because wrapping and changing a block type are operations ProseMirror
 * refuses outright when the result would not fit; a node inserted next to the caret is not, so this
 * one fired anywhere and `tr.insert` did what it always does with a block that has nowhere to go.
 * Typing "--- " in a table cell cut the table in two around the rule and left a row of empty cells
 * behind where the text had been.
 *
 * Declining is returning null, which is how an InputRule says the match was not for it: the run
 * loop drops the transaction and the characters stay as the characters that were typed. So "--- "
 * in a cell is the text "--- ", which is what it is in GFM anyway, and in a list item or a callout
 * it is still the rule it has always been.
 */
function ruleInputRule(type: NodeType): InputRule {
  const rule = nodeInputRule({ find: RULE, type });
  return new InputRule({
    find: RULE,
    handler: (props) => {
      if (!fits(props.state.doc.resolve(props.range.from), type)) return null;
      return rule.handler(props);
    },
  });
}

export const Shortcuts = Extension.create({
  name: "shortcuts",

  addKeyboardShortcuts() {
    const editor = this.editor;
    const mark = (name: MarkName) => () => editor.commands.toggleMark(name);

    // Every chord that changes what a block is goes through the same guard the toolbar's own
    // conversions go through, and for the same reason: a chord is a command like any other, and
    // the file does not care which of the two the user reached for. Mod-Alt-2 in a raw block
    // rewrote the user's html as an escaped heading, and Mod-Alt-0 in a toggle deleted the toggle
    // and its title, both of them while the toolbar items beside them were being fixed.
    const headings = Object.fromEntries(
      HEADING_LEVELS.map((level) => [
        `Mod-Alt-${level}`,
        () => change(editor, "convert", (chain) => chain.toggleNode("heading", "paragraph", { level })),
      ]),
    );

    return {
      ...headings,
      "Mod-b": mark("strong"),
      "Mod-i": mark("em"),
      "Mod-e": mark("code"),
      "Mod-Shift-x": mark("strikethrough"),

      "Mod-Alt-0": () => change(editor, "convert", (chain) => chain.setNode("paragraph")),
      "Mod-Shift-7": () => change(editor, "wrap", (chain) => chain.toggleList("orderedList", "listItem")),
      "Mod-Shift-8": () => change(editor, "wrap", (chain) => chain.toggleList("bulletList", "listItem")),
      "Mod-Shift-9": () => change(editor, "wrap", (chain) => chain.toggleList("taskList", "taskItem")),
      "Mod-Shift-b": () => change(editor, "wrap", (chain) => chain.toggleWrap("blockquote")),
      "Mod-Alt-c": () => change(editor, "convert", (chain) => chain.toggleNode("codeBlock", "paragraph")),

      // Falls through to the core keymap's exit-code binding when the cursor is not in a task.
      "Mod-Enter": () =>
        editor.commands.command(({ state, tr, dispatch }) => {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const item = $from.node(depth);
            if (item.type.name !== "taskItem") continue;
            if (dispatch) {
              tr.setNodeMarkup($from.before(depth), undefined, {
                ...item.attrs,
                checked: !item.attrs.checked,
              });
            }
            return true;
          }
          return false;
        }),

      // A fence and a raw block take the newline as the newline they are holding; everywhere else
      // this is a `<br>`, and the guard is which of those the file can hold. A cell cannot: GFM
      // gives a cell one line, so the serializer writes a break inside one as a space and the next
      // open of the file has no break in it. Nothing was lost, and an editor drawing a line the
      // file swallows is still an editor showing a save that did not happen.
      "Shift-Enter": () => {
        if (editor.commands.newlineInCode()) return true;
        // Claimed rather than declined, which is the difference between refusing and letting
        // somebody else do it: a shortcut that answers false leaves the keydown to the browser,
        // and a browser handed Shift+Enter in a contenteditable puts a <br> in by itself.
        if (!breakable(editor.state)) return true;
        return editor.commands.insertContent({ type: "hardBreak" });
      },

      Enter: () =>
        editor.commands.first(({ commands }) => [
          () => commands.splitListItem("taskItem"),
          () => commands.splitListItem("listItem"),
        ]),
      // Tab inside a table is src/editor/blocks/tables.ts, which binds it ahead of this one and
      // answers with prosemirror-tables' own cell walk, claiming the key in the first and the last
      // cell too so that neither of these is reached from inside one. What is left here is the list
      // case, and the guard is still said out loud because that is an ordering rather than a rule
      // and these two are the direction that costs a document. A cell holds inline content and can
      // never hold a list of its own, so the only item either command could find to act on is the
      // one the table itself is nested in: a table indented under a bullet, with the whole list
      // lifted apart by a key the user pressed to move back one cell.
      Tab: () =>
        !isInTable(editor.state) &&
        (editor.commands.sinkListItem("taskItem") || editor.commands.sinkListItem("listItem")),
      "Shift-Tab": () =>
        !isInTable(editor.state) &&
        (editor.commands.liftListItem("taskItem") || editor.commands.liftListItem("listItem")),
    };
  },

  addInputRules() {
    const { schema } = this.editor;

    return [
      textblockTypeInputRule({
        find: HEADING,
        type: schema.nodes.heading,
        getAttributes: (match) => ({ level: match[1].length }),
      }),
      textblockTypeInputRule({
        find: FENCE,
        type: schema.nodes.codeBlock,
        getAttributes: (match) => ({ language: match[1] ?? null, meta: null }),
      }),
      wrappingInputRule({ find: BULLET, type: schema.nodes.bulletList }),
      wrappingInputRule({
        find: ORDERED,
        type: schema.nodes.orderedList,
        getAttributes: (match) => ({ start: Number(match[1]) }),
        joinPredicate: (match, node) => node.childCount + node.attrs.start === Number(match[1]),
      }),
      wrappingInputRule({ find: QUOTE, type: schema.nodes.blockquote }),
      ruleInputRule(schema.nodes.horizontalRule),
      checkboxRule(this.editor),

      markInputRule({ find: STAR_BOLD, type: schema.marks.strong }),
      markInputRule({ find: UNDERSCORE_BOLD, type: schema.marks.strong }),
      markInputRule({ find: STAR_ITALIC, type: schema.marks.em }),
      markInputRule({ find: UNDERSCORE_ITALIC, type: schema.marks.em }),
      markInputRule({ find: STRIKETHROUGH, type: schema.marks.strikethrough }),
      markInputRule({ find: CODE, type: schema.marks.code }),
    ];
  },
});
