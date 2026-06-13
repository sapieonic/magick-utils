// Pure async data-access functions over the Mongo collections. Every query that
// touches a tenant-scoped document filters by tenantId + accountId so data can
// never leak across tenants. Server-only.

import type { AnyBulkWriteOperation, FindCursor, WithId } from "mongodb";
import {
  aggregates,
  batches,
  insights,
  jobs,
  records,
} from "@/lib/server/db";
import type {
  AggregatesDoc,
  BatchDoc,
  Insight,
  Job,
  NormalizedRecord,
} from "@/lib/server/types";

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/** Upsert a batch keyed on (tenantId, accountId, batchId). */
export async function upsertBatch(doc: BatchDoc): Promise<void> {
  const col = await batches();
  await col.updateOne(
    {
      tenantId: doc.tenantId,
      accountId: doc.accountId,
      batchId: doc.batchId,
    },
    { $set: doc },
    { upsert: true }
  );
}

export async function listBatches(
  tenantId: string,
  accountId: string
): Promise<BatchDoc[]> {
  const col = await batches();
  return col.find({ tenantId, accountId }).sort({ date: -1 }).toArray();
}

export async function getBatch(
  tenantId: string,
  accountId: string,
  batchId: string
): Promise<BatchDoc | null> {
  const col = await batches();
  return col.findOne({ tenantId, accountId, batchId });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * Replace the records for a single batch via bulk upsert keyed on recordId.
 * Each record is upserted within the (tenant, account, batch, record) scope so
 * re-ingesting a batch overwrites in place without cross-tenant leakage.
 */
export async function replaceBatchRecords(
  tenantId: string,
  accountId: string,
  batchId: string,
  recordsToWrite: NormalizedRecord[]
): Promise<void> {
  if (recordsToWrite.length === 0) return;
  const col = await records();
  const ops: AnyBulkWriteOperation<NormalizedRecord>[] = recordsToWrite.map(
    (record) => {
      // Force the tenant/account/batch scope on every written doc — never trust
      // the caller's copy to embed the correct ownership keys.
      const doc: NormalizedRecord = {
        ...record,
        tenantId,
        accountId,
        batchId,
      };
      return {
        updateOne: {
          filter: {
            tenantId,
            accountId,
            batchId,
            recordId: doc.recordId,
          },
          update: { $set: doc },
          upsert: true,
        },
      };
    }
  );
  await col.bulkWrite(ops, { ordered: false });
}

function recordsFilter(
  tenantId: string,
  accountId: string,
  batchIds: string[]
) {
  return { tenantId, accountId, batchId: { $in: batchIds } };
}

export async function getRecords(
  tenantId: string,
  accountId: string,
  batchIds: string[],
  opts?: { limit?: number; skip?: number }
): Promise<NormalizedRecord[]> {
  if (batchIds.length === 0) return [];
  const col = await records();
  let cursor = col
    .find(recordsFilter(tenantId, accountId, batchIds))
    .sort({ batchId: 1, recordId: 1 });
  if (opts?.skip != null) cursor = cursor.skip(opts.skip);
  if (opts?.limit != null) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

/** Raw cursor for streaming large exports without buffering in memory. */
export async function streamRecords(
  tenantId: string,
  accountId: string,
  batchIds: string[]
): Promise<FindCursor<WithId<NormalizedRecord>>> {
  const col = await records();
  return col
    .find(recordsFilter(tenantId, accountId, batchIds))
    .sort({ batchId: 1, recordId: 1 });
}

export async function countRecords(
  tenantId: string,
  accountId: string,
  batchIds: string[]
): Promise<number> {
  if (batchIds.length === 0) return 0;
  const col = await records();
  return col.countDocuments(recordsFilter(tenantId, accountId, batchIds));
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function createJob(job: Job): Promise<void> {
  const col = await jobs();
  await col.insertOne(job);
}

export async function getJob(jobId: string): Promise<Job | null> {
  const col = await jobs();
  return col.findOne({ jobId });
}

/** Patch a job, always bumping updatedAt. Returns the updated job or null. */
export async function updateJob(
  jobId: string,
  patch: Partial<Job>
): Promise<Job | null> {
  const col = await jobs();
  // Never let a caller rewrite the immutable jobId via the patch.
  const { jobId: _ignored, ...rest } = patch;
  return col.findOneAndUpdate(
    { jobId },
    { $set: { ...rest, updatedAt: nowIso() } },
    { returnDocument: "after" }
  );
}

/**
 * Atomically claim the oldest queued job, flipping it to running. Concurrency-
 * safe: findOneAndUpdate is a single atomic op, so two workers can't claim the
 * same job. Returns the claimed (now-running) job, or null if none are queued.
 */
export async function claimNextJob(): Promise<Job | null> {
  const col = await jobs();
  return col.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "running", updatedAt: nowIso() } },
    { sort: { createdAt: 1 }, returnDocument: "after" }
  );
}

