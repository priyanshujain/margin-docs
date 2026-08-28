// The ProseMirror document to Typst converter.
//
// Every node in src/model/schema.ts needs an answer here, and escaping is a security boundary
// rather than a formatting detail: a document containing `#let`, `$` or `@` must reach the
// compiler as text and never as Typst.
//
// The whole defence is one rule, and it is the reason this file has no `esc` that sprinkles
// backslashes through markup the way the sibling book exporter does. Nothing the document holds is
// ever written into markup. Every character that came out of a user's file leaves this module
// through `str`, which produces a Typst *string literal*, and a string literal has exactly five
// escapes and no syntax inside it: `#"= #let x $y$ @z"` is eight words on a page and cannot be
// anything else. So the grep that proves the boundary is short. If a template literal below
// interpolates a value that did not come from `str`, from `hex` or from a constant declared in this
// file, that is the bug.
//
// The corollary is the shape of the output. Inline content is a run of `#`-prefixed expressions
// with nothing between them, because a string literal followed by a bare `[` or `(` would be read
// as a call and a string literal followed by a space would put a space on the page. Blocks are
// single expressions joined by blank lines. Anything that needs real layout is a `#let` in the
// preamble taking its text as a parameter, so the preamble is the only markup in the file and it
// is written here rather than derived from anything.

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ImageInput } from "../ipc";
import { resolveRelative } from "../links";
import { CALLOUT_LABELS, calloutKindFromLabel, type CalloutKind } from "../model/doc";

export interface TypstDocument {
  source: string;
  images: ImageInput[];
  /** What the converter worked around: an image with nowhere to read it from, a src it cannot use. */
  warnings: string[];
}

/** A mermaid fence's text, mapped to the SVG it drew. Missing means the fence stays code. */
export type Diagrams = ReadonlyMap<string, string>;

/**
 * How a formula is written out.
 *
 * `typeset` hands the LaTeX to mitex, which is the point of having maths at all. `literal` writes
 * it as its own source in monospace, which is what the editor shows on screen and what an export
 * falls back to when mitex will not take the document's LaTeX: mitex fails a compile rather than
 * a formula, so one expression it cannot parse would otherwise cost the whole PDF.
 */
export type MathMode = "typeset" | "literal";

export interface TypstOptions {
  diagrams?: Diagrams;
  math?: MathMode;
}

const MERMAID = "mermaid";

/**
 * Where an image with no file behind it is put.
 *
 * The leading slash is load bearing. Typst resolves `image("x")` against the file that wrote it and
 * the backend's resolver answers on the resolved path, so a relative name in a document compiled at
 * the root would be looked up as `/x` and not found. Everything this module names is rooted, which
 * is also true of the file-backed images: those carry the absolute path the backend reads them from.
 */
const INLINE = "/inline/";

// ------------------------------------------------------------------------------------------------
// The boundary
// ------------------------------------------------------------------------------------------------

/**
 * A lone surrogate is half of a character, and it survives neither the JSON of the IPC boundary nor
 * UTF-8 on the other side of it. Nothing in a real document has one; a paste out of a broken tool
 * does, and it must not be the thing that decides whether an export happens.
 */
function sanitize(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0xd800 && code <= 0xdfff ? "�" : ch;
  }
  return out;
}

/**
 * The one place a string from the document becomes Typst source.
 *
 * A Typst string literal knows `\\`, `\"`, `\n`, `\r`, `\t` and `\u{...}` and nothing else, so a
 * control character is written as its escape rather than passed through, and every other character
 * stands for itself. There is no construct inside a string literal for a `#`, a `$` or an `@` to
 * open, which is the whole point: the escaping here has one rule instead of a list of them, and a
 * list is what goes out of date when Typst gains syntax.
 */
