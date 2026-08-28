// Quick open and full text with the index faked out. The interesting behaviour is not the mapping
// but the ordering: somebody typing outruns the index, and the answer to what they typed three
// keystrokes ago must not land on top of the answer to what they typed last.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickOpenHit } from "../ipc";

const index = vi.hoisted(() => ({
  indexRebuild: vi.fn(),
  indexStatus: vi.fn(),
  searchQuickOpen: vi.fn(),
  searchText: vi.fn(),
  backlinksFor: vi.fn(),
}));

vi.mock("../api", () => index);
vi.mock("../api/roots", () => ({
  rootsList: vi.fn(),
  rootOpen: vi.fn(),
  rootClose: vi.fn(),
  treeRead: vi.fn(),
  revealInFinder: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("../api/files", () => ({
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
vi.mock("../api/watch", () => ({ watchStart: vi.fn(), watchStop: vi.fn() }));
vi.mock("../markdown", () => ({
  parseMarkdown: vi.fn(),
  serializeMarkdown: vi.fn(),
  parsePlainText: vi.fn(),
  serializePlainText: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { useSearch } = await import("./useSearch");
const { useWorkspace } = await import("./useWorkspace");

const HANDBOOK = "/Users/you/Documents/Handbook";

const hit = (name: string): QuickOpenHit => ({
  path: `${HANDBOOK}/${name}`,
  name,
  root: "handbook",
  relPath: name,
  score: 10,
  ranges: [{ start: 0, end: 2 }],
});

beforeEach(() => {
  for (const mock of Object.values(index)) mock.mockReset();
  useWorkspace.setState({
    roots: [{ id: "handbook", path: HANDBOOK, name: "Handbook", tree: [] }],
  });
  useSearch.getState().reset();
});

describe("quick open", () => {
  it("names the folder a hit came from and keeps the ranges that highlight it", async () => {
    index.searchQuickOpen.mockResolvedValue([hit("README.md")]);

    await useSearch.getState().runQuickOpen("re");

    expect(useSearch.getState().quickOpenHits).toEqual([
      {
        path: `${HANDBOOK}/README.md`,
        name: "README.md",
        rootPath: HANDBOOK,
        relPath: "README.md",
        ranges: [{ start: 0, end: 2 }],
      },
    ]);
    expect(useSearch.getState().quickOpenPhase).toBe("idle");
  });

  it("clears itself on an empty query without asking the index anything", async () => {
    index.searchQuickOpen.mockResolvedValue([hit("README.md")]);
    await useSearch.getState().runQuickOpen("re");

    await useSearch.getState().runQuickOpen("   ");

    expect(useSearch.getState().quickOpenHits).toEqual([]);
    expect(index.searchQuickOpen).toHaveBeenCalledTimes(1);
  });

  it("never lets a slow answer to an old query overwrite a newer one", async () => {
    let answerFirst: (hits: QuickOpenHit[]) => void = () => {};
    index.searchQuickOpen
      .mockImplementationOnce(
        () =>
          new Promise<QuickOpenHit[]>((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce([hit("readme.md")]);

    const stale = useSearch.getState().runQuickOpen("re");
    const fresh = useSearch.getState().runQuickOpen("readme");
    await fresh;
    answerFirst([hit("recipes.md")]);
    await stale;

    expect(useSearch.getState().quickOpenHits.map((h) => h.name)).toEqual(["readme.md"]);
  });

  it("surfaces a failure as a phase and an empty list, not as stale rows", async () => {
    index.searchQuickOpen.mockResolvedValueOnce([hit("README.md")]);
    await useSearch.getState().runQuickOpen("re");
    index.searchQuickOpen.mockRejectedValueOnce(new Error("index is locked"));

    await useSearch.getState().runQuickOpen("read");

    expect(useSearch.getState().quickOpenPhase).toBe("error");
    expect(useSearch.getState().quickOpenError).toContain("index is locked");
    expect(useSearch.getState().quickOpenHits).toEqual([]);
  });
});

describe("full text", () => {
  it("keeps the line number and the title the index recorded", async () => {
    index.searchText.mockResolvedValue([
      {
        path: `${HANDBOOK}/README.md`,
        root: "handbook",
        title: "Handbook",
        line: 12,
        snippet: "…plain markdown…",
        ranges: [{ start: 6, end: 14 }],
      },
    ]);

    await useSearch.getState().runFullText("markdown");

    expect(useSearch.getState().fullTextHits).toEqual([
      {
        path: `${HANDBOOK}/README.md`,
        title: "Handbook",
        line: 12,
        excerpt: "…plain markdown…",
        ranges: [{ start: 6, end: 14 }],
      },
    ]);
  });

  it("drops an answer that arrives after a reset", async () => {
    let answer: (hits: never[]) => void = () => {};
    index.searchText.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          answer = resolve;
        }),
    );

    const running = useSearch.getState().runFullText("markdown");
    useSearch.getState().reset();
    answer([]);
    await running;

    expect(useSearch.getState().fullTextPhase).toBe("idle");
    expect(useSearch.getState().fullTextQuery).toBe("");
  });
});
