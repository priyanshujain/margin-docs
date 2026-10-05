import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "./schema";

export type DocumentKind = "markdown" | "text";

/**
 * A file the app can put on screen without being able to edit it: a picture, or a PDF.
 *
 * These are not documents and deliberately do not become one. Nothing parses them, nothing holds a
 * buffer of them and there is no path from one to `file_write`, which is why they are a kind of
 * their own rather than a third `DocumentKind` the store would then have to be trusted not to save.
 */
export type ViewerKind = "image" | "pdf";

/** Everything this app opens in its own window, editable or not. */
export type OpenKind = DocumentKind | ViewerKind;

export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn"] as const;
export const TEXT_EXTENSIONS = ["txt", "text"] as const;

/**
 * The pictures the viewer will show, and the media type each one is handed to the browser as.
 *
 * The type is not decoration. Bytes arrive from Rust with no name attached and go on screen as a
 * blob url, which carries no extension for the engine to sniff a format out of, so what is written
 * here is the whole of what the `<img>` is told. An SVG is in this table like any other picture and
 * is drawn as one: an `<img>` never runs the script an SVG is free to contain, and inlining one
 * into the document instead would run whatever a file somebody was sent happens to hold.
 */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  heic: "image/heic",
};

const PDF_MEDIA_TYPE = "application/pdf";

/** Lower case, and empty for a dotfile or a name with no extension at all. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/**
 * A file the editor can open and write back. Everything else is either shown read only by
 * `viewerKindForPath` or handed to the system.
 */
export function documentKindForPath(path: string): DocumentKind | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  if ((MARKDOWN_EXTENSIONS as readonly string[]).includes(ext)) return "markdown";
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return "text";
  return null;
}

/** A file the app can show and cannot edit. Null for a document and for everything foreign. */
export function viewerKindForPath(path: string): ViewerKind | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  if (ext === "pdf") return "pdf";
  return ext in IMAGE_MEDIA_TYPES ? "image" : null;
}

/**
 * What the app does with a path when the user asks for it: edit it, show it, or hand it over.
 *
 * Null is what makes a row grey in the tree and what sends a link to macOS, so this is the one
 * question those two ask. The distinction between the two kinds that are not null belongs to
 * whatever is about to put something on screen.
 */
export function openKindForPath(path: string): OpenKind | null {
  return documentKindForPath(path) ?? viewerKindForPath(path);
}

/** What the bytes of a viewable file are handed to the browser as. */
export function mediaTypeForPath(path: string): string {
  const ext = extensionOf(path);
  return ext === "pdf" ? PDF_MEDIA_TYPE : (IMAGE_MEDIA_TYPES[ext] ?? "application/octet-stream");
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
