import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "./schema";

export type DocumentKind = "markdown" | "text";

export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn"] as const;
export const TEXT_EXTENSIONS = ["txt", "text"] as const;

/**
 * A file the editor can open. Everything else in the tree is greyed out and handed to the system.
 */
export function documentKindForPath(path: string): DocumentKind | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  if ((MARKDOWN_EXTENSIONS as readonly string[]).includes(ext)) return "markdown";
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return "text";
  return null;
}

/**
 * An open document, as the document store holds it and as the bridge produces and consumes it.
 *
 * `frontmatter` is the leading metadata block exactly as it was read, delimiter lines and trailing
 * newline included, or null when the file has none. It is deliberately not a node in the schema:
 * once YAML becomes a tree of nodes, writing it back means re-emitting it, and a serializer will
 * reorder keys, requote strings, restyle lists and collapse blank lines. Held here as an opaque
 * string it is never parsed, so `frontmatter + serialize(doc)` reproduces the original bytes of
 * the metadata no matter what it contained, including formats the app does not understand at all
 * such as TOML fenced with +++.
 *
 * `source` is the whole file as it was read, kept so a save can be compared against it and so a
 * document whose round trip is not byte identical can be detected rather than silently rewritten.
 */
export interface MarkdownDocument {
  frontmatter: string | null;
  doc: ProseMirrorNode;
  source: string;
  path: string;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export const CALLOUT_KINDS: readonly CalloutKind[] = ["note", "tip", "important", "warning", "caution"];

/** The label inside "> [!NOTE]" on disk. GitHub only recognises these five, in upper case. */
export const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: "NOTE",
  tip: "TIP",
  important: "IMPORTANT",
  warning: "WARNING",
  caution: "CAUTION",
};

export function calloutKindFromLabel(label: string): CalloutKind | null {
  const lower = label.trim().toLowerCase();
  return CALLOUT_KINDS.find((kind) => kind === lower) ?? null;
}

/** GFM column alignment, from the delimiter row. null is the writer's default. */
export type ColumnAlign = "left" | "center" | "right" | null;

export interface HeadingAttrs {
  level: HeadingLevel;
}

export interface ImageAttrs {
  src: string;
  alt: string | null;
  title: string | null;
}

export interface LinkAttrs {
  href: string | null;
  title: string | null;
}

export interface CodeBlockAttrs {
  language: string | null;
  meta: string | null;
}

export interface ListAttrs {
  tight: boolean;
}

export interface OrderedListAttrs extends ListAttrs {
  start: number;
}

export interface TaskItemAttrs {
  checked: boolean;
}

export interface TableCellAttrs {
  colspan: number;
  rowspan: number;
  colwidth: number[] | null;
  align: ColumnAlign;
}

export interface CalloutAttrs {
  kind: CalloutKind;
}

export interface ToggleAttrs {
  summary: string;
  open: boolean;
}

export interface MathAttrs {
  latex: string;
}

export interface RawAttrs {
  source: string;
}

/**
 * The only correct way to build a raw block: the text content starts out equal to the attribute,
 * which is the invariant the byte identical round trip depends on.
 */
export function rawNode(source: string): ProseMirrorNode {
  return schema.nodes.raw.create({ source }, source ? schema.text(source) : null);
}

/** What the serializer writes for a raw block: the user's edit if there was one, else the file's own bytes. */
export function rawOutput(node: ProseMirrorNode): string {
  return node.textContent;
}

export function isRawUnchanged(node: ProseMirrorNode): boolean {
  return node.textContent === node.attrs.source;
}

export function emptyDoc(): ProseMirrorNode {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create());
}

export function emptyMarkdownDocument(path: string): MarkdownDocument {
  return { frontmatter: null, doc: emptyDoc(), source: "", path };
}