export function str(value: string): string {
  let out = '"';
  for (const ch of sanitize(value)) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A colour from the table below, never from the document. */
function hex(value: string): string {
  return `rgb(${str(value)})`;
}

/**
 * Inline text as a page reads it rather than as the file stores it.
 *
 * A soft wrap inside a paragraph is a decision the author made about the file, not about the page,
 * and a PDF has its own measure, so it becomes a space. Runs of whitespace collapse for the same
 * reason every markdown renderer collapses them. A hard break is a separate node and keeps its
 * break. The non-breaking space is deliberately not in the class: it is a character somebody typed.
 */
function flow(value: string): string {
  return value.replace(/[ \t\n\r\f\v\u2028\u2029]+/g, " ");
}

// ------------------------------------------------------------------------------------------------
// The palette and the faces
//
// Both are the app's own, read off src/styles/tokens.css and src/styles/prose.css rather than
// chosen here, because an export is the document on screen and not a second design. The light
// palette specifically: a PDF is a white page whatever `data-theme` says.
//
// Literata and Hanken Grotesk are the two families src-tauri/src/pdf.rs compiles into the binary,
// so they are always there and can be named here. Monospace and the maths face are not named here
// at all: neither is bundled, both come off the machine, and Typst warns once for every family it
// was asked for and could not find, so a hopeful list written on this side would end every export
// with a toast about fonts nobody chose. src-tauri/src/fonts.rs asks the system what it actually
// has, and pdf.rs puts the answer in front of this preamble.
// ------------------------------------------------------------------------------------------------

const BODY_FONT = "Literata";
const UI_FONT = "Hanken Grotesk";

// The light palette of src/styles/tokens.css, written out because Typst source cannot read a CSS
// custom property. Each one names the token it is a copy of, so a token that moves can be found
// again from here; nothing checks that they still agree, and a fork between the two is a PDF that
// stops looking like the screen it was exported from.
const INK = "#23201b"; // --ink
const INK_SOFT = "#6b6458"; // --ink-soft
const INK_FAINT = "#9b9484"; // --ink-faint
const DOC_RULE = "#e3ddce"; // --doc-rule
const DOC_RULE_STRONG = "#cdc4ae"; // --doc-rule-strong
const DOC_WASH = "#23201b0d"; // --ink at 5 percent
const CODE_SURFACE = "#f2ece0"; // --code-surface
const CODE_LINE = "#e6dfce"; // --code-line
const CODE_WASH = "#23201b14"; // --ink at 8 percent
const DANGER = "#b4453a"; // --danger
const DANGER_INK = "#963327"; // --danger-ink
const DANGER_WASH = "#b4453a1a"; // --danger at 10 percent

/**
 * The five callouts, in ink tones and the one warning colour rather than in five new hues.
 *
 * This is prose.css's decision, not a fresh one: the palette has a single danger colour and
 * inventing four more here would fork the visual language between the screen and the page.
 */
const CALLOUT_COLOURS: Record<CalloutKind, { edge: string; fill: string; label: string }> = {
  note: { edge: INK_FAINT, fill: DOC_WASH, label: INK_SOFT },
  tip: { edge: INK_FAINT, fill: DOC_WASH, label: INK_SOFT },
  important: { edge: INK_FAINT, fill: DOC_WASH, label: INK_SOFT },
  warning: { edge: DANGER, fill: DANGER_WASH, label: DANGER_INK },
  caution: { edge: DANGER, fill: DANGER_WASH, label: DANGER_INK },
};

// ------------------------------------------------------------------------------------------------
// The preamble
// ------------------------------------------------------------------------------------------------

/**
 * The document's furniture, and the only markup in this file.
 *
 * A document editor, not a book: one page size, no chapter openers, no trim.
 *
 * `mitex` is imported only when the document has a formula in it. The import path is the contract
 * with the backend, and a missing package is a hard compile error rather than a warning, so a
 * document with no maths in it is not made to depend on it.
 */
function preamble(title: string, math: boolean): string {
  const mitex = math ? `#import "/mitex/lib.typ": mitex, mi\n\n` : "";
  return `${mitex}#set document(title: ${str(title)})
#set page(paper: "a4", margin: (x: 2.4cm, y: 2.6cm), numbering: "1", number-align: center)
#set text(font: ${str(BODY_FONT)}, size: 11pt, fill: ${hex(INK)}, lang: "en")
#set par(leading: 0.7em, spacing: 1.05em, justify: false)
#set heading(numbering: none)

// Six levels do not come from six sizes: by the fourth step the difference is under a point and
// the reader stops seeing a hierarchy. Size for the first three, a weight step for the fourth, the
// UI face for the last two, case for the sixth. prose.css's scale, in print units.
#show heading: set block(above: 1.9em, below: 0.55em)
#show heading.where(level: 1): set text(size: 1.77em, weight: 600, tracking: -0.016em)
#show heading.where(level: 2): set text(size: 1.35em, weight: 600, tracking: -0.008em)
#show heading.where(level: 3): set text(size: 1.12em, weight: 600)
#show heading.where(level: 4): set text(size: 1em, weight: 700)
#show heading.where(level: 5): set text(font: ${str(UI_FONT)}, size: 0.88em, weight: 700)
#show heading.where(level: 6): set text(
  font: ${str(UI_FONT)},
  size: 0.77em,
  weight: 700,
  tracking: 0.1em,
  fill: ${hex(INK_SOFT)},
)
#show heading.where(level: 6): upper

// This palette has no link colour, because the book it came from had no links. A link is body text
// with a permanent underline instead: unmistakable in a scan, and it keeps the colour of whatever
// block it sits in.
#show link: it => underline(stroke: 0.6pt + ${hex(INK_FAINT)}, offset: 0.16em, it)
#show strike: set text(fill: ${hex(INK_SOFT)})

#show table: set text(size: 0.88em)
#show raw.where(block: true): it => block(
  width: 100%,
  fill: ${hex(CODE_SURFACE)},
  stroke: 0.5pt + ${hex(CODE_LINE)},
  radius: 5pt,
  inset: (x: 0.9em, y: 0.75em),
  above: 1.5em,
  below: 1.5em,
  breakable: true,
  text(size: 0.82em, it),
)
#show raw.where(block: false): it => box(
  fill: ${hex(CODE_WASH)},
  radius: 2.5pt,
  inset: (x: 0.3em),
  outset: (y: 0.2em),
  text(size: 0.88em, it),
)

#let doc-rule = block(
  width: 100%,
  above: 2.6em,
  below: 2.6em,
  line(length: 100%, stroke: 0.7pt + ${hex(DOC_RULE_STRONG)}),
)

// Not italic, unlike a book's. A quote in a technical document is as likely to be a paragraph of a
// spec or somebody's bug report as an epigraph, and the bar and the ink carry it instead.
#let doc-quote(body) = block(
  width: 100%,
  inset: (left: 1.55em),
  stroke: (left: 2pt + ${hex(DOC_RULE_STRONG)}),
  above: 1.5em,
  below: 1.5em,
  text(fill: ${hex(INK_SOFT)}, body),
)

#let doc-callout(edge, fill, label-ink, label, body) = block(
  width: 100%,
  fill: fill,
  radius: 8pt,
  stroke: (rest: 0.5pt + ${hex(DOC_RULE)}, left: 3pt + edge),
  inset: (x: 1.15em, y: 0.95em),
  above: 1.5em,
  below: 1.5em,
  {
    text(font: ${str(UI_FONT)}, size: 0.68em, weight: 700, tracking: 0.12em, fill: label-ink, upper(label))
    v(0.5em, weak: true)
    body
  },
)

// Always open. A PDF has no disclosure to click, so a closed toggle would be a paragraph the export
// lost, and the summary is a line of its own above the body exactly as the <summary> is on screen.
#let doc-toggle(summary, body) = block(
  width: 100%,
  stroke: 0.5pt + ${hex(DOC_RULE)},
  radius: 8pt,
  inset: (x: 1.1em, y: 0.85em),
  above: 1.5em,
  below: 1.5em,
  {
    text(weight: 600, summary)
    v(0.5em, weak: true)
    body
  },
)

// Drawn rather than written, because a checkbox glyph is only a checkbox in a font that has one,
// and the faces behind this compile are not this module's to choose.
#let doc-check(done) = box(
  width: 0.8em,
  height: 0.8em,
  radius: 2.5pt,
  baseline: 0.08em,
  stroke: 0.8pt + ${hex(INK_FAINT)},
  fill: if done { ${hex(INK_SOFT)} } else { none },
)

#let doc-figure(body) = block(width: 100%, above: 1.8em, below: 1.8em, align(center, body))
`;
}

// ------------------------------------------------------------------------------------------------
// Images
// ------------------------------------------------------------------------------------------------

interface Context {
  /** The document's own path, which every relative link and image src is resolved against. */
  readonly file: string;
  readonly diagrams: Diagrams;
  readonly mathMode: MathMode;
  readonly images: ImageInput[];
  /** A src as the document wrote it, mapped to how the source refers to it, or null for a refusal. */
  readonly seen: Map<string, string | null>;
  readonly warnings: string[];
  math: boolean;
  drawings: number;
}

function extensionOf(dataUrl: string): string {
  const match = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl);
  const kind = (match?.[1] ?? "png").toLowerCase().split("+")[0];
  return kind === "jpeg" ? "jpg" : kind;
}

