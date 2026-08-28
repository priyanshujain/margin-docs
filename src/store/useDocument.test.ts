// The document lifecycle with the disk faked out. The first test in here is the product's first
// promise: a file that is opened, looked at and closed again is not written. Everything after it
// exists because the save path has to be wrong in only one way to lose somebody's work.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createEditorExtensions } from "../editor/extensions";
import { corpusFile } from "../markdown/corpus/load";
import { schema } from "../model/schema";

const files = vi.hoisted(() => ({
  fileRead: vi.fn(),
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

const { documentChangedOnDisk, initDocument, keepBuffer, SAVE_DEBOUNCE_MS } = await import("../document");
const { useDocument } = await import("./useDocument");

/**
 * The bridge for real, for the tests whose subject is a file's bytes rather than the plumbing.
 *
 * Those tests have to run against the house style the app actually writes: the whole point of the
 * last describe in this file is that a hand written document does not serialize to the bytes it
 * was read from, and a mock that writes back whatever it was handed cannot show that.
 */
const real = await vi.importActual<typeof import("../markdown")>("../markdown");

/** Everything in the files api that changes something. None of these may fire on an open. */
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

/**
 * The schema the editor actually runs on.
 *
 * src/editor/extensions.ts builds it from the same specs as src/model/schema.ts, node for node and
 * mark for mark, and src/editor/extensions.test.ts is what keeps that true. It is still a second
 * `Schema` instance, so every NodeType and MarkType in it is a different object from the
 * contract's twin, and that is not a detail of this file: it is what the running app is. The
 * bridge parses on to the contract's schema, `buildState` in src/editor/Editor.tsx rebinds the
 * result on to this one before the editor can hold it, and everything the store is handed back
 * comes from here.
 */
const editorSchema = getSchema(
  createEditorExtensions({ documentPath: () => "/root/notes.md", onError: () => {} }),
);

/**
 * A tree the bridge built, as the editor hands it back: the same rebind through JSON that
 * `buildState` does when it installs a document.
 *
 * Every `setContent` below goes through this, because in the running app every `setContent` comes
 * off an editor transaction and there is no other kind. A test that skips it is testing a pairing
 * of documents the app never produces, which is how a guard comparing NodeType objects passed a
 * suite for two rounds while never once returning true on a real edit.
 */
const asEditorSees = (doc: ProseMirrorNode): ProseMirrorNode =>
  editorSchema.nodeFromJSON(doc.toJSON());

/** A one paragraph document, on the contract's schema, which is the side a parse comes back on. */
const docOf = (text: string): ProseMirrorNode =>
  schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(null, text ? schema.text(text) : null),
  );

/** The same document, on the side the editor holds it. */
const editorDocOf = (text: string): ProseMirrorNode => asEditorSees(docOf(text));

const disk = new Map<string, { text: string; modifiedMs: number }>();

/**
 * Holds the next `fileWrite` call open until `release` is called, then lets it run through the
 * normal disk-writing mock. Lets a test pin exactly one write on the wire and observe what does or
 * does not happen while it is stuck there.
 */
function gateNextWrite(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const defaultImpl = files.fileWrite.getMockImplementation();
  files.fileWrite.mockImplementationOnce(async (path: string, text: string, expected?: number) => {
    await gate;
    return defaultImpl!(path, text, expected);
  });
  return { release };
}

function put(path: string, text: string, modifiedMs: number): void {
  disk.set(path, { text, modifiedMs });
}

/**
 * The same document with `attrs` written over the first cell of every table row, which is the shape
 * both a column drag and an align op leave behind: one attribute, on a whole column, and nothing
 * else in the tree touched.
 *
 * Rebuilt from the top rather than patched in place, so that every node on the way down is a new
 * object. A real transaction leaves the subtrees it did not visit alone and this does not, which
 * makes it the harder input of the two: a comparison that leant on identity would be caught here.
 */
function withFirstColumn(node: ProseMirrorNode, attrs: Record<string, unknown>): ProseMirrorNode {
  if (node.type.name === "tableRow") {
    const cells: ProseMirrorNode[] = [];
    node.forEach((cell, _offset, index) => {
      const next = index === 0 ? { ...cell.attrs, ...attrs } : cell.attrs;
      cells.push(cell.type.create(next, cell.content, cell.marks));
    });
    return node.copy(Fragment.fromArray(cells));
  }
  if (node.childCount === 0) return node;
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => children.push(withFirstColumn(child, attrs)));
  return node.copy(Fragment.fromArray(children));
}

let stopDocument: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  disk.clear();
  for (const mock of Object.values(files)) mock.mockReset();
  for (const mock of Object.values(bridge)) mock.mockReset();

  files.fileRead.mockImplementation(async (path: string) => {
    const entry = disk.get(path);
    if (!entry) throw new Error(`no such file: ${path}`);
    return { path, text: entry.text, modifiedMs: entry.modifiedMs };
  });
  files.fileWrite.mockImplementation(async (path: string, text: string, expected?: number) => {
    const entry = disk.get(path);
    if (entry && expected !== undefined && expected !== entry.modifiedMs) {
      return { path, modifiedMs: entry.modifiedMs, conflict: true };
    }
    const modifiedMs = (entry?.modifiedMs ?? 0) + 1000;
    put(path, text, modifiedMs);
    return { path, modifiedMs, conflict: false };
  });

  const parse = (source: string, path: string) => ({
    frontmatter: null,
    doc: docOf(source),
    source,
    path,
  });
  const serialize = (document: { frontmatter: string | null }, doc: ProseMirrorNode) =>
    (document.frontmatter ?? "") + doc.textContent;
  bridge.parseMarkdown.mockImplementation(parse);
  bridge.parsePlainText.mockImplementation(parse);
  bridge.serializeMarkdown.mockImplementation(serialize);
  bridge.serializePlainText.mockImplementation(serialize);

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
  stopDocument = initDocument();
});

