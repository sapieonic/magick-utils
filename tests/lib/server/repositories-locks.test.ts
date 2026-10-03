import { beforeEach, describe, expect, it, vi } from "vitest";

const locks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  deleteOne: vi.fn(),
  find: vi.fn(),
  insertMany: vi.fn(),
  updateMany: vi.fn(),
}));
const usage = vi.hoisted(() => ({ findOneAndUpdate: vi.fn() }));
const jobs = vi.hoisted(() => ({ findOne: vi.fn() }));
const batchDb = vi.hoisted(() => ({ deleteMany: vi.fn(), find: vi.fn(), findOne: vi.fn(), findOneAndUpdate: vi.fn(), updateOne: vi.fn() }));
const recordDb = vi.hoisted(() => ({ bulkWrite: vi.fn(), deleteMany: vi.fn(), find: vi.fn(), updateMany: vi.fn() }));

vi.mock("@/lib/server/db", () => ({
  aggregates: vi.fn(),
  aiUsage: vi.fn(async () => usage),
  batches: vi.fn(async () => batchDb),
  ingestionLocks: vi.fn(async () => locks),
  insights: vi.fn(),
  jobs: vi.fn(async () => jobs),
  records: vi.fn(async () => recordDb),
}));

import {
  acquireIngestionLocks,
  beginBatchIngestion,
  consumeAiQuota,
  deleteBatchDataOlderThan,
  deleteCarriedRecords,
  getRevisionRecordsMissingFrom,
  replaceBatchRecords,
  deleteRetiredRecordRevisionsOlderThan,
  deleteOrphanedRecordRevisions,
  deleteOrphanedRecordRevisionsEverywhere,
  deleteSupersededRecordRevisions,
  failBatchIfOwned,
  keepPublishedRevisionIfOwned,
  retireBatchRevision,
  SUPERSEDED_REVISION_GRACE_MS,
  IngestionConflictError,
  refreshBatchFromSource,
} from "@/lib/server/repositories";

describe("source batch refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates only the exact source snapshot that was read", async () => {
    const refreshed = { tenantId: "t1", accountId: "a1", batchId: "b1", updatedAt: "new" };
    batchDb.findOneAndUpdate.mockResolvedValue(refreshed);

    await expect(refreshBatchFromSource(refreshed as never, "old")).resolves.toBe(refreshed);

    expect(batchDb.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: "t1", accountId: "a1", batchId: "b1", updatedAt: "old" },
      { $set: refreshed },
      { returnDocument: "after" },
    );
  });

  it("does not write worker ownership fields during a source-metadata refresh", async () => {
    const refreshed = {
      tenantId: "t1",
      accountId: "a1",
      batchId: "b1",
      updatedAt: "new",
      ingestJobId: "stale-job",
      ingestLeaseId: "stale-lease",
      ingestLeaseUntil: "stale-until",
    };
    batchDb.findOneAndUpdate.mockResolvedValue({ tenantId: "t1", accountId: "a1", batchId: "b1", updatedAt: "new" });

    await refreshBatchFromSource(refreshed as never, "old");

    const set = batchDb.findOneAndUpdate.mock.calls[0][1].$set;
    expect(set).toEqual({ tenantId: "t1", accountId: "a1", batchId: "b1", updatedAt: "new" });
    expect(set).not.toHaveProperty("ingestJobId");
    expect(set).not.toHaveProperty("ingestLeaseId");
    expect(set).not.toHaveProperty("ingestLeaseUntil");
  });

  it("returns a concurrently published batch instead of overwriting it", async () => {
    const stale = { tenantId: "t1", accountId: "a1", batchId: "b1", updatedAt: "stale" };
    const published = { ...stale, updatedAt: "published", publishedRevision: "r2" };
    batchDb.findOneAndUpdate.mockResolvedValue(null);
    batchDb.findOne.mockResolvedValue(published);

    await expect(refreshBatchFromSource(stale as never, "old")).resolves.toBe(published);

    expect(batchDb.findOneAndUpdate).toHaveBeenCalledOnce();
    expect(batchDb.findOne).toHaveBeenCalledWith({ tenantId: "t1", accountId: "a1", batchId: "b1" });
  });
});

