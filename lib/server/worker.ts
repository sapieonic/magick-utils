// In-process ingestion worker. Boots from instrumentation.ts on the long-running
// Node host, tails the `jobs` collection, and processes ingest/merge jobs:
// paginates magick-master, normalizes records, writes them to Mongo, and rebuilds
// the BatchDoc summary. Insights/chat run synchronously in their route handlers.

import {
  beginBatchIngestion,
  checkpointJob,
  claimNextJob,
  countRecords,
  deleteBatchRevisionRecords,
  deleteOrphanedRecordRevisions,
  deleteSupersededRecordRevisions,
  deleteUnpublishedBatchRevision,
  failBatchIfOwned,
  getBatch,
  getRecordsForRevision,
  keepPublishedRevisionIfOwned,
  publishBatchIfOwned,
  releaseIngestionLocks,
  renewIngestionLocks,
  retireBatchRevision,
  replaceBatchRecords,
  SUPERSEDED_REVISION_GRACE_MS,
  updateClaimedJob,
} from "./repositories";
import { MagickApiError, MagickClient, type RawBulkJob, normalizeJobDispatchType, resolveJobDispatchType } from "./magick-client";
import {
  idTokenNeedsRefresh,
  mintIdToken,
  TokenRefreshPermanentError,
  TokenRefreshTransientError,
  type MintedToken,
} from "./firebase-token";
import { isTokenRefreshConfigured } from "./env";
import { buildBatchDoc, normalizeCall, normalizeMessage } from "./normalize";
import { recordsContentFingerprint } from "./record-fingerprint";
import { bulkJobRecordsStamp } from "./records-stamp";
import {
  isBatchReadable,
  isEmptyDispatchedPull,
  isIncompletePaginatedPull,
  type Job,
  type JobWarning,
  type NormalizedRecord,
  type PullShortfall,
  type TenantContext,
} from "./types";
import { shortfallMessage } from "@/lib/shortfall";
import { logger, log } from "./logger";
import { runWithRequestContext } from "./observability/request-context";

const PAGE_SIZE = 100;
const IDLE_DELAY_MS = 2500;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const LEASE_MS = 60_000;
/** How long a job waits before trying a credential again. A minute is long
 *  enough that a Google outage or a magick-master auth blip has moved on, and
 *  short enough that a user who signs back in sees their ingestion continue
 *  rather than assuming it is dead and starting another one. */
const AUTH_RETRY_DELAY_MS = 60_000;
/** How many times a job may be put back for a credential problem before it is
 *  failed outright. Waiting is only worth anything because something CAN hand
 *  the job a new token — /api/ingest re-stamps the credential when a signed-in
 *  user reattaches to this job — but nothing guarantees anyone will, and a job
 *  that defers forever shows the customer a progress bar that never finishes and
 *  never errors. At AUTH_RETRY_DELAY_MS apiece this is ~20 minutes of grace,
 *  then a message that tells them exactly what to do.
 *
 *  Counted off `authRetryCount`, which only credential deferrals advance — a
 *  long ingest that has already survived a dozen rate limits arrives here with
 *  its full grace intact, and those are precisely the jobs long enough to outlive
 *  their token in the first place. */
const MAX_AUTH_DEFERRALS = 20;
/** The job `error` a customer reads when a credential problem is terminal. The
 *  UI prints `job.error` verbatim, so this says what to do rather than naming a
 *  status code they cannot act on. */
const RELOGIN_ERROR = "Your sign-in expired and could not be renewed. Sign in again, then retry.";
/** Small margin so a deferred sweep fires strictly after the grace cutoff it
 *  is waiting on, rather than racing it by a millisecond. */
export const SWEEP_DELAY_MARGIN_MS = 5_000;

let started = false;