afterEach(() => {
  stopDocument();
  vi.useRealTimers();
});

// The harness itself, asserted rather than assumed.
//
// Everything below compares a document that came off the bridge against one that came off the
// editor, and those are built on two different `Schema` instances. Every guard in src/document.ts
// stands or falls on that: a comparison written against NodeType or MarkType objects answers "not
// equal" to every pair the running app can produce, and a suite that built both sides from one
// schema was green through two rounds while the buffer was dirty from the first keystroke and the
// colwidth exemption had never once run.
//
// So these are about the setup as much as about the answer. If somebody later simplifies the
// helpers above into one schema, the premise here goes red before the guards go quiet.
describe("the two schemas this app really has", () => {
  it("builds the disk side and the editor side on different schema objects", () => {
    expect(editorSchema).not.toBe(schema);
    expect(editorSchema.nodes.paragraph).not.toBe(schema.nodes.paragraph);
    expect(editorSchema.marks.strong).not.toBe(schema.marks.strong);
    expect(editorSchema.nodes.paragraph.name).toBe(schema.nodes.paragraph.name);
  });

  it("hands the store a tree the editor's schema owns, which is where a transaction comes from", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    useDocument.getState().setContent(editorDocOf("hello"));

    const state = useDocument.getState();
    expect(state.document!.doc.type.schema).toBe(schema);
    expect(state.content!.type.schema).toBe(editorSchema);
  });

  // The point of the two above: the same document on either side is the same document, so the
  // buffer is not dirty. Asserted on the flag the instant the transaction lands rather than on the
  // disk after the debounce, because the byte comparison inside `performSave` also stops a write
  // here and would have this passing while the flag was wrong: that is how S1 hid.
  it("calls the same document on either side of that boundary unchanged", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    useDocument.getState().setContent(editorDocOf("hello"));
    expect(useDocument.getState().dirty).toBe(false);

    useDocument.getState().setContent(editorDocOf("hello there"));
    expect(useDocument.getState().dirty).toBe(true);
  });

  // Marks are the second half of the same mistake and they need saying separately, because
  // `Mark.sameSet` compares MarkType by object too: with only the node types fixed, every piece of
  // bold or linked text in the file would still have come back different from itself.
  it("calls a marked span unchanged across the boundary, and a changed destination changed", async () => {
    const linked = (href: string) =>
      schema.nodes.doc.create(
        null,
        schema.nodes.paragraph.create(null, [
          schema.text("see "),
          schema.text("here", [
            schema.marks.strong.create(),
            schema.marks.link.create({ href, title: null }),
          ]),
        ]),
      );

    put("/root/notes.md", "see here", 1000);
    bridge.parseMarkdown.mockImplementation((source: string, path: string) => ({
      frontmatter: null,
      doc: linked("./a.md"),
      source,
      path,
    }));
    await useDocument.getState().open("/root/notes.md");

    useDocument.getState().setContent(asEditorSees(linked("./a.md")));
    expect(useDocument.getState().dirty).toBe(false);

    useDocument.getState().setContent(asEditorSees(linked("./b.md")));
    expect(useDocument.getState().dirty).toBe(true);
  });
});