describe("batch worker ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("orders competing workers by their lease deadline", async () => {
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });
    const doc = {
      tenantId: "t1", accountId: "a1", batchId: "b1", ingestStatus: "none",
      updatedAt: "old",
    };

    await expect(beginBatchIngestion(doc as never, "j1", "lease-new", "2026-08-12T12:02:00Z"))
      .resolves.toBe(true);

    expect(batchDb.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        accountId: "a1",
        batchId: "b1",
        $or: expect.arrayContaining([
          { ingestJobId: { $exists: false } },
          { ingestJobId: { $type: "null" } },
          { ingestLeaseUntil: { $exists: false } },
          { ingestLeaseUntil: { $type: "null" } },
          { ingestLeaseUntil: { $lt: "2026-08-12T12:02:00Z" } },
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          ingestJobId: "j1",
          ingestLeaseId: "lease-new",
          ingestLeaseUntil: "2026-08-12T12:02:00Z",
        }),
      }),
    );
  });

  it("does not copy a stale lease from the batch snapshot onto the ownership write", async () => {
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });
    const doc = {
      tenantId: "t1",
      accountId: "a1",
      batchId: "b1",
      ingestJobId: "old-job",
      ingestLeaseId: "old-lease",
      ingestLeaseUntil: "2026-08-12T11:00:00Z",
    };

    await beginBatchIngestion(doc as never, "j1", "lease-new", "2026-08-12T12:02:00Z");

    const set = batchDb.updateOne.mock.calls[0][1].$set;
    expect(set.ingestJobId).toBe("j1");
    expect(set.ingestLeaseId).toBe("lease-new");
    expect(set.ingestLeaseUntil).toBe("2026-08-12T12:02:00Z");
  });

  it("rejects a stale worker when its ownership update no longer matches", async () => {
    batchDb.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(beginBatchIngestion({ tenantId: "t1", accountId: "a1", batchId: "b1" } as never, "j1", "old", "2026-08-12T12:01:00Z"))
      .resolves.toBe(false);
  });

  // A batch behind its source still has a complete published revision, so a
  // refresh must not make it unreadable while it runs.
  it("keeps a stale batch readable for the duration of a refresh", async () => {
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });
    const doc = { tenantId: "t1", accountId: "a1", batchId: "b1", ingestStatus: "stale" };

    await beginBatchIngestion(doc as never, "j1", "lease-new", "2026-08-12T12:02:00Z");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("stale");
  });

  it("marks a first-time batch as ingesting, since it has nothing to serve yet", async () => {
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });
    const doc = { tenantId: "t1", accountId: "a1", batchId: "b1", ingestStatus: "none" };

    await beginBatchIngestion(doc as never, "j1", "lease-new", "2026-08-12T12:02:00Z");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("ingesting");
  });

  it("resolves a failed refresh back to stale when the source has moved on", async () => {
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1",
      publishedRevision: "rev-1", sourceFingerprint: "fp-new", ingestedSourceFingerprint: "fp-old",
    });
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

    await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

    // "ready" here would hide the pending work and skip the next refresh.
    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("stale");
  });

  it("resolves a failed refresh to ready when the source never moved", async () => {
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1",
      publishedRevision: "rev-1", sourceFingerprint: "fp", ingestedSourceFingerprint: "fp",
    });
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

    await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("ready");
  });

  it("marks a batch with no published revision as errored", async () => {
    batchDb.findOne.mockResolvedValue({ tenantId: "t1", accountId: "a1", batchId: "b1" });
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

    await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("error");
  });

  it("errors a batch whose published revision is the empty pull, rather than restoring it", async () => {
    // The poisoned document a pre-fix build committed: a published revision
    // holding no records for a job upstream says dispatched 3,475 contacts, and
    // an unchanged source — which is exactly what the "ready" branch above keys
    // off. Restoring it hands the customer the same blank Analytics screen
    // under a green label, and since nothing about the batch changes, every
    // retry restores it again and the worker's error can never stick.
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1",
      publishedRevision: "rev-1", sourceFingerprint: "fp", ingestedSourceFingerprint: "fp",
      total: 0, sourceTotal: 3475,
    });
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

    await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("error");
  });

  // A refresh the worker refused because the pull came back short: the
  // revision behind it may be one an older build published short. It stays
  // readable — "error" would take real records offline — but not "ready", or the
  // next refresh proves the terminal job unchanged and never retries it.
  it("resolves a failed refresh over a possibly-short published revision to stale, not ready", async () => {
    for (const shortDoc of [
      { total: 8038, sourceTotal: 8232 }, // pre-stamp revision: judged by the contact count
      { total: 470, sourceTotal: 470, ingestedListedTotal: 480 }, // stamped short
    ]) {
      batchDb.updateOne.mockClear();
      batchDb.findOne.mockResolvedValue({
        tenantId: "t1", accountId: "a1", batchId: "b1",
        publishedRevision: "rev-1", sourceFingerprint: "fp", ingestedSourceFingerprint: "fp",
        ...shortDoc,
      });
      batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

      await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

      expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("stale");
    }
  });

  // A failure after a pull that left a shortfall on record: the kept revision
  // may hold every record, but it is behind, and "ready" would let the next
  // refresh prove it unchanged and never retry it.
  it("resolves a failure over a batch with a recorded shortfall to stale", async () => {
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1",
      publishedRevision: "rev-1", sourceFingerprint: "fp", ingestedSourceFingerprint: "fp",
      total: 8232, sourceTotal: 8232, ingestedListedTotal: 8232,
      shortPull: { listed: 8232, received: 8038, carried: 1, keptPrevious: true, settled: true, detectedAt: "x" },
    });
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

    await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("stale");
  });

  it("keeps the published revision after a short pull only while this lease owns the batch", async () => {
    const shortPull = { listed: 3, received: 2, carried: 1, keptPrevious: true, settled: true, detectedAt: "2026-10-01T00:00:00Z" };
    batchDb.updateOne.mockResolvedValueOnce({ matchedCount: 1 }).mockResolvedValueOnce({ matchedCount: 0 });

    await expect(keepPublishedRevisionIfOwned("t1", "a1", "b1", "j1", "lease-1", shortPull)).resolves.toBe(true);
    await expect(keepPublishedRevisionIfOwned("t1", "a1", "b1", "j1", "lease-1", shortPull)).resolves.toBe(false);

    const [filter, update] = batchDb.updateOne.mock.calls[0];
    expect(filter).toEqual({ tenantId: "t1", accountId: "a1", batchId: "b1", ingestJobId: "j1", ingestLeaseId: "lease-1" });
    // Readable, flagged, released — and nothing about the revision itself moves.
    expect(update.$set).toEqual(expect.objectContaining({ ingestStatus: "stale", shortPull }));
    expect(update.$set).not.toHaveProperty("publishedRevision");
    expect(update.$set).not.toHaveProperty("total");
    expect(update.$unset).toEqual({ ingestJobId: "", ingestLeaseId: "", ingestLeaseUntil: "" });
  });

  // An identical short re-pull passes the stamps a publish would have written;
  // an undefined stamp leaves the published value alone, an explicit null is
  // written (a resumed pull cannot vouch for its source timestamp).
  it("writes only the defined built-from stamps when keeping a revision", async () => {
    const shortPull = { listed: 3, received: 2, carried: 0, keptPrevious: false, settled: true, detectedAt: "2026-10-01T00:00:00Z" };
    batchDb.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

    await keepPublishedRevisionIfOwned("t1", "a1", "b1", "j1", "lease-1", shortPull, {
      ingestedListedTotal: 3,
      ingestedSourceFingerprint: "sfp",
      ingestedRecordsStamp: null,
      sourceTotal: undefined,
    });

    const [, update] = batchDb.updateOne.mock.calls[0];
    expect(update.$set).toEqual(
      expect.objectContaining({
        ingestStatus: "stale",
        shortPull,
        ingestedListedTotal: 3,
        ingestedSourceFingerprint: "sfp",
        ingestedRecordsStamp: null,
      }),
    );
    expect(update.$set).not.toHaveProperty("sourceTotal");
    expect(update.$set).not.toHaveProperty("publishedRevision");
  });

  it("restores ready over a stamped-complete revision even when contacts exceed rows", async () => {
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1",
      publishedRevision: "rev-1", sourceFingerprint: "fp", ingestedSourceFingerprint: "fp",
      total: 359, sourceTotal: 369, ingestedListedTotal: 359,
    });
    batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

    await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

    expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("ready");
  });

  it("still restores a genuinely empty campaign's published revision", async () => {
    // Zero records and zero dispatched contacts is a real, complete batch. An
    // absent `sourceTotal` (every document written before the field existed)
    // must read the same way: no dispatched count is no claim, not a claim of
    // nothing. Erroring these would take a fleet of healthy batches offline.
    for (const sourceTotal of [0, undefined]) {
      batchDb.updateOne.mockClear();
      batchDb.findOne.mockResolvedValue({
        tenantId: "t1", accountId: "a1", batchId: "b1",
        publishedRevision: "rev-1", sourceFingerprint: "fp", ingestedSourceFingerprint: "fp",
        total: 0, sourceTotal,
      });
      batchDb.updateOne.mockResolvedValue({ matchedCount: 1 });

      await failBatchIfOwned("t1", "a1", "b1", "j1", "lease-1");

      expect(batchDb.updateOne.mock.calls[0][1].$set.ingestStatus).toBe("ready");
    }
  });
});