export function startWorker() {
  if (started) return;
  started = true;
  logger.info("[worker] ingestion worker loop started");
  void loop();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loop() {
  // Runs for the lifetime of the process.
  for (;;) {
    let job: Job | null = null;
    try {
      job = await claimNextJob(LEASE_MS);
    } catch (err) {
      logger.error({ err }, "[worker] claimNextJob failed");
    }
    if (!job) {
      await sleep(IDLE_DELAY_MS);
      continue;
    }
    const claimed = job;
    // Tag every log line (and every magick-master call) for this job's run with
    // the jobId + tenant/account so a single ingestion is easy to follow in Grafana.
    try {
      await runWithRequestContext(
        {
          jobId: claimed.jobId,
          route: `worker:${claimed.type}`,
          tenantId: claimed.tenantId,
          accountId: claimed.accountId,
        },
        async () => {
          const startedAt = Date.now();
          log().info(
            { type: claimed.type, batchCount: claimed.batchIds.length, total: claimed.total },
            "[worker] job claimed",
          );
          await runClaimedJob(claimed, startedAt);
        },
      );
    } catch (err) {
      logger.error({ err, jobId: claimed.jobId }, "[worker] claimed job transition failed; lease recovery will retry");
    }
  }
}

/** A failure that says the job's credential — not its data — is the problem: a
 *  magick-master 401, or a mint attempt that failed for a reason that may not
 *  recur. Both are recoverable by waiting, and neither says anything about the
 *  records already staged.
 *
 *  `TokenRefreshPermanentError` is deliberately excluded. A revoked or expired
 *  refresh token answers the same way every time, so waiting on it only delays
 *  the message that tells the customer to sign in again. */
function isCredentialProblem(err: unknown): boolean {
  if (err instanceof TokenRefreshTransientError) return true;
  return err instanceof MagickApiError && err.status === 401;
}

/** How long to put a job back for, or null when it must fail instead. */
function deferralFor(
  err: unknown,
  claimed: Job,
): { retryAfterMs: number; reason: string; credential: boolean } | null {
  if (err instanceof MagickApiError && err.status === 429) {
    return {
      retryAfterMs: Math.max(err.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, IDLE_DELAY_MS),
      reason: "rate_limited",
      credential: false,
    };
  }
  if (!isCredentialProblem(err)) return null;
  if ((claimed.authRetryCount ?? 0) >= MAX_AUTH_DEFERRALS) return null;
  return {
    retryAfterMs: AUTH_RETRY_DELAY_MS,
    reason: err instanceof MagickApiError ? "unauthorized" : "token_refresh_unavailable",
    credential: true,
  };
}

/** What to write into `job.error` when a job is failing for good. */
function terminalErrorMessage(err: unknown): string {
  // A dead refresh token, or credential trouble we have already waited out: in
  // both cases the only thing that helps is a human signing in again, so say so
  // instead of printing "MagickApiError 401" at someone who cannot act on it.
  if (err instanceof TokenRefreshPermanentError) return `${RELOGIN_ERROR} (${err.reason})`;
  if (isCredentialProblem(err)) return RELOGIN_ERROR;
  return String(err);
}

export async function runClaimedJob(claimed: Job, startedAt = Date.now()) {
  if (!claimed.leaseId) throw new Error("claimed job has no leaseId");
  try {
    await processJob(claimed);
    await releaseIngestionLocks(claimed.jobId).catch((error) => {
      log().warn({ error }, "[worker] completed job lock cleanup deferred to TTL");
    });
    log().info({ durationMs: Date.now() - startedAt }, "[worker] job completed");
  } catch (err) {
    const deferral = deferralFor(err, claimed);
    if (deferral) {
      const { retryAfterMs, reason, credential } = deferral;
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      log().warn(
        { reason, retryAfterMs, retryAt, durationMs: Date.now() - startedAt },
        "[worker] job deferred; scheduled to resume",
      );
      const scheduled = await updateClaimedJob(claimed.jobId, claimed.leaseId, {
        // `rate_limited` is the ONE status that means "alive, paused, come back
        // at retryAt": `claimNextJob` re-claims it once `retryAt` passes, and
        // `findActiveJobForBatches` still counts it as active so nothing
        // enqueues a duplicate ingestion over it. An expired credential wants
        // exactly that behaviour, so it reuses the status rather than adding a
        // sibling — a new JobStatus would ripple into every screen that switches
        // on it, and the UI's only reaction here is to poll again at `retryAt`,
        // which is correct either way. Read it as "deferred", not as "the
        // upstream is throttling us"; `reason` in the line above says which.
        status: "rate_limited",
        retryAt,
        // The status cannot distinguish these two; this is what the screen reads
        // to tell the customer whether to wait or to sign in again.
        deferReason: credential ? "credential" : "rate_limited",
        // Each backoff advances only its own counter, so a long ingest that has
        // survived many rate limits still gets its full credential grace.
        ...(credential
          ? { authRetryCount: (claimed.authRetryCount ?? 0) + 1 }
          : { retryCount: (claimed.retryCount ?? 0) + 1 }),
        leaseUntil: null,
        leaseId: null,
        // Clearing the error matters most for the credential case: the staged
        // revision is intact and the job is expected to continue, so leaving a
        // previous run's message on it would show a failure that is not one.
        error: null,
      });
      if (!scheduled) throw new Error("job lease lost before rate-limit scheduling");
      await renewIngestionLocks(claimed.jobId, retryAfterMs + LEASE_MS).catch((error) => {
        log().warn({ error }, "[worker] rate-limit lock renewal failed; existing lease retained");
      });
      return;
    }
    log().error({ err, durationMs: Date.now() - startedAt }, "[worker] job failed");
    const failed = await updateClaimedJob(
      claimed.jobId,
      claimed.leaseId,
      {
        status: "error",
        leaseUntil: null,
        leaseId: null,
        error: terminalErrorMessage(err),
      },
      // The job is over; it has no further use for the caller's credential.
      { clearCredential: true },
    );
    if (!failed) throw err;
    await Promise.all(claimed.batchIds.map(async (batchId) => {
      await failBatchIfOwned(claimed.tenantId, claimed.accountId, batchId, claimed.jobId, claimed.leaseId!);
      await deleteUnpublishedBatchRevision(claimed.tenantId, claimed.accountId, batchId, claimed.jobId);
    }));
    await releaseIngestionLocks(claimed.jobId).catch((error) => {
      log().warn({ error }, "[worker] failed job lock cleanup deferred to TTL");
    });
  }
}

export async function processJob(job: Job) {
  if (!job.idToken) throw new Error("job has no idToken; cannot call magick-master");
  if (!job.leaseId) throw new Error("job has no leaseId; cannot process without ownership");
  const leaseId = job.leaseId;
  const ctx: TenantContext = {
    idToken: job.idToken,
    refreshToken: job.refreshToken,
    tenantId: job.tenantId,
    accountId: job.accountId,
  };

  /** Adopt a freshly minted credential, in memory and on the job document.
   *
   *  The job document is what a later claim reads — after a crash, a lease
   *  expiry or a deferral — so a token that only ever lived in this process is a
   *  token the next run does not have. The refresh token matters even more:
   *  Google may rotate it on exchange, and the rotated value going unwritten
   *  leaves the job holding one that is refused the next time it is used. */
  const adoptCredential = async (minted: MintedToken) => {
    ctx.idToken = minted.idToken;
    ctx.refreshToken = minted.refreshToken;
    const stored = await updateClaimedJob(job.jobId, leaseId, {
      idToken: minted.idToken,
      refreshToken: minted.refreshToken,
    });
    if (!stored) {
      // Not fatal here: the run continues on the token in hand, and the very
      // next checkpoint fails loudly on the same lost lease.
      log().warn("[worker] could not store the re-minted credential; lease may have moved on");
    }
  };

  // Mint before the first upstream call rather than after the first 401, when
  // the token we were handed is already spent. A job that sat out a rate-limit
  // pause — or that a restart re-claimed hours later — resumes with a credential
  // from the request that enqueued it, and that hour is long gone.
  if (ctx.refreshToken && isTokenRefreshConfigured() && idTokenNeedsRefresh(ctx.idToken)) {
    log().info("[worker] stored id token is at or near expiry; minting a replacement before resuming");
    await adoptCredential(await mintIdToken(ctx.refreshToken));
  }
  // The client re-mints on a 401 of its own accord; this callback is how the
  // credential it switched to reaches the job document.
  const client = new MagickClient(ctx, { onCredentialRefresh: adoptCredential });

  let done = job.done ?? 0;
  const startBatch = job.batchIndex ?? 0;
  // Published revisions are the durable source of truth for completed batches.
  // Job progress can include a partially staged current batch and is therefore
  // not sufficient to recover this value after a crash.
  let completedDone = startBatch > 0
    ? await countRecords(ctx.tenantId, ctx.accountId, job.batchIds.slice(0, startBatch))
    : 0;
  // Carried from the claimed document so a run resumed after a deferral still
  // reports the shortfalls an earlier run of the same job found.
  let warnings: JobWarning[] = [...(job.warnings ?? [])];
  for (let batchIndex = startBatch; batchIndex < job.batchIds.length; batchIndex += 1) {
    const batchId = job.batchIds[batchIndex];
    const outcome = await ingestBatch(
      client,
      ctx,
      job.jobId,
      leaseId,
      batchId,
      batchIndex,
      job.cursor ?? 0,
      completedDone,
    );
    done = outcome.done;
    completedDone = done;
    job.cursor = 0;
    // One entry per batch: a batch re-ingested on resume replaces what an
    // earlier run said about it, including clearing it if this pull was whole.
    const hadWarning = warnings.some((warning) => warning.batchId === batchId);
    if (outcome.warning || hadWarning) {
      warnings = [
        ...warnings.filter((warning) => warning.batchId !== batchId),
        ...(outcome.warning ? [outcome.warning] : []),
      ];
      // Written now rather than only at completion, so a deferral later in the
      // job cannot lose it.
      if (!(await updateClaimedJob(job.jobId, leaseId, { warnings }))) {
        throw new Error("job lease lost while recording a batch warning");
      }
    }
  }

  const result = job.type === "merge" ? { rowCount: done } : undefined;
  const completed = await updateClaimedJob(
    job.jobId,
    leaseId,
    {
      status: "done",
      done,
      cursor: 0,
      batchIndex: job.batchIds.length,
      leaseUntil: null,
      leaseId: null,
      result,
      ...(warnings.length ? { warnings } : {}),
    },
    // A merge that finished in thirty seconds must not leave a non-expiring
    // refresh token sitting in Mongo until the retention sweep gets to it.
    { clearCredential: true },
  );
  if (!completed) throw new Error("job lease lost before completion");
}

/** Reclaim the revision a publish just superseded, after the reader grace
 *  window it sits inside has elapsed.
 *
 *  Deferred rather than awaited: the worker must not block a job for minutes,
 *  and the rows are unreachable the moment the published pointer moves. The
 *  timer is unref'd so it can never hold the process open, and the cron sweep
 *  remains the backstop if the host restarts before it fires. At fire time the
 *  batch's CURRENT published revision is what must be spared — another refresh
 *  may have published a newer one in the meantime. */
function scheduleSupersededRevisionSweep(ctx: TenantContext, batchId: string, publishedRevision: string) {
  const timer = setTimeout(() => {
    void (async () => {
      const current = await getBatch(ctx.tenantId, ctx.accountId, batchId).catch(() => null);
      const keep = current?.publishedRevision ?? publishedRevision;
      const reclaimed = await deleteSupersededRecordRevisions(ctx.tenantId, ctx.accountId, batchId, keep);
      if (reclaimed > 0) {
        // Outside the job's async context, so correlation fields are passed explicitly.
        logger.info(
          { batchId, reclaimed, tenantId: ctx.tenantId, accountId: ctx.accountId },
          "[worker] superseded revision rows reclaimed after grace",
        );
      }
    })().catch((error) => {
      logger.warn({ error, batchId }, "[worker] deferred revision sweep failed; cron will retry");
    });
  }, SUPERSEDED_REVISION_GRACE_MS + SWEEP_DELAY_MARGIN_MS);
  timer.unref?.();
}

/** Bulk-job statuses that mean upstream finished putting the contact list on
 *  the wire, so records for it should exist and an empty pull is a fault.
 *
 *  Positive and narrow, deliberately. Only a job we can PROVE finished dialling
 *  arms the empty-pull guard in `ingestBatch`; anything else — still queued or
 *  processing, cancelled or failed before it dialled, an unrecognised state, or
 *  a job detail we could not fetch at all — leaves it disarmed. Both directions
 *  of error are real, but they are not equal: a missed detection leaves the
 *  blank batch this guard set out to surface, while a false positive puts
 *  "Sync failed" on a healthy campaign that is simply still running or was
 *  deliberately cancelled, and `failBatchIfOwned` writes `error` on a batch with
 *  no published revision — a red state no click can clear. The second is worse
 *  and hits far more campaigns, so "unsure" must mean "stay quiet".
 *
 *  These three are the statuses `messageBreakdown` (map.ts) treats as "it went
 *  out". `TERMINAL_JOB_STATUSES` there is a different question — "will anything
 *  more arrive" — and includes `failed`/`cancelled`, which is exactly why this
 *  cannot reuse it. */
const DIALLED_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "dispatched",
  "partially_failed",
]);

