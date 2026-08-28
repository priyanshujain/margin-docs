import { Schema } from "@tiptap/pm/model";
import type { AttributeSpec, Attrs, MarkSpec, Node as ProseMirrorNode, NodeSpec } from "@tiptap/pm/model";

// This schema is the contract between the markdown bridge and the editor. The bridge may only
// produce nodes declared here, and the serializer must be able to write every one of them back to
// disk, so the set is closed: anything markdown can express that has no node becomes `raw`.
//
// Names are camelCase to match TipTap, so an M2 extension can adopt a spec from this file rather
// than restating it. The order of the entries is the schema order, and it matters: the first node
// in the `block` group is what ProseMirror fills empty content with, so `paragraph` comes first.

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

export type NodeName =
  | "doc"
  | "paragraph"
  | "heading"
  | "text"
  | "hardBreak"
  | "image"
  | "mathInline"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "listItem"
  | "taskList"
  | "taskItem"
  | "codeBlock"
  | "horizontalRule"
  | "table"
  | "tableRow"
  | "tableHeader"
  | "tableCell"
  | "callout"
  | "toggle"
  | "mathBlock"
  | "raw";

export type MarkName = "link" | "strong" | "em" | "strikethrough" | "code";

function validateColwidth(value: unknown): void {
  if (value === null) return;
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) return;
  throw new RangeError("colwidth must be null or an array of numbers");
}

// colspan, rowspan and colwidth exist for prosemirror-tables, which reads those exact names.
// GFM has no spanning cells, so a table where either span is not 1 cannot be serialized and the
// bridge has to fall back to a raw block. align is the GFM per column alignment from the delimiter
// row; it is carried on every cell in the column so a cell can be styled without walking upwards.
const cellAttrs: Record<string, AttributeSpec> = {
  colspan: { default: 1, validate: "number" },
  rowspan: { default: 1, validate: "number" },
  colwidth: { default: null, validate: validateColwidth },
  align: { default: null, validate: "string|null" },
};

function cellAttrsFromDOM(dom: HTMLElement): Attrs {
  const widths = dom.getAttribute("data-colwidth");
  return {
    colspan: Number(dom.getAttribute("colspan") ?? 1),
    rowspan: Number(dom.getAttribute("rowspan") ?? 1),
    colwidth: widths && /^\d+(,\d+)*$/.test(widths) ? widths.split(",").map(Number) : null,
    align: dom.getAttribute("data-align") || null,
  };
}

function cellAttrsToDOM(node: ProseMirrorNode): Record<string, string> {
  const out: Record<string, string> = {};
  if (node.attrs.colspan !== 1) out.colspan = String(node.attrs.colspan);
  if (node.attrs.rowspan !== 1) out.rowspan = String(node.attrs.rowspan);
  if (node.attrs.colwidth) out["data-colwidth"] = (node.attrs.colwidth as number[]).join(",");
  if (node.attrs.align) out["data-align"] = String(node.attrs.align);
  return out;
}

