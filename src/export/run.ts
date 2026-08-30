// Running an export: the document on screen becomes Typst source, the source becomes PDF bytes,
// and the bytes go wherever the native save panel points.
//
// Nothing in here writes the user's markdown or touches the open buffer. An export of a document
// with unsaved edits exports what is on screen, and leaves the file alone: this module never calls
// `save`, never dispatches a transaction, and never asks the document store for anything but the
// tree it is already holding. That is not an accident of the current code, it is the requirement.
// A save before an export would mean choosing to export a document turns into writing over a file
// the user had not decided to write yet, and there is no undo for that on disk.
//
// The export is two halves, and the seam between them is the point. `compile` produces the bytes;
// `save` puts them on disk; between the two sits src/components/ExportPreview.tsx, which draws the
// pages the compiler actually produced and does not call `save` until somebody has looked at them
// and asked for a file. The sibling book app puts the same panel behind the same command, and the
// reason is the same in both: a PDF is the one thing either app makes that its author cannot see
// before it exists, and a save panel is a poor place to find out that a diagram did not draw.
//
// The guard that used to live here, a module-level phase refusing a second export while the first
// was running, is gone with it. The panel is the guard now: there is one of it, opening it while
// it is open is nothing happening, and the compile belongs to its lifetime.

import { listen } from "@tauri-apps/api/event";
import { save as savePanel } from "@tauri-apps/plugin-dialog";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { pdfCompile, pdfWrite } from "../api/pdf";
import { PDF_WARNINGS_EVENT, isDesktop, isTauri, type PdfWarning } from "../ipc";
import { useDocument } from "../store/useDocument";
import { useDocumentFonts } from "../store/useDocumentFonts";
import { notify } from "../store/useToast";
import type { DocumentFonts } from "../model/fonts";
import { diagramSources, documentToTypst, renderDiagrams, type Diagrams, type TypstDocument } from "./typst";

/**
 * A compiled document, waiting to be looked at and then written.
 *
 * `path` travels with the bytes rather than being read again at save time, so the file the panel
 * offers to write is named after the document the pages on screen came from, even if the sidebar
 * has moved on underneath.
 */