function jobFinishedDialling(job: RawBulkJob | null): boolean {
  return DIALLED_JOB_STATUSES.has((job?.status ?? "").toLowerCase().trim());
}

/** Bulk-job statuses after which upstream inserts no more rows for the job, so
 *  the list surface's COUNT and its pages describe one fixed row set and a
 *  unique count below the COUNT is loss, not lag.
 *
 *  Wider than `DIALLED_JOB_STATUSES` on purpose, and only possible because a
 *  short pull no longer fails anything. The empty-pull guard throws, so it
 *  arms only on proof the job dialled; this one flags, keeps or publishes —
 *  readable either way — so the question it needs answered is narrower: will
 *  more rows appear? A cancelled or failed job's rows are as fixed as a
 *  completed one's, and exempting them would leave the same tie loss silent on
 *  exactly those campaigns. Still-dispatching, unrecognised or unreadable jobs
 *  stay exempt: the COUNT may genuinely be running ahead of the pages. */
const ROWS_SETTLED_JOB_STATUSES: ReadonlySet<string> = new Set([
  ...DIALLED_JOB_STATUSES,
  "failed",
  "cancelled",
  "canceled",
]);

/** Statuses master can reach while a dispatch request to core is still in
 *  flight. A Stop flips the job to `cancelled` without waiting for the batch
 *  being POSTed (master cancels whatever that request created once it
 *  returns), and a dispatch that throws mid-campaign writes `failed` the same
 *  way — so for a short while core may still be inserting rows the job's
 *  status says will never come. Judged inside that window, a healthy
 *  just-stopped campaign reads "Incomplete upstream data". */