/**
 * How the source should refer to this image, and the entry the backend needs to find it. Null when
 * there is nothing to point at: a picture on the web, which this app does not fetch, or an src that
 * is not a path at all.
 *
 * A file-backed image travels as a path and the backend opens it, which is also where it is checked
 * against the open roots, because an src in a document is untrusted input. Bytes only travel inline
 * when there is no file behind them.
 */
function imagePath(ctx: Context, src: string): string | null {
  const known = ctx.seen.get(src);
  if (known !== undefined) return known;

  let path: string | null = null;
  if (src.startsWith("data:image/")) {
    const comma = src.indexOf(",");
    const data = comma === -1 ? "" : src.slice(comma + 1);
    if (data) {
      path = `${INLINE}image-${ctx.images.length + 1}.${extensionOf(src)}`;
      ctx.images.push({ path, data });
    }
  } else {
    // Sanitised once, here, so the path the source names and the path the backend is handed are the
    // same string. They are compared for equality on the other side, and a path that went through
    // this function twice has to come back the same both times.
    const resolved = resolveRelative(ctx.file, src);
    if (resolved !== null) {
      path = sanitize(resolved);
      ctx.images.push({ path, data: null });
    }
  }

  if (path === null) ctx.warnings.push(`${src || "an image with no source"} could not be included`);
  ctx.seen.set(src, path);
  return path;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A drawn diagram, which has no file behind it and so travels as bytes. */
function diagramPath(ctx: Context, svg: string): string {
  ctx.drawings += 1;
  const path = `${INLINE}diagram-${ctx.drawings}.svg`;
  ctx.images.push({ path, data: base64(svg) });
  return path;
}

// ------------------------------------------------------------------------------------------------
// Inline content
// ------------------------------------------------------------------------------------------------

function marked(node: ProseMirrorNode, body: string): string {
  let out = body;
  // Code is innermost and the emphasis goes around it, which is the direction src/markdown's
  // serializer already picked for the same flat mark set.
  if (node.marks.some((m) => m.type.name === "em")) out = `#emph[${out}]`;
  if (node.marks.some((m) => m.type.name === "strong")) out = `#strong[${out}]`;
  if (node.marks.some((m) => m.type.name === "strikethrough")) out = `#strike[${out}]`;
  const href = node.marks.find((m) => m.type.name === "link")?.attrs.href;
  if (typeof href === "string" && href) out = `#link(${str(href)})[${out}]`;
  return out;
}

function inline(ctx: Context, node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "text": {
      const text = node.text ?? "";
      if (!text) return "";
      const code = node.marks.some((m) => m.type.name === "code");
      // A code span keeps its whitespace: it is the one inline place where a run of spaces is
      // content. Everything else flows.
      return marked(node, code ? `#raw(${str(sanitize(text))})` : `#${str(flow(text))}`);
    }
    case "hardBreak":
      return "#linebreak()";
    case "image": {
      const path = imagePath(ctx, String(node.attrs.src ?? ""));
      if (path === null) return altText(node);
      // Sized to the line rather than left at its natural size, because an image sitting inside a
      // sentence is a badge or an icon and a photograph does not go there.
      return `#box(image(${str(path)}, height: 1em), baseline: 0.15em)`;
    }
    case "mathInline": {
      const latex = String(node.attrs.latex ?? "");
      if (ctx.mathMode === "literal") return `#raw(${str(sanitize(latex))})`;
      ctx.math = true;
      return `#mi(${str(latex)})`;
    }
    default:
      // Nothing else is inline in this schema. An unknown node still gets its text on the page,
      // because a construct nobody thought of is worth less than a construct silently dropped.
      return node.textContent ? `#${str(flow(node.textContent))}` : "";
  }
}

