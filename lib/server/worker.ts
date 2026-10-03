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
  deleteCarriedRecords,
  deleteOrphanedRecordRevisions,
  deleteSupersededRecordRevisions,
  deleteUnpublishedBatchRevision,
  failBatchIfOwned,
  getBatch,
  getRecordsForRevision,
  getRevisionRecordsMissingFrom,
  keepPublishedRevisionIfOwned,
  publishBatchIfOwned,
  releaseIngestionLocks,
  renewIngestionLocks,
  retireBatchRevision,
  replaceBatchRecords,
  SUPERSEDED_REVISION_GRACE_MS,
  updateClaimedJob,
} from "./repositories";
import {
  LEGACY_LIST_ORDER,
  listOrderToken,
  MagickApiError,
  MagickClient,
  normalizeJobDispatchType,
  resolveJobDispatchType,
} from "./magick-client";
import {
  idTokenNeedsRefresh,
  mintIdToken,
  TokenRefreshPermanentError,
  TokenRefreshTransientError,
  type MintedToken,
} from "./firebase-token";
import { isTokenRefreshConfigured } from "./env";
import { buildBatchDoc, normalizeCall, normalizeMessage } from "./normalize";
import { jobFinishedDialling, jobStoppedAddingRows } from "./job-state";
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
    // `ingestBatch` writes this batch's warning (or its withdrawal) in the SAME
    // checkpoint that advances `batchIndex` past the batch — see
    // `withBatchWarning` — so what is returned here is already durable.
    const outcome = await ingestBatch(
      client,
      ctx,
      job.jobId,
      leaseId,
      batchId,
      batchIndex,
      job.cursor ?? 0,
      job.cursorOrder,
      completedDone,
      warnings,
    );
    done = outcome.done;
    completedDone = done;
    job.cursor = 0;
    job.cursorOrder = undefined;
    warnings = outcome.warnings;
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

/** The job's warnings after `batchId` finished, and whether they changed.
 *
 *  One entry per batch: a batch re-ingested on resume replaces what an earlier
 *  run said about it, including clearing it if this pull was whole.
 *
 *  Written by the caller in the same checkpoint that moves `batchIndex` past
 *  the batch, never afterwards. The two used to be separate writes — the
 *  transition first, the warning once `ingestBatch` returned — and a lease
 *  loss, deploy or kill between them resumed the job PAST the batch, so the
 *  warning was never written; Analytics then treats every batch of the job as
 *  covered by its warnings and suppressed the listing's shortfall too, so the
 *  notice vanished entirely. */
function withBatchWarning(
  warnings: readonly JobWarning[],
  batchId: string,
  warning: JobWarning | undefined,
): { warnings: JobWarning[]; changed: boolean } {
  const had = warnings.some((existing) => existing.batchId === batchId);
  if (!warning && !had) return { warnings: [...warnings], changed: false };
  return {
    warnings: [...warnings.filter((existing) => existing.batchId !== batchId), ...(warning ? [warning] : [])],
    changed: true,
  };
}

