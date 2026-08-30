// The PDF preview: what Cmd-E opens now, and where Save PDF lives.
//
// The sibling book app answers Export with this same panel, and both apps answer it this way for
// the same reason. A PDF is the one thing either of them produces that its author cannot see
// before it exists: the editor draws a document on a scrolling sheet with no page breaks in it, and
// where the pages fall, whether a diagram drew, whether a formula typeset and whether a table fits
// the measure are all only knowable after the compiler has run. Sending that straight to a save
// panel means the first look at the result happens in Preview.app, after a file has been written.
// So the compile happens first, the pages go on screen, and the save panel is a button somebody
// presses once they have seen what they are about to write.
//
// It is drawn over the editor pane rather than over the window, which is the sibling's shape too:
// the sidebar stays where it is, and the pages appear where the page was. That is also why the
// panel measures `.editor-pane` and pins itself to it instead of being a child of it. The pane
// scrolls, and a child of a scrolling container that has to stay still is a fight with the
// scrollbar rather than a layout.
//
// The document cannot change under a preview: nothing in this panel edits, and the pane behind it
// is covered. The sidebar is not, so switching documents closes the panel rather than leaving the
// pages of one document over the name of another.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { icons } from "margin-shared";
import { useEscapeLayer } from "../escape";
import { compile, save, suggestedName, type CompiledPdf } from "../export/run";
import { onCommand } from "../keys/commands";
import { useKeyContext } from "../keys/keymap";
import { useDocument } from "../store/useDocument";
import { notify } from "../store/useToast";
import { Icon } from "./Icon";

/**
 * pdf.js, fetched the first time somebody previews something and kept for every preview after.
 *
 * Imported here rather than at the top of the file because it is a megabyte and a half of reader
 * and a separate worker, and an editor that has not been asked for a PDF has no use for either. It
 * is the same call mermaid gets in src/export/typst.ts, for the same reason. The types above are
 * `import type` and cost nothing: they are erased before anything runs.
 *
 * The worker is a bundled asset URL rather than a path, so the bundler emits it and the app's CSP
 * sees it as its own origin. `worker-src 'self' blob:` in tauri.conf.json is what lets pdf.js
 * start it at all.
 */
type Pdfjs = typeof import("pdfjs-dist");

let reader: Promise<Pdfjs> | null = null;

