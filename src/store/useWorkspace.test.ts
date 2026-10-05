// The open folder with the disk faked out: what goes in the store when a folder opens, what stops
// when it closes, and what a relaunch does and deliberately no longer does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../ipc";

const roots = vi.hoisted(() => ({
  rootsList: vi.fn(),
  rootOpen: vi.fn(),
  rootClose: vi.fn(),
  treeRead: vi.fn(),
  sweepDocuments: vi.fn(),
  revealInFinder: vi.fn(),
  openExternal: vi.fn(),
}));

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

const watch = vi.hoisted(() => ({ watchStart: vi.fn(), watchStop: vi.fn() }));

const index = vi.hoisted(() => ({
  indexRebuild: vi.fn(),
  indexStatus: vi.fn(),
  searchQuickOpen: vi.fn(),
  searchText: vi.fn(),
  backlinksFor: vi.fn(),
}));

const bridge = vi.hoisted(() => ({
  parseMarkdown: vi.fn(),
  serializeMarkdown: vi.fn(),
  parsePlainText: vi.fn(),
  serializePlainText: vi.fn(),
}));

vi.mock("../api/roots", () => roots);
vi.mock("../api/files", () => files);
vi.mock("../api/watch", () => watch);
vi.mock("../api", () => index);
vi.mock("../markdown", () => bridge);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { useWorkspace } = await import("./useWorkspace");
const { useDocument } = await import("./useDocument");
const { restoreSession } = await import("../workspace");
const { schema } = await import("../model/schema");

const HANDBOOK = "/Users/you/Documents/Handbook";

const dir = (path: string, children: FileNode[]): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind: "dir",
  editable: false,
  modifiedMs: 1000,
  children,
});

const file = (path: string, kind: FileNode["kind"] = "markdown"): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind,
  editable: kind === "markdown" || kind === "text",
  modifiedMs: 1000,
  children: [],
});

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (n: number) => [...map.keys()][n] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  for (const group of [roots, files, watch, index, bridge]) {
    for (const mock of Object.values(group)) mock.mockReset();
  }

  roots.rootsList.mockResolvedValue([]);
  roots.rootOpen.mockImplementation(async (path: string) => ({
    id: `id-${path}`,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    openedMs: 1000,
  }));
  roots.treeRead.mockImplementation(async (rootId: string) => {
    const path = rootId.slice("id-".length);
    return dir(path, [
      file(`${path}/README.md`),
      dir(`${path}/guides`, [file(`${path}/guides/writing.md`)]),
      file(`${path}/logo.png`, "other"),
    ]);
  });
  roots.sweepDocuments.mockImplementation(async (rootId: string) => {
    const path = rootId.slice("id-".length);
    return [`${path}/README.md`, `${path}/guides/writing.md`];
  });
  roots.rootClose.mockResolvedValue(undefined);
  roots.revealInFinder.mockResolvedValue(undefined);
  watch.watchStart.mockResolvedValue(undefined);
  watch.watchStop.mockResolvedValue(undefined);
  index.indexRebuild.mockResolvedValue({
    phase: "idle",
    indexed: 3,
    total: 3,
    lastIndexed: 1000,
    error: null,
    message: null,
  });
  files.fileRead.mockImplementation(async (path: string) => ({
    path,
    text: "hello",
    modifiedMs: 1000,
  }));
  bridge.parseMarkdown.mockImplementation((source: string, path: string) => ({
    frontmatter: null,
    doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(source))),
    source,
    path,
  }));

  useWorkspace.setState({
    root: null,
    expanded: new Set(),
    selectedPath: null,
    showIgnored: false,
    recentFolders: [],
    scanPhase: "idle",
    scanError: null,
  });
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opening a folder", () => {
  it("reads the tree once and watches it, and writes nothing into it", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);

    const root = useWorkspace.getState().root;
    expect(root?.id).toBe(`id-${HANDBOOK}`);
    expect(root?.name).toBe("Handbook");
    expect(root?.tree.map((n) => n.name)).toEqual(["README.md", "guides", "logo.png"]);
    expect(watch.watchStart).toHaveBeenCalledWith(`id-${HANDBOOK}`);
    expect(files.fileCreate).not.toHaveBeenCalled();
    expect(files.fileWrite).not.toHaveBeenCalled();
  });

  it("marks directories as directories and everything else by what opens it", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);

    const [readme, guides, logo] = useWorkspace.getState().root?.tree ?? [];
    expect(readme.isDir).toBe(false);
    expect(readme.editable).toBe(true);
    expect(guides.isDir).toBe(true);
    expect(guides.children?.map((n) => n.name)).toEqual(["writing.md"]);
    expect(logo.editable).toBe(false);
    expect(logo.children).toBeUndefined();
  });

  it("shows what is inside the folder without waiting to be asked", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);

    expect(useWorkspace.getState().expanded.has(HANDBOOK)).toBe(true);
  });

  // Rewritten from "remembers the folder so the next launch can put it back". A launch no longer
  // puts anything back, so the only list left is the one the start screen is drawn from, and
  // `margindocs-roots` was removed along with the code that read it.
  it("remembers the folder so the start screen can offer it back", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);

    expect(useWorkspace.getState().recentFolders).toEqual([HANDBOOK]);
    expect(JSON.parse(localStorage.getItem("margindocs-recents") ?? "[]")).toEqual([HANDBOOK]);
    expect(localStorage.getItem("margindocs-roots")).toBeNull();
  });

  it("refreshes the folder that is opened twice rather than closing and reopening it", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);
    await addRoot(HANDBOOK);

    expect(useWorkspace.getState().root?.path).toBe(HANDBOOK);
    expect(useWorkspace.getState().recentFolders).toEqual([HANDBOOK]);
    expect(roots.rootClose).not.toHaveBeenCalled();
  });

  // One folder at a time is the whole point of this pass, and the folder being replaced is not
  // just dropped from memory: its watcher stops, the backend hears about it, and a document that
  // came out of it is flushed and closed rather than left pointing into a tree that is gone.
  it("replaces the folder that was open and lets the old one go", async () => {
    const SCRATCH = "/Users/you/Documents/Scratch";
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);
    await useDocument.getState().open(`${HANDBOOK}/README.md`);
    useWorkspace.getState().select(`${HANDBOOK}/README.md`);

    await addRoot(SCRATCH);

    expect(useWorkspace.getState().root?.path).toBe(SCRATCH);
    expect(useWorkspace.getState().selectedPath).toBeNull();
    expect(useDocument.getState().path).toBeNull();
    expect(watch.watchStop).toHaveBeenCalledWith(`id-${HANDBOOK}`);
    expect(roots.rootClose).toHaveBeenCalledWith(`id-${HANDBOOK}`);
    expect(useWorkspace.getState().recentFolders).toEqual([SCRATCH, HANDBOOK]);
  });

  it("keeps the folder that is open when the new one cannot be read", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);
    roots.treeRead.mockRejectedValueOnce(new Error("permission denied"));

    await expect(addRoot("/Users/you/Documents/Scratch")).rejects.toThrow("permission denied");

    expect(useWorkspace.getState().root?.path).toBe(HANDBOOK);
    expect(roots.rootClose).not.toHaveBeenCalled();
  });

  it("reports a folder it could not read without leaving the phase stuck", async () => {
    roots.treeRead.mockRejectedValueOnce(new Error("permission denied"));
    const { addRoot } = await import("../workspace");

    await expect(addRoot(HANDBOOK)).rejects.toThrow("permission denied");
    expect(useWorkspace.getState().scanPhase).toBe("error");
    expect(useWorkspace.getState().scanError).toContain("permission denied");
    expect(useWorkspace.getState().root).toBeNull();
  });
});

