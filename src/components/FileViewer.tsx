// A file the app can show and cannot edit, standing where the document would be.
//
// It replaces the editor surface the way the plain text surface replaces the WYSIWYG one: the shell
// picks one of the three off the path and mounts it, and no two of them are ever in the tree at
// once. What is different about this one is what it is missing. There is no onChange, no handle
// back to the shell, no debounce and no serializer, because a picture and a PDF are not documents
// and this app's promise is that it never writes a file the user did not edit. Everything below
// only reads.
//
// The bytes live here rather than in the store on purpose. A blob url is a document-lifetime
// resource that has to be handed back, and a pdf.js document owns a worker that has to be told to
// stop; both of them belong to whatever is on screen, and the component is the only thing that
// knows exactly when that stops being true. The store holds which file, and the shell gives this a
// `key` of the path, so opening a second picture unmounts the first and every cleanup below runs.

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { fileBytes } from "../api/files";
import { openExternal } from "../api/roots";
import { mediaTypeForPath, type ViewerKind } from "../model/doc";
import { loadPdfjs, type Pdfjs } from "../pdfjs";
import { notify } from "../store/useToast";
import { Icon } from "./Icon";

const EXTERNAL =
  "M14 3h7v7 M21 3l-9 9 M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5";
const EXPAND = "M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7";
const CONTRACT = "M9 3v6H3 M15 21v-6h6 M3 3l6 6 M21 21l-6-6";

/** How far outside the viewport a PDF page is drawn before it is scrolled to. */
const AHEAD = "1400px 0px";

/** The widest a page is drawn however wide the window is, because a line of type has a limit. */
const PAGE_MAX = 1000;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The file's size, said the way a file manager says it. Binary units, because that is what the
 * ceiling in src-tauri/src/fs.rs is counted in and the two numbers are read next to each other the
 * one time a file is refused.
 */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ViewerProps {
  path: string;
  kind: ViewerKind;
}