describe("opening a document", () => {
  it("writes nothing, to this file or to any other", async () => {
    put("/root/notes.md", "# Notes\n", 1000);

    await useDocument.getState().open("/root/notes.md");
    await vi.advanceTimersByTimeAsync(10_000);
    useDocument.getState().close();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileRead).toHaveBeenCalledTimes(1);
    for (const mutation of MUTATIONS) expect(mutation).not.toHaveBeenCalled();
    expect(disk.get("/root/notes.md")).toEqual({ text: "# Notes\n", modifiedMs: 1000 });
  });

  it("keeps the timestamp the read came with, which is what a write is checked against", async () => {
    put("/root/notes.md", "hello", 4242);
    await useDocument.getState().open("/root/notes.md");

    const state = useDocument.getState();
    expect(state.path).toBe("/root/notes.md");
    expect(state.modifiedMs).toBe(4242);
    expect(state.dirty).toBe(false);
    expect(state.content).toBe(state.document?.doc);
  });

  it("sends a .txt through the plain text bridge and never through the markdown one", async () => {
    put("/root/plain.txt", "# not a heading\n", 1000);
    await useDocument.getState().open("/root/plain.txt");

    expect(bridge.parsePlainText).toHaveBeenCalledTimes(1);
    expect(bridge.parseMarkdown).not.toHaveBeenCalled();
  });

  it("refuses a file it cannot open before it reads anything", async () => {
    await expect(useDocument.getState().open("/root/photo.png")).rejects.toThrow();
    expect(files.fileRead).not.toHaveBeenCalled();
  });

  it("leaves an already open document alone rather than reloading over the edit", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    useDocument.getState().setContent(editorDocOf("hello there"));

    await useDocument.getState().open("/root/notes.md");

    expect(files.fileRead).toHaveBeenCalledTimes(1);
    expect(useDocument.getState().dirty).toBe(true);
    expect(useDocument.getState().content?.textContent).toBe("hello there");
  });
});