export const nodes: { [name in NodeName]: NodeSpec } = {
  doc: {
    content: "block+",
  },

  // `whitespace: "pre"` because a newline inside a paragraph is the author's own line wrap and not
  // a space this editor may reflow. src/markdown/parse.ts keeps the soft breaks mdast gives it
  // inside the text so a hand wrapped file is written back wrapped where it was, and prose.css
  // draws a paragraph pre-wrap so those newlines are on screen exactly where the author put them.
  // This field is the third part of that sentence, and it was the missing one: prosemirror-view
  // reads it to decide how to parse the editor's own DOM back after a keystroke, and left at the
  // default every soft wrap in the paragraph being typed into came back as a `hardBreak`, so one
  // character typed into a hand wrapped paragraph put a backslash at every wrap point in it. It is
  // also what lets Backspace join two hand wrapped paragraphs without rewriting both their wraps
  // as breaks, since prosemirror-transform asks the same field before it joins.
  //
  // The parse rule says the opposite on purpose, and a rule's own answer outranks the node's:
  // whitespace is significant in a paragraph THIS editor rendered, and meaningless in a `<p>` off
  // somebody else's page, where the newlines are the html source's own indentation and keeping
  // them would put line breaks and runs of spaces through the middle of a pasted sentence.
  paragraph: {
    content: "inline*",
    group: "block",
    whitespace: "pre",
    parseDOM: [{ tag: "p", preserveWhitespace: false }],
    toDOM: () => ["p", 0],
  },

  heading: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: { level: { default: 1, validate: "number" } },
    parseDOM: HEADING_LEVELS.map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  text: {
    group: "inline",
  },

  hardBreak: {
    inline: true,
    group: "inline",
    selectable: false,
    linebreakReplacement: true,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },

  // Markdown has no block image: ![alt](src) is phrasing content, and a picture on its own line is
  // a paragraph whose only child is this node. Modelling it as a block would rewrite the file.
  image: {
    inline: true,
    group: "inline",
    draggable: true,
    attrs: {
      src: { default: "", validate: "string" },
      alt: { default: null, validate: "string|null" },
      title: { default: null, validate: "string|null" },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => ({
          src: dom.getAttribute("src") ?? "",
          alt: dom.getAttribute("alt"),
          title: dom.getAttribute("title"),
        }),
      },
    ],
    toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  mathInline: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: { latex: { default: "", validate: "string" } },
    parseDOM: [
      {
        tag: "span[data-latex]",
        getAttrs: (dom) => ({ latex: dom.getAttribute("data-latex") ?? "" }),
      },
    ],
    toDOM: (node) => ["span", { class: "math-inline", "data-latex": node.attrs.latex }, node.attrs.latex],
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },

  // Task items are allowed in the plain lists as well as in taskList, because GFM lets a single
  // list mix "- [ ] done" items with ordinary ones. The bridge emits taskList only when every item
  // carries a checkbox; a mixed list is a bulletList or orderedList holding both kinds of item.
  bulletList: {
    content: "(listItem | taskItem)+",
    group: "block",
    attrs: { tight: { default: true, validate: "boolean" } },
    parseDOM: [{ tag: "ul", getAttrs: (dom) => ({ tight: !dom.hasAttribute("data-loose") }) }],
    toDOM: (node) => ["ul", { "data-loose": node.attrs.tight ? null : "" }, 0],
  },

  orderedList: {
    content: "(listItem | taskItem)+",
    group: "block",
    attrs: {
      start: { default: 1, validate: "number" },
      tight: { default: true, validate: "boolean" },
    },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => ({
          start: Number(dom.getAttribute("start") ?? 1),
          tight: !dom.hasAttribute("data-loose"),
        }),
      },
    ],
    toDOM: (node) => [
      "ol",
      { start: node.attrs.start === 1 ? null : node.attrs.start, "data-loose": node.attrs.tight ? null : "" },
      0,
    ],
  },

  // An item opens with a paragraph, which is what makes Enter, Tab and Backspace behave and what
  // the TipTap list commands assume. Markdown does allow an item that starts with a nested list or
  // a fence, so the bridge writes those items' list out as a raw block instead of mangling it.
  listItem: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },

  taskList: {
    content: "taskItem+",
    group: "block",
    attrs: { tight: { default: true, validate: "boolean" } },
    parseDOM: [
      {
        tag: "ul[data-task-list]",
        priority: 60,
        getAttrs: (dom) => ({ tight: !dom.hasAttribute("data-loose") }),
      },
    ],
    toDOM: (node) => ["ul", { class: "task-list", "data-task-list": "", "data-loose": node.attrs.tight ? null : "" }, 0],
  },

  taskItem: {
    content: "paragraph block*",
    defining: true,
    attrs: { checked: { default: false, validate: "boolean" } },
    parseDOM: [
      {
        tag: "li[data-checked]",
        priority: 60,
        getAttrs: (dom) => ({ checked: dom.getAttribute("data-checked") !== "false" }),
      },
    ],
    toDOM: (node) => ["li", { class: "task-item", "data-checked": node.attrs.checked ? "true" : "false" }, 0],
  },

  // meta is everything after the language on the opening fence, ```ts twoslash. Dropping it would
  // silently rewrite the file, so it rides along even though nothing reads it yet.
  codeBlock: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    whitespace: "pre",
    attrs: {
      language: { default: null, validate: "string|null" },
      meta: { default: null, validate: "string|null" },
    },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => ({ language: dom.getAttribute("data-language"), meta: null }),
      },
    ],
    toDOM: (node) => ["pre", { "data-language": node.attrs.language }, ["code", 0]],
  },

  horizontalRule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },

  table: {
    content: "tableRow+",
    group: "block",
    tableRole: "table",
    isolating: true,
    parseDOM: [{ tag: "table" }],
    toDOM: () => ["table", ["tbody", 0]],
  },

  tableRow: {
    content: "(tableCell | tableHeader)*",
    tableRole: "row",
    parseDOM: [{ tag: "tr" }],
    toDOM: () => ["tr", 0],
  },

  // Cells hold inline content, not blocks: a GFM cell cannot contain a paragraph, a list or a
  // fenced block, and allowing them would let the editor build a table that cannot be written out.
  tableHeader: {
    content: "inline*",
    attrs: cellAttrs,
    tableRole: "header_cell",
    isolating: true,
    parseDOM: [{ tag: "th", getAttrs: (dom) => cellAttrsFromDOM(dom) }],
    toDOM: (node) => ["th", cellAttrsToDOM(node), 0],
  },

  tableCell: {
    content: "inline*",
    attrs: cellAttrs,
    tableRole: "cell",
    isolating: true,
    parseDOM: [{ tag: "td", getAttrs: (dom) => cellAttrsFromDOM(dom) }],
    toDOM: (node) => ["td", cellAttrsToDOM(node), 0],
  },

  // A GitHub alert: a blockquote whose first line is "> [!NOTE]".
  callout: {
    content: "block+",
    group: "block",
    defining: true,
    attrs: { kind: { default: "note", validate: "string" } },
    parseDOM: [
      {
        tag: "div[data-callout]",
        getAttrs: (dom) => ({ kind: dom.getAttribute("data-callout") || "note" }),
      },
    ],
    toDOM: (node) => ["div", { class: "callout", "data-callout": node.attrs.kind }, 0],
  },

  // <details> on disk. The summary is an attribute rather than a child node, so it is plain text:
  // a <summary> carrying markup is not modellable and belongs in a raw block.
  toggle: {
    content: "block+",
    group: "block",
    defining: true,
    attrs: {
      summary: { default: "", validate: "string" },
      open: { default: false, validate: "boolean" },
    },
    parseDOM: [
      {
        tag: "details",
        contentElement: (dom) => dom.querySelector<HTMLElement>("[data-toggle-body]") ?? dom,
        getAttrs: (dom) => ({
          summary: dom.querySelector("summary")?.textContent ?? "",
          open: dom.hasAttribute("open"),
        }),
      },
    ],
    toDOM: (node) => [
      "details",
      { class: "toggle", open: node.attrs.open ? "" : null },
      ["summary", {}, node.attrs.summary],
      ["div", { "data-toggle-body": "" }, 0],
    ],
  },

  mathBlock: {
    group: "block",
    atom: true,
    attrs: { latex: { default: "", validate: "string" } },
    parseDOM: [
      {
        tag: "div[data-math-block]",
        getAttrs: (dom) => ({ latex: dom.getAttribute("data-latex") ?? "" }),
      },
    ],
    toDOM: (node) => [
      "div",
      { class: "math-block", "data-math-block": "", "data-latex": node.attrs.latex },
      node.attrs.latex,
    ],
  },

  // The safety net. Anything the bridge cannot model, an HTML block, a footnote definition, a
  // table with spanning cells, a construct nobody thought of, becomes one of these and MUST round
  // trip byte identical: the serializer writes the text content out verbatim, with no escaping, no
  // reflowing and no trailing newline of its own.
  //
  // The node holds the source twice on purpose. `source` is the slice exactly as it was read from
  // disk and never changes; the text content is the same string, but editable, because the block
  // is shown as a monospace field the user can type in. While the two are equal the block is
  // provably untouched and the bytes are the file's own. Once they differ the user has edited it
  // and the text content wins. Never write to `source` after parsing.
  raw: {
    content: "text*",
    marks: "",
    group: "block",
    atom: false,
    code: true,
    defining: true,
    isolating: true,
    whitespace: "pre",
    attrs: { source: { default: "", validate: "string" } },
    parseDOM: [
      {
        tag: "pre[data-raw]",
        priority: 60,
        preserveWhitespace: "full",
        getAttrs: (dom) => ({ source: dom.textContent ?? "" }),
      },
    ],
    toDOM: () => ["pre", { class: "raw-block", "data-raw": "" }, ["code", 0]],
  },
};

