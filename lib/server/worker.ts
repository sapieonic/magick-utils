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
  deleteUnpublishedBatchRevision,
  failBatchIfOwned,
  getBatch,
  getRecordsForRevision,
  publishBatchIfOwned,
  releaseIngestionLocks,
  renewIngestionLocks,
  retireBatchRevision,
  replaceBatchRecords,
  updateClaimedJob,
} from "./repositories";
import { MagickApiError, MagickClient } from "./magick-client";
import { buildBatchDoc, normalizeCall, normalizeMessage } from "./normalize";
import { fingerprint } from "./fingerprint";
import type { Job, NormalizedRecord, TenantContext } from "./types";
import { logger, log } from "./logger";
import { runWithRequestContext } from "./observability/request-context";

const PAGE_SIZE = 100;
const IDLE_DELAY_MS = 2500;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const LEASE_MS = 60_000;

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

export async function runClaimedJob(claimed: Job, startedAt = Date.now()) {
  if (!claimed.leaseId) throw new Error("claimed job has no leaseId");
  try {
    await processJob(claimed);
    await releaseIngestionLocks(claimed.jobId).catch((error) => {
      log().warn({ error }, "[worker] completed job lock cleanup deferred to TTL");
    });
    log().info({ durationMs: Date.now() - startedAt }, "[worker] job completed");
  } catch (err) {
    if (err instanceof MagickApiError && err.status === 429) {
      const retryAfterMs = Math.max(err.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, IDLE_DELAY_MS);
      const retryAt = new Date(Date.now() + retryAfterMs).toISOString();
      log().warn({ retryAfterMs, retryAt, durationMs: Date.now() - startedAt }, "[worker] rate limited; job scheduled to resume");
      const scheduled = await updateClaimedJob(claimed.jobId, claimed.leaseId, {
        status: "rate_limited",
        retryAt,
        retryCount: (claimed.retryCount ?? 0) + 1,
        leaseUntil: null,
        leaseId: null,
        error: null,
      });
      if (!scheduled) throw new Error("job lease lost before rate-limit scheduling");
      await renewIngestionLocks(claimed.jobId, retryAfterMs + LEASE_MS).catch((error) => {
        log().warn({ error }, "[worker] rate-limit lock renewal failed; existing lease retained");
      });
      return;
    }
    log().error({ err, durationMs: Date.now() - startedAt }, "[worker] job failed");
    const failed = await updateClaimedJob(claimed.jobId, claimed.leaseId, {
      status: "error",
      leaseUntil: null,
      leaseId: null,
      error: String(err),
    });
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
  const ctx: TenantContext = { idToken: job.idToken, tenantId: job.tenantId, accountId: job.accountId };
  const client = new MagickClient(ctx);
  if (!job.leaseId) throw new Error("job has no leaseId; cannot process without ownership");

  let done = job.done ?? 0;
  const startBatch = job.batchIndex ?? 0;
  // Published revisions are the durable source of truth for completed batches.
  // Job progress can include a partially staged current batch and is therefore
  // not sufficient to recover this value after a crash.
  let completedDone = startBatch > 0
    ? await countRecords(ctx.tenantId, ctx.accountId, job.batchIds.slice(0, startBatch))
    : 0;
  for (let batchIndex = startBatch; batchIndex < job.batchIds.length; batchIndex += 1) {
    const batchId = job.batchIds[batchIndex];
    done = await ingestBatch(
      client,
      ctx,
      job.jobId,
      job.leaseId,
      batchId,
      batchIndex,
      job.cursor ?? 0,
      completedDone,
    );
    completedDone = done;
    job.cursor = 0;
  }

  const result = job.type === "merge" ? { rowCount: done } : undefined;
  const completed = await updateClaimedJob(job.jobId, job.leaseId, { status: "done", done, cursor: 0, batchIndex: job.batchIds.length, leaseUntil: null, leaseId: null, result });
  if (!completed) throw new Error("job lease lost before completion");
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
): Promise<number> {
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
    throw new Error("newer worker owns batch ingestion");
  }
  const revision = jobId;
  const revisionCreatedAt = new Date();
  if (initialOffset === 0) {
    await deleteBatchRevisionRecords(ctx.tenantId, ctx.accountId, batchId, revision);
  }

  let offset = initialOffset;
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
  for (;;) {
    let page: NormalizedRecord[];
    let total = 0;
    if (batch.selType === "message") {
      const response = await client.listMessages({ batchId: batch.sourceId, limit: PAGE_SIZE, offset });
      total = response.total ?? 0;
      const channel = batch.channel as "whatsapp" | "telegram" | "email";
      page = (response.messages ?? []).map((raw) => ({
        ...normalizeMessage(raw, ctx, { channel, batchId, fingerprint: batch.fingerprint }),
        revision,
        revisionCreatedAt,
      }));
    } else {
      const params = batch.sourceId ? { jobId: batch.sourceId } : { batchId };
      const response = await client.listCalls({ ...params, limit: PAGE_SIZE, offset });
      total = response.total ?? 0;
      const selType = batch.selType as "ai" | "ivr";
      page = (response.calls ?? []).map((raw) => ({
        ...normalizeCall(raw, ctx, { selType, batchId, fingerprint: batch.fingerprint }),
        revision,
        revisionCreatedAt,
      }));
    }
    reportedTotal = Math.max(reportedTotal, total);
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
  if (reportedTotal !== records.length) {
    log().warn(
      { batchId, reportedTotal, actualTotal: records.length },
      "[worker] upstream total differed from paginated record count",
    );
  }
  const freshFp = fingerprint([
    records.length,
    ...records
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .map((r) =>
        JSON.stringify([
          r.recordId,
          r.status,
          r.activityTimestamp,
          r.raw?.status,
          r.totalCostInr,
          r.telephonyCostInr,
          r.aiCostInr,
          r.sentiment,
          r.keyTopics,
          r.durationSeconds,
          r.talkTimeSeconds,
          r.replyText,
        ]),
      ),
  ]);
  const rebuilt = buildBatchDoc(records, ctx, {
    batchId: batch.batchId,
    sourceId: batch.sourceId,
    name: batch.name,
    channel: batch.channel,
    callType: batch.callType,
    selType: batch.selType,
    provider: batch.provider,
    date: batch.date,
    fingerprint: freshFp,
    sourceFingerprint: batch.sourceFingerprint,
    publishedRevision: revision,
    ingestStatus: "ready",
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
  const done = completedDone + records.length;
  const transitioned = await checkpointJob(jobId, leaseId, { done, cursor: 0, batchIndex: batchIndex + 1 });
  if (!transitioned) throw new Error("job lease lost during batch transition");
  log().info({ batchId, records: records.length, durationMs: Date.now() - startedAt }, "[worker] batch ingested");
  return done;
}
