import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext } from "@/lib/server/session";
import { MagickClient } from "@/lib/server/magick-client";
import { bulkJobIsUnchangedSince } from "@/lib/server/map";
import {
  acquireIngestionLocks,
  countRecords,
  createJob,
  findActiveJobForBatches,
  IngestionConflictError,
  releaseIngestionLocks,
} from "@/lib/server/repositories";
import { isBatchReadable, type BatchDoc, type Job, type JobType, type TenantContext } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";
import { parseBatchIds, selectionErrorResponse, validateSelection } from "@/lib/server/selection";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/server/request";

/** Upstream reads issued at once while deciding what a refresh has to re-pull.
 *  A selection can hold up to MAX_SELECTION_BATCHES batches; firing them all at
 *  magick-master together invites a 429 on the very request meant to avoid work. */
const REFRESH_CHECK_CONCURRENCY = 10;

/**
 * Narrow a refresh to the batches whose source actually moved.
 *
 * Every ingestion writes a complete new copy of a batch's records, so an
 * unconditional refresh rewrote an identical dataset on each click — the
 * mechanism that repeatedly exhausted the cluster's storage. Re-read each
 * batch's bulk job and drop only the ones that can be PROVEN untouched since
 * their last pull (see bulkJobIsUnchangedSince).
 *
 * Deliberately conservative at every step: a batch with no complete revision, no
 * recorded stamp, or an unreadable upstream job all stay in the refresh. Doing
 * redundant work is recoverable and the worker reclaims the duplicate itself;
 * silently refusing the refresh a customer asked for is not.
 */
async function refreshableBatchIds(
  ctx: TenantContext,
  batchIds: string[],
  batchDocs: BatchDoc[],
  complete: boolean[],
): Promise<string[]> {
  const client = new MagickClient(ctx);
  const keep: string[] = [];
  for (let i = 0; i < batchIds.length; i += REFRESH_CHECK_CONCURRENCY) {
    const slice = batchIds.slice(i, i + REFRESH_CHECK_CONCURRENCY);
    const decisions = await Promise.all(
      slice.map(async (batchId, offset) => {
        const index = i + offset;
        const batch = batchDocs[index];
        // Nothing complete to compare against — this is a plain first ingest.
        if (!complete[index] || !batch.ingestedSourceUpdatedAt || !batch.sourceId) return batchId;
        try {
          const job = await client.getBulkJob(batch.sourceId);
          if (bulkJobIsUnchangedSince(job, batch.ingestedSourceUpdatedAt)) {
            log().info({ batchId }, "refresh skipped — upstream job untouched since last ingestion");
            return null;
          }
        } catch (err) {
          log().warn({ error: err, batchId }, "refresh source check failed — re-ingesting to be safe");
        }
        return batchId;
      }),
    );
    for (const batchId of decisions) if (batchId) keep.push(batchId);
  }
  return keep;
}

/** Enqueue an ingestion (or merge) job for a set of batches. The worker picks it
 *  up, paginates magick-master, normalizes, and persists records to Mongo. */
export const POST = withLogging("ingest", async (req: Request) => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: unknown; type?: JobType; refresh?: boolean };
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    const response = jsonBodyErrorResponse(error);
    if (response) return response;
    throw error;
  }
  let requestedBatchIds: string[];
  let batchDocs;
  try {
    requestedBatchIds = parseBatchIds(body?.batchIds);
    batchDocs = await validateSelection(ctx, requestedBatchIds);
  } catch (error) {
    const response = selectionErrorResponse(error);
    if (response) return response;
    throw error;
  }
  if (body.type != null && body.type !== "ingest" && body.type !== "merge") {
    return NextResponse.json({ error: "invalid_job_type" }, { status: 400 });
  }
  if (body.refresh != null && typeof body.refresh !== "boolean") {
    return NextResponse.json({ error: "invalid_refresh" }, { status: 400 });
  }
  const type: JobType = body.type === "merge" ? "merge" : "ingest";
  // Analyze "Refresh data" re-pulls. Merge/CSV and a normal Analyze load must
  // not; a page reload used to enqueue a second full ingest of ready batches.
  const forceRefresh = type === "ingest" && body.refresh === true;

  // Skip batches whose normalized records already match the known total. Merge
  // has always done this so CSV download does not scale with upstream API
  // speed/rate limits. A refresh applies the same test against a freshly read
  // source rather than skipping the test outright — see refreshableBatchIds.
  const counts = await Promise.all(
    requestedBatchIds.map((id) => countRecords(ctx.tenantId, ctx.accountId, [id])),
  );
  const complete = requestedBatchIds.map(
    (_, index) => isBatchReadable(batchDocs[index]) && counts[index] === batchDocs[index].total,
  );
  const batchIds = forceRefresh
    ? await refreshableBatchIds(ctx, requestedBatchIds, batchDocs, complete)
    : requestedBatchIds.filter((_, index) => !complete[index]);
  if (batchIds.length === 0) {
    // `upToDate` distinguishes "we checked upstream and there is nothing new"
    // from "these batches were already ingested". Without it a refresh that
    // correctly does nothing is indistinguishable on screen from one that
    // silently failed — and the whole complaint behind this work was a customer
    // unable to trust the numbers in front of them.
    return NextResponse.json({ jobId: null, total: 0, done: 0, ready: true, upToDate: forceRefresh });
  }

  const activeJob = await findActiveJobForBatches(ctx.tenantId, ctx.accountId, batchIds);
  if (activeJob) {
    const covered = batchIds.every((batchId) => activeJob.batchIds.includes(batchId));
    if (!covered) {
      return NextResponse.json(
        {
          error: "ingestion_in_progress",
          message: "Another ingestion overlaps this selection but does not cover every requested batch. Wait for it to finish, then retry.",
        },
        { status: 409 },
      );
    }
    // Let a reloaded screen/modal reattach to the existing compatible work
    // instead of remaining blocked until it finishes in the background.
    return NextResponse.json({
      jobId: activeJob.jobId,
      total: activeJob.total,
      done: activeJob.done ?? 0,
      ready: false,
      existing: true,
    });
  }

  // total = sum of known batch totals (for progress display)
  let total = 0;
  for (const id of batchIds) total += batchDocs[requestedBatchIds.indexOf(id)].total;

  const session = await getSession();
  const now = new Date().toISOString();
  const jobId = randomUUID();
  const job: Job = {
    jobId,
    type,
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    idToken: session.idToken,
    batchIds,
    status: "queued",
    total,
    done: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await acquireIngestionLocks(ctx.tenantId, ctx.accountId, batchIds, jobId);
    await createJob(job);
  } catch (error) {
    await releaseIngestionLocks(jobId).catch(() => {});
    if (error instanceof IngestionConflictError) {
      return NextResponse.json(
        { error: "ingestion_in_progress", message: error.message },
        { status: 409 },
      );
    }
    throw error;
  }
  log().info(
    { jobId: job.jobId, type, batchCount: batchIds.length, total },
    "ingestion job enqueued",
  );
  return NextResponse.json({ jobId: job.jobId, total, done: 0, ready: false });
});