describe("saving", () => {
  it("waits for the typing to stop and then writes once", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    useDocument.getState().setContent(editorDocOf("hello t"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    expect(files.fileWrite).not.toHaveBeenCalled();

    useDocument.getState().setContent(editorDocOf("hello there"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    expect(files.fileWrite).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    expect(files.fileWrite).toHaveBeenCalledWith("/root/notes.md", "hello there", 1000);
    expect(useDocument.getState().dirty).toBe(false);
    expect(useDocument.getState().modifiedMs).toBe(2000);
  });

  it("does nothing at all for a document nobody edited", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    await useDocument.getState().save();

    expect(files.fileWrite).not.toHaveBeenCalled();
    expect(bridge.serializeMarkdown).not.toHaveBeenCalled();
  });

  // The last thing between a dirty buffer and the disk: a save that serializes to the bytes that
  // are already there is not written. The edit below is a real one, splitting the paragraph in two,
  // and the bytes it produces through the serializer in this file are the ones it started with,
  // which is also what an edit and its undo inside one debounce look like from here.
  //
  // A resized column is not this test. That never gets as far as being dirty; see the last describe
  // in this file, which asserts it on a real file's bytes.
  it("does not write when a real change comes out as the bytes already on disk", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    useDocument.getState().setContent(
      asEditorSees(
        schema.nodes.doc.create(null, [
          schema.nodes.paragraph.create(null, schema.text("hel")),
          schema.nodes.paragraph.create(null, schema.text("lo")),
        ]),
      ),
    );
    expect(useDocument.getState().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(bridge.serializeMarkdown).toHaveBeenCalled();
    expect(files.fileWrite).not.toHaveBeenCalled();
    expect(useDocument.getState().dirty).toBe(false);
    expect(useDocument.getState().savePhase).toBe("idle");
    expect(disk.get("/root/notes.md")).toEqual({ text: "hello", modifiedMs: 1000 });
  });

  // The other side of the same guard. Keeping the buffer over a copy that moved on disk has to
  // write, and the bytes it writes are often exactly the ones this module last saw, so "nothing to
  // write" must not be the answer here.
  it("still writes when the buffer is kept over a file that moved on disk", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    keepBuffer();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    expect(files.fileWrite).toHaveBeenCalledWith("/root/notes.md", "hello", undefined);
    expect(useDocument.getState().dirty).toBe(false);
  });

  it("serializes the tree the editor has now, not the one the file was opened with", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    useDocument.getState().setContent(editorDocOf("edited"));

    await useDocument.getState().save();

    const [document, doc] = bridge.serializeMarkdown.mock.calls[0];
    expect(doc.textContent).toBe("edited");
    expect(document.source).toBe("hello");
  });

  it("keeps a conflict, does not overwrite and does not try again", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    put("/root/notes.md", "somebody else got here first", 9000);
    useDocument.getState().setContent(editorDocOf("mine"));

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    expect(disk.get("/root/notes.md")?.text).toBe("somebody else got here first");
    const state = useDocument.getState();
    expect(state.externalChange).toBe("changed-on-disk");
    expect(state.dirty).toBe(true);
    expect(state.savePhase).toBe("idle");
    expect(state.content?.textContent).toBe("mine");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);
  });

  it("reports a failed write without losing the buffer", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    files.fileWrite.mockRejectedValueOnce(new Error("read-only volume"));
    useDocument.getState().setContent(editorDocOf("mine"));

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    const state = useDocument.getState();
    expect(state.savePhase).toBe("error");
    expect(state.saveError).toContain("read-only volume");
    expect(state.dirty).toBe(true);
    expect(state.content?.textContent).toBe("mine");
  });

  it("flushes the pending edit before it opens something else", async () => {
    put("/root/one.md", "one", 1000);
    put("/root/two.md", "two", 1000);
    await useDocument.getState().open("/root/one.md");
    useDocument.getState().setContent(editorDocOf("one edited"));

    await useDocument.getState().open("/root/two.md");

    expect(disk.get("/root/one.md")?.text).toBe("one edited");
    const wrote = files.fileWrite.mock.invocationCallOrder[0];
    const readTwo = files.fileRead.mock.invocationCallOrder[1];
    expect(wrote).toBeLessThan(readTwo);
    expect(useDocument.getState().path).toBe("/root/two.md");
    expect(useDocument.getState().dirty).toBe(false);
  });
});

