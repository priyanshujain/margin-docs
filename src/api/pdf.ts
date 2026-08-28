// PDF export. The source is built here and compiled there; these two calls are the boundary.

import { call, type ImageInput } from "../ipc";

/**
 * Compiles Typst source to PDF bytes. Warnings do not come back through the return value, because
 * the answer is raw bytes and has no room for a second one: they arrive on `pdf-warnings` instead.
 */
export const pdfCompile = (source: string, images: readonly ImageInput[]) =>
  call<ArrayBuffer>("pdf_compile", { source, images });

/**
 * Writes the finished file wherever the native save panel pointed.
 *
 * `Array.from` because the IPC boundary is JSON and a `Uint8Array` stringifies to an object with
 * numeric keys, which is not a `Vec<u8>` on the other side. One export's worth of numbers is the
 * cost of not inventing a second transport for a thing that happens once per document.
 */
export const pdfWrite = (path: string, bytes: Uint8Array) =>
  call<void>("pdf_write", { path, bytes: Array.from(bytes) });