/** What is left of an image that has no file: the words the author wrote in its place. */
function altText(node: ProseMirrorNode): string {
  const alt = String(node.attrs.alt ?? "").trim();
  return alt ? `#emph[#${str(flow(alt))}]` : "";
}

function inlines(ctx: Context, node: ProseMirrorNode): string {
  let out = "";
  node.forEach((child) => {
    out += inline(ctx, child);
  });
  return out;
}

/** Inline content as a Typst content block, which is what every layout helper takes. */
function content(ctx: Context, node: ProseMirrorNode): string {
  return `[${inlines(ctx, node)}]`;
}

// ------------------------------------------------------------------------------------------------
// Blocks
// ------------------------------------------------------------------------------------------------

/** The children of a container, as one content block. */
function body(ctx: Context, node: ProseMirrorNode): string {
  return `[${blocks(ctx, node)}]`;
}

function blocks(ctx: Context, node: ProseMirrorNode): string {
  const out: string[] = [];
  node.forEach((child) => {
    const rendered = block(ctx, child);
    if (rendered) out.push(rendered);
  });
  return out.join("\n\n");
}

function isImageOnly(node: ProseMirrorNode): boolean {
  let images = 0;
  let others = 0;
  node.forEach((child) => {
    if (child.type.name === "image") images += 1;
    else if (child.type.name !== "text" || (child.text ?? "").trim()) others += 1;
  });
  return images === 1 && others === 0;
}