export async function listJobs(
  tenantId: string,
  accountId: string,
  opts?: { status?: Job["status"]; type?: Job["type"]; limit?: number; skip?: number }
): Promise<Job[]> {
  const col = await jobs();
  const filter: {
    tenantId: string;
    accountId: string;
    status?: Job["status"];
    type?: Job["type"];
  } = { tenantId, accountId };
  if (opts?.status) filter.status = opts.status;
  if (opts?.type) filter.type = opts.type;
  let cursor = col.find(filter).sort({ createdAt: -1 });
  if (opts?.skip != null) cursor = cursor.skip(opts.skip);
  if (opts?.limit != null) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export async function getAggregates(
  tenantId: string,
  accountId: string,
  key: string
): Promise<AggregatesDoc | null> {
  const col = await aggregates();
  return col.findOne({ tenantId, accountId, key });
}

/** Upsert precomputed aggregates keyed on (tenantId, accountId, key). */
export async function setAggregates(doc: AggregatesDoc): Promise<void> {
  const col = await aggregates();
  await col.updateOne(
    { tenantId: doc.tenantId, accountId: doc.accountId, key: doc.key },
    { $set: doc },
    { upsert: true }
  );
}

/**
 * Delete cached aggregates last computed before `cutoffIso`. Returns the number
 * removed. Aggregates are a regenerable cache (recomputed on the next analytics
 * request), so pruning stale ones keeps the collection and its index small
 * enough to stay on the Atlas free tier. `computedAt` is an ISO-8601 UTC string,
 * which sorts lexicographically, so a `$lt` string comparison is correct here.
 */
export async function deleteAggregatesOlderThan(
  cutoffIso: string
): Promise<number> {
  const col = await aggregates();
  const res = await col.deleteMany({ computedAt: { $lt: cutoffIso } });
  return res.deletedCount ?? 0;
}

/**
 * Delete completed/errored jobs last updated before `cutoffIso`. Only terminal
 * jobs are removed — queued/running jobs are live work the worker still needs.
 * Returns the number removed. Jobs also carry the caller's Firebase idToken, so
 * pruning finished ones is good token hygiene on top of keeping the index small.
 */
export async function deleteTerminalJobsOlderThan(
  cutoffIso: string
): Promise<number> {
  const col = await jobs();
  const res = await col.deleteMany({
    status: { $in: ["done", "error"] satisfies Job["status"][] },
    updatedAt: { $lt: cutoffIso },
  });
  return res.deletedCount ?? 0;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export async function getInsight(
  tenantId: string,
  accountId: string,
  key: string
): Promise<Insight | null> {
  const col = await insights();
  return col.findOne({ tenantId, accountId, key });
}

/** Upsert an insight keyed on (tenantId, accountId, key). */
export async function setInsight(doc: Insight): Promise<void> {
  const col = await insights();
  await col.updateOne(
    { tenantId: doc.tenantId, accountId: doc.accountId, key: doc.key },
    { $set: doc },
    { upsert: true }
  );
}

/**
 * Delete cached LLM insights created before `cutoffIso`. Insights are
 * regenerable, but regeneration costs an LLM call, so callers use a longer
 * retention window than for aggregates. Returns the number removed.
 */
export async function deleteInsightsOlderThan(
  cutoffIso: string
): Promise<number> {
  const col = await insights();
  const res = await col.deleteMany({ createdAt: { $lt: cutoffIso } });
  return res.deletedCount ?? 0;
}