describe("superseded revision reclamation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes this batch's retired revisions past the grace window, keeping the published one", async () => {
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 6204 });
    const before = Date.now();

    await expect(deleteSupersededRecordRevisions("t1", "a1", "b1", "rev-new")).resolves.toBe(6204);

    const filter = recordDb.deleteMany.mock.calls[0][0];
    expect(filter).toMatchObject({
      tenantId: "t1",
      accountId: "a1",
      batchId: "b1",
      revision: { $exists: true, $ne: "rev-new" },
    });
    // Only explicitly retired rows are eligible — a concurrent job's staging
    // revision carries no retiredAt and must never be swept mid-ingestion.
    // The cutoff is computed inside the call, so it trails `before` by exactly
    // one grace window plus however long the call took.
    const cutoff = (filter.retiredAt as { $lt: Date }).$lt.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - SUPERSEDED_REVISION_GRACE_MS);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - SUPERSEDED_REVISION_GRACE_MS);
  });
});

describe("ingestion admission locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locks.deleteMany.mockResolvedValue({});
    locks.deleteOne.mockResolvedValue({});
    locks.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    locks.insertMany.mockResolvedValue({});
    jobs.findOne.mockResolvedValue({ status: "running" });
  });

  it("acquires one batch-scoped lock per selected batch", async () => {
    await acquireIngestionLocks("t1", "a1", ["b1", "b2"], "j1", 60_000);
    expect(locks.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: "t1", accountId: "a1", batchId: "b1", jobId: "j1" }),
        expect.objectContaining({ tenantId: "t1", accountId: "a1", batchId: "b2", jobId: "j1" }),
      ]),
      { ordered: false },
    );
  });

  it("rolls back a partial insert when the unique batch lock conflicts", async () => {
    locks.insertMany.mockRejectedValue(Object.assign(new Error("duplicate key"), { code: 11000 }));
    await expect(acquireIngestionLocks("t1", "a1", ["b1", "b2"], "j2"))
      .rejects.toBeInstanceOf(IngestionConflictError);
    expect(locks.deleteMany).toHaveBeenLastCalledWith({ tenantId: "t1", accountId: "a1", jobId: "j2" });
  });

  it("preserves an unexpired ownerless lock during the lock-to-job insert window", async () => {
    locks.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([
      { tenantId: "t1", accountId: "a1", batchId: "b1", jobId: "gone", expiresAt: new Date(Date.now() + 60_000) },
    ]) });
    jobs.findOne.mockResolvedValue(null);

    await acquireIngestionLocks("t1", "a1", ["b1"], "j3");

    expect(locks.deleteOne).not.toHaveBeenCalled();
    expect(locks.insertMany).toHaveBeenCalled();
  });
});