describe("closing a folder", () => {
  it("stops the watcher, closes the root and forgets it, touching nothing on disk", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);
    useWorkspace.getState().select(`${HANDBOOK}/README.md`);

    useWorkspace.getState().closeFolder();
    await vi.waitFor(() => expect(roots.rootClose).toHaveBeenCalled());

    expect(useWorkspace.getState().root).toBeNull();
    expect(useWorkspace.getState().selectedPath).toBeNull();
    expect(watch.watchStop).toHaveBeenCalledWith(`id-${HANDBOOK}`);
    expect(roots.rootClose).toHaveBeenCalledWith(`id-${HANDBOOK}`);
    expect(files.fileTrash).not.toHaveBeenCalled();
  });

  it("keeps the folder on the start screen after it is closed", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);

    useWorkspace.getState().closeFolder();
    await vi.waitFor(() => expect(roots.rootClose).toHaveBeenCalled());

    expect(useWorkspace.getState().recentFolders).toEqual([HANDBOOK]);
  });

  it("forgets a folder off the start screen without touching it", async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);

    useWorkspace.getState().forgetFolder(HANDBOOK);

    expect(useWorkspace.getState().recentFolders).toEqual([]);
    expect(JSON.parse(localStorage.getItem("margindocs-recents") ?? "[]")).toEqual([]);
    expect(files.fileTrash).not.toHaveBeenCalled();
  });
});