function loadPdfjs(): Promise<Pdfjs> {
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

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

/** Zoom glyphs, which are a minus and a plus and are not worth a name in margin-shared. */
const MINUS = "M5 12h14";
const PLUS = "M12 5v14M5 12h14";

/** How far outside the viewport a page is drawn before it is scrolled to. */
const AHEAD = "1400px 0px";

interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

function measurePane(): Frame | null {
  const pane = document.querySelector(".editor-pane");
  if (!pane) return null;
  const r = pane.getBoundingClientRect();
  return {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/**
 * The mount, which is one `onCommand` and nothing else.
 *
 * src/keys/commands.ts dispatches `export-pdf` once it has checked there is a document and a window
 * to put a file in, exactly as it does for quick open and the command palette. Nothing about the
 * panel's existence is a precondition for that table to compile.
 */
export function ExportPreview() {
  const [open, setOpen] = useState(false);
  const path = useDocument((s) => s.path);

  useEffect(() => onCommand("export-pdf", () => setOpen(true)), []);
  useEffect(() => setOpen(false), [path]);

  if (!open || path === null) return null;
  return <Preview path={path} onClose={() => setOpen(false)} />;
}

function Preview({ path, onClose }: { path: string; onClose: () => void }) {
  const [pdf, setPdf] = useState<CompiledPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(measurePane);
  const panelRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const started = useRef(false);
  const live = useRef(true);

  useEscapeLayer(true, onClose);
  useKeyContext("overlay");

  // Where the editor pane is, now and whenever it moves. Dragging the sidebar's resize handle
  // moves it without the window changing size, hence the observer as well as the resize listener.
  useLayoutEffect(() => {
    const update = () => setFrame(measurePane());
    update();
    const pane = document.querySelector(".editor-pane");
    const observer = new ResizeObserver(update);
    if (pane) observer.observe(pane);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Once, on the way in. The document behind the panel cannot change while it is up, so there is
  // nothing to recompile for, and a compile per keystroke is not what a preview of a fifty page
  // document should cost.
  //
  // Two refs rather than the usual `let cancelled` because of what React's development StrictMode
  // does to an effect: it runs it, tears it down and runs it again on the same instance, to shake
  // out cleanups that do not clean up. That is the right test for a subscription and the wrong one
  // for a typesetter. `started` is what makes the compile happen once per open, and `live` is what
  // an in-flight result is checked against, because the plain closure flag would have been set by
  // the teardown between the two runs and the only answer this panel ever gets would be dropped.
  // Both reset with the component, which is unmounted when the panel closes.
  useEffect(() => {
    live.current = true;
    if (!started.current) {
      started.current = true;
      compile()
        .then((result) => live.current && setPdf(result))
        .catch((e) => live.current && setError(String(e)));
    }
    return () => {
      live.current = false;
    };
  }, []);

  // Pinch on a trackpad and Ctrl-scroll on a mouse, which are the two gestures a page of a document
  // is expected to answer. Both have to be taken off the window rather than left to the browser:
  // the webview's own zoom would scale the chrome around the pages as well.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const snap = (z: number) => clamp(Math.round(z / ZOOM_STEP) * ZOOM_STEP);
    let start = 1;
    let accumulated = 0;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      accumulated += e.deltaY;
      if (accumulated <= -40) {
        accumulated = 0;
        setZoom((z) => clamp(z + ZOOM_STEP));
      } else if (accumulated >= 40) {
        accumulated = 0;
        setZoom((z) => clamp(z - ZOOM_STEP));
      }
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      start = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const next = snap(start * (e as unknown as { scale: number }).scale);
      setZoom((z) => (z === next ? z : next));
    };
    const onGestureEnd = (e: Event) => e.preventDefault();

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);

  // The file that is about to be written, rather than the document it came from. The title bar an
  // inch above already says which document this is.
  const name = suggestedName(path);

  // Closes on a written file and stays put on a cancelled panel, because cancelling means the user
  // is not finished with the preview yet.
  const write = async () => {
    if (!pdf) return;
    setSaving(true);
    try {
      if (await save(pdf)) onClose();
    } catch (e) {
      notify(`Could not export: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const adjustZoom = (delta: number) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + delta) * 100) / 100)));

  // Under this the bar has to drop the words and keep the buttons, which happens when the sidebar
  // is wide and the window is not.
  const compact = (frame?.width ?? 1000) < 460;

  return (
    <div className="overlay preview-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className="panel preview-panel"
        role="dialog"
        aria-modal="true"
        aria-label="PDF preview"
        style={
          frame
            ? { position: "fixed", left: frame.left, top: frame.top, width: frame.width, height: frame.height }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
      >
        <header className="preview-bar">
          <button className="icon-button" onClick={onClose} title="Close (⎋)" aria-label="Close">
            <Icon d={icons.CLOSE} />
          </button>
          <div className="preview-title">{name}</div>
          {pages > 0 && !compact && (
            <span className="preview-count">
              {pages} {pages === 1 ? "page" : "pages"}
            </span>
          )}
          <div className="preview-zoom">
            <button
              className="icon-button"
              disabled={!pdf || zoom <= ZOOM_MIN}
              onClick={() => adjustZoom(-ZOOM_STEP)}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <Icon d={MINUS} />
            </button>
            {!compact && <span>{zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}</span>}
            <button
              className="icon-button"
              disabled={!pdf || zoom >= ZOOM_MAX}
              onClick={() => adjustZoom(ZOOM_STEP)}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Icon d={PLUS} />
            </button>
          </div>
          <button className="btn-primary" disabled={!pdf || saving} onClick={() => void write()}>
            {saving ? "Saving…" : compact ? "Save" : "Save PDF…"}
          </button>
        </header>

        {/* What the compiler worked around, said before the file is written rather than after.
            These are the same sentences the toast used to carry alone, and they are worth more
            here: a diagram that did not draw is a thing to look at on the page below. */}
        {pdf && pdf.trouble.length > 0 && (
          <div className="preview-warn">Exported with {pdf.trouble.join("; ")}.</div>
        )}

        {error !== null ? (
          <div className="preview-stage">
            <pre className="preview-error">{error}</pre>
          </div>
        ) : pdf ? (
          <Pages bytes={pdf.bytes} zoom={zoom} onPages={setPages} />
        ) : (
          <div className="preview-stage">
            <div className="preview-loading">
              <div className="preview-spinner" />
              <p>Typesetting…</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The scroller, and the arithmetic that decides how wide a page is drawn.
 *
 * At zoom 1 a page is whichever of the stage's two dimensions runs out first, so one whole page is
 * visible and "Fit" means what it says. Every other zoom is a multiple of that, which is why the
 * column is `width: max-content` and the stage scrolls in both directions.
 */
function Pages({
  bytes,
  zoom,
  onPages,
}: {
  bytes: Uint8Array;
  zoom: number;
  onPages: (n: number) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<Pdfjs["getDocument"]> | undefined;
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        // A copy, because pdf.js takes ownership of the buffer it is handed and the same bytes
        // still have to go through the IPC boundary when Save is pressed.
        task = pdfjs.getDocument({ data: bytes.slice() });
        const opened = await task.promise;
        if (cancelled) return;
        const first = (await opened.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        setDoc(opened);
        setRatio(first.height / first.width);
        onPages(opened.numPages);
      } catch {
        // A PDF this build cannot parse still saves: the bytes came from the compiler and the
        // reader is the only thing that failed. The stage stays empty and Save stays live.
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [bytes, onPages]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  const fit = Math.max(240, Math.min(stage.width - 56, (stage.height - 56) / (ratio ?? 1)));
  const width = Math.round(fit * zoom);

  return (
    <div className="preview-stage" ref={stageRef}>
      {doc && ratio !== null && stage.width > 0 && (
        <div className="preview-col">
          {Array.from({ length: doc.numPages }, (_, i) => (
            <Page
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
 * One page, drawn when it comes near the viewport and thrown away when it leaves.
 *
 * A hundred page document is a hundred canvases at device resolution, which is more memory than a
 * preview is worth, so the holder keeps the page's shape and the canvas inside it comes and goes.
 * The shape is the first page's until this one has been opened, which is right for every document
 * whose pages are the same size and self-corrects for the ones that are not.
 */
function Page({
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
        canvas.className = "preview-canvas";
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
        if (cancelled) return;
        el.replaceChildren(canvas);
      } catch {
        // Cancelled by a zoom that arrived mid-render, or a page that would not draw. The canvas
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
      className="preview-page"
      style={{ width, height: Math.round(width * shape) }}
    />
  );
}
