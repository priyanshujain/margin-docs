// The editor's schema is the contract's schema, node for node and mark for mark.
//
// src/model/schema.ts is frozen and the markdown bridge is written against it: it produces
// callouts, toggles, task lists, tables, math and raw blocks, marks named `strong`, `em` and
// `strikethrough`, a code block that carries the `meta` off its opening fence and lists that
// remember whether they were tight. StarterKit's own nodes are a different schema: no callout, no
// toggle, no raw, `bold` where this one says `strong`, and a code block with nowhere to keep
// `meta`. Adopting them would mean the bridge parsing a document the editor cannot hold, and every
// attribute the two disagree about is a piece of somebody's file quietly lost on the next save.
//
// So the node and mark extensions below are generated from those specs rather than restated: one
// TipTap extension per entry in the contract, carrying that entry's own content expression,
// attributes, parse rules and DOM rendering. A node added to the contract appears here without
// this file being touched, and a node that is not in the contract cannot appear here at all.
//
// StarterKit is still here for the things that are behaviour rather than schema: undo and redo,
// the drop cursor, the gap cursor, and the list backspace and delete handling. Everything it
// contributes to the schema is switched off, `trailingNode` included, because that one appends an
// empty paragraph to the end of a document and an editor that changes a file it was only asked to
// open is the one thing this app must never do.

import { Extension, Mark, Node } from "@tiptap/core";
import type { Extensions, MarkConfig, NodeConfig } from "@tiptap/core";
import type { AttributeSpec } from "@tiptap/pm/model";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import { marks as markSpecs, nodes as nodeSpecs } from "../model/schema";
import type { MarkName, NodeName } from "../model/schema";
import { BLOCK_EXTENSIONS } from "./blocks";
import { LinkPicker } from "./linkPicker";
import { imageView } from "./images";
import { createPaste, type PasteContext } from "./paste";
import { Proofing } from "./proofing";
import { SearchHighlight } from "./search";
import { Shortcuts } from "./shortcuts";

const NODE_NAMES = Object.keys(nodeSpecs) as NodeName[];
const MARK_NAMES = Object.keys(markSpecs) as MarkName[];

/** Enter at the end of a finished task starts an unfinished one. Every other attribute carries. */
const RESET_ON_SPLIT: ReadonlySet<string> = new Set(["taskItem.checked"]);

function attributesFrom(owner: string, attrs: Record<string, AttributeSpec> | undefined) {
  if (!attrs) return null;
  return Object.fromEntries(
    Object.entries(attrs).map(([name, spec]) => [
      name,
      {
        default: "default" in spec ? spec.default : null,
        validate: spec.validate,
        // The spec's own toDOM already writes what the DOM needs under the names the DOM uses,
        // so rendering the attribute again under its schema name would put `kind="note"` next to
        // `data-callout="note"` on the same element.
        rendered: false,
        keepOnSplit: !RESET_ON_SPLIT.has(`${owner}.${name}`),
      },
    ]),
  );
}

function nodeExtension(name: NodeName) {
  const spec = nodeSpecs[name];
  const config: Partial<NodeConfig> = {
    name,
    topNode: name === "doc",
    content: spec.content,
    marks: spec.marks,
    group: spec.group,
    inline: spec.inline,
    atom: spec.atom,
    selectable: spec.selectable,
    draggable: spec.draggable,
    code: spec.code,
    whitespace: spec.whitespace,
    linebreakReplacement: spec.linebreakReplacement,
    defining: spec.defining,
    isolating: spec.isolating,
  };

  const attributes = attributesFrom(name, spec.attrs);
  if (attributes) config.addAttributes = () => attributes;

  const { parseDOM, toDOM } = spec;
  if (parseDOM) config.parseHTML = () => parseDOM;
  if (toDOM) config.renderHTML = ({ node }) => toDOM(node);
  // A local picture is read from beside the document, which a bare `src` in a webview is not.
  if (name === "image") config.addNodeView = () => ({ node }) => imageView(node);

  return Node.create(config);
}

function markExtension(name: MarkName) {
  const spec = markSpecs[name];
  const config: Partial<MarkConfig> = {
    name,
    inclusive: spec.inclusive,
    excludes: spec.excludes,
    group: spec.group,
    spanning: spec.spanning,
    code: spec.code,
  };

  const attributes = attributesFrom(name, spec.attrs);
  if (attributes) config.addAttributes = () => attributes;

  const { parseDOM, toDOM } = spec;
  if (parseDOM) config.parseHTML = () => parseDOM;
  // The second argument is ProseMirror's "is this mark on inline content", which TipTap's
  // renderHTML does not carry and no mark in the contract reads.
  if (toDOM) config.renderHTML = ({ mark }) => toDOM(mark, true);

  return Mark.create(config);
}

