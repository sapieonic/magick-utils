import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext, persistRefreshedCredential } from "@/lib/server/session";
import { TokenRefreshPermanentError } from "@/lib/server/firebase-token";
import { MagickClient } from "@/lib/server/magick-client";
import { bulkJobIsUnchangedSince } from "@/lib/server/map";
import {
  acquireIngestionLocks,
  countRecords,
  createJob,
  findActiveJobForBatches,
  IngestionConflictError,
  refreshJobCredential,
  releaseIngestionLocks,
} from "@/lib/server/repositories";
import {
  isBatchReadable,
  isEmptyDispatchedPull,
  needsCompletenessRepull,
  shortPullCheckedRecently,
  type BatchDoc,
  type Job,
  type JobType,
  type TenantContext,
} from "@/lib/server/types";
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
 * recorded stamp, an unreadable upstream job, or a listing that already flagged
 * it stale all stay in the refresh. Doing redundant work is recoverable and the
 * worker reclaims the duplicate itself; silently refusing the refresh a customer
 * asked for is not.
 */
async function refreshableBatchIds(
  ctx: TenantContext,
  batchIds: string[],
  batchDocs: BatchDoc[],
  complete: boolean[],
): Promise<string[]> {
  const client = new MagickClient(ctx, { onCredentialRefresh: persistRefreshedCredential });
  const keep: string[] = [];
  for (let i = 0; i < batchIds.length; i += REFRESH_CHECK_CONCURRENCY) {
    const slice = batchIds.slice(i, i + REFRESH_CHECK_CONCURRENCY);
    const decisions = await Promise.all(
      slice.map(async (batchId, offset) => {
        const index = i + offset;
        const batch = batchDocs[index];
        // Nothing complete to compare against — this is a plain first ingest.
        if (!complete[index] || !batch.ingestedRecordsStamp || !batch.sourceId) return batchId;
        // A batch the campaigns listing already marked "stale" is one we have
        // positive evidence has moved, so there is nothing left to decide: pull
        // it. Skipping here would deadlock the two freshness signals against
        // each other. They are deliberately different — staleness compares the
        // listing's source fingerprint, the skip compares the records stamp
        // (master's `records_updated_at` + `status_summary`) — and they can
        // disagree either way round. When staleness says "changed" and the
        // stamp says "untouched", trusting the stamp leaves the batch
        // latched stale in Mongo with every later refresh no-oping against the
        // same unchanged stamp, and no click can ever clear it. Re-pulling
        // costs one redundant ingestion that the worker reclaims itself; the
        // latch costs the customer their refresh, permanently.
        if (batch.ingestStatus === "stale") return batchId;
        // Same reasoning for a batch that may be incomplete — the listing marks
        // those stale too, but this must not depend on a listing having
        // rewritten the document since it was published. It is how a short
        // revision (published by an older build, or flagged
        // by the worker) gets re-pulled once upstream pagination is fixed,
        // instead of being "proven unchanged" forever. Against an unfixed
        // upstream the re-pull is short again and the worker carries forward
        // every served record it did not return — writing nothing when the
        // result is identical — so this costs upstream load, never data or
        // storage. Deliberately NOT
        // subject to the merge cooldown: this is the customer's explicit ask.
        if (needsCompletenessRepull(batch)) return batchId;
        try {
          const job = await client.getBulkJob(batch.sourceId);
          // The stamp being compared was observed by the worker BEFORE the
          // pull that built the published revision, so equality here means no
          // core row of the job was written since — not merely since the pull
          // finished. A `null` on either side never matches.
          if (bulkJobIsUnchangedSince(job, batch.ingestedRecordsStamp)) {
            log().info({ batchId }, "refresh skipped — upstream job untouched since last ingestion");
            return null;
          }
        } catch (err) {
          // A credential that can never be renewed is NOT a source-check
          // failure. Swallowing it here queued a full re-ingest — a complete
          // duplicate dataset, per the batch revision rules — and handed back a
          // job id that the worker then failed, instead of clearing the dead
          // session and bouncing the user to /login as every other route does.
          if (err instanceof TokenRefreshPermanentError) throw err;
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
  const complete = requestedBatchIds.map((_, index) => {
    const doc = batchDocs[index];
    if (!isBatchReadable(doc) || counts[index] !== doc.total) return false;
    // A batch holding zero records while upstream reports dispatched contacts
    // is not complete — it is the empty-pull failure the worker now refuses to
    // publish, committed by a build that still did. Counting it as complete is
    // what made it unrecoverable rather than merely wrong: `total` collapsed to
    // 0 on that commit, so `counts === doc.total` is `0 === 0` and the batch is
    // filtered out here, meaning no job is enqueued and the worker's guard never
    // runs. The refresh path is the same story one step later — it reads this
    // same array, and a "ready" batch whose job upstream has not touched since
    // is proven unchanged and skipped. Both routes agreed the batch was fine and
    // the customer got a green "Up to date" over an empty screen with no way to
    // clear it. Treating it as incomplete puts it back in front of the worker,
    // which decides — and now says so.
    if (isEmptyDispatchedPull(counts[index], doc.sourceTotal)) return false;
    // A merge re-pulls a batch that may be incomplete — the merge job visits
    // each of its batches once and never retries a short pull. Without this the
    // customer's re-export after upstream pagination is fixed would still stream
    // the short revision, because only Analytics' "Refresh data" sends
    // `refresh`. Safe against an unfixed upstream: a pull that comes back short
    // again never drops a served record (they are carried forward), and one
    // whose result is identical to the served revision writes nothing (see
    // `ingestBatch`).
    //
    // Not on every merge, though. Against an unfixed core the re-pull is the
    // same short set every time, so re-paging each flagged batch on each
    // Generate is pure upstream load, all of it from this host against master's
    // global per-IP limit. A batch whose short pull was observed within
    // SHORT_PULL_REPULL_COOLDOWN_MS is served as it stands; the next merge after
    // the window re-pulls it, which is what lets it converge once core is fixed.
    // Every short pull the worker makes is recorded with its time — a running
    // job's too, unsettled — so the cooldown covers them all. A batch that
    // merely MAY be short (legacy stamps from before `shortPull` existed) has
    // no recorded observation and is re-pulled — that pull is what judges it.
    //
    // A plain Analytics load does NOT re-pull at all — it serves the flagged
    // data and its Refresh button is the deliberate re-pull, which ignores the
    // cooldown (refreshableBatchIds); re-pulling on every page view would be a
    // full upstream re-page per visit for as long as upstream stays unfixed.
    if (type === "merge" && needsCompletenessRepull(doc) && !shortPullCheckedRecently(doc)) return false;
    return true;
  });
  let batchIds: string[];
  try {
    batchIds = forceRefresh
      ? await refreshableBatchIds(ctx, requestedBatchIds, batchDocs, complete)
      : requestedBatchIds.filter((_, index) => !complete[index]);
  } catch (error) {
    // Same treatment campaigns gives it: the stored session is unrenewable, so
    // clear it and answer 401 rather than 500-ing or, worse, enqueueing work
    // that cannot possibly authenticate.
    if (error instanceof TokenRefreshPermanentError) {
      const session = await getSession();
      session.destroy();
      log().warn({ reason: error.reason }, "ingest credential is unrenewable — session expired, cleared");
      return NextResponse.json({ error: "session_expired", detail: error.reason }, { status: 401 });
    }
    throw error;
  }
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
    // Hand the running job this request's credential. `getTenantContext()` has
    // already re-minted it if it was near expiry, so it is good for another
    // hour, whereas the job may still be carrying the one it was enqueued with —
    // which is exactly the token that expires mid-ingestion and used to take the
    // whole staged revision down with it. A reattach after signing back in is
    // therefore what un-sticks a job the worker has been deferring.
    await refreshJobCredential(ctx.tenantId, ctx.accountId, activeJob.jobId, {
      idToken: ctx.idToken,
      refreshToken: ctx.refreshToken,
    }).catch((error) => {
      // Best-effort: the job is still running on its own token and the reattach
      // itself must not fail over this.
      log().warn({ error, jobId: activeJob.jobId }, "could not refresh the running job's credential");
    });
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

  const now = new Date().toISOString();
  const jobId = randomUUID();
  const job: Job = {
    jobId,
    type,
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    // Both credentials come from `ctx`, never from a second read of the raw
    // session: `getTenantContext()` has already replaced a near-expired ID token,
    // while `session.idToken` can hand the worker one with minutes left on it —
    // a job that starts by 401ing on its own first page. The refresh token is
    // what lets the worker mint its own replacements for the rest of the run.
    idToken: ctx.idToken,
    refreshToken: ctx.refreshToken,
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