describe("AI generation quota", () => {
  it("accepts counts through the limit and rejects later calls", async () => {
    usage.findOneAndUpdate.mockResolvedValueOnce({ count: 20 }).mockResolvedValueOnce({ count: 21 });
    await expect(consumeAiQuota("t1", "a1", "insight", 20)).resolves.toBe(true);
    await expect(consumeAiQuota("t1", "a1", "insight", 20)).resolves.toBe(false);
  });
});

describe("retired revision cleanup", () => {
  beforeEach(() => vi.clearAllMocks());

  // The marker alone is the filter. `retireBatchRevision` is the only writer and
  // refuses to mark the published revision, and revision ids are job ids that
  // are never reused — so a marked row can never become readable again. The
  // previous per-batch exclusion list was unbounded across every tenant and
  // blew past MongoDB's 16MB command limit on a large database, at which point
  // cleanup failed outright and reclaimed nothing.
  it("deletes every revision retired before the grace cutoff, in one bounded query", async () => {
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 5 });
    await expect(deleteRetiredRecordRevisionsOlderThan(new Date("2026-08-11T00:00:00Z"))).resolves.toBe(5);
    expect(recordDb.deleteMany).toHaveBeenCalledWith({
      retiredAt: { $lt: new Date("2026-08-11T00:00:00Z") },
    });
    // No scan of the batches collection — that is what made this unbounded.
    expect(batchDb.find).not.toHaveBeenCalled();
  });

  // A crash between publishing a revision and retiring the previous one, or a
  // SIGKILL mid-staging, leaves rows whose batch document no longer points at
  // them. The old exclusion-list query could not reach those at all.
  it("reaches orphans left by a crash, which have no surviving batch document", async () => {
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 2 });
    await deleteRetiredRecordRevisionsOlderThan(new Date("2026-08-11T00:00:00Z"));
    const filter = recordDb.deleteMany.mock.calls[0][0];
    expect(Object.keys(filter)).toEqual(["retiredAt"]);
  });
});