/**
 * `tableRole` is the one field a NodeSpec can carry that TipTap does not have a config key for,
 * and prosemirror-tables reads it by that exact name. Nothing in this build reads it yet; it is
 * here so the sentence at the top of this file stays true rather than nearly true.
 */
const SchemaExtras = Extension.create({
  name: "schemaExtras",

  extendNodeSchema(extension) {
    const spec = nodeSpecs[extension.name as NodeName];
    return spec && spec.tableRole ? { tableRole: spec.tableRole } : {};
  },
});

export function createEditorExtensions(context: PasteContext): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      document: false,
      hardBreak: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      orderedList: false,
      paragraph: false,
      strike: false,
      text: false,
      underline: false,
      trailingNode: false,
    }),

    ...NODE_NAMES.map(nodeExtension),
    ...MARK_NAMES.map(markExtension),
    SchemaExtras,

    // What an empty block says it is waiting for.
    //
    // `includeChildren` is what makes this more than one prompt on one node. Left off, the plugin
    // never looks past the document's own children, so the words appeared in an empty top level
    // paragraph and in nothing else: not in a list item, not in a table cell, not in the first
    // paragraph of a callout somebody had just made, not in a toggle nobody had typed into yet. It
    // does not put more of them on screen at once, because `showOnlyCurrent` is on and only the
    // block holding the caret is ever decorated; what it changes is which blocks can be that one.
    //
    // The text is a function of the node, and only of the node, because that is all the plugin can
    // truthfully be asked. It computes the decoration inside a state field's apply, where the
    // document it is describing is the transaction's and `editor.state` is still the one before it,
    // so a position resolved against the editor here is resolved against the wrong document exactly
    // when the block is new: press Enter for a second list item and the paragraph the prompt is for
    // does not exist in the document this callback can see. A heading knows its own level and a
    // fence knows its own language, so those two are answered here. Whether a paragraph is a list
    // item's line, a cell, or a quote is a fact about its parent, and prose.css answers that with a
    // descendant selector, which cannot be wrong about ancestry and costs nothing.
    //
    // A fence used to be silenced here rather than answered, and that was a workaround for where
    // the words landed rather than for what they said: `data-placeholder` goes on the empty node's
    // element, which for a code block is the `<pre>`, and the fence keeps its padding on the
    // `<code>` inside, so the prompt floated onto the top left corner of the box, over the border,
    // 12.6px above and 15.4px left of the caret, in the document's 17px serif rather than the
    // fence's 14px mono. prose.css places it against the `<code>`'s content box now, and the label
    // it used to collide with has moved off `::before`. `graph TD` for a diagram, since an empty
    // ```mermaid fence is the one block in this editor that gives no clue at all what goes in it.
    //
    // Not AppFlowy's paragraph prompt, which reads "Enter a / to insert a block, or start typing".
    // There is no slash menu here and there is not going to be one, per docs/design.md.
    //
    // Both class options are set empty rather than left out. Their defaults are `is-empty` and
    // `is-editor-empty`, and an `is-` class is what the CSS conventions say state is never spelled
    // as; the names that were here instead were spelled the house way and then never used by any
    // stylesheet, which is worse than either. The attribute is the whole contract.
    Placeholder.configure({
      emptyEditorClass: "",
      emptyNodeClass: "",
      includeChildren: true,
      placeholder: ({ node }) => {
        if (node.type.name === "heading") return `Heading ${node.attrs.level}`;
        if (node.type.name === "codeBlock") {
          return node.attrs.language === "mermaid" ? "graph TD" : "Start writing…";
        }
        // A raw block is somebody's source bytes held verbatim, and an empty one is a fence with
        // nothing between its markers. Prompting there would be this editor offering to write into
        // the one construct it has said it cannot model.
        if (node.type.name === "raw") return "";
        return "Start writing…";
      },
    }),

    SearchHighlight,

    // Spelling underlines the whole document and opens a menu over a word; like SearchHighlight it
    // only ever draws, so it sits beside it rather than among the block lanes. It claims no paste
    // and no drop, which is what keeps it from ever getting in front of the clipboard guard below.
    Proofing,

    createPaste(context),
    Shortcuts,

    // The `[[` picker. Its position in this array does no work: it sets priority 500, and TipTap
    // sorts by priority after reversing, so it is asked after the clipboard guard at 1000 and
    // before every block lane at 100. It is listed here because this is where a reader looks for
    // it. Do not raise it past the clipboard: that guard has to keep the front of the list.
    LinkPicker.configure({ documentPath: context.documentPath }),

    // Behaviour for the blocks that need more than a spec: tables, code, math and mermaid. It is
    // kept in src/editor/blocks/ rather than here because a generated node extension has nowhere
    // to put a node view or a keymap, and because those four are worked on independently of each
    // other and of this file. Last in the array on purpose: TipTap reverses extensions when it
    // collects plugins, so a lane's keymap is asked before the general one above it.
    ...BLOCK_EXTENSIONS,
  ];
}
