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
const batchDb = vi.hoisted(() => ({ find: vi.fn() }));
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
  consumeAiQuota,
  deleteRetiredRecordRevisionsOlderThan,
  IngestionConflictError,
} from "@/lib/server/repositories";

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