export function FileViewer({ path, kind }: ViewerProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);

  // One read per file. The url is made here rather than in the render so that the revoke has
  // something to name: a blob url that is replaced without being handed back is a copy of the file
  // held in the webview until the window closes, and a folder of photographs clicked through is
  // however many of those nobody will ever see again.
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setBytes(null);
    setUrl(null);
    setSize(null);
    setError(null);
    setNatural(null);
    setPages(0);

    fileBytes(path)
      .then((buffer) => {
        if (!live) return;
        setSize(buffer.byteLength);
        if (kind === "image") {
          made = URL.createObjectURL(new Blob([buffer], { type: mediaTypeForPath(path) }));
          setUrl(made);
        } else {
          setBytes(new Uint8Array(buffer));
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });

    return () => {
      live = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [path, kind]);

  const openOutside = () => {
    openExternal(path).catch((e) => notify(`Could not open: ${String(e)}`));
  };

  const meta: string[] = [];
  if (kind === "pdf" && pages > 0) meta.push(`${pages} ${pages === 1 ? "page" : "pages"}`);
  // An SVG with no width in it has no natural size to report, and the browser's 300x150 stand-in is
  // not a fact about the file, so nothing is said rather than something untrue.
  if (natural !== null && natural.width > 0) meta.push(`${natural.width} × ${natural.height}`);
  if (size !== null) meta.push(fileSize(size));

  return (
    <div className="viewer" data-kind={kind}>
      <header className="viewer-bar">
        <span className="viewer-name" title={path}>
          {baseName(path)}
        </span>
        {meta.length > 0 && <span className="viewer-meta">{meta.join(" · ")}</span>}
        {kind === "image" && url !== null && error === null && (
          <button
            className="icon-button"
            data-active={actualSize}
            title={actualSize ? "Fit to window" : "Actual size"}
            aria-label={actualSize ? "Fit to window" : "Actual size"}
            aria-pressed={actualSize}
            onClick={() => setActualSize((on) => !on)}
          >
            <Icon d={actualSize ? CONTRACT : EXPAND} />
          </button>
        )}
        <button
          className="icon-button"
          title="Open in Default App"
          aria-label="Open in Default App"
          onClick={openOutside}
        >
          <Icon d={EXTERNAL} />
        </button>
      </header>

      {error !== null ? (
        <div className="viewer-stage">
          <div className="viewer-note">
            <p className="viewer-error">{error}</p>
            <button className="btn-primary" onClick={openOutside}>
              Open in Default App
            </button>
          </div>
        </div>
      ) : kind === "image" ? (
        <div className="viewer-stage" data-zoom={actualSize ? "actual" : "fit"}>
          {url !== null && (
            <img
              className="viewer-image"
              src={url}
              alt={baseName(path)}
              style={
                actualSize && natural !== null && natural.width > 0
                  ? { width: natural.width, height: natural.height }
                  : undefined
              }
              onLoad={(e) =>
                setNatural({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
              onError={() =>
                setError(
                  `${baseName(path)} is in a format this window cannot draw. The system app can probably open it.`,
                )
              }
            />
          )}
        </div>
      ) : bytes !== null ? (
        <PdfPages bytes={bytes} onPages={setPages} onError={setError} />
      ) : (
        <div className="viewer-stage">
          <p className="viewer-note">Opening…</p>
        </div>
      )}
    </div>
  );
}

/**
 * Every page of a PDF, top to bottom, in one scroller.
 *
 * The reader is src/pdfjs.ts, which is the same one the export preview loads, because two copies of
 * a megabyte and a half in one bundle would be two workers and two chances to get the CSP wrong.
 * The document it opens is destroyed on the way out: a viewer that leaked one per file opened would
 * pass every test ever written for it and show up in somebody's memory a folder of scans later.
 */
function PdfPages({
  bytes,
  onPages,
  onError,
}: {
  bytes: Uint8Array;
  onPages: (n: number) => void;
  onError: (message: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<Pdfjs["getDocument"]> | undefined;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        // A copy, because pdf.js takes ownership of the buffer it is handed and React is holding
        // the original in state for as long as this file is on screen.
        task = pdfjs.getDocument({ data: bytes.slice() });
        const opened = await task.promise;
        if (cancelled) return;
        const first = (await opened.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setDoc(opened);
        setRatio(first.height / first.width);
        onPages(opened.numPages);
      } catch (e) {
        if (!cancelled) onError(`This PDF could not be opened: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [bytes, onPages, onError]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStage(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  const width = Math.round(Math.max(240, Math.min(stage - 56, PAGE_MAX)));

  return (
    <div className="viewer-stage viewer-pages" ref={stageRef}>
      {doc !== null && stage > 0 && (
        <div className="viewer-col">
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage
              key={i + 1}
              doc={doc}
              number={i + 1}
              root={stageRef.current}
              width={width}
              ratio={ratio}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One page, drawn when it comes near the viewport and thrown away when it leaves. A two hundred
 * page scan is two hundred canvases at device resolution otherwise, which is more memory than
 * looking at a file is worth.
 */
function PdfPage({
  doc,
  number,
  root,
  width,
  ratio,
}: {
  doc: PDFDocumentProxy;
  number: number;
  root: HTMLElement | null;
  width: number;
  ratio: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [shape, setShape] = useState(ratio);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root,
      rootMargin: AHEAD,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    if (!near) {
      el.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: RenderTask | undefined;
    void (async () => {
      try {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        setShape(natural.height / natural.width);
        // Capped at 2, because a 3x screen would draw nine times the pixels for a difference
        // nobody can see on a page of body text.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / natural.width) * dpr });
        const canvas = document.createElement("canvas");
        canvas.className = "viewer-canvas";
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
        if (cancelled) return;
        el.replaceChildren(canvas);
      } catch {
        // Cancelled by a resize that arrived mid-render, or a page that would not draw. Whatever is
        // already on screen is the better thing to leave up either way.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, number, width]);

  return (
    <div
      ref={holder}
      className="viewer-page"
      style={{ width, height: Math.round(width * shape) }}
    />
  );
}