function paragraph(ctx: Context, node: ProseMirrorNode): string {
  // Markdown has no block image: a picture on its own line is a paragraph holding nothing else, and
  // that is the one this exporter gives a figure to rather than a line's worth of height.
  if (isImageOnly(node)) {
    let picture = "";
    node.forEach((child) => {
      if (child.type.name === "image") picture = blockImage(ctx, child);
    });
    if (picture) return picture;
  }
  const rendered = inlines(ctx, node);
  // An empty paragraph is a blank line in a plain text file, and a blank line is content there.
  return rendered || "#v(0.9em, weak: true)";
}

function blockImage(ctx: Context, node: ProseMirrorNode): string {
  const path = imagePath(ctx, String(node.attrs.src ?? ""));
  if (path === null) {
    const alt = altText(node);
    return alt || "#v(0.9em, weak: true)";
  }
  const title = String(node.attrs.title ?? "").trim();
  const picture = `image(${str(path)})`;
  if (!title) return `#doc-figure(${picture})`;
  return `#doc-figure(figure(${picture}, caption: [#${str(flow(title))}]))`;
}

function listItems(ctx: Context, node: ProseMirrorNode): string[] {
  const items: string[] = [];
  node.forEach((child) => {
    // A GFM list may mix "- [ ] a" with ordinary items, so a checkbox can turn up inside a plain
    // list. It rides at the head of the item rather than being dropped.
    const box = child.type.name === "taskItem" ? `#doc-check(${child.attrs.checked ? "true" : "false"})#h(0.45em)` : "";
    items.push(`[${box}${blocks(ctx, child)}]`);
  });
  return items;
}

function taskList(ctx: Context, node: ProseMirrorNode): string {
  const cells: string[] = [];
  node.forEach((child) => {
    // No leading `#`: a grid's arguments are already code, and the marker there is a call rather
    // than an escape back into markup.
    cells.push(`doc-check(${child.attrs.checked ? "true" : "false"})`);
    cells.push(body(ctx, child));
  });
  if (cells.length === 0) return "";
  const gutter = node.attrs.tight ? "0.4em" : "0.85em";
  return `#grid(columns: (1.35em, 1fr), row-gutter: ${gutter}, align: (left + top, left + top), ${cells.join(", ")})`;
}

const ALIGNMENTS: Record<string, string> = { left: "left", center: "center", right: "right" };