// Rewritten wholesale. This suite used to assert that a relaunch reopened every folder from
// localStorage and from the backend's own list, and that is exactly the behaviour the user asked
// to be rid of: the window now comes back on the start screen with nothing open.
describe("restoring a session", () => {
  it("opens nothing and puts the recents list on the start screen", async () => {
    localStorage.setItem("margindocs-recents", JSON.stringify([HANDBOOK, "/Users/you/Scratch"]));

    await restoreSession();

    expect(useWorkspace.getState().root).toBeNull();
    expect(roots.rootOpen).not.toHaveBeenCalled();
    expect(index.indexRebuild).not.toHaveBeenCalled();
    expect(useWorkspace.getState().recentFolders).toEqual([HANDBOOK, "/Users/you/Scratch"]);
  });

  // Rust keeps its own list of open roots across a relaunch, and nothing on screen mentions them
  // any more, so a watcher and a set of index rows would otherwise be left running for a folder
  // the user cannot see or close.
  it("lets go of the roots the backend was still holding from last session", async () => {
    roots.rootsList.mockResolvedValue([
      { id: `id-${HANDBOOK}`, path: HANDBOOK, name: "Handbook", openedMs: 1 },
      { id: "id-scratch", path: "/Users/you/Scratch", name: "Scratch", openedMs: 2 },
    ]);

    await restoreSession();

    expect(roots.rootClose).toHaveBeenCalledWith(`id-${HANDBOOK}`);
    expect(roots.rootClose).toHaveBeenCalledWith("id-scratch");
    expect(watch.watchStop).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState().root).toBeNull();
  });
});

describe("changing the tree", () => {
  beforeEach(async () => {
    const { addRoot } = await import("../workspace");
    await addRoot(HANDBOOK);
    roots.treeRead.mockClear();
  });

  // The name comes from the setup panel now rather than from a placeholder the tree then offers to
  // rename, so the store is handed one instead of inventing it.
  it("creates a document under the name it was given and re-reads the folder", async () => {
    files.fileCreate.mockResolvedValue(file(`${HANDBOOK}/Meeting notes.md`));

    const path = await useWorkspace.getState().newDocument(HANDBOOK, "Meeting notes.md");

    expect(path).toBe(`${HANDBOOK}/Meeting notes.md`);
    expect(files.fileCreate).toHaveBeenCalledWith(HANDBOOK, "Meeting notes.md");
    expect(roots.treeRead).toHaveBeenCalledWith(`id-${HANDBOOK}`);
  });

  it("falls back to Untitled.md rather than writing a file with no name", async () => {
    files.fileCreate.mockResolvedValue(file(`${HANDBOOK}/Untitled.md`));

    await useWorkspace.getState().newDocument(HANDBOOK, "   ");

    expect(files.fileCreate).toHaveBeenCalledWith(HANDBOOK, "Untitled.md");
  });

  it("creates a folder with a name the user can see and rename", async () => {
    files.fileFolderCreate.mockResolvedValue(dir(`${HANDBOOK}/Untitled Folder`, []));

    await useWorkspace.getState().newFolder(HANDBOOK);

    expect(files.fileFolderCreate).toHaveBeenCalledWith(HANDBOOK, "Untitled Folder");
  });

  it("sends a delete to the Trash and closes the document if that was the one", async () => {
    await useDocument.getState().open(`${HANDBOOK}/README.md`);
    useWorkspace.getState().select(`${HANDBOOK}/README.md`);
    files.fileTrash.mockResolvedValue(undefined);

    await useWorkspace.getState().deleteEntry(`${HANDBOOK}/README.md`);

    expect(files.fileTrash).toHaveBeenCalledWith(`${HANDBOOK}/README.md`);
    expect(useDocument.getState().path).toBeNull();
    expect(useWorkspace.getState().selectedPath).toBeNull();
  });

  it("does not write a deleted document back out on its way to the Trash", async () => {
    await useDocument.getState().open(`${HANDBOOK}/README.md`);
    useDocument.getState().setContent(
      schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text("edited"))),
    );
    files.fileTrash.mockResolvedValue(undefined);

    await useWorkspace.getState().deleteEntry(`${HANDBOOK}/README.md`);
    await vi.waitFor(() => expect(useDocument.getState().path).toBeNull());

    expect(files.fileWrite).not.toHaveBeenCalled();
  });

  it("follows the open document to its new name after a rename", async () => {
    await useDocument.getState().open(`${HANDBOOK}/README.md`);
    files.fileRename.mockResolvedValue(file(`${HANDBOOK}/Overview.md`));

    await useWorkspace.getState().renameEntry(`${HANDBOOK}/README.md`, "Overview.md");

    expect(useDocument.getState().path).toBe(`${HANDBOOK}/Overview.md`);
    expect(files.fileWrite).not.toHaveBeenCalled();
  });

  it("leaves the open document alone when something else is renamed", async () => {
    await useDocument.getState().open(`${HANDBOOK}/README.md`);
    files.fileRename.mockResolvedValue(file(`${HANDBOOK}/guides/style.md`));

    await useWorkspace.getState().renameEntry(`${HANDBOOK}/guides/writing.md`, "style.md");

    expect(useDocument.getState().path).toBe(`${HANDBOOK}/README.md`);
  });
});
