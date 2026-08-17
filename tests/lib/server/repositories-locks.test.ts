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
const recordDb = vi.hoisted(() => ({ deleteMany: vi.fn() }));

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
  deleteRetiredRecordRevisionsOlderThan,
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
  it("deletes only revisions explicitly retired before the grace cutoff", async () => {
    batchDb.find.mockReturnValue({
      project: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { tenantId: "t1", accountId: "a1", batchId: "b1", publishedRevision: "current" },
        ]),
      }),
    });
    recordDb.deleteMany.mockResolvedValue({ deletedCount: 5 });
    await expect(deleteRetiredRecordRevisionsOlderThan(new Date("2026-08-11T00:00:00Z"))).resolves.toBe(5);
    expect(recordDb.deleteMany).toHaveBeenCalledWith({
      retiredAt: { $lt: new Date("2026-08-11T00:00:00Z") },
      $nor: [{ tenantId: "t1", accountId: "a1", batchId: "b1", revision: "current" }],
    });
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