export interface CompiledPdf {
  path: string;
  bytes: Uint8Array;
  /** What the compile worked around, phrased to be joined into the sentence a toast ends with. */
  trouble: string[];
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * The same name with a .pdf on it, which is what the save panel opens with.
 *
 * Exported because the preview's bar shows it: naming the file that is about to be written is more
 * use there than repeating the document name the title bar is already showing an inch above.
 */
export function suggestedName(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.pdf`;
}

function describe(warnings: readonly PdfWarning[]): string {
  const total = warnings.reduce((sum, warning) => sum + Math.max(1, warning.count), 0);
  const first = warnings[0]?.message ?? "";
  if (total <= 1) return first;
  return `${first} (and ${total - 1} more)`;
}

/**
 * Warnings arrive on an event rather than with the bytes, so the listener has to be up before the
 * compile starts and down again after it. Anything that arrives outside that window belongs to
 * somebody else's export and is none of this call's business.
 */
async function withWarnings<T>(work: () => Promise<T>): Promise<{ result: T; warnings: PdfWarning[] }> {
  const warnings: PdfWarning[] = [];
  // In a browser there is no Tauri event bus to listen on. The dev fixture answers the two commands
  // so the path can be walked, and it has no warnings to send.
  const unlisten = isTauri
    ? await listen<PdfWarning[]>(PDF_WARNINGS_EVENT, (event) => {
        if (Array.isArray(event.payload)) warnings.push(...event.payload);
      })
    : null;
  try {
    return { result: await work(), warnings };
  } finally {
    unlisten?.();
  }
}

/** Whether a document has anything for the maths package to choke on. */
function hasMath(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === "mathInline" || node.type.name === "mathBlock") found = true;
    return !found;
  });
  return found;
}

/**
 * The compile, and the one retry worth making.
 *
 * mitex fails a compile rather than a formula: LaTeX it cannot parse is a hard error out of the
 * plugin, and there is no try in Typst to put around it. So a document whose maths will not typeset
 * would otherwise cost the whole PDF, over one expression, with no way for the author to tell which.
 * The second attempt writes every formula as the monospace source the editor already shows on
 * screen, which is a page the author can read and act on rather than a failure they cannot.
 *
 * Only for a document that actually has a formula in it. Anything else that fails to compile failed
 * for a reason a second identical compile will not fix.
 *
 * This is the second line and not the first. src-tauri/src/pdf.rs already retries a compile that
 * mitex brought down, by serving a stand-in library that sets each formula as the source it was
 * written in, and that catches almost everything: reaching here means even that failed. The two
 * are worth having separately because they fail differently. That one still goes through mitex's
 * own files; this one regenerates the source without asking mitex anything at all.
 */
async function compileWithFallback(
  doc: ProseMirrorNode,
  path: string,
  diagrams: Diagrams,
  fonts: DocumentFonts,
  first: TypstDocument,
): Promise<{ bytes: ArrayBuffer; warnings: PdfWarning[]; retried: boolean }> {
  try {
    const attempt = await withWarnings(() => pdfCompile(first.source, first.images, fonts));
    return { bytes: attempt.result, warnings: attempt.warnings, retried: false };
  } catch (e) {
    if (!hasMath(doc)) throw e;
    const literal = documentToTypst(doc, path, { diagrams, math: "literal", fonts });
    const attempt = await withWarnings(() => pdfCompile(literal.source, literal.images, fonts));
    return { bytes: attempt.result, warnings: attempt.warnings, retried: true };
  }
}

/**
 * Whether there is anything to export, and the sentence saying why not when there is not.
 *
 * Asked by the `export-pdf` entry in src/keys/commands.ts before it opens the panel, because a
 * panel that opens onto "no document" is a worse answer than never opening. The save panel is a
 * window API, so it is not merely absent in a browser, it is refused, and there is no point
 * compiling a PDF this build has nowhere to put.
 */
export function canExport(): boolean {
  const { path, content } = useDocument.getState();
  if (path === null || content === null) {
    notify("Open a document to export it.");
    return false;
  }
  if (!isDesktop) {
    notify("PDF export needs the desktop app.");
    return false;
  }
  return true;
}

/**
 * The document on screen, typeset.
 *
 * Throws rather than notifying, because its caller is a panel with somewhere to put the message:
 * a compile that failed is the whole of what that panel has to show, and a toast behind an empty
 * preview would be the wrong place to read it.
 */
export async function compile(): Promise<CompiledPdf> {
  const { path, content } = useDocument.getState();
  if (path === null || content === null) throw new Error("no document is open");

  // Drawn before the conversion rather than during it, because mermaid is asynchronous and wants
  // a DOM, and the converter is neither. A diagram that will not draw is simply missing from the
  // map and comes out of the converter as the fence it always was.
  const drawings = await renderDiagrams(content);
  const undrawn = diagramSources(content).length - drawings.size;

  // The faces the page is in on screen, so an export is the document as its author sees it.
  const fonts = useDocumentFonts.getState().fonts;
  const converted = documentToTypst(content, path, { diagrams: drawings, fonts });

  const { bytes, warnings, retried } = await compileWithFallback(
    content,
    path,
    drawings,
    fonts,
    converted,
  );

  return {
    path,
    bytes: new Uint8Array(bytes),
    trouble: [
      ...converted.warnings,
      ...(undrawn > 0 ? [`${undrawn} diagram${undrawn === 1 ? "" : "s"} could not be drawn`] : []),
      ...(retried ? ["every formula shown as the source it was written in"] : []),
      ...(warnings.length > 0 ? [describe(warnings)] : []),
    ],
  };
}

/**
 * The native save panel, and the write behind it.
 *
 * Answers whether a file was written, which is not the same question as whether anything went
 * wrong: cancelling the panel is an ordinary way to end an export and gets no toast, because
 * nothing happened and the user is the one who decided that.
 */
export async function save(pdf: CompiledPdf): Promise<boolean> {
  const target = await savePanel({
    title: "Export as PDF",
    defaultPath: suggestedName(pdf.path),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (target === null) return false;

  await pdfWrite(target, pdf.bytes);

  notify(
    pdf.trouble.length === 0
      ? `Exported ${baseName(target)}`
      : `Exported ${baseName(target)}, with ${pdf.trouble.join("; ")}`,
  );
  return true;
}
