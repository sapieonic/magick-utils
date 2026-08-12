// Pure async data-access functions over the Mongo collections. Every query that
// touches a tenant-scoped document filters by tenantId + accountId so data can
// never leak across tenants. Server-only.

import { randomUUID } from "node:crypto";
import type { AnyBulkWriteOperation, FindCursor, WithId } from "mongodb";
import {
  aggregates,
  aiUsage,
  batches,
  ingestionLocks,
  insights,
  jobs,
  records,
} from "@/lib/server/db";
import type {
  AggregatesDoc,
  BatchDoc,
  DashboardVolume,
  Insight,
  Job,
  NormalizedRecord,
} from "@/lib/server/types";

function nowIso(): string {
  return new Date().toISOString();
}

/** Campaign-list refreshes must not copy a stale in-memory lease over the
 *  worker's live ownership marker. begin/publish/fail are the only writers. */
function withoutIngestionOwnership(doc: BatchDoc): Omit<BatchDoc, "ingestJobId" | "ingestLeaseId" | "ingestLeaseUntil"> {
  const source = { ...doc };
  delete source.ingestJobId;
  delete source.ingestLeaseId;
  delete source.ingestLeaseUntil;
  return source;
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

/** Refresh source metadata without allowing a stale campaign-list read to
 * overwrite a revision that the ingestion worker published concurrently. */
export async function refreshBatchFromSource(
  doc: BatchDoc,
  expectedUpdatedAt: string | null,
): Promise<BatchDoc> {
  const col = await batches();
  const key = {
    tenantId: doc.tenantId,
    accountId: doc.accountId,
    batchId: doc.batchId,
  };
  const source = withoutIngestionOwnership(doc);
  if (expectedUpdatedAt == null) {
    const current = await col.findOneAndUpdate(
      key,
      { $setOnInsert: source },
      { upsert: true, returnDocument: "after" },
    );
    if (current) return current;
  } else {
    const updated = await col.findOneAndUpdate(
      { ...key, updatedAt: expectedUpdatedAt },
      { $set: source },
      { returnDocument: "after" },
    );
    if (updated) return updated;
  }
  // A worker or another source refresh won the optimistic race. Return its
  // document rather than writing the stale snapshot over it.
  const current = await col.findOne(key);
  if (current) return current;
  // Deletion between the compare-and-swap and read is exceptionally rare; an
  // insert-only retry safely recreates the source document.
  return refreshBatchFromSource(doc, null);
}

/** Mark a batch as staging for this worker without letting an older lease
 * overwrite ownership established by a reclaimed/newer worker. */
export async function beginBatchIngestion(
  doc: BatchDoc,
  jobId: string,
  leaseId: string,
  leaseUntil: string,
): Promise<boolean> {
  const col = await batches();
  const result = await col.updateOne(
    {
      tenantId: doc.tenantId,
      accountId: doc.accountId,
      batchId: doc.batchId,
      $or: [
        { ingestJobId: { $exists: false } },
        { ingestJobId: { $type: "null" } },
        { ingestJobId: jobId, ingestLeaseId: leaseId },
        // Pre-#25 workers wrote ingestJobId without ingestLeaseUntil. `$lt`
        // does not match a missing field, so those markers blocked every later
        // job (analytics generation failed immediately with "newer worker owns
        // batch ingestion") until we treat "no deadline" as takeable.
        { ingestLeaseUntil: { $exists: false } },
        { ingestLeaseUntil: { $type: "null" } },
        { ingestLeaseUntil: { $lt: leaseUntil } },
      ],
    },
    {
      $set: {
        ...withoutIngestionOwnership(doc),
        ingestStatus: doc.ingestStatus === "ready" ? "ready" : "ingesting",
        ingestJobId: jobId,
        ingestLeaseId: leaseId,
        ingestLeaseUntil: leaseUntil,
        updatedAt: nowIso(),
      },
    },
  );
  return result.matchedCount === 1;
}

/** Atomically publish a revision only while this exact worker lease still owns
 * the batch. A reclaimed worker replaces ingestLeaseId, so stale workers cannot
 * swap the published pointer. */
export async function publishBatchIfOwned(
  doc: BatchDoc,
  jobId: string,
  leaseId: string,
): Promise<boolean> {
  const col = await batches();
  const result = await col.updateOne(
    {
      tenantId: doc.tenantId,
      accountId: doc.accountId,
      batchId: doc.batchId,
      ingestJobId: jobId,
      ingestLeaseId: leaseId,
    },
    { $set: doc, $unset: { ingestJobId: "", ingestLeaseId: "", ingestLeaseUntil: "" } },
  );
  return result.matchedCount === 1;
}

export async function failBatchIfOwned(
  tenantId: string,
  accountId: string,
  batchId: string,
  jobId: string,
  leaseId: string,
): Promise<void> {
  const col = await batches();
  const current = await col.findOne({ tenantId, accountId, batchId, ingestJobId: jobId, ingestLeaseId: leaseId });
  if (!current) return;
  await col.updateOne(
    { tenantId, accountId, batchId, ingestJobId: jobId, ingestLeaseId: leaseId },
    {
      $set: {
        ingestStatus: current.publishedRevision ? "ready" : "error",
        updatedAt: nowIso(),
      },
      $unset: { ingestJobId: "", ingestLeaseId: "", ingestLeaseUntil: "" },
    },
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
export async function deleteBatchRecords(
  tenantId: string,
  accountId: string,
  batchId: string
): Promise<void> {
  const col = await records();
  await col.deleteMany({ tenantId, accountId, batchId });
}

/** Delete only a staging revision, never the currently published data. */
export async function deleteBatchRevisionRecords(
  tenantId: string,
  accountId: string,
  batchId: string,
  revision: string,
): Promise<void> {
  const col = await records();
  await col.deleteMany({ tenantId, accountId, batchId, revision });
}

export async function deleteUnpublishedBatchRevision(
  tenantId: string,
  accountId: string,
  batchId: string,
  revision: string,
): Promise<void> {
  const batch = await getBatch(tenantId, accountId, batchId);
  if (batch?.publishedRevision === revision) return;
  await deleteBatchRevisionRecords(tenantId, accountId, batchId, revision);
}

export async function retireBatchRevision(
  tenantId: string,
  accountId: string,
  batchId: string,
  revision: string | undefined,
): Promise<void> {
  if (!revision) return; // legacy unversioned rows remain until migrated separately
  const batch = await getBatch(tenantId, accountId, batchId);
  if (batch?.publishedRevision === revision) return;
  const col = await records();
  await col.updateMany(
    { tenantId, accountId, batchId, revision },
    { $set: { retiredAt: new Date() } },
  );
}

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
            revision: doc.revision,
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

async function publishedRecordsFilter(
  tenantId: string,
  accountId: string,
  batchIds: string[]
) {
  const col = await batches();
  const docs = await col
    .find({ tenantId, accountId, batchId: { $in: batchIds } })
    .project<Pick<BatchDoc, "batchId" | "publishedRevision">>({ batchId: 1, publishedRevision: 1 })
    .toArray();
  if (docs.length === 0) return { tenantId, accountId, batchId: { $in: [] as string[] } };
  return {
    tenantId,
    accountId,
    $or: docs.map((doc) => doc.publishedRevision
      ? { batchId: doc.batchId, revision: doc.publishedRevision }
      : { batchId: doc.batchId, revision: { $exists: false } }),
  };
}

export async function getRecords(
  tenantId: string,
  accountId: string,
  batchIds: string[],
  opts?: { limit?: number; skip?: number }
): Promise<NormalizedRecord[]> {
  if (batchIds.length === 0) return [];
  const col = await records();
  const filter = await publishedRecordsFilter(tenantId, accountId, batchIds);
  let cursor = col
    .find(filter)
    .sort({ batchId: 1, recordId: 1 });
  if (opts?.skip != null) cursor = cursor.skip(opts.skip);
  if (opts?.limit != null) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

export async function getRecordsForRevision(
  tenantId: string,
  accountId: string,
  batchId: string,
  revision: string,
): Promise<NormalizedRecord[]> {
  const col = await records();
  return col.find({ tenantId, accountId, batchId, revision }).sort({ recordId: 1 }).toArray();
}

/** Raw cursor for streaming large exports without buffering in memory. */
export async function streamRecords(
  tenantId: string,
  accountId: string,
  batchIds: string[]
): Promise<FindCursor<WithId<NormalizedRecord>>> {
  if (batchIds.length === 0) throw new Error("Cannot stream an empty batch selection.");
  const col = await records();
  const filter = await publishedRecordsFilter(tenantId, accountId, batchIds);
  return col
    .find(filter)
    .sort({ batchId: 1, recordId: 1 });
}

export async function countRecords(
  tenantId: string,
  accountId: string,
  batchIds: string[]
): Promise<number> {
  if (batchIds.length === 0) return 0;
  const col = await records();
  return col.countDocuments(await publishedRecordsFilter(tenantId, accountId, batchIds));
}

/** Aggregate true placed/sent activity by UTC day. The fallback to `timestamp`
 * keeps records ingested before activityTimestamp was introduced visible until
 * their next refresh. Work stays in Mongo so an all-time dashboard never loads
 * every normalized record into application memory. */
export async function getDashboardVolume(
  tenantId: string,
  accountId: string,
  range: string,
  start: Date | null,
  end: Date,
): Promise<DashboardVolume> {
  const col = await records();
  const readyBatches = (await listBatches(tenantId, accountId))
    .filter((batch) => batch.ingestStatus === "ready");
  if (readyBatches.length === 0) {
    return {
      timezone: "UTC", range, start: start?.toISOString() ?? null, end: end.toISOString(),
      totalRecords: 0, totalCalls: 0, totalMessages: 0, successRate: 0,
      spendInr: 0, telephonyInr: 0, aiInr: 0, statusMix: [], points: [],
    };
  }
  const eventDate = {
    $ifNull: [
      "$activityDate",
      { $convert: {
      input: { $ifNull: ["$activityTimestamp", "$timestamp"] },
      to: "date",
      onError: null,
      onNull: null,
      } },
    ],
  };
  const rawStatus = {
    $toLower: {
      $trim: {
        input: {
          $convert: {
            input: { $ifNull: ["$raw.status", "$status"] },
            to: "string",
            onError: "",
            onNull: "",
          },
        },
      },
    },
  };
  const statusSwitch = (branches: Array<{ case: unknown; then: string }>) => ({
    $switch: { branches, default: "$status" },
  });
  const equalsAny = (values: string[]) => ({ $in: [rawStatus, values] });
  const canonicalStatus = {
    $cond: [
      { $eq: ["$selType", "message"] },
      statusSwitch([
        { case: equalsAny(["read", "opened"]), then: "read" },
        { case: equalsAny(["delivered", "clicked"]), then: "delivered" },
        { case: equalsAny(["bounced", "undelivered", "complained"]), then: "bounced" },
        { case: equalsAny(["failed"]), then: "failed" },
        { case: equalsAny(["queued", "sending", "sent"]), then: "sent" },
      ]),
      statusSwitch([
        { case: equalsAny(["completed"]), then: "completed" },
        { case: equalsAny(["failed", "escalate_human"]), then: "failed" },
        { case: equalsAny(["switched_off"]), then: "switchedoff" },
        { case: equalsAny(["no_answer"]), then: "noanswer" },
        { case: equalsAny(["busy"]), then: "busy" },
        { case: equalsAny(["voicemail"]), then: "voicemail" },
        { case: equalsAny(["in_progress"]), then: "inprogress" },
        { case: equalsAny(["queued", "initiating", "ringing"]), then: "pending" },
      ]),
    ],
  };
  const dateMatch: Record<string, Date> = { $lte: end };
  if (start) dateMatch.$gte = start;
  const rows = await col.aggregate<{
    _id: { date: string; status: string };
    calls: number;
    messages: number;
    total: number;
    spendInr: number;
    telephonyInr: number;
    aiInr: number;
  }>([
    {
      $match: {
        tenantId,
        accountId,
        $or: readyBatches.map((batch) => batch.publishedRevision
          ? { batchId: batch.batchId, revision: batch.publishedRevision }
          : { batchId: batch.batchId, revision: { $exists: false } }),
        $and: [{ $or: [{ activityDate: dateMatch }, { activityDate: { $exists: false } }, { activityDate: null }] }],
      },
    },
    { $set: { _eventDate: eventDate } },
    { $match: { _eventDate: dateMatch } },
    {
      $group: {
        _id: {
          date: { $dateToString: { date: "$_eventDate", format: "%Y-%m-%d", timezone: "UTC" } },
          status: canonicalStatus,
        },
        calls: { $sum: { $cond: [{ $eq: ["$selType", "message"] }, 0, 1] } },
        messages: { $sum: { $cond: [{ $eq: ["$selType", "message"] }, 1, 0] } },
        total: { $sum: 1 },
        spendInr: { $sum: { $ifNull: ["$totalCostInr", 0] } },
        telephonyInr: { $sum: { $ifNull: ["$telephonyCostInr", 0] } },
        aiInr: { $sum: { $ifNull: ["$aiCostInr", 0] } },
      },
    },
    { $sort: { "_id.date": 1 } },
  ]).toArray();

  const pointMap = new Map<string, { date: string; calls: number; messages: number }>();
  const statusMap = new Map<string, number>();
  let totalCalls = 0, totalMessages = 0, spendInr = 0, telephonyInr = 0, aiInr = 0, reached = 0;
  for (const row of rows) {
    const point = pointMap.get(row._id.date) ?? { date: row._id.date, calls: 0, messages: 0 };
    point.calls += row.calls;
    point.messages += row.messages;
    pointMap.set(row._id.date, point);
    statusMap.set(row._id.status, (statusMap.get(row._id.status) ?? 0) + row.total);
    totalCalls += row.calls;
    totalMessages += row.messages;
    spendInr += row.spendInr;
    telephonyInr += row.telephonyInr;
    aiInr += row.aiInr;
    if (row._id.status === "completed" || row._id.status === "read") reached += row.total;
  }
  const totalRecords = totalCalls + totalMessages;

  return {
    timezone: "UTC",
    range,
    start: start?.toISOString() ?? null,
    end: end.toISOString(),
    totalRecords,
    totalCalls,
    totalMessages,
    successRate: totalRecords > 0 ? reached / totalRecords : 0,
    spendInr,
    telephonyInr,
    aiInr,
    statusMix: [...statusMap].map(([key, value]) => ({ key, value })),
    points: [...pointMap.values()],
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function createJob(job: Job): Promise<void> {
  const col = await jobs();
  await col.insertOne(job);
}

export class IngestionConflictError extends Error {
  constructor() {
    super("One or more selected batches are already being ingested.");
    this.name = "IngestionConflictError";
  }
}

/** Atomically acquire every batch lock for a job. The unique index makes
 * concurrent overlapping requests mutually exclusive; partial inserts are
 * rolled back by jobId. Expired locks are cleared eagerly because TTL cleanup
 * is intentionally approximate. */
export async function acquireIngestionLocks(
  tenantId: string,
  accountId: string,
  batchIds: string[],
  jobId: string,
  leaseMs = 10 * 60 * 1000,
): Promise<void> {
  const col = await ingestionLocks();
  const now = new Date();
  const jobCol = await jobs();
  const existing = await col.find({ tenantId, accountId, batchId: { $in: batchIds } }).toArray();
  for (const lock of existing) {
    const owner = await jobCol.findOne({ jobId: lock.jobId }, { projection: { status: 1 } });
    // An ownerless, unexpired lock may be in the intentional lock→job insert
    // window; deleting it would reopen the scheduling race. TTL recovers a
    // process crash in that window.
    const stale = lock.expiresAt <= now || owner?.status === "done" || owner?.status === "error";
    if (stale) {
      await col.deleteOne({ tenantId, accountId, batchId: lock.batchId, jobId: lock.jobId });
    }
  }
  try {
    await col.insertMany(
      batchIds.map((batchId) => ({
        tenantId,
        accountId,
        batchId,
        jobId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + leaseMs),
      })),
      { ordered: false },
    );
  } catch (error) {
    await col.deleteMany({ tenantId, accountId, jobId });
    if ((error as { code?: number } | null)?.code === 11000
      || /duplicate key/i.test((error as Error | null)?.message ?? "")) {
      throw new IngestionConflictError();
    }
    throw error;
  }
}

export async function renewIngestionLocks(jobId: string, leaseMs = 10 * 60 * 1000): Promise<void> {
  const col = await ingestionLocks();
  const minimumLease = 10 * 60 * 1000;
  await col.updateMany({ jobId }, { $set: { expiresAt: new Date(Date.now() + Math.max(leaseMs, minimumLease)) } });
}

export async function releaseIngestionLocks(jobId: string): Promise<void> {
  const col = await ingestionLocks();
  await col.deleteMany({ jobId });
}

/** Distributed fixed-window attempt quota. Cached insight reads call this only
 * after a cache miss. A reserved attempt remains counted if the provider later
 * fails: refunding outages would permit an unbounded retry/cost storm. */
export async function consumeAiQuota(
  tenantId: string,
  accountId: string,
  kind: "chat" | "insight" | "comparison",
  limit: number,
  windowMs = 60 * 60 * 1000,
): Promise<boolean> {
  const col = await aiUsage();
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const key = JSON.stringify([tenantId, accountId, kind, bucket]);
  const update = {
    $setOnInsert: {
      tenantId,
      accountId,
      kind,
      createdAt: new Date(now),
      expiresAt: new Date((bucket + 2) * windowMs),
    },
    $inc: { count: 1 },
  };
  let result;
  try {
    result = await col.findOneAndUpdate(
      { key },
      update,
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if ((error as { code?: number } | null)?.code !== 11000) throw error;
    result = await col.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { returnDocument: "after" });
  }
  return (result?.count ?? limit + 1) <= limit;
}

export async function getJob(jobId: string): Promise<Job | null> {
  const col = await jobs();
  return col.findOne({ jobId });
}

export async function findActiveJobForBatches(
  tenantId: string,
  accountId: string,
  batchIds: string[],
): Promise<Job | null> {
  const col = await jobs();
  return col.findOne({
    tenantId,
    accountId,
    status: { $in: ["queued", "running", "rate_limited"] },
    batchIds: { $in: batchIds },
  });
}

/** Patch a job, always bumping updatedAt. Returns the updated job or null. */
export async function updateJob(
  jobId: string,
  patch: Partial<Job>
): Promise<Job | null> {
  const col = await jobs();
  // Never let a caller rewrite the immutable jobId via the patch.
  const rest = { ...patch };
  delete rest.jobId;
  return col.findOneAndUpdate(
    { jobId },
    { $set: { ...rest, updatedAt: nowIso() } },
    { returnDocument: "after" }
  );
}

export async function updateClaimedJob(
  jobId: string,
  leaseId: string,
  patch: Partial<Job>
): Promise<Job | null> {
  const col = await jobs();
  const rest = { ...patch };
  delete rest.jobId;
  return col.findOneAndUpdate(
    { jobId, status: "running", leaseId },
    { $set: { ...rest, updatedAt: nowIso() } },
    { returnDocument: "after" }
  );
}

export async function checkpointJob(
  jobId: string,
  leaseId: string,
  patch: Pick<Job, "done" | "cursor" | "batchIndex"> & Partial<Pick<Job, "leaseUntil">>
): Promise<Job | null> {
  const col = await jobs();
  return col.findOneAndUpdate(
    { jobId, status: "running", leaseId, done: { $lte: patch.done } },
    { $set: { ...patch, updatedAt: nowIso() } },
    { returnDocument: "after" }
  );
}

/**
 * Atomically claim the oldest queued or due job, including running work whose
 * lease expired. findOneAndUpdate prevents concurrent workers claiming it.
 */
export async function claimNextJob(leaseMs = 60_000): Promise<Job | null> {
  const col = await jobs();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  const leaseId = randomUUID();
  return col.findOneAndUpdate(
    {
      $or: [
        { status: "queued" },
        { status: "rate_limited", retryAt: { $lte: now } },
        { status: "running", leaseUntil: { $lte: now } },
        { status: "running", leaseUntil: { $exists: false } },
      ],
    },
    { $set: { status: "running", retryAt: null, leaseUntil, leaseId, updatedAt: now } },
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

/** Delete only retired immutable revisions after a grace period. Current
 * published revisions and legacy unversioned records are always retained. */
export async function deleteRetiredRecordRevisionsOlderThan(cutoff: Date): Promise<number> {
  const batchCol = await batches();
  const recordCol = await records();
  // Only explicitly retired revisions are eligible. Active/rate-limited
  // staging revisions never carry retiredAt and cannot be swept mid-ingestion.
  const published = await batchCol
    .find({ publishedRevision: { $exists: true } })
    .project<Pick<BatchDoc, "tenantId" | "accountId" | "batchId" | "publishedRevision">>({
      tenantId: 1, accountId: 1, batchId: 1, publishedRevision: 1,
    })
    .toArray();
  const filter: Record<string, unknown> = { retiredAt: { $lt: cutoff } };
  if (published.length > 0) {
    filter.$nor = published.map((batch) => ({
      tenantId: batch.tenantId,
      accountId: batch.accountId,
      batchId: batch.batchId,
      revision: batch.publishedRevision,
    }));
  }
  const res = await recordCol.deleteMany(filter);
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
