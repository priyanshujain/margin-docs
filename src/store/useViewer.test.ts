// Looking at a file the app cannot edit, with the disk faked out.
//
// The claim being made here is the one the whole feature turns on: showing somebody a picture must
// not put anything on their disk. It is asserted against the same list of mutations
// src/store/useDocument.test.ts uses, because the interesting failure is not "the viewer called
// fileWrite", which nothing in it could, but "opening a picture left the document store holding
// something the debounce then flushed".
//
// The second half is about which of the two stores owns the pane. Both directions are one line in
// the source and neither is reachable from anywhere else, so both are asserted here rather than
// left to a reader to notice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { schema } from "../model/schema";
import { openKindForPath, viewerKindForPath } from "../model/doc";

const files = vi.hoisted(() => ({
  fileRead: vi.fn(),
  fileBytes: vi.fn(),
  fileWrite: vi.fn(),
  fileCreate: vi.fn(),
  fileFolderCreate: vi.fn(),
  fileRename: vi.fn(),
  fileMove: vi.fn(),
  fileDuplicate: vi.fn(),
  fileTrash: vi.fn(),
  assetWrite: vi.fn(),
}));

const bridge = vi.hoisted(() => ({
  parseMarkdown: vi.fn(),
  serializeMarkdown: vi.fn(),
  parsePlainText: vi.fn(),
  serializePlainText: vi.fn(),
}));

vi.mock("../api/files", () => files);
vi.mock("../markdown", () => bridge);

const { initDocument } = await import("../document");
const { useDocument } = await import("./useDocument");
const { useViewer } = await import("./useViewer");

const ROOT = "/root";
const NOTES = `${ROOT}/notes.md`;
const PICTURE = `${ROOT}/assets/shot.png`;
const SCAN = `${ROOT}/assets/scan.pdf`;

/** Everything in the files api that changes something. None of these may fire on a view. */
const MUTATIONS = [
  files.fileWrite,
  files.fileCreate,
  files.fileFolderCreate,
  files.fileRename,
  files.fileMove,
  files.fileDuplicate,
  files.fileTrash,
  files.assetWrite,
] as const;

const docOf = (text: string): ProseMirrorNode =>
  schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(null, text ? schema.text(text) : null),
  );

const disk = new Map<string, { text: string; modifiedMs: number }>();

let stopDocument: () => void;

beforeEach(() => {
  disk.clear();
  disk.set(NOTES, { text: "hello", modifiedMs: 1000 });
  for (const mock of Object.values(files)) mock.mockReset();
  for (const mock of Object.values(bridge)) mock.mockReset();

  files.fileRead.mockImplementation(async (path: string) => {
    const entry = disk.get(path);
    if (!entry) throw new Error(`no such file: ${path}`);
    return { path, text: entry.text, modifiedMs: entry.modifiedMs };
  });
  files.fileWrite.mockImplementation(async (path: string, text: string) => {
    const entry = disk.get(path);
    const modifiedMs = (entry?.modifiedMs ?? 0) + 1000;
    disk.set(path, { text, modifiedMs });
    return { path, modifiedMs, conflict: false };
  });

  const parse = (source: string, path: string) => ({
    frontmatter: null,
    doc: docOf(source),
    source,
    path,
  });
  bridge.parseMarkdown.mockImplementation(parse);
  bridge.parsePlainText.mockImplementation(parse);
  bridge.serializeMarkdown.mockImplementation(
    (document: { frontmatter: string | null }, doc: ProseMirrorNode) =>
      (document.frontmatter ?? "") + doc.textContent,
  );

  useDocument.setState({
    path: null,
    document: null,
    content: null,
    modifiedMs: null,
    dirty: false,
    savePhase: "idle",
    saveError: null,
    frontmatter: null,
    externalChange: "synced",
    history: [],
    historyIndex: -1,
  });
  useViewer.setState({ path: null, kind: null });
  stopDocument = initDocument();
});

afterEach(() => {
  stopDocument();
});

