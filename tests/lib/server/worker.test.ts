import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  beginBatchIngestion: vi.fn(),
  checkpointJob: vi.fn(),
  claimNextJob: vi.fn(),
  countRecords: vi.fn(),
  deleteBatchRevisionRecords: vi.fn(),
  deleteUnpublishedBatchRevision: vi.fn(),
  failBatchIfOwned: vi.fn(),
  getBatch: vi.fn(),
  getRecordsForRevision: vi.fn(),
  publishBatchIfOwned: vi.fn(),
  releaseIngestionLocks: vi.fn(),
  renewIngestionLocks: vi.fn(),
  retireBatchRevision: vi.fn(),
  deleteSupersededRecordRevisions: vi.fn(),
  deleteOrphanedRecordRevisions: vi.fn(),
  SUPERSEDED_REVISION_GRACE_MS: 30 * 60 * 1000,
  replaceBatchRecords: vi.fn(),
  updateClaimedJob: vi.fn(),
}));
const client = vi.hoisted(() => ({ listCalls: vi.fn(), listMessages: vi.fn(), getBulkJob: vi.fn() }));
const logFns = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  log: () => logFns,
}));
vi.mock("@/lib/server/observability/request-context", () => ({ runWithRequestContext: vi.fn() }));

import { logger } from "@/lib/server/logger";
import { MagickApiError } from "@/lib/server/magick-client";
import { processJob, runClaimedJob, SWEEP_DELAY_MARGIN_MS } from "@/lib/server/worker";

// Mirrors the repositories mock above; the real constant is covered by its own test.
const SUPERSEDED_REVISION_GRACE_MS = 30 * 60 * 1000;
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
  repositories.beginBatchIngestion.mockResolvedValue(true);
  repositories.countRecords.mockResolvedValue(0);
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
  repositories.deleteSupersededRecordRevisions.mockResolvedValue(0);
  repositories.deleteOrphanedRecordRevisions.mockResolvedValue(0);
  client.getBulkJob.mockResolvedValue({ id: "source-b1", updated_at: "2026-09-01T09:00:00Z" });
  repositories.replaceBatchRecords.mockResolvedValue(undefined);
});