describe("orphaned revision reclamation", () => {
  beforeEach(() => vi.clearAllMocks());

  // A crash between publishing a revision and retiring the previous one, or a
  // SIGKILL mid-staging, leaves rows that never receive a retiredAt marker and
  // are therefore invisible to the ordinary sweep.
  it("reclaims a batch's unreferenced revisions, sparing every live one", async () => {
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 3 });

    await expect(
      deleteOrphanedRecordRevisions("t1", "a1", "b1", ["rev-published", "rev-staging"]),
    ).resolves.toBe(3);

    const filter = recordDb.deleteMany.mock.calls[0][0];
    expect(filter).toMatchObject({
      tenantId: "t1",
      accountId: "a1",
      batchId: "b1",
      revision: { $exists: true, $nin: ["rev-published", "rev-staging"] },
    });
    // Age-bounded, so a revision created moments ago is never a candidate — a
    // rate-limited job keeps its staging revision across a long pause.
    expect((filter.revisionCreatedAt as { $lt: Date }).$lt.getTime()).toBeLessThanOrEqual(
      Date.now() - SUPERSEDED_REVISION_GRACE_MS,
    );
  });

  it("drops undefined from the keep list rather than matching on it", async () => {
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 0 });
    await deleteOrphanedRecordRevisions("t1", "a1", "b1", [undefined, "rev-staging"]);
    expect(recordDb.deleteMany.mock.calls[0][0]).toMatchObject({
      revision: { $exists: true, $nin: ["rev-staging"] },
    });
  });
});