export const marks: { [name in MarkName]: MarkSpec } = {
  link: {
    inclusive: false,
    attrs: {
      href: { default: null, validate: "string|null" },
      title: { default: null, validate: "string|null" },
    },
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => ({ href: dom.getAttribute("href"), title: dom.getAttribute("title") }),
      },
    ],
    toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.title }, 0],
  },

  strong: {
    group: "formatting",
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
  },

  em: {
    group: "formatting",
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM: () => ["em", 0],
  },

  strikethrough: {
    group: "formatting",
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    toDOM: () => ["s", 0],
  },

  // A code span's own content is literal, so nothing can be emphasised inside one, but a code span
  // can itself be emphasised or linked: `**\`x\`**` and `[\`x\`](y)` are both ordinary markdown and
  // both render on GitHub. Marks are a flat set here, so those two readings are the same set and
  // the direction is decided once, by the serializer: src/markdown/serialize.ts puts code innermost
  // and writes the emphasis around it. Excluding the formatting group instead, which this mark did
  // until a document holding `**\`x\`**` could not be opened at all, is not a narrower rule but a
  // wrong one: the bridge kept building the set the file described and every such document failed
  // `doc.check()` on the way into the editor.
  code: {
    code: true,
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
  },
};

export const schema = new Schema<NodeName, MarkName>({ nodes, marks, topNode: "doc" });
