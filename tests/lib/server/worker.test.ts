import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  checkpointJob: vi.fn(),
  claimNextJob: vi.fn(),
  deleteBatchRevisionRecords: vi.fn(),
  deleteUnpublishedBatchRevision: vi.fn(),
  failBatchIfOwned: vi.fn(),
  getBatch: vi.fn(),
  getRecordsForRevision: vi.fn(),
  publishBatchIfOwned: vi.fn(),
  releaseIngestionLocks: vi.fn(),
  renewIngestionLocks: vi.fn(),
  retireBatchRevision: vi.fn(),
  replaceBatchRecords: vi.fn(),
  updateClaimedJob: vi.fn(),
  upsertBatch: vi.fn(),
}));
const client = vi.hoisted(() => ({ listCalls: vi.fn(), listMessages: vi.fn() }));

vi.mock("@/lib/server/repositories", () => repositories);
vi.mock("@/lib/server/magick-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/magick-client")>();
  return { ...actual, MagickClient: vi.fn(() => client) };
});
vi.mock("@/lib/server/normalize", () => ({
  normalizeCall: (raw: { id: string }) => ({ recordId: raw.id, status: "done" }),
  normalizeMessage: (raw: { id: string }) => ({ recordId: raw.id, status: "done" }),
  buildBatchDoc: (_records: unknown[], _ctx: unknown, batch: unknown) => batch,
}));
vi.mock("@/lib/server/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/server/observability/request-context", () => ({ runWithRequestContext: vi.fn() }));

import { MagickApiError } from "@/lib/server/magick-client";
import { processJob, runClaimedJob } from "@/lib/server/worker";
import type { Job } from "@/lib/server/types";

const job = (patch: Partial<Job> = {}): Job => ({
  jobId: "j1",
  type: "merge",
  tenantId: "t1",
  accountId: "a1",
  idToken: "token",
  batchIds: ["b1", "b2"],
  status: "running",
  total: 250,
  done: 0,
  cursor: 0,
  batchIndex: 0,
  leaseId: "lease-1",
  leaseUntil: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const batch = (batchId: string) => ({
  batchId,
  sourceId: `source-${batchId}`,
  selType: "ai",
  total: 1,
  fingerprint: "fp",
});

beforeEach(() => {
  vi.clearAllMocks();
  repositories.checkpointJob.mockResolvedValue(job());
  repositories.updateClaimedJob.mockResolvedValue(job());
  repositories.deleteBatchRevisionRecords.mockResolvedValue(undefined);
  repositories.deleteUnpublishedBatchRevision.mockResolvedValue(undefined);
  repositories.getBatch.mockImplementation((_t, _a, id) => Promise.resolve(batch(id)));
  repositories.failBatchIfOwned.mockResolvedValue(undefined);
  repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "1", status: "done" }]);
  repositories.publishBatchIfOwned.mockResolvedValue(true);
  repositories.releaseIngestionLocks.mockResolvedValue(undefined);
  repositories.renewIngestionLocks.mockResolvedValue(undefined);
  repositories.retireBatchRevision.mockResolvedValue(undefined);
  repositories.replaceBatchRecords.mockResolvedValue(undefined);
  repositories.upsertBatch.mockResolvedValue(undefined);
});

describe("processJob resume", () => {
  it("resumes at the durable offset and derives progress without double counting", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "101" }], total: 101 });
    repositories.getRecordsForRevision.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
    );
    await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 101 }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
    expect(repositories.deleteBatchRevisionRecords).not.toHaveBeenCalled();
    expect(repositories.replaceBatchRecords).toHaveBeenCalledTimes(1);
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(2, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(3, "j1", "lease-1", { done: 101, cursor: 0, batchIndex: 1 });
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({ status: "done", done: 101 }));
  });

  it("starts the next batch from zero after a durable batch transition", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    await processJob(job({ done: 100, cursor: 0, batchIndex: 1 }));
    expect(repositories.getBatch).toHaveBeenCalledTimes(1);
    expect(repositories.getBatch).toHaveBeenCalledWith("t1", "a1", "b2");
    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b2", limit: 100, offset: 0 });
    expect(repositories.deleteBatchRevisionRecords).toHaveBeenCalledWith("t1", "a1", "b2", "j1");
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({ done: 101 }));
  });

  it("stops if ownership is lost while checkpointing", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.checkpointJob.mockResolvedValueOnce(null);
    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost while checkpointing");
    expect(repositories.updateClaimedJob).not.toHaveBeenCalled();
  });

  it("treats paginated rows as authoritative when an upstream total is stale-high", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 100 });
    client.listCalls.mockResolvedValueOnce({ calls: [], total: 100 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 100 }))).resolves.toBeUndefined();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0 }),
      "j1",
      "lease-1",
    );
  });

  it("continues past a stale-low upstream total while full pages are returned", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }));
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 1 });
    client.listCalls
      .mockResolvedValueOnce({ calls: firstPage, total: 1 })
      .mockResolvedValueOnce({ calls: [{ id: "101" }], total: 1 });
    repositories.getRecordsForRevision.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
    );

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listCalls).toHaveBeenNthCalledWith(2, {
      jobId: "source-b1",
      limit: 100,
      offset: 100,
    });
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 101 }),
      "j1",
      "lease-1",
    );
  });

  it("deduplicates repeated upstream ids and publishes the unique records", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 2 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "dup" }, { id: "dup" }], total: 2 });
    repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "dup", status: "done" }]);

    await expect(processJob(job({ batchIds: ["b1"], total: 2 }))).resolves.toBeUndefined();
    expect(repositories.replaceBatchRecords).toHaveBeenCalledWith(
      "t1",
      "a1",
      "b1",
      [expect.objectContaining({ recordId: "dup" })],
    );
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1 }),
      "j1",
      "lease-1",
    );
  });

  it("rejects upstream rows that have no stable record id", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "" }], total: 1 });

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "1 of 1 records at offset 0 have no record id",
    );
    expect(repositories.replaceBatchRecords).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  it("retains partial-write detection after deduplicating source ids", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }], total: 2 });
    repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "1", status: "done" }]);

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "stored 1 of 2 unique records fetched",
    );
  });

  it("does not publish after another worker replaces the batch lease owner", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.publishBatchIfOwned.mockResolvedValueOnce(false);

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "lease lost during batch publication",
    );
  });
});

describe("runClaimedJob 429", () => {
  it("durably schedules the Retry-After transition", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "60"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    await runClaimedJob(job({ batchIds: ["b1"], retryCount: 2 }));
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({
      status: "rate_limited",
      retryAt: "2026-08-12T12:01:00.000Z",
      retryCount: 3,
      leaseUntil: null,
      leaseId: null,
    }));
    vi.useRealTimers();
  });

  it("surfaces scheduling persistence failure", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "1"));
    repositories.updateClaimedJob.mockResolvedValueOnce(null);
    await expect(runClaimedJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost before rate-limit scheduling");
  });
});

describe("runClaimedJob terminal failures", () => {
  it("marks a partially written batch as errored", async () => {
    client.listCalls.mockRejectedValueOnce(new Error("upstream failed"));
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), ingestStatus: "ingesting" });
    await runClaimedJob(job({ batchIds: ["b1"] }));
    expect(repositories.failBatchIfOwned).toHaveBeenCalledWith("t1", "a1", "b1", "j1", "lease-1");
  });
});