describe("what the app does with a path", () => {
  it("names the pictures it can show and the one document format that is not one", () => {
    expect(viewerKindForPath("/a/photo.PNG")).toBe("image");
    expect(viewerKindForPath("/a/photo.jpeg")).toBe("image");
    expect(viewerKindForPath("/a/anim.gif")).toBe("image");
    expect(viewerKindForPath("/a/shot.webp")).toBe("image");
    expect(viewerKindForPath("/a/shot.avif")).toBe("image");
    expect(viewerKindForPath("/a/logo.svg")).toBe("image");
    expect(viewerKindForPath("/a/old.bmp")).toBe("image");
    expect(viewerKindForPath("/a/phone.heic")).toBe("image");
    expect(viewerKindForPath("/a/report.pdf")).toBe("pdf");
  });

  it("keeps a document a document and everything else foreign", () => {
    expect(viewerKindForPath("/a/notes.md")).toBeNull();
    expect(viewerKindForPath("/a/notes.txt")).toBeNull();
    expect(viewerKindForPath("/a/archive.zip")).toBeNull();
    // A dotfile has no extension, whatever the dot suggests, and neither has a bare name.
    expect(viewerKindForPath("/a/.png")).toBeNull();
    expect(viewerKindForPath("/a/png")).toBeNull();

    expect(openKindForPath("/a/notes.md")).toBe("markdown");
    expect(openKindForPath("/a/notes.txt")).toBe("text");
    expect(openKindForPath("/a/shot.png")).toBe("image");
    expect(openKindForPath("/a/report.pdf")).toBe("pdf");
    // Null is what greys a row in the tree and what sends a link to macOS.
    expect(openKindForPath("/a/archive.zip")).toBeNull();
  });
});

describe("viewing a file", () => {
  it("writes nothing at all", async () => {
    useViewer.getState().open(PICTURE);
    await Promise.resolve();

    expect(useViewer.getState()).toMatchObject({ path: PICTURE, kind: "image" });
    for (const mutation of MUTATIONS) expect(mutation).not.toHaveBeenCalled();
    // The bytes are the component's business, not the store's, so nothing has even been read yet.
    expect(files.fileBytes).not.toHaveBeenCalled();
  });

  it("leaves the document store empty, so there is no buffer for the debounce to find", () => {
    useViewer.getState().open(SCAN);

    const state = useDocument.getState();
    expect(state.path).toBeNull();
    expect(state.document).toBeNull();
    expect(state.content).toBeNull();
    expect(state.dirty).toBe(false);
  });

  it("refuses a path it has no viewer for rather than opening an empty pane", () => {
    useViewer.getState().open(NOTES);
    expect(useViewer.getState().path).toBeNull();

    useViewer.getState().open(`${ROOT}/archive.zip`);
    expect(useViewer.getState().path).toBeNull();
  });
});

describe("one thing on screen", () => {
  it("closes the open document, and lands its unsaved edit first", async () => {
    await useDocument.getState().open(NOTES);
    useDocument.getState().setContent(docOf("hello there"));
    expect(useDocument.getState().dirty).toBe(true);

    useViewer.getState().open(PICTURE);

    await vi.waitFor(() => expect(files.fileWrite).toHaveBeenCalledTimes(1));
    expect(disk.get(NOTES)?.text).toBe("hello there");
    expect(useDocument.getState().path).toBeNull();
  });

  it("closes the viewer when a document opens, whichever way it was opened", async () => {
    useViewer.getState().open(PICTURE);
    await useDocument.getState().open(NOTES);
    expect(useViewer.getState().path).toBeNull();

    // Back and forward do not go through the store's `open`, which is why the close sits in
    // `loadDocument` rather than beside it.
    useViewer.getState().open(SCAN);
    disk.set(`${ROOT}/other.md`, { text: "other", modifiedMs: 1000 });
    await useDocument.getState().open(`${ROOT}/other.md`);
    useViewer.getState().open(SCAN);
    await useDocument.getState().back();
    expect(useDocument.getState().path).toBe(NOTES);
    expect(useViewer.getState().path).toBeNull();
  });
});