const ROWS_SETTLE_AFTER_STOP_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled", "canceled"]);

/** How long after a stop/failure the row set is treated as still settling. A
 *  late batch is bounded by the dispatch request that carries it; five minutes
 *  covers a slow core comfortably while still flagging a genuinely short
 *  stopped campaign on the next pull after it. */
const ROWS_SETTLE_WINDOW_MS = 5 * 60_000;

/** Whether the job's row set has stopped growing. `completed`, `dispatched`
 *  and `partially_failed` mean so outright. `cancelled`/`failed` mean so once
 *  the terminal timestamp master stamped (`cancelled_at`, `completed_at`) is
 *  older than the settle window; inside it the pull is judged as for a running
 *  job — published stamped short, re-pullable, flagged to nobody — and the next
 *  pull judges it exactly. A missing or unparseable timestamp keeps the old
 *  behaviour (settled): master stamps both on every such transition, and
 *  withholding the flag on an absence would leave a short pull silent with
 *  nothing to bring the judgement back. */
function jobStoppedAddingRows(job: RawBulkJob | null, now: number = Date.now()): boolean {
  const status = (job?.status ?? "").toLowerCase().trim();
  if (!ROWS_SETTLED_JOB_STATUSES.has(status)) return false;
  if (!ROWS_SETTLE_AFTER_STOP_STATUSES.has(status)) return true;
  const stoppedAt = Date.parse(job?.cancelled_at ?? job?.completed_at ?? "");
  if (!Number.isFinite(stoppedAt)) return true;
  return now - stoppedAt >= ROWS_SETTLE_WINDOW_MS;
}

