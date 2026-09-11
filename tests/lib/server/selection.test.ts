import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({ getBatch: vi.fn(), countRecords: vi.fn() }));
vi.mock("@/lib/server/repositories", () => repositories);

import { parseBatchIds, SelectionError, validateSelection } from "@/lib/server/selection";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "token" };
const ready = (id: string, over: Record<string, unknown> = {}) => ({
  batchId: id, selType: "ai", ingestStatus: "ready", total: 10, fingerprint: `fp-${id}`, ...over,
});

describe("selection validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositories.getBatch.mockImplementation((_tenant, _account, id) => Promise.resolve(ready(id)));
    repositories.countRecords.mockResolvedValue(10);
  });

  it("deduplicates ids and rejects malformed or oversized selections", () => {
    expect(parseBatchIds(["b1", "b1", "b2"])).toEqual(["b1", "b2"]);
    expect(() => parseBatchIds("b1")).toThrow(SelectionError);
    expect(() => parseBatchIds(["b1", 2])).toThrow(SelectionError);
    expect(() => parseBatchIds(Array.from({ length: 51 }, (_, i) => `b${i}`))).toThrow(SelectionError);
    expect(() => parseBatchIds(Array.from({ length: 51 }, () => "b1"))).toThrow(SelectionError);
    expect(() => parseBatchIds(["x".repeat(201)])).toThrow(SelectionError);
  });

  it("rejects a missing or mixed-type member instead of analyzing a subset", async () => {
    repositories.getBatch.mockImplementation((_tenant, _account, id) => Promise.resolve(id === "missing" ? null : ready(id)));
    await expect(validateSelection(ctx, ["b1", "missing"])).rejects.toMatchObject({ code: "batch_not_found" });

    repositories.getBatch.mockImplementation((_tenant, _account, id) => Promise.resolve(ready(id, { selType: id === "b2" ? "message" : "ai" })));
    await expect(validateSelection(ctx, ["b1", "b2"])).rejects.toMatchObject({ code: "seltype_mismatch" });
  });

  it("requires every ready batch count to match its committed total", async () => {
    repositories.countRecords.mockImplementation((_tenant, _account, ids) => Promise.resolve(ids[0] === "b1" ? 10 : 1));
    await expect(validateSelection(ctx, ["b1", "b2"], { requireReady: true, verifyCounts: true }))
      .rejects.toMatchObject({ code: "incomplete_ingestion" });
  });

  // A stale batch's published revision is complete and is what every reader
  // sees. 409-ing it made the Analytics screen fail and re-ingest in a loop.
  it("serves a stale batch rather than rejecting it as un-ingested", async () => {
    repositories.getBatch.mockImplementation((_tenant, _account, id) =>
      Promise.resolve(ready(id, { ingestStatus: "stale" })),
    );
    await expect(
      validateSelection(ctx, ["b1"], { requireReady: true, verifyCounts: true }),
    ).resolves.toHaveLength(1);
  });

  it("still rejects a batch with no complete revision to read", async () => {
    repositories.getBatch.mockImplementation((_tenant, _account, id) =>
      Promise.resolve(ready(id, { ingestStatus: "none" })),
    );
    await expect(validateSelection(ctx, ["b1"], { requireReady: true })).rejects.toMatchObject({
      code: "not_ingested",
    });
  });
});