describe("processJob resume", () => {
  it("resumes at the durable offset and derives progress without double counting", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "101" }], total: 101 });
    repositories.getRecordsForRevision
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
      )
      .mockResolvedValueOnce(
        Array.from({ length: 101 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
      );
    await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 101 }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
    expect(repositories.deleteBatchRevisionRecords).not.toHaveBeenCalled();
    expect(repositories.replaceBatchRecords).toHaveBeenCalledTimes(1);
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(2, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(3, "j1", "lease-1", { done: 101, cursor: 0, batchIndex: 1 });
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done", done: 101 }),
      { clearCredential: true },
    );
  });

  it("keeps the raw pagination cursor separate from unique-record progress", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 3 });
    client.listCalls.mockResolvedValueOnce({
      calls: [{ id: "dup" }, { id: "dup" }, { id: "unique" }],
      total: 3,
    });
    repositories.getRecordsForRevision.mockResolvedValue([
      { recordId: "dup", status: "done" },
      { recordId: "unique", status: "done" },
    ]);

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({
      done: 2,
      cursor: 3,
      batchIndex: 0,
    }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(2, "j1", "lease-1", expect.objectContaining({
      done: 2,
      cursor: 3,
      batchIndex: 0,
    }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(3, "j1", "lease-1", {
      done: 2,
      cursor: 0,
      batchIndex: 1,
    });
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done", done: 2 }),
      { clearCredential: true },
    );
  });

  it("resumes duplicate-heavy pagination from the raw offset with unique progress", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "unique" }], total: 3 });
    repositories.getRecordsForRevision
      .mockResolvedValueOnce([{ recordId: "dup", status: "done" }])
      .mockResolvedValueOnce([
        { recordId: "dup", status: "done" },
        { recordId: "unique", status: "done" },
      ]);

    await processJob(job({ done: 1, cursor: 2, batchIndex: 0, batchIds: ["b1"], total: 3 }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 2 });
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({
      done: 2,
      cursor: 3,
    }));
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done", done: 2 }),
      { clearCredential: true },
    );
  });

  it("starts the next batch from zero after a durable batch transition", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.countRecords.mockResolvedValueOnce(100);
    await processJob(job({ done: 100, cursor: 0, batchIndex: 1 }));
    expect(repositories.countRecords).toHaveBeenCalledWith("t1", "a1", ["b1"]);
    expect(repositories.getBatch).toHaveBeenCalledTimes(1);
    expect(repositories.getBatch).toHaveBeenCalledWith("t1", "a1", "b2");
    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b2", limit: 100, offset: 0 });
    expect(repositories.deleteBatchRevisionRecords).toHaveBeenCalledWith("t1", "a1", "b2", "j1");
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ done: 101 }),
      { clearCredential: true },
    );
  });

  it("stops if ownership is lost while checkpointing", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.checkpointJob.mockResolvedValueOnce(null);
    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost while checkpointing");
    expect(repositories.updateClaimedJob).toHaveBeenCalledTimes(1);
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      { leaseUntil: expect.any(String) },
    );
  });

  // Upstream totals are progress hints, not pagination boundaries: a dispatched
  // contact with no call row yet makes them run ahead of the rows they count.
  // A short pull still publishes, with the paginated count as the total.
  it("treats paginated rows as authoritative when an upstream total is stale-high", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 100 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }], total: 100 });
    repositories.getRecordsForRevision.mockResolvedValue([
      { recordId: "1", status: "done" },
      { recordId: "2", status: "done" },
    ]);

    await expect(processJob(job({ batchIds: ["b1"], total: 100 }))).resolves.toBeUndefined();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2 }),
      "j1",
      "lease-1",
    );
  });

  // The IVR/static-call failure: upstream reports thousands of dispatched
  // contacts and returns no rows at all. Publishing that put a green "Up to
  // date" over an empty Analytics screen, so it is now a job failure — which
  // leaves the batch "error" and the reason on the job.
  it("fails the batch when upstream returns no records for a job it reports as dispatched", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", status: "completed", updated_at: "2026-09-18T10:00:00Z" });
    client.listCalls.mockResolvedValueOnce({ calls: [], total: 3475 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).rejects.toThrow(
      /no records returned for b1.*3475 dispatched contacts/,
    );
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  // A batch poisoned by an empty publish before this guard existed has `total`
  // already collapsed to 0, and upstream may report 0 on the calls listing too
  // — `sourceTotal` is the only figure left that proves records are missing, so
  // the guard has to read it or those batches stay silently empty forever.
  it("catches a batch whose total already collapsed to zero, via sourceTotal", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 0, sourceTotal: 3475 });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", status: "completed", updated_at: "2026-09-18T10:00:00Z" });
    client.listCalls.mockResolvedValueOnce({ calls: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 0 }))).rejects.toThrow(
      /3475 dispatched contacts/,
    );
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  // A campaign the customer has only just launched has dispatched contacts and
  // no calls yet. That is not the read-path gap above, and reporting "Sync
  // failed" on it would be a fresh bug of its own.
  it("publishes an empty batch while upstream is still dialling", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", status: "processing", updated_at: "2026-09-18T10:00:00Z" });
    client.listCalls.mockResolvedValueOnce({ calls: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).resolves.toBeUndefined();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalled();
  });

  // The other direction: a campaign that genuinely dispatched nothing must
  // still publish, or an empty batch becomes a permanent error nobody can clear.
  it("publishes an empty batch when upstream reports nothing dispatched either", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 0, sourceTotal: 0 });
    client.listCalls.mockResolvedValueOnce({ calls: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 0 }))).resolves.toBeUndefined();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0 }),
      "j1",
      "lease-1",
    );
  });

  // `total` is the exact ingested count once committed; the dispatched figure
  // has to ride through publication on its own field or the next listing loses
  // it again on the commit after that.
  it("carries the dispatched count through publication", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 10, sourceTotal: 10 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 10 });

    await processJob(job({ batchIds: ["b1"], total: 10 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1, sourceTotal: 10 }),
      "j1",
      "lease-1",
    );
  });

  // Every ingestion stages a full new copy of a batch's records. Leaving the
  // superseded copies for a daily cron meant each "Refresh data" click added a
  // duplicate dataset that lingered for days, until storage ran out.
  it("reclaims revisions superseded by earlier runs once the new one is published", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(repositories.retireBatchRevision).toHaveBeenCalledBefore(
      repositories.deleteSupersededRecordRevisions,
    );
    expect(repositories.deleteSupersededRecordRevisions).toHaveBeenCalledWith("t1", "a1", "b1", "j1");
  });

  it("clears crash orphans before staging, sparing the published and staging revisions", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), publishedRevision: "rev-live" });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(repositories.deleteOrphanedRecordRevisions).toHaveBeenCalledWith(
      "t1", "a1", "b1", ["rev-live", "j1"],
    );
    // Must run before any row of the new revision is written, so a resumed job
    // never has its own staged work swept.
    expect(repositories.deleteOrphanedRecordRevisions).toHaveBeenCalledBefore(
      repositories.replaceBatchRecords,
    );
  });

  // The sweep above spares anything inside the reader grace window, so it can
  // never reclaim the revision this very job just retired. Without a second,
  // deferred pass that duplicate survives until the daily cron — which is the
  // storage growth the whole change exists to stop.
  it("comes back for the revision it just superseded, once the grace has passed", async () => {
    vi.useFakeTimers();
    try {
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
      await processJob(job({ batchIds: ["b1"], total: 1 }));
      expect(repositories.deleteSupersededRecordRevisions).toHaveBeenCalledTimes(1);

      // At fire time the batch's CURRENT published revision is what must be
      // spared — another refresh may have published a newer one since.
      repositories.getBatch.mockResolvedValue({ ...batch("b1"), publishedRevision: "j2" });
      await vi.advanceTimersByTimeAsync(SUPERSEDED_REVISION_GRACE_MS + SWEEP_DELAY_MARGIN_MS);

      expect(repositories.deleteSupersededRecordRevisions).toHaveBeenCalledTimes(2);
      expect(repositories.deleteSupersededRecordRevisions).toHaveBeenLastCalledWith("t1", "a1", "b1", "j2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail the job when the deferred sweep throws", async () => {
    vi.useFakeTimers();
    try {
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
      await processJob(job({ batchIds: ["b1"], total: 1 }));
      repositories.deleteSupersededRecordRevisions.mockRejectedValue(new Error("mongo down"));
      await vi.advanceTimersByTimeAsync(SUPERSEDED_REVISION_GRACE_MS + SWEEP_DELAY_MARGIN_MS);
      // Swallowed and logged, never an unhandled rejection that takes the
      // long-running worker process down hours after the job finished.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: "b1" }),
        expect.stringContaining("deferred revision sweep failed"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // The stamp a refresh compares against must predate the pull: anything
  // upstream writes while we page has to leave it behind, so the next refresh
  // re-pulls rather than concluding nothing changed.
  it("stamps the source timestamp read before paging began", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), sourceFingerprint: "src-fp" });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", updated_at: "2026-09-01T10:00:00Z" });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.getBulkJob).toHaveBeenCalledWith("source-b1");
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestedSourceFingerprint: "src-fp",
        ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
      }),
      "j1",
      "lease-1",
    );
  });

  it("does not stamp a resumed pull, whose stamp would postdate its own pause", async () => {
    repositories.getRecordsForRevision
      .mockResolvedValueOnce([{ recordId: "1", status: "done" }])
      .mockResolvedValue([{ recordId: "1", status: "done" }, { recordId: "2", status: "done" }]);
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "2" }], total: 2 });

    await processJob(job({ batchIds: ["b1"], total: 2, done: 1, cursor: 1, batchIndex: 0 }));

    // A rate-limited job can pause for longer than the changes it would be
    // claiming to have captured.
    expect(client.getBulkJob).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedSourceUpdatedAt: null }),
      "j1",
      "lease-1",
    );
  });

  it("publishes without a stamp when the source job cannot be read", async () => {
    client.getBulkJob.mockRejectedValue(new Error("upstream down"));
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    // No stamp means no skip: the next refresh re-pulls rather than guessing.
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedSourceUpdatedAt: null }),
      "j1",
      "lease-1",
    );
  });

  it("still completes when the superseded-revision sweep fails", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.deleteSupersededRecordRevisions.mockRejectedValue(new Error("mongo down"));

    await expect(processJob(job({ batchIds: ["b1"], total: 1 }))).resolves.toBeUndefined();
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done" }),
      { clearCredential: true },
    );
  });

  it("stamps the source fingerprint the published revision was built from", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), sourceFingerprint: "src-fp" });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    // Without this stamp a refresh cannot tell an unchanged source from a moved
    // one, and re-pulls an identical dataset on every click.
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedSourceFingerprint: "src-fp" }),
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

  it("stops before fetching when a newer worker owns the batch", async () => {
    repositories.beginBatchIngestion.mockResolvedValueOnce(false);
    repositories.getBatch
      .mockResolvedValueOnce(batch("b1"))
      .mockResolvedValueOnce({
        ...batch("b1"),
        ingestJobId: "newer-job",
        ingestLeaseId: "newer-lease",
        ingestLeaseUntil: "2099-01-01T00:00:00.000Z",
      });

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "newer worker owns batch ingestion",
    );
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(repositories.getBatch).toHaveBeenCalledTimes(2);
    expect(logFns.warn).toHaveBeenCalledWith(
      {
        batchId: "b1",
        ingestJobId: "newer-job",
        ingestLeaseId: "newer-lease",
        ingestLeaseUntil: "2099-01-01T00:00:00.000Z",
      },
      "[worker] batch ingestion ownership lost",
    );
  });

  it("logs the snapshot ownership when a re-read after denial fails", async () => {
    repositories.beginBatchIngestion.mockResolvedValueOnce(false);
    repositories.getBatch
      .mockResolvedValueOnce({
        ...batch("b1"),
        ingestJobId: "old-job",
        ingestLeaseId: "old-lease",
        ingestLeaseUntil: "2026-08-12T12:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("mongo down"));

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "newer worker owns batch ingestion",
    );
    expect(logFns.warn).toHaveBeenCalledWith(
      {
        batchId: "b1",
        ingestJobId: "old-job",
        ingestLeaseId: "old-lease",
        ingestLeaseUntil: "2026-08-12T12:00:00.000Z",
      },
      "[worker] batch ingestion ownership lost",
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
    repositories.updateClaimedJob.mockResolvedValueOnce(job()).mockResolvedValueOnce(null);
    await expect(runClaimedJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost before rate-limit scheduling");
  });

  it("names the deferral reason so the screen can say which kind of pause this is", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "60"));

    await runClaimedJob(job({ batchIds: ["b1"] }));

    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "rate_limited", deferReason: "rate_limited" }),
    );
  });

  it("KEEPS the job's credential when it is only deferred", async () => {
    // A deferred job resumes and pages the rest of the campaign with this same
    // credential. Clearing it here would strand every paused job.
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "60"));

    await runClaimedJob(job({ batchIds: ["b1"], refreshToken: "refresh-1" }));

    const deferral = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "rate_limited",
    );
    expect(deferral).toBeDefined();
    expect(deferral?.[3]).toBeUndefined();
  });
});