/** A cursor over `docs` shaped like the projected batch cursor the sweep uses. */
function batchCursor(docs: unknown[]) {
  return {
    project: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const doc of docs) yield doc;
      },
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe("cron-wide orphaned revision reclamation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes the sweep per batch and spares both live revisions of each", async () => {
    batchDb.find.mockReturnValue(
      batchCursor([
        { tenantId: "t1", accountId: "a1", batchId: "b1", publishedRevision: "rev-1" },
        // Mid-ingestion: its staging revision IS the job id, and a rate-limited
        // job can hold it open for longer than the grace window.
        { tenantId: "t1", accountId: "a2", batchId: "b2", publishedRevision: "rev-2", ingestJobId: "job-9" },
      ]),
    );
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 4 });

    await expect(deleteOrphanedRecordRevisionsEverywhere()).resolves.toBe(4);

    const filter = recordDb.deleteMany.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { tenantId: "t1", accountId: "a1", batchId: "b1", revision: { $nin: ["rev-1"] } },
      { tenantId: "t1", accountId: "a2", batchId: "b2", revision: { $nin: ["rev-2", "job-9"] } },
    ]);
    // Legacy rows predate revisions entirely and must never be swept.
    expect(filter.revision).toEqual({ $exists: true });
    expect((filter.revisionCreatedAt as { $lt: Date }).$lt.getTime()).toBeLessThanOrEqual(
      Date.now() - SUPERSEDED_REVISION_GRACE_MS,
    );
  });

  // The unbounded exclusion list is what broke the previous cleanup: past
  // roughly a hundred thousand batches the query document itself exceeded
  // MongoDB's 16MB command limit and the whole run reclaimed nothing.
  it("chunks the sweep so the query never grows with the database", async () => {
    const docs = Array.from({ length: 1_100 }, (_, i) => ({
      tenantId: "t1", accountId: "a1", batchId: `b${i}`, publishedRevision: `rev-${i}`,
    }));
    batchDb.find.mockReturnValue(batchCursor(docs));
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 1 });

    await expect(deleteOrphanedRecordRevisionsEverywhere()).resolves.toBe(3);

    expect(recordDb.deleteMany).toHaveBeenCalledTimes(3);
    const sizes = recordDb.deleteMany.mock.calls.map((c) => (c[0].$or as unknown[]).length);
    expect(sizes).toEqual([500, 500, 100]);
  });

  it("issues no delete at all when there are no batches", async () => {
    batchDb.find.mockReturnValue(batchCursor([]));
    await expect(deleteOrphanedRecordRevisionsEverywhere()).resolves.toBe(0);
    expect(recordDb.deleteMany).not.toHaveBeenCalled();
  });
});

describe("revision retirement invariant", () => {
  beforeEach(() => vi.clearAllMocks());

  // Cleanup safety rests entirely on this: nothing may mark the revision that
  // readers are currently being served.
  it("refuses to retire the revision a batch currently publishes", async () => {
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1", publishedRevision: "rev-current",
    });

    await retireBatchRevision("t1", "a1", "b1", "rev-current");

    expect(recordDb.updateMany).not.toHaveBeenCalled();
  });

  it("marks a superseded revision", async () => {
    batchDb.findOne.mockResolvedValue({
      tenantId: "t1", accountId: "a1", batchId: "b1", publishedRevision: "rev-new",
    });
    recordDb.updateMany.mockResolvedValue({});

    await retireBatchRevision("t1", "a1", "b1", "rev-old");

    expect(recordDb.updateMany).toHaveBeenCalledWith(
      { tenantId: "t1", accountId: "a1", batchId: "b1", revision: "rev-old" },
      { $set: { retiredAt: expect.any(Date) } },
    );
  });
});