function table(ctx: Context, node: ProseMirrorNode): string {
  const rows: ProseMirrorNode[] = [];
  node.forEach((row) => rows.push(row));
  if (rows.length === 0) return "";

  const widthOf = (row: ProseMirrorNode): number => {
    let width = 0;
    row.forEach((cell) => {
      width += Math.max(1, Number(cell.attrs.colspan) || 1);
    });
    return width;
  };
  const columns = Math.max(1, ...rows.map(widthOf));

  // GFM carries one alignment per column on the delimiter row and the bridge copies it on to every
  // cell in that column, so the first row is as good a place to read it as any.
  const aligns: string[] = [];
  rows[0].forEach((cell) => {
    const align = ALIGNMENTS[String(cell.attrs.align ?? "")] ?? "left";
    for (let i = 0; i < Math.max(1, Number(cell.attrs.colspan) || 1); i += 1) aligns.push(align);
  });
  while (aligns.length < columns) aligns.push("left");
  aligns.length = columns;

  const cellsOf = (row: ProseMirrorNode): string[] => {
    const out: string[] = [];
    row.forEach((cell) => {
      const inner = cell.type.name === "tableHeader" ? `[#strong[${inlines(ctx, cell)}]]` : content(ctx, cell);
      const colspan = Math.max(1, Number(cell.attrs.colspan) || 1);
      const rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1);
      out.push(
        colspan === 1 && rowspan === 1
          ? inner
          : `table.cell(colspan: ${colspan}, rowspan: ${rowspan})${inner}`,
      );
    });
    return out;
  };

  let heads = 0;
  rows[0].forEach((cell) => {
    if (cell.type.name === "tableHeader") heads += 1;
  });
  const headed = heads > 0 && heads === rows[0].childCount;

  const parts: string[] = [];
  rows.forEach((row, index) => {
    const cells = cellsOf(row);
    if (cells.length === 0) return;
    if (index === 0 && headed) parts.push(`table.header(${cells.join(", ")})`);
    else parts.push(cells.join(", "));
  });
  if (parts.length === 0) return "";

  // Horizontal rules and a washed header row: prose.css's table, which has no vertical rules at all
  // because a document table is not a spreadsheet.
  const fill = headed ? `\n  fill: (_, y) => if y == 0 { ${hex(DOC_WASH)} },` : "";
  return `#table(
  columns: ${columns},
  align: (${aligns.join(", ")}),
  stroke: (x: none, y: 0.5pt + ${hex(DOC_RULE)}),
  inset: (x: 0.8em, y: 0.5em),${fill}
  ${parts.join(",\n  ")},
)`;
}

function callout(ctx: Context, node: ProseMirrorNode): string {
  const declared = String(node.attrs.kind ?? "note");
  const kind = calloutKindFromLabel(declared);
  const colours = CALLOUT_COLOURS[kind ?? "note"];
  // A kind nobody has heard of keeps its own word as the label. It is text off disk either way, so
  // it goes through `str` either way; only the colours are chosen here, and never by the document.
  const label = kind === null ? declared.trim() || "note" : CALLOUT_LABELS[kind];
  return `#doc-callout(${hex(colours.edge)}, ${hex(colours.fill)}, ${hex(colours.label)}, ${str(flow(label))}, ${body(ctx, node)})`;
}

function codeBlock(ctx: Context, node: ProseMirrorNode): string {
  const text = sanitize(node.textContent);
  const language = typeof node.attrs.language === "string" ? node.attrs.language.trim() : "";

  if (language === MERMAID) {
    const svg = ctx.diagrams.get(node.textContent);
    // A diagram that would not draw stays the fence the user wrote, which is the same answer the
    // editor gives on screen: a broken diagram is a line to go and fix, not a block to hide.
    if (svg) return `#doc-figure(image(${str(diagramPath(ctx, svg))}))`;
  }

  const lang = language ? `, lang: ${str(language)}` : "";
  return `#raw(${str(text)}${lang}, block: true)`;
}