describe("runClaimedJob credential lifetime", () => {
  it("drops the credential in the same write that completes the job", async () => {
    // A refresh token does not expire. A thirty-second merge would otherwise
    // leave one at rest in Mongo until the retention sweep — an external cron
    // that fails silently and is sized by DATA_RETENTION_DAYS, which an operator
    // may raise for reasons that have nothing to do with credentials.
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await runClaimedJob(job({ batchIds: ["b1"], total: 1, refreshToken: "refresh-1" }));

    const completion = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "done",
    );
    expect(completion?.[3]).toEqual({ clearCredential: true });
  });

  it("drops the credential when the job fails for good, too", async () => {
    client.listCalls.mockRejectedValueOnce(new Error("upstream failed"));

    await runClaimedJob(job({ batchIds: ["b1"], refreshToken: "refresh-1" }));

    const failure = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "error",
    );
    expect(failure?.[3]).toEqual({ clearCredential: true });
  });
});

describe("runClaimedJob terminal failures", () => {
  it("marks a partially written batch as errored", async () => {
    client.listCalls.mockRejectedValueOnce(new Error("upstream failed"));
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), ingestStatus: "ingesting" });
    repositories.beginBatchIngestion.mockResolvedValue(true);
    repositories.updateClaimedJob.mockResolvedValue(job());
    await runClaimedJob(job({ batchIds: ["b1"] }));
    expect(repositories.failBatchIfOwned).toHaveBeenCalledWith("t1", "a1", "b1", "j1", "lease-1");
  });
});
