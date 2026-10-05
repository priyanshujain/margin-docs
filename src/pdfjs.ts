// pdf.js, fetched the first time something needs to draw a PDF and kept for everything after.
//
// Two surfaces draw one now, the export preview and the file viewer, and they load the library the
// same way because there is only one way to load it that works here. It is imported dynamically
// rather than at the top of a module: it is a megabyte and a half of reader plus a separate worker,
// and an editor nobody has asked for a PDF has no use for either. The worker is a bundled asset URL
// rather than a path, so the bundler emits it and the app's CSP sees it as its own origin;
// `worker-src 'self' blob:` in tauri.conf.json is what lets pdf.js start it at all.
//
// The promise is cached rather than the module, so two panels opening at once share one fetch
// rather than racing to set `workerSrc` twice.

export type Pdfjs = typeof import("pdfjs-dist");

let reader: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  reader ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return reader;
}