async function ingestBatch(
  client: MagickClient,
  ctx: TenantContext,
  jobId: string,
  leaseId: string,
  batchId: string,
  batchIndex: number,
  initialOffset: number,
  completedDone: number,
): Promise<{ done: number; warning?: JobWarning }> {
  const batch = await getBatch(ctx.tenantId, ctx.accountId, batchId);
  if (!batch) throw new Error(`batch ${batchId} not found (list campaigns first)`);

  const startedAt = Date.now();
  log().info({ batchId, offset: initialOffset, selType: batch.selType, channel: batch.channel }, "[worker] ingesting batch");
  // Keep an already-published revision readable during refresh. New/stale
  // datasets remain blocked until their first complete revision is committed.
  // Renew and prove job ownership immediately before marking the batch. This
  // closes the stale-worker window around the separately stored batch marker.
  const batchLeaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  if (!(await updateClaimedJob(jobId, leaseId, { leaseUntil: batchLeaseUntil }))) {
    throw new Error("job lease lost before batch ingestion");
  }
  if (!(await beginBatchIngestion(batch, jobId, leaseId, batchLeaseUntil))) {
    const current = await getBatch(ctx.tenantId, ctx.accountId, batchId).catch(() => null);
    const owner = current ?? batch;
    log().warn(
      {
        batchId,
        ingestJobId: owner.ingestJobId,
        ingestLeaseId: owner.ingestLeaseId,
        ingestLeaseUntil: owner.ingestLeaseUntil,
      },
      "[worker] batch ingestion ownership lost",
    );
    throw new Error("newer worker owns batch ingestion");
  }
  // The job's records stamp (`bulkJobRecordsStamp`: master's
  // `records_updated_at`, the latest core row write across its batches), read
  // BEFORE this batch's first page so that anything upstream writes while we
  // page leaves it behind and the next refresh re-pulls. Reading it after the
  // pull would be the one unsafe order: a write landing between our last page
  // and that read would be in the stamp but not in the records, and the next
  // refresh would skip it forever. A value master served from its few-second
  // cache is only ever OLDER than the truth, which errs toward a redundant
  // re-pull. Only a pull that starts at offset 0 gets one: a resumed job would
  // be reading the stamp after its pause, and would then claim to include
  // changes made during that pause. A null stamp simply means the batch never
  // qualifies for a skip, which is the safe direction.
  //
  // The same fetch now also supplies `dispatch_type`, which is what chooses
  // `/proxy/calls` vs `/proxy/ivr-calls` vs `/proxy/static-calls` vs messaging.
  // Resume used to skip this call, but selType cannot tell ivr_call from
  // static_call, so a resumed IVR ingest would have no surface to hit. The
  // stamp is still gated on offset 0 below; a missing `dispatch_type` falls
  // back to the value the campaigns listing stored on the BatchDoc.
  //
  // MagickUtils `batchId` is the bulk-job id, not a core batch UUID. After
  // master's job-scoped guard, sending it as `batch_id` matches nothing (the
  // same class of bug messaging used to have). A BatchDoc with no sourceId
  // cannot be listed correctly — fail it rather than guessing a filter.
  if (!batch.sourceId) {
    throw new Error(
      `cannot list records for ${batchId}: batch has no sourceId (upstream job id)`,
    );
  }
  const sourceJob = await client
    .getBulkJob(batch.sourceId)
    .catch((error) => {
      log().warn({ error, batchId }, "[worker] source job unavailable; listing will use the batch's stored dispatch_type");
      return null;
    });
  const recordsStamp = initialOffset === 0 ? bulkJobRecordsStamp(sourceJob) : null;
  const dispatchType = resolveJobDispatchType(sourceJob, batch);

  const revision = jobId;
  const revisionCreatedAt = new Date();
  if (initialOffset === 0) {
    await deleteBatchRevisionRecords(ctx.tenantId, ctx.accountId, batchId, revision);
  }
  // Before staging, drop anything a previous crash orphaned for this batch —
  // rows that never got a retiredAt marker and so are invisible to the normal
  // sweep. The published revision and this job's own (possibly resumed) staging
  // revision are explicitly spared.
  const orphaned = await deleteOrphanedRecordRevisions(
    ctx.tenantId,
    ctx.accountId,
    batchId,
    [batch.publishedRevision, revision],
  ).catch((error) => {
    log().warn({ error, batchId }, "[worker] orphaned revision sweep skipped");
    return 0;
  });
  if (orphaned > 0) {
    log().info({ batchId, orphaned }, "[worker] orphaned revision rows reclaimed");
  }

  // A resumed job may already have unique rows staged for this revision. Seed
  // the expected-id set from those rows so duplicate detection remains correct
  // across a rate-limit/restart boundary.
  const stagedRecords = initialOffset > 0
    ? await getRecordsForRevision(ctx.tenantId, ctx.accountId, batchId, revision)
    : [];
  const expectedRecordIds = new Set(stagedRecords.map((record) => record.recordId));
  // `cursor` tracks the raw upstream offset, while `done` tracks unique records.
  // Keeping them separate prevents duplicate rows from moving progress backward
  // at publication and preserves the correct offset after a worker restart.
  // Upstream totals are progress hints, not pagination boundaries. They can be
  // stale in either direction, so the returned pages determine completion.
  let reportedTotal = batch.total;
  // The list surface's own `total`, kept apart from `reportedTotal` because that
  // one is seeded from `batch.total` — the dispatched CONTACT count until a
  // revision commits — and contacts are not rows. This is the figure the
  // completeness check below compares against: core computes it as a COUNT over
  // the same WHERE the pages come from. Undefined until a page reports one.
  let listedTotal: number | undefined;
  let offset = initialOffset;
  for (;;) {
    let page: NormalizedRecord[];
    let pageTotal: number | null | undefined;
    // Always `job_id`. Dropping it to dodge a type-mismatch 400 would list the
    // whole account, which is the bug master's guard exists to prevent.
    const listParams = { jobId: batch.sourceId, limit: PAGE_SIZE, offset };
    // Exhaustive on JobDispatchType so a seventh key cannot fall through to
    // `/proxy/calls` and 400. `JOB_LIST_SURFACE` is the allowlist; the worker
    // still names the typed client method and row key per case.
    switch (dispatchType) {
      case "whatsapp_message":
      case "telegram_message":
      case "email_message": {
        const response = await client.listMessages(listParams);
        pageTotal = response.total;
        const channel = batch.channel as "whatsapp" | "telegram" | "email";
        page = (response.messages ?? []).map((raw) => ({
          ...normalizeMessage(raw, ctx, { channel, batchId, fingerprint: batch.fingerprint }),
          revision,
          revisionCreatedAt,
        }));
        break;
      }
      case "ivr_call": {
        const response = await client.listIvrCalls(listParams);
        pageTotal = response.total;
        page = (response.sessions ?? []).map((raw) => ({
          ...normalizeCall(raw, ctx, { selType: "ivr", batchId, fingerprint: batch.fingerprint }),
          revision,
          revisionCreatedAt,
        }));
        break;
      }
      case "static_call": {
        const response = await client.listStaticCalls(listParams);
        pageTotal = response.total;
        page = (response.calls ?? []).map((raw) => ({
          ...normalizeCall(raw, ctx, { selType: "ivr", batchId, fingerprint: batch.fingerprint }),
          revision,
          revisionCreatedAt,
        }));
        break;
      }
      case "ai_voice_call": {
        const response = await client.listCalls(listParams);
        pageTotal = response.total;
        page = (response.calls ?? []).map((raw) => ({
          ...normalizeCall(raw, ctx, { selType: "ai", batchId, fingerprint: batch.fingerprint }),
          revision,
          revisionCreatedAt,
        }));
        break;
      }
      default: {
        const unexpected: never = dispatchType;
        throw new Error(`unsupported magick-master list surface: ${String(unexpected)}`);
      }
    }
    reportedTotal = Math.max(reportedTotal, pageTotal ?? 0);
    if (typeof pageTotal === "number" && Number.isFinite(pageTotal)) {
      listedTotal = Math.max(listedTotal ?? 0, pageTotal);
    }
    if (page.length === 0) {
      break;
    }
    const missingRecordIds = page.filter(
      (record) => typeof record.recordId !== "string" || record.recordId.trim().length === 0,
    ).length;
    if (missingRecordIds > 0) {
      throw new Error(
        `invalid upstream records for ${batchId}: ${missingRecordIds} of ${page.length} records at offset ${offset} have no record id`,
      );
    }
    // Repeated source ids represent the same session. Keep the latest payload
    // for each id while retaining the raw page length for upstream pagination.
    const uniquePage = [...new Map(page.map((record) => [record.recordId, record])).values()];
    for (const record of uniquePage) expectedRecordIds.add(record.recordId);
    await replaceBatchRecords(ctx.tenantId, ctx.accountId, batchId, uniquePage);
    offset += page.length;
    const checkpoint = await checkpointJob(jobId, leaseId, {
      done: completedDone + expectedRecordIds.size,
      cursor: offset,
      batchIndex,
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    if (!checkpoint) throw new Error("job lease lost while checkpointing");
    await renewIngestionLocks(jobId);
    if (page.length < PAGE_SIZE) break;
  }

  const records = await getRecordsForRevision(ctx.tenantId, ctx.accountId, batchId, revision);
  // Compare Mongo's unique staged rows with the unique source identities that
  // should exist. Raw pages may legitimately repeat a session id.
  if (records.length !== expectedRecordIds.size) {
    throw new Error(
      `incomplete ingestion for ${batchId}: stored ${records.length} of ${expectedRecordIds.size} unique records fetched`,
    );
  }
  const duplicateRows = offset - expectedRecordIds.size;
  if (duplicateRows > 0) {
    log().warn(
      { batchId, fetchedRows: offset, uniqueRecords: records.length, duplicateRows },
      "[worker] duplicate upstream record ids deduplicated",
    );
  }
  // Upstream says this campaign dispatched contacts, and pagination returned
  // nothing at all. Publishing that as a complete revision is what puts a green
  // "Up to date" over an empty Analytics screen: the batch looks ingested, the
  // only evidence sits in a warning nobody reads, and the failure then conceals
  // itself — the empty revision commits, `total` collapses to the ingested 0,
  // and the next run has no figure left to notice the gap with. `sourceTotal`
  // is read alongside `reportedTotal` for exactly that reason: it survives a
  // commit, so a batch already poisoned by an earlier empty publish is still
  // caught here.
  //
  // Only for a job we can prove finished dialling: `jobFinishedDialling`
  // keeps a still-running, cancelled or unreadable job out of this entirely,
  // because reporting "Sync failed" on a campaign the customer has only just
  // launched, or deliberately cancelled, is a worse bug than the one being
  // fixed. A resumed batch has staged rows and so does not reach
  // `records.length === 0`; fetching the job on resume (for dispatch_type) does
  // not change that. It is checked before the completeness decision below.
  //
  // Throwing marks a never-ingested batch "error", and — for a batch already
  // poisoned by an earlier empty publish — `failBatchIfOwned` recognises that
  // its published revision is this same fault and errors it too rather than
  // resolving it back to "ready". Any other published revision stays readable,
  // because a failed refresh has not invalidated the good data behind it.
  const dispatched = Math.max(reportedTotal, batch.sourceTotal ?? 0);
  if (isEmptyDispatchedPull(records.length, dispatched) && jobFinishedDialling(sourceJob)) {
    log().error(
      {
        batchId,
        selType: batch.selType,
        channel: batch.channel,
        dispatched,
        sourceId: batch.sourceId,
        sourceStatus: sourceJob?.status ?? null,
      },
      "[worker] upstream returned no records for a batch it reports as dispatched",
    );
    throw new Error(
      `no records returned for ${batchId}: upstream reports ${dispatched} dispatched contacts ` +
        `but returned no records for this ${batch.selType} batch`,
    );
  }
  // Completeness: fewer UNIQUE records than the list surface itself counts.
  //
  // Core pages its lists with LIMIT/OFFSET ordered by a non-unique `created_at`
  // (a dispatch chunk is one multi-row INSERT, so its rows share a timestamp).
  // Postgres then sorts each page with a top-N heapsort whose bound is
  // OFFSET+LIMIT, so the order among tied rows differs from one page request to
  // the next — and that loses rows DETERMINISTICALLY, with no writes at all:
  // measured on Postgres 16, 3,600 tied rows paged 100 at a time came back as
  // 3,584 unique, identical on every pass, and the union of three passes was
  // still 3,584. Concurrent UPDATEs (status callbacks) are a secondary cause.
  // The raw row count still equals `total`, so deduping hides the duplicates
  // and publishing then hides the loss: an 8,232-call campaign was served as
  // 8,038 rows under a green label. Re-pulling cannot fix that, so this makes
  // ONE pass and decides what to serve.
  //
  // Only for a job whose row set has stopped growing (`jobStoppedAddingRows`):
  // while upstream is still dispatching, the COUNT and the pages legitimately
  // move apart, so a short pull there is published as before, stamped short
  // (so the next refresh re-pulls it) and flagged nowhere.
  //
  // Not keyed on duplicates: duplicates with a complete set are harmless, and
  // loss can occur on a pass with none. More unique records than the total is
  // not loss — rows can only have been added between the COUNT and the pages.
  //
  // A short pull fails nothing. If readers are already served a revision that
  // holds MORE records, that one is kept, the batch is marked stale with the
  // shortfall recorded, and the job moves on to its other batches. If they are
  // served exactly these records already, nothing is written but the flag.
  // Otherwise — a first-ever pull, or a refresh over a revision no fuller than
  // this one and different from it —
  // the short pull is published, flagged with the same record, because a
  // partial dataset with "N of M" on it beats no dataset for a customer who
  // cannot be made to wait for an upstream deploy. Either way the job reports a
  // warning, `BatchDoc.shortPull` puts the shortfall in front of every reader,
  // and `needsCompletenessRepull` keeps the batch re-pullable; the first
  // complete pull clears it.
  //
  // Content fingerprint of exactly what this pull would publish. Computed before
  // the completeness decision because that decision uses it: a short pull whose
  // fingerprint equals the published revision's is the same dataset, and is not
  // written again (see `unchanged` below). It covers every field of every
  // record except storage metadata (see record-fingerprint.ts) — a hand-picked
  // field list here once left out recording URLs, transcripts and outcomes, so
  // a recording that arrived after the campaign finished was never delivered.
  const freshFp = recordsContentFingerprint(records);
  let shortPull: PullShortfall | null = null;
  let shortfallWarning: JobWarning | undefined;
  if (jobStoppedAddingRows(sourceJob) && isIncompletePaginatedPull(records.length, listedTotal)) {
    const listed = listedTotal ?? 0;
    const readable = isBatchReadable(batch);
    // `batch.total` is the served revision's record count once one is
    // readable. A revision holding MORE records is kept in place of this pull:
    // the customer already had more. The empty-pull fault revision has a total
    // of 0 and so can never be kept over anything.
    const keptPrevious = readable && batch.total > records.length;
    // A short pull that matches the served revision record for record — same
    // count, same content fingerprint — is not written either. This is the
    // common case against a core without the `id` tiebreak: the loss is
    // deterministic, so every re-pull of a finished job returns the identical
    // short set, and publishing it would write a complete duplicate dataset
    // (and later reclaim the old one) to change nothing a reader can see. Every
    // merge, per-campaign download and Refresh of a flagged batch did exactly
    // that until this check existed.
    //
    // Gated on the fingerprint rather than on the count alone because a tie is
    // not always "nothing new": the job's row set is fixed, but its rows'
    // statuses, costs, receipts and post-call fields can still move after it
    // finishes, and those are what the fingerprint covers. A tie that carries
    // such a change publishes as before, so a refresh still delivers it; once
    // upstream stops changing, the next tie is identical and writes nothing.
    // A legacy revision fingerprinted by an older formula publishes once and
    // matches from then on.
    const unchanged =
      readable && !keptPrevious && batch.total === records.length && batch.fingerprint === freshFp;
    shortPull = { listed, received: records.length, keptPrevious, detectedAt: new Date().toISOString() };
    const shortfallLog = {
      jobId,
      batchId,
      sourceId: batch.sourceId,
      dispatchType,
      sourceStatus: sourceJob?.status ?? null,
      listedTotal: listed,
      uniqueRecords: records.length,
      missingRecords: listed - records.length,
      duplicateRows,
      servedRecords: keptPrevious ? batch.total : records.length,
      keptPrevious,
    };
    const warning: JobWarning = {
      kind: "incomplete_upstream",
      batchId,
      name: batch.name ?? batchId,
      listed,
      received: records.length,
      keptPrevious,
      served: keptPrevious ? batch.total : records.length,
      message: shortfallMessage(batch.name ?? batchId, shortPull),
    };
    if (keptPrevious || unchanged) {
      log().warn(
        { ...shortfallLog, unchanged },
        keptPrevious
          ? "[worker] paginated pull came back short of upstream's total; keeping the fuller published revision"
          : "[worker] paginated pull came back short of upstream's total and identical to the published revision; nothing written",
      );
      // An identical pull describes the published revision exactly, so it may
      // refresh what that revision is recorded as built from — the same stamps
      // a publish would have written. A strictly fuller kept revision was built
      // from an earlier pull and keeps its own.
      const stamps = unchanged
        ? {
            ingestedListedTotal: listed,
            ingestedSourceFingerprint: batch.sourceFingerprint,
            ingestedRecordsStamp: recordsStamp,
            sourceTotal: sourceJob?.total_contacts ?? batch.sourceTotal,
          }
        : undefined;
      if (!(await keepPublishedRevisionIfOwned(ctx.tenantId, ctx.accountId, batchId, jobId, leaseId, shortPull, stamps))) {
        throw new Error("job lease lost while keeping the published revision");
      }
      // The staged copy is never going to be published. Guarded for the one
      // case where it already is (a resumed job re-reading its own revision):
      // the in-memory `batch` is a fast path, and `deleteUnpublishedBatchRevision`
      // re-reads the batch before deleting, so a revision that became the
      // published one after `batch` was read can never be deleted from under
      // its readers.
      if (batch.publishedRevision !== revision) {
        await deleteUnpublishedBatchRevision(ctx.tenantId, ctx.accountId, batchId, revision).catch((error) => {
          log().warn({ error, batchId }, "[worker] unpublished short revision cleanup deferred to the orphan sweep");
        });
      }
      const done = completedDone + batch.total;
      const transitioned = await checkpointJob(jobId, leaseId, { done, cursor: 0, batchIndex: batchIndex + 1 });
      if (!transitioned) throw new Error("job lease lost during batch transition");
      return { done, warning };
    }
    log().warn(shortfallLog, "[worker] paginated pull came back short of upstream's total; publishing it flagged incomplete");
    shortfallWarning = warning;
  }
  if (reportedTotal !== records.length) {
    log().warn(
      {
        batchId,
        reportedTotal,
        listedTotal: listedTotal ?? null,
        actualTotal: records.length,
        duplicateRows,
        sourceStatus: sourceJob?.status ?? null,
      },
      "[worker] upstream total differed from paginated record count",
    );
  }
  const rebuilt = buildBatchDoc(records, ctx, {
    batchId: batch.batchId,
    sourceId: batch.sourceId,
    name: batch.name,
    channel: batch.channel,
    callType: batch.callType,
    selType: batch.selType,
    dispatchType: normalizeJobDispatchType(sourceJob?.dispatch_type) ?? batch.dispatchType,
    provider: batch.provider,
    date: batch.date,
    // `total` below is the exact record count; this is the dispatched figure,
    // which is upstream's and must survive publication — dropping it here
    // would let the next listing re-derive it and lose it again on the commit
    // after that. Prefer the detail payload just fetched over the copy the last
    // campaigns listing left on the doc, and never let either absence overwrite
    // a figure already held.
    sourceTotal: sourceJob?.total_contacts ?? batch.sourceTotal,
    fingerprint: freshFp,
    sourceFingerprint: batch.sourceFingerprint,
    // Stamp what this revision was built from. The fingerprint is what later
    // listings compare against to flag the batch stale; the timestamp is what a
    // refresh checks before deciding it has nothing to pull.
    //
    // The fingerprint comes from the batch document — i.e. from the LIST payload
    // the campaigns route last saw — and not from the detail payload fetched
    // just above for `recordsStamp`, even though that one is fresher. A
    // fingerprint is only meaningful against another fingerprint of the same
    // shape: `/bulk-dispatch-jobs` and `/bulk-dispatch-jobs/{id}` are separate
    // endpoints whose summary fields (`status_summary`, `call_status_counts`)
    // need not agree, so stamping a detail-derived value would make the very
    // next listing compute a different fingerprint and mark this batch stale
    // forever, on every batch, immediately after a successful ingestion.
    //
    // Being a listing behind instead is the safe direction: a source change that
    // landed mid-ingestion shows up as "stale" on the next listing, and the
    // refresh that follows is no longer skippable (see refreshableBatchIds,
    // which never skips a stale batch), so the two signals converge on the next
    // pull rather than deadlocking.
    ingestedSourceFingerprint: batch.sourceFingerprint,
    ingestedRecordsStamp: recordsStamp,
    // What the list surface counted for this pull, so the published revision
    // can later be judged complete or not (publishedRevisionMayBeShort). A
    // surface that reported no total made no claim of loss, so the pull is
    // stamped with what it returned rather than left unstamped: unstamped
    // falls back to the contact count, which a partially-failed campaign never
    // reaches, and the batch would then be re-pulled on every merge forever.
    ingestedListedTotal: listedTotal ?? records.length,
    // Null on a complete pull, which is what clears a previous flag.
    shortPull,
    publishedRevision: revision,
    // A revision that may be short reads "stale" from the moment it is
    // published rather than waiting for the next listing to say so: readable,
    // and never skipped by a refresh.
    ingestStatus:
      shortPull || isIncompletePaginatedPull(records.length, listedTotal) ? "stale" : "ready",
    total: records.length,
  });
  // Prove ownership immediately before publication. The conditional batch
  // write below closes the remaining lease-expiry window during fingerprinting.
  const ownership = await checkpointJob(jobId, leaseId, {
    done: completedDone + records.length,
    cursor: offset,
    batchIndex,
    leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  if (!ownership) throw new Error("job lease lost before batch publication");
  // One document update switches every reader from the previous immutable
  // revision to the fully validated staging revision.
  if (!(await publishBatchIfOwned(rebuilt, jobId, leaseId))) {
    throw new Error("job lease lost during batch publication");
  }
  const previousRevision = batch.publishedRevision === revision ? undefined : batch.publishedRevision;
  await retireBatchRevision(ctx.tenantId, ctx.accountId, batchId, previousRevision).catch((error) => {
    log().warn({ error, batchId, revision: previousRevision }, "[worker] retired revision marking deferred");
  });
  // Reclaim copies superseded by earlier ingestions of this batch, which are
  // already past the reader grace window. Repeated refreshes therefore cannot
  // stack duplicate datasets — that stacking is what filled the cluster.
  const reclaimed = await deleteSupersededRecordRevisions(
    ctx.tenantId,
    ctx.accountId,
    batchId,
    revision,
  ).catch((error) => {
    log().warn({ error, batchId }, "[worker] superseded revision sweep deferred to cron");
    return 0;
  });
  if (reclaimed > 0) {
    log().info({ batchId, reclaimed }, "[worker] superseded revision rows reclaimed");
  }
  // The copy THIS job just superseded is still inside the grace window, so the
  // sweep above deliberately spared it. Come back for it once the window has
  // passed instead of leaving a full duplicate dataset for the daily cron.
  scheduleSupersededRevisionSweep(ctx, batchId, revision);
  const done = completedDone + records.length;
  const transitioned = await checkpointJob(jobId, leaseId, { done, cursor: 0, batchIndex: batchIndex + 1 });
  if (!transitioned) throw new Error("job lease lost during batch transition");
  log().info({ batchId, records: records.length, durationMs: Date.now() - startedAt }, "[worker] batch ingested");
  return { done, warning: shortfallWarning };
}