describe("expired batch cleanup", () => {
  it("deletes expired batch metadata and all records owned by those batches", async () => {
    batchDb.find.mockReturnValue({
      project: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { tenantId: "t1", accountId: "a1", batchId: "b1" },
          { tenantId: "t2", accountId: "a2", batchId: "b2" },
        ]),
      }),
    });
    batchDb.deleteMany.mockResolvedValue({ deletedCount: 2 });
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 500 });

    await expect(deleteBatchDataOlderThan("2026-08-12T00:00:00.000Z")).resolves.toEqual({
      batches: 2,
      records: 500,
    });
    expect(batchDb.deleteMany).toHaveBeenCalledWith({ date: { $lt: "2026-08-12T00:00:00.000Z" } });
    expect(recordDb.deleteMany).toHaveBeenCalledWith({
      $or: [
        { tenantId: "t1", accountId: "a1", batchId: "b1" },
        { tenantId: "t2", accountId: "a2", batchId: "b2" },
      ],
    });
  });
});

// The carry-forward of an incomplete pull (see `ingestBatch`): the rows a pull
// did not return are copied from the published revision into the new one.
describe("carried-forward records", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the published rows a pull did not return, ready to write into another revision", async () => {
    recordDb.find.mockReturnValue([
      { _id: "oid-1", recordId: "1", revision: "rev-1", status: "done" },
      { _id: "oid-3", recordId: "3", revision: "rev-1", status: "done", retiredAt: new Date(0) },
    ]);

    const missing = await getRevisionRecordsMissingFrom("t1", "a1", "b1", "rev-1", new Set(["1", "2"]));

    expect(recordDb.find).toHaveBeenCalledWith({ tenantId: "t1", accountId: "a1", batchId: "b1", revision: "rev-1" });
    // `_id` would collide with the stored copy; `retiredAt` describes it only.
    expect(missing).toEqual([{ recordId: "3", revision: "rev-1", status: "done" }]);
  });

  it("drops carried rows from a staging revision only", async () => {
    batchDb.findOne.mockResolvedValueOnce({ publishedRevision: "rev-1" });
    await deleteCarriedRecords("t1", "a1", "b1", "j1");
    expect(recordDb.deleteMany).toHaveBeenCalledWith({
      tenantId: "t1", accountId: "a1", batchId: "b1", revision: "j1", carriedFrom: { $exists: true },
    });

    // The published revision's carried rows are what readers see.
    recordDb.deleteMany.mockClear();
    batchDb.findOne.mockResolvedValueOnce({ publishedRevision: "j1" });
    await deleteCarriedRecords("t1", "a1", "b1", "j1");
    expect(recordDb.deleteMany).not.toHaveBeenCalled();
  });

  // A row the pull returned replaces a carried copy of the same id staged
  // earlier in the revision; `$set` alone would leave the marker behind and
  // the row would keep counting as carried.
  it("clears the carried marker when a pulled row overwrites a carried one, and only then", async () => {
    recordDb.bulkWrite.mockResolvedValue({});
    await replaceBatchRecords("t1", "a1", "b1", [
      { recordId: "1", revision: "j1", status: "done" },
      { recordId: "2", revision: "j1", status: "done", carriedFrom: "rev-1" },
    ] as never);

    const [ops] = recordDb.bulkWrite.mock.calls[0];
    expect(ops[0].updateOne.update).toEqual({
      $set: expect.not.objectContaining({ carriedFrom: expect.anything() }),
      $unset: { carriedFrom: "" },
    });
    expect(ops[1].updateOne.update).toEqual({ $set: expect.objectContaining({ carriedFrom: "rev-1" }) });
  });
});