describe("overlapping saves", () => {
  it("does not start a second write while one is in flight, and folds a save requested during it into a single write of the newest content", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    const write = gateNextWrite();
    useDocument.getState().setContent(editorDocOf("first edit"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    // A further edit and an explicit Cmd+S both land while that write is still on the wire.
    useDocument.getState().setContent(editorDocOf("second edit"));
    const explicitSave = useDocument.getState().save();
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    write.release();
    await explicitSave;

    expect(files.fileWrite).toHaveBeenCalledTimes(2);
    expect(files.fileWrite).toHaveBeenNthCalledWith(1, "/root/notes.md", "first edit", 1000);
    // The fold uses the mtime the first write actually produced, not the stale one it started
    // with, which is what keeps the second write from reading back as a spurious conflict.
    expect(files.fileWrite).toHaveBeenNthCalledWith(2, "/root/notes.md", "second edit", 2000);
    expect(disk.get("/root/notes.md")).toEqual({ text: "second edit", modifiedMs: 3000 });
    expect(useDocument.getState().dirty).toBe(false);
    expect(useDocument.getState().modifiedMs).toBe(3000);
  });

  it("collapses any number of saves requested during one write into a single follow-up carrying the last content typed", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    const write = gateNextWrite();
    useDocument.getState().setContent(editorDocOf("first edit"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    useDocument.getState().setContent(editorDocOf("second edit"));
    const saveB = useDocument.getState().save();
    useDocument.getState().setContent(editorDocOf("third edit"));
    const saveC = useDocument.getState().save();
    useDocument.getState().setContent(editorDocOf("fourth edit"));
    const saveD = useDocument.getState().save();

    // Three more requests stacked up while the first write was in flight, but that is one flag,
    // not a growing queue, so nothing has gone out for any of them yet.
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    write.release();
    await Promise.all([saveB, saveC, saveD]);

    // Exactly one follow-up write, carrying whatever was newest, never one write per request.
    expect(files.fileWrite).toHaveBeenCalledTimes(2);
    expect(files.fileWrite).toHaveBeenNthCalledWith(2, "/root/notes.md", "fourth edit", 2000);
    expect(disk.get("/root/notes.md")?.text).toBe("fourth edit");
    expect(useDocument.getState().dirty).toBe(false);
  });

  it("does not retry when the in-flight write it was folded into comes back as a conflict", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    const write = gateNextWrite();
    useDocument.getState().setContent(editorDocOf("mine"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    // The file moves on while that write sits gated, so it will come back as a conflict.
    put("/root/notes.md", "somebody else got here first", 9000);
    const foldedSave = useDocument.getState().save();

    write.release();
    await foldedSave;

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    const state = useDocument.getState();
    expect(state.externalChange).toBe("changed-on-disk");
    expect(state.dirty).toBe(true);
    expect(state.content?.textContent).toBe("mine");
    expect(disk.get("/root/notes.md")?.text).toBe("somebody else got here first");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);
  });

  it("flushing while a write is in flight waits for it rather than racing a second write alongside it", async () => {
    put("/root/one.md", "hello", 1000);
    put("/root/two.md", "two", 1000);
    await useDocument.getState().open("/root/one.md");

    const write = gateNextWrite();
    useDocument.getState().setContent(editorDocOf("mine"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    const opened = useDocument.getState().open("/root/two.md");
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    write.release();
    await opened;

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    expect(disk.get("/root/one.md")?.text).toBe("mine");
    expect(useDocument.getState().path).toBe("/root/two.md");
  });
});

describe("a change made outside the app", () => {
  it("is taken silently while the buffer is clean", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");

    put("/root/notes.md", "hello from elsewhere", 5000);
    await documentChangedOnDisk("/root/notes.md");

    const state = useDocument.getState();
    expect(state.content?.textContent).toBe("hello from elsewhere");
    expect(state.modifiedMs).toBe(5000);
    expect(state.dirty).toBe(false);
    expect(state.externalChange).toBe("synced");
    expect(files.fileWrite).not.toHaveBeenCalled();
  });

  it("leaves a dirty buffer exactly where it was and asks the UI for a decision", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    useDocument.getState().setContent(editorDocOf("mine"));

    put("/root/notes.md", "theirs", 5000);
    await documentChangedOnDisk("/root/notes.md");

    const state = useDocument.getState();
    expect(state.content?.textContent).toBe("mine");
    expect(state.dirty).toBe(true);
    expect(state.externalChange).toBe("changed-on-disk");
    expect(disk.get("/root/notes.md")?.text).toBe("theirs");
  });

  it("is not what this app's own save looks like coming back", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    useDocument.getState().setContent(editorDocOf("mine"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    bridge.parseMarkdown.mockClear();

    await documentChangedOnDisk("/root/notes.md");

    expect(bridge.parseMarkdown).not.toHaveBeenCalled();
    expect(useDocument.getState().externalChange).toBe("synced");
  });

  it("holds on to the buffer when the file has gone", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    disk.delete("/root/notes.md");

    await documentChangedOnDisk("/root/notes.md");

    expect(useDocument.getState().externalChange).toBe("changed-on-disk");
    expect(useDocument.getState().content?.textContent).toBe("hello");
  });

  // Putting a deleted file back is `keepBuffer`, and it is something the user says out loud. A
  // transaction that leaves the document exactly as it was is not somebody saying it.
  it("does not put a file that has gone back on disk for a transaction that changed nothing", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    disk.delete("/root/notes.md");
    await documentChangedOnDisk("/root/notes.md");

    useDocument.getState().setContent(editorDocOf("hello"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileWrite).not.toHaveBeenCalled();
    expect(disk.has("/root/notes.md")).toBe(false);
  });

  // The other side of it. Once there is an edit to lose, the buffer is the only copy of it and it
  // goes to disk like any other.
  it("writes an edit made after the file has gone", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    disk.delete("/root/notes.md");
    await documentChangedOnDisk("/root/notes.md");

    useDocument.getState().setContent(editorDocOf("hello, edited"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    expect(disk.get("/root/notes.md")?.text).toBe("hello, edited");
  });

  it("is reloaded on demand, throwing the buffer away", async () => {
    put("/root/notes.md", "hello", 1000);
    await useDocument.getState().open("/root/notes.md");
    useDocument.getState().setContent(editorDocOf("mine"));
    put("/root/notes.md", "theirs", 5000);
    await documentChangedOnDisk("/root/notes.md");

    await useDocument.getState().reloadFromDisk();

    const state = useDocument.getState();
    expect(state.content?.textContent).toBe("theirs");
    expect(state.dirty).toBe(false);
    expect(state.externalChange).toBe("synced");
    expect(files.fileWrite).not.toHaveBeenCalled();
  });
});

describe("history", () => {
  beforeEach(() => {
    put("/root/one.md", "one", 1000);
    put("/root/two.md", "two", 1000);
    put("/root/three.md", "three", 1000);
  });

  it("walks back and forward along the paths that were opened", async () => {
    await useDocument.getState().open("/root/one.md");
    await useDocument.getState().open("/root/two.md");

    await useDocument.getState().back();
    expect(useDocument.getState().path).toBe("/root/one.md");
    expect(useDocument.getState().historyIndex).toBe(0);

    await useDocument.getState().forward();
    expect(useDocument.getState().path).toBe("/root/two.md");
    expect(useDocument.getState().historyIndex).toBe(1);
  });

  it("stops at either end", async () => {
    await useDocument.getState().open("/root/one.md");
    await useDocument.getState().back();
    await useDocument.getState().forward();
    expect(useDocument.getState().path).toBe("/root/one.md");
    expect(useDocument.getState().history).toEqual(["/root/one.md"]);
  });

  it("cuts the branch when a new document is opened from the middle", async () => {
    await useDocument.getState().open("/root/one.md");
    await useDocument.getState().open("/root/two.md");
    await useDocument.getState().back();
    await useDocument.getState().open("/root/three.md");

    expect(useDocument.getState().history).toEqual(["/root/one.md", "/root/three.md"]);
    expect(useDocument.getState().historyIndex).toBe(1);
  });

  it("does not lose the forward branch just by walking back over it", async () => {
    await useDocument.getState().open("/root/one.md");
    await useDocument.getState().open("/root/two.md");
    await useDocument.getState().open("/root/three.md");
    await useDocument.getState().back();
    await useDocument.getState().back();

    expect(useDocument.getState().history).toEqual([
      "/root/one.md",
      "/root/two.md",
      "/root/three.md",
    ]);
    expect(useDocument.getState().historyIndex).toBe(0);
  });
});

// The one gesture in the app that changes the document without changing the file, run against a
// real file through the real bridge, because both halves of it matter: prosemirror-tables writes a
// width on to every cell of the column whose edge was dragged, and GFM has no column widths.
//
// The file is a hand written one, and that is the whole point. Its author spelled the tables the
// way a person does, the house style spells them another way, and so the byte comparison inside
// performSave, which is the second line of this defence, has nothing to match: it only fires on a
// document the editor has written before. What has to hold here is the first line. Nobody typed
// anything, so nothing may be written, and the assertion is the bytes on disk rather than the flag.
describe("a change the markdown has nowhere to put", () => {
  const HAND = corpusFile("hand/gfm-table.md").source;

  beforeEach(() => {
    bridge.parseMarkdown.mockImplementation(real.parseMarkdown);
    bridge.serializeMarkdown.mockImplementation(real.serializeMarkdown);
    put("/root/table.md", HAND, 1000);
  });

  it("leaves a hand written file untouched when a column is dragged", async () => {
    await useDocument.getState().open("/root/table.md");
    const opened = useDocument.getState().document!;

    // The premise, said out loud: this file does not serialize to itself, so the write this test
    // is about would have gone all the way to the disk.
    expect(real.serializeMarkdown(opened, opened.doc)).not.toBe(HAND);

    useDocument.getState().setContent(asEditorSees(withFirstColumn(opened.doc, { colwidth: [180] })));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(useDocument.getState().dirty).toBe(false);
    expect(files.fileWrite).not.toHaveBeenCalled();
    expect(disk.get("/root/table.md")).toEqual({ text: HAND, modifiedMs: 1000 });
  });

  // The other side of it, and the reason the rule is about the serializer rather than about table
  // attributes in general. Alignment is a cell attribute too, and the delimiter row is exactly
  // where GFM keeps it, so an align op is an edit like any other and has to reach the disk.
  it("still writes an alignment change, which the delimiter row does hold", async () => {
    await useDocument.getState().open("/root/table.md");
    const opened = useDocument.getState().document!;

    useDocument.getState().setContent(asEditorSees(withFirstColumn(opened.doc, { align: "center" })));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    const written = disk.get("/root/table.md")!.text;
    expect(written).not.toBe(HAND);
    // The first column centred and the other two left as the author had them. Written as a shape
    // rather than as a line so that this asserts the alignment and not the serializer's padding,
    // which src/editor/blocks/tables.test.ts is the place to pin down.
    expect(written.split("\n")[5]).toMatch(/^\| :-+: \| :-+ \| -+: \|$/);
  });

  // Typing is still typing. The comparison that keeps a drag off the disk runs on every keystroke,
  // and a cell it decided was unchanged is a character of somebody's file that never got saved.
  it("still writes a character typed into a cell", async () => {
    await useDocument.getState().open("/root/table.md");
    const edited = HAND.replace("Opens a folder", "Opens a folder!");
    const typed = real.parseMarkdown(edited, "/root/table.md");

    useDocument.getState().setContent(asEditorSees(typed.doc));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    expect(disk.get("/root/table.md")!.text).toContain("Opens a folder!");
  });
});

// The other way a document ends up back where it started: the user typed and then undid it, both
// inside one debounce. Nothing was edited in the end, so nothing may be written, and on a hand
// written file that write is the whole file reformatted.
//
// Run against a real file through the real bridge for the same reason as the describe above. This
// document does not serialize to its own bytes, so the byte comparison inside performSave cannot
// be what catches this, and neither can a dirty flag that only ever counts up: an undo has to be
// able to take the flag back down again.
describe("an edit and the undo of it", () => {
  const HAND = corpusFile("hand/setext-headings.md").source;
  const PATH = "/root/setext.md";

  beforeEach(() => {
    bridge.parseMarkdown.mockImplementation(real.parseMarkdown);
    bridge.serializeMarkdown.mockImplementation(real.serializeMarkdown);
    put(PATH, HAND, 1000);
  });

  /**
   * The tree a real undo lands on, built the hardest way there is: a fresh parse of the file's own
   * bytes, sharing not one node object with the tree the editor was handed. prosemirror-history
   * gives back most of the untouched subtrees by reference and this gives back none of them, so a
   * comparison that leant on identity would be caught here.
   */
  const undone = () => asEditorSees(real.parseMarkdown(HAND, PATH).doc);
  const typed = (text: string) => asEditorSees(real.parseMarkdown(HAND.replace("Some prose.", text), PATH).doc);

  it("leaves a hand written file untouched when the undo lands inside the debounce", async () => {
    await useDocument.getState().open(PATH);
    const opened = useDocument.getState().document!;

    // The premise, said out loud: this file does not serialize to itself, so the write this test
    // is about would have gone all the way to the disk and reformatted every line of it.
    expect(real.serializeMarkdown(opened, opened.doc)).not.toBe(HAND);

    useDocument.getState().setContent(typed("Some prose.zz"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    const restored = undone();
    expect(restored).not.toBe(opened.doc);
    useDocument.getState().setContent(restored);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileWrite).not.toHaveBeenCalled();
    expect(disk.get(PATH)).toEqual({ text: HAND, modifiedMs: 1000 });
  });

  // The other side of it, and the reason this is not just "never write a file nobody has retyped
  // by hand". The one time rewrite into house style is the product's decision and it still has to
  // happen the moment an edit actually survives the debounce.
  it("still rewrites the file in house style for the next edit that survives", async () => {
    await useDocument.getState().open(PATH);

    useDocument.getState().setContent(typed("Some prose.zz"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    useDocument.getState().setContent(undone());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(files.fileWrite).not.toHaveBeenCalled();

    useDocument.getState().setContent(typed("Some prose, edited."));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileWrite).toHaveBeenCalledTimes(1);
    const written = disk.get(PATH)!.text;
    expect(written).toContain("Some prose, edited.");
    expect(written).toContain("# Setext one");
    expect(written).not.toContain("==========");
  });

  // An undo that lands while the write it is undoing is still on the wire. That write was correct
  // when it went out, so the file is now the house style copy of the edit, and the buffer no longer
  // matches it. The undo has to reach the disk on the next lap rather than sitting there unwritten.
  it("writes the undone document back when the undo lands during the write it undoes", async () => {
    await useDocument.getState().open(PATH);

    const write = gateNextWrite();
    useDocument.getState().setContent(typed("Some prose.zz"));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(files.fileWrite).toHaveBeenCalledTimes(1);

    useDocument.getState().setContent(undone());
    write.release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(files.fileWrite).toHaveBeenCalledTimes(2);
    const written = disk.get(PATH)!.text;
    expect(written).not.toContain("Some prose.zz");
    expect(written).toContain("Some prose.");
    expect(useDocument.getState().dirty).toBe(false);
  });
});
