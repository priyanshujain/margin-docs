// The index status, which is a mapping and nothing else. It gets a test because the DTO has no
// "ready": a finished pass and an index that has never run are both `idle` on the wire, and
// telling a search box "no results" apart from "nothing has been indexed yet" depends on the
// difference.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus } from "../ipc";

const index = vi.hoisted(() => ({
  indexRebuild: vi.fn(),
  indexStatus: vi.fn(),
  searchQuickOpen: vi.fn(),
  searchText: vi.fn(),
  backlinksFor: vi.fn(),
}));

vi.mock("../api", () => index);

const { applyIndexStatus, useIndex } = await import("./useIndex");

const status = (patch: Partial<IndexStatus>): IndexStatus => ({
  phase: "idle",
  indexed: 0,
  total: 0,
  lastIndexed: null,
  error: null,
  message: null,
  ...patch,
});

beforeEach(() => {
  for (const mock of Object.values(index)) mock.mockReset();
  useIndex.getState().reset();
});

describe("reflecting the index", () => {
  it("calls a finished pass ready and one that never ran idle", () => {
    applyIndexStatus(status({ indexed: 40, total: 40, lastIndexed: 1700 }));
    expect(useIndex.getState().phase).toBe("ready");
    expect(useIndex.getState().filesIndexed).toBe(40);

    applyIndexStatus(status({}));
    expect(useIndex.getState().phase).toBe("idle");
  });

  it("passes a partial pass through as progress", () => {
    applyIndexStatus(status({ phase: "indexing", indexed: 12, total: 40 }));

    expect(useIndex.getState().phase).toBe("indexing");
    expect(useIndex.getState().filesIndexed).toBe(12);
    expect(useIndex.getState().total).toBe(40);
  });

  it("keeps the reason an index failed", () => {
    applyIndexStatus(status({ phase: "error", error: "database is locked" }));

    expect(useIndex.getState().phase).toBe("error");
    expect(useIndex.getState().error).toBe("database is locked");
  });
});

describe("starting a rebuild", () => {
  it("shows itself as working and then takes the status it is handed", async () => {
    index.indexRebuild.mockResolvedValue(status({ indexed: 3, total: 3, lastIndexed: 1700 }));

    await useIndex.getState().start();

    expect(useIndex.getState().phase).toBe("ready");
    expect(useIndex.getState().total).toBe(3);
  });

  it("does not leave the phase stuck when the rebuild throws", async () => {
    index.indexRebuild.mockRejectedValue(new Error("no app data directory"));

    await useIndex.getState().start();

    expect(useIndex.getState().phase).toBe("error");
    expect(useIndex.getState().error).toContain("no app data directory");
  });
});