function block(ctx: Context, node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "paragraph":
      return paragraph(ctx, node);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1));
      return `#heading(level: ${level})${content(ctx, node)}`;
    }
    case "blockquote":
      return `#doc-quote(${body(ctx, node)})`;
    case "bulletList": {
      const items = listItems(ctx, node);
      return items.length ? `#list(tight: ${node.attrs.tight ? "true" : "false"}, ${items.join(", ")})` : "";
    }
    case "orderedList": {
      const items = listItems(ctx, node);
      const start = Number(node.attrs.start);
      const from = Number.isFinite(start) ? Math.max(0, Math.trunc(start)) : 1;
      return items.length
        ? `#enum(start: ${from}, tight: ${node.attrs.tight ? "true" : "false"}, ${items.join(", ")})`
        : "";
    }
    case "taskList":
      return taskList(ctx, node);
    case "codeBlock":
      return codeBlock(ctx, node);
    case "horizontalRule":
      return "#doc-rule";
    case "table":
      return table(ctx, node);
    case "callout":
      return callout(ctx, node);
    case "toggle":
      // Open, always. A PDF has no disclosure to click, so a closed toggle would be a paragraph the
      // export lost.
      return `#doc-toggle(${str(flow(String(node.attrs.summary ?? "")))}, ${body(ctx, node)})`;
    case "mathBlock": {
      // Bare, with none of the surface the editor draws around it. On screen a formula is a box of
      // monospace source because that is what is being edited; on the page it is typeset, and
      // typeset mathematics does not want a code block's border around it.
      const latex = String(node.attrs.latex ?? "");
      if (ctx.mathMode === "literal") return `#raw(${str(sanitize(latex))}, block: true)`;
      ctx.math = true;
      return `#mitex(${str(latex)})`;
    }
    case "raw":
      // The bytes the bridge could not model, shown as what they are. No language: this is source
      // in no particular language, and guessing one would colour it wrong.
      return `#raw(${str(sanitize(node.textContent))}, block: true)`;
    default: {
      // A node this file has never heard of still reaches the page. Its own children are walked
      // where it has any, so a future container does not take its contents down with it.
      if (node.isTextblock) return inlines(ctx, node) || "";
      const inner = blocks(ctx, node);
      return inner || (node.textContent ? `#${str(flow(node.textContent))}` : "");
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Mermaid
// ------------------------------------------------------------------------------------------------

/** Every mermaid fence in the document, in order, deduplicated. Pure, so a test can call it. */
export function diagramSources(doc: ProseMirrorNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "codeBlock") return true;
    if (node.attrs.language === MERMAID && node.textContent.trim() && !out.includes(node.textContent)) {
      out.push(node.textContent);
    }
    return false;
  });
  return out;
}

let configured = false;
let drawn = 0;

/**
 * Mermaid is several megabytes, so this import is dynamic exactly as the editor's own is: a user who
 * never exports a document with a diagram in it never fetches the library.
 *
 * The theme is `neutral` rather than the app's own palette, and that is the one place this differs
 * from the block on screen. A drawn diagram bakes its colours in, the page it is going on to is
 * white whatever the app's theme is, and mermaid's neutral theme is the one meant for a document
 * that will be printed. Exporting in dark mode must not produce a black rectangle on white paper.
 */
async function draw(text: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  if (!configured) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "neutral",
    });
    configured = true;
  }
  await mermaid.parse(text);
  drawn += 1;
  const { svg } = await mermaid.render(`typst-diagram-${drawn}`, text);
  return svg;
}

/**
 * Every diagram in the document, drawn. Needs a DOM, which is why it is not part of the conversion:
 * a fence whose render failed is simply absent from the map and comes out of the converter as the
 * code it always was.
 */
export async function renderDiagrams(doc: ProseMirrorNode): Promise<Map<string, string>> {
  const svgs = new Map<string, string>();
  for (const text of diagramSources(doc)) {
    try {
      svgs.set(text, await draw(text));
    } catch {
      // Deliberately swallowed. The caller counts what is missing; one diagram that will not parse
      // is not a reason to refuse the other forty pages.
    }
  }
  return svgs;
}

// ------------------------------------------------------------------------------------------------
// The document
// ------------------------------------------------------------------------------------------------

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * One document, as Typst source and the images it refers to.
 *
 * `path` is the file the document came from. It is what relative image sources resolve against, and
 * it is the PDF's title: a markdown file's identity is its path and the H1 is content, so a
 * document whose first heading disagrees with its filename is not renamed on the way out. There is
 * no frontmatter here to strip, because the bridge never put it in the tree.
 *
 * `diagrams` comes from `renderDiagrams`, which is async and wants a DOM. Everything below is
 * neither, so the whole conversion is a pure function of the document.
 */
export function documentToTypst(doc: ProseMirrorNode, path: string, options: TypstOptions = {}): TypstDocument {
  const ctx: Context = {
    file: path,
    diagrams: options.diagrams ?? new Map(),
    mathMode: options.math ?? "typeset",
    images: [],
    seen: new Map(),
    warnings: [],
    math: false,
    drawings: 0,
  };
  const rendered = blocks(ctx, doc);
  return {
    source: `${preamble(baseName(path), ctx.math)}\n${rendered}\n`,
    images: ctx.images,
    warnings: ctx.warnings,
  };
}