async function ingestBatch(
  client: MagickClient,
  ctx: TenantContext,
  jobId: string,
  leaseId: string,
  batchId: string,
  batchIndex: number,
  initialOffset: number,
  initialOrder: string | undefined,
  completedDone: number,
  priorWarnings: readonly JobWarning[],
): Promise<{ done: number; warnings: JobWarning[] }> {
  const batch = await getBatch(ctx.tenantId, ctx.accountId, batchId);
  if (!batch) throw new Error(`batch ${batchId} not found (list campaigns first)`);

  const startedAt = Date.now();
  log().info({ batchId, offset: initialOffset, cursorOrder: initialOrder ?? null, selType: batch.selType, channel: batch.channel }, "[worker] ingesting batch");
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
  // refresh would skip it forever. Master serves this from a few-second cache:
  // a cached value is never newer than the truth, so what we stamp here cannot
  // claim a change we did not pull — but the COMPARING read in the ingest route
  // can see an older value too, and skip a write made in the last few seconds
  // until the next refresh. Bounded by master's cache TTL, not zero. Only a pull that starts at offset 0 gets one: a resumed job would
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
  const dispatchType = resolveJobDispatchType(sourceJob, batch);
  const revision = jobId;
  const listOrder = listOrderToken(dispatchType);
  // A resumed pull may only append pages fetched under the ordering its staged
  // pages were fetched under: the cursor is a raw OFFSET into one ORDER BY, and
  // continuing it under another skips and repeats arbitrary rows (ascending and
  // descending lose different tied rows on a core without the `id` tiebreak).
  // That is exactly a job checkpointed by a build that sent no sort parameter
  // (server default, newest-first) and resumed by one that pages oldest-first.
  // Start the revision again from offset 0 instead — it costs the pages already
  // fetched, nothing else.
  //
  // Not when the staged revision is already the PUBLISHED one (a job resumed
  // between publishing and its batch transition): that pull completed under a
  // single ordering, and restarting would delete its rows from under readers.
  let startOffset = initialOffset;
  const stagedOrder = initialOrder ?? LEGACY_LIST_ORDER;
  if (startOffset > 0 && stagedOrder !== listOrder && batch.publishedRevision !== revision) {
    log().warn(
      { batchId, stagedOrder, listOrder, discardedOffset: startOffset },
      "[worker] staged pages were fetched under a different list ordering; restarting the batch from offset 0",
    );
    startOffset = 0;
    // `checkpointJob` refuses to move `done` backwards, and the staged pages are
    // about to be discarded, so progress is reset through the lease-guarded
    // update instead. `cursorOrder` is written with it so a crash before the
    // first page cannot make the next resume repeat this decision wrongly.
    if (!(await updateClaimedJob(jobId, leaseId, { done: completedDone, cursor: 0, cursorOrder: listOrder }))) {
      throw new Error("job lease lost while restarting the batch under a new list ordering");
    }
  }
  const recordsStamp = startOffset === 0 ? bulkJobRecordsStamp(sourceJob) : null;

  const revisionCreatedAt = new Date();
  if (startOffset === 0) {
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
  const stagedRecords = startOffset > 0
    ? await getRecordsForRevision(ctx.tenantId, ctx.accountId, batchId, revision)
    : [];
  // Rows a previous attempt of this job CARRIED into the staging revision were
  // not returned by upstream, so they must not count as fetched.
  const expectedRecordIds = new Set(
    stagedRecords.filter((record) => record.carriedFrom == null).map((record) => record.recordId),
  );
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
  let offset = startOffset;
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
      cursorOrder: listOrder,
      batchIndex,
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    if (!checkpoint) throw new Error("job lease lost while checkpointing");
    await renewIngestionLocks(jobId);
    if (page.length < PAGE_SIZE) break;
  }

  const stagedNow = await getRecordsForRevision(ctx.tenantId, ctx.accountId, batchId, revision);
  // What this pull returned, apart from any rows a previous attempt of this job
  // carried into the same staging revision before it was interrupted.
  const records = stagedNow.filter((record) => record.carriedFrom == null);
  const stagedCarried = stagedNow.filter((record) => record.carriedFrom != null);
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
  // Not keyed on duplicates: duplicates with a complete set are harmless, and
  // loss can occur on a pass with none. More unique records than the total is
  // not loss — rows can only have been added between the COUNT and the pages.
  //
  // A short pull fails nothing, and it never takes a record away from a reader:
  //
  // 1. CARRY FORWARD. Every record the served revision holds that this pull did
  //    not return is copied into the new revision (`carriedFrom` marks it), so
  //    what is served is this pull's records — fresh — plus the rest of what
  //    readers already had. "Keep whichever revision has more records" was not
  //    enough: two short pulls can each hold rows the other lacks (ascending and
  //    descending order lose DIFFERENT tied rows, and a running job's snapshots
  //    differ), so a pull with more records could still drop rows a customer
  //    had, and a kept revision froze every status in it. Carried rows may be
  //    behind on status — the price of not deleting them on the word of a pull
  //    known to be incomplete — and a row genuinely removed upstream stays until
  //    the first complete pull, which publishes exactly what upstream lists.
  // 2. UNCHANGED → WRITE NOTHING. If the result is the served revision record
  //    for record (same count, same content fingerprint), nothing is written
  //    but the flag and the built-from stamps. That is the common case against
  //    a core without the `id` tiebreak — every re-pull of a finished job is the
  //    identical short set — and it holds whatever the job's state: a running
  //    job re-pulled before anything moved is just as unchanged.
  // 3. Otherwise the result is published, flagged.
  //
  // Either way `BatchDoc.shortPull` records the observation, and its
  // `detectedAt` is what rate-limits merge re-pulls (`shortPullCheckedRecently`)
  // for EVERY incomplete pull. Only a job whose row set has stopped growing
  // (`jobStoppedAddingRows`) gets `settled: true`, the job warning and the
  // reader-facing statement: while upstream may still be dispatching (or its
  // state could not be read, or it stopped moments ago) the COUNT and the pages
  // legitimately move apart, and "upstream returned incomplete data" would be
  // false. Recording the unsettled gap anyway is what stopped every merge of a
  // running campaign from re-paging upstream and writing another full copy.
  const incomplete = isIncompletePaginatedPull(records.length, listedTotal);
  const readable = isBatchReadable(batch);
  let carried: NormalizedRecord[] = [];
  if (batch.publishedRevision === revision) {
    // Resumed after this job already published the revision: whatever it
    // carried is part of what readers see, so it is part of what is served.
    carried = stagedCarried;
  } else {
    if (stagedCarried.length > 0) {
      // Carried by an interrupted attempt of this job; re-derived below against
      // the revision actually being replaced, or not needed at all.
      await deleteCarriedRecords(ctx.tenantId, ctx.accountId, batchId, revision);
    }
    const previousRevision = batch.publishedRevision;
    if (incomplete && readable && previousRevision) {
      const present = new Set(records.map((record) => record.recordId));
      carried = (
        await getRevisionRecordsMissingFrom(ctx.tenantId, ctx.accountId, batchId, previousRevision, present)
      ).map((record) => ({ ...record, revision, revisionCreatedAt, carriedFrom: previousRevision }));
    }
  }
  const served = carried.length > 0 ? [...records, ...carried] : records;
  // Content fingerprint of exactly what would be served. Computed before the
  // decision because the decision uses it. It covers every field of every
  // record except storage metadata (see record-fingerprint.ts) — a hand-picked
  // field list here once left out recording URLs, transcripts and outcomes, so
  // a recording that arrived after the campaign finished was never delivered.
  const freshFp = recordsContentFingerprint(served);
  let shortPull: PullShortfall | null = null;
  let shortfallWarning: JobWarning | undefined;
  if (incomplete) {
    const listed = listedTotal ?? 0;
    const settled = jobStoppedAddingRows(sourceJob);
    // Gated on the fingerprint rather than the count alone because a tie is
    // not always "nothing new": rows' statuses, costs, receipts and post-call
    // fields can move after a job finishes, and those are what the fingerprint
    // covers. A legacy revision fingerprinted by an older formula publishes
    // once and matches from then on. Never-ingested batches are not readable,
    // so a first pull is always published.
    const unchanged = readable && batch.total === served.length && batch.fingerprint === freshFp;
    const recorded: PullShortfall = {
      listed,
      received: records.length,
      carried: carried.length,
      keptPrevious: carried.length > 0,
      settled,
      detectedAt: new Date().toISOString(),
    };
    shortPull = recorded;
    const shortfallLog = {
      jobId,
      batchId,
      sourceId: batch.sourceId,
      dispatchType,
      sourceStatus: sourceJob?.status ?? null,
      settled,
      listedTotal: listed,
      uniqueRecords: records.length,
      missingRecords: listed - records.length,
      carriedRecords: carried.length,
      servedRecords: served.length,
      duplicateRows,
    };
    const warning: JobWarning | undefined = settled
      ? {
          kind: "incomplete_upstream",
          batchId,
          name: batch.name ?? batchId,
          listed,
          received: records.length,
          carried: carried.length,
          keptPrevious: carried.length > 0,
          served: served.length,
          message: shortfallMessage(batch.name ?? batchId, recorded),
        }
      : undefined;
    if (unchanged) {
      log().warn(
        { ...shortfallLog, unchanged },
        settled
          ? "[worker] paginated pull came back short of upstream's total and identical to the published revision; nothing written"
          : "[worker] pull of a job still adding rows came back short and identical to the published revision; nothing written",
      );
      // The served set IS the published revision, so it may take the stamps a
      // publish would have written.
      const stamps = {
        ingestedListedTotal: listed,
        ingestedSourceFingerprint: batch.sourceFingerprint,
        ingestedRecordsStamp: recordsStamp,
        sourceTotal: sourceJob?.total_contacts ?? batch.sourceTotal,
      };
      if (!(await keepPublishedRevisionIfOwned(ctx.tenantId, ctx.accountId, batchId, jobId, leaseId, recorded, stamps))) {
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
      const done = completedDone + served.length;
      const next = withBatchWarning(priorWarnings, batchId, warning);
      const transitioned = await checkpointJob(jobId, leaseId, {
        done,
        cursor: 0,
        batchIndex: batchIndex + 1,
        ...(next.changed ? { warnings: next.warnings } : {}),
      });
      if (!transitioned) throw new Error("job lease lost during batch transition");
      return { done, warnings: next.warnings };
    }
    if (carried.length > 0 && batch.publishedRevision !== revision) {
      // Only now, on the way to publishing: the unchanged path above writes
      // nothing at all, and carrying first would have cost it a full copy.
      await replaceBatchRecords(ctx.tenantId, ctx.accountId, batchId, carried);
    }
    log().warn(
      shortfallLog,
      settled
        ? "[worker] paginated pull came back short of upstream's total; publishing it flagged incomplete"
        : "[worker] pull of a job still adding rows came back short of its total; publishing it re-pullable",
    );
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
  const rebuilt = buildBatchDoc(served, ctx, {
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
    ingestStatus: shortPull ? "stale" : "ready",
    total: served.length,
  });
  // Prove ownership immediately before publication. The conditional batch
  // write below closes the remaining lease-expiry window during fingerprinting.
  //
  // `done` counts PULLED records here, not served ones: a job resumed after
  // this publish re-checkpoints each new page as pulled-so-far, and
  // `checkpointJob` refuses to move `done` backwards — counting carried rows
  // now would make that resume fail its first page checkpoint as a lost lease.
  // The batch transition below adds the carried rows.
  const ownership = await checkpointJob(jobId, leaseId, {
    done: completedDone + records.length,
    cursor: offset,
    cursorOrder: listOrder,
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
  const done = completedDone + served.length;
  const next = withBatchWarning(priorWarnings, batchId, shortfallWarning);
  const transitioned = await checkpointJob(jobId, leaseId, {
    done,
    cursor: 0,
    batchIndex: batchIndex + 1,
    ...(next.changed ? { warnings: next.warnings } : {}),
  });
  if (!transitioned) throw new Error("job lease lost during batch transition");
  log().info({ batchId, records: served.length, carried: carried.length, durationMs: Date.now() - startedAt }, "[worker] batch ingested");
  return { done, warnings: next.warnings };
}
