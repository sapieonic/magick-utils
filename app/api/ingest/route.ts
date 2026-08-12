import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext } from "@/lib/server/session";
import {
  acquireIngestionLocks,
  countRecords,
  createJob,
  findActiveJobForBatches,
  IngestionConflictError,
  releaseIngestionLocks,
} from "@/lib/server/repositories";
import type { Job, JobType } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";
import { parseBatchIds, selectionErrorResponse, validateSelection } from "@/lib/server/selection";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/server/request";

/** Enqueue an ingestion (or merge) job for a set of batches. The worker picks it
 *  up, paginates magick-master, normalizes, and persists records to Mongo. */
export const POST = withLogging("ingest", async (req: Request) => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: unknown; type?: JobType };
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
  const type: JobType = body.type === "merge" ? "merge" : "ingest";

  // Export combines normalized Mongo records. Do not re-pull batches that are
  // already ready; doing so made every download scale with upstream API speed
  // and rate limits even though the export route could stream them immediately.
  let batchIds = requestedBatchIds;
  if (type === "merge") {
    const counts = await Promise.all(
      requestedBatchIds.map((id) => countRecords(ctx.tenantId, ctx.accountId, [id])),
    );
    batchIds = requestedBatchIds.filter((_, index) => batchDocs[index].ingestStatus !== "ready" || counts[index] !== batchDocs[index].total);
    if (batchIds.length === 0) {
      return NextResponse.json({ jobId: null, total: 0, ready: true });
    }
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
  return NextResponse.json({ jobId: job.jobId, total, ready: false });
});
