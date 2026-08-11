// In-process ingestion worker. Boots from instrumentation.ts on the long-running
// Node host, tails the `jobs` collection, and processes ingest/merge jobs:
// paginates magick-master, normalizes records, writes them to Mongo, and rebuilds
// the BatchDoc summary. Insights/chat run synchronously in their route handlers.

import { checkpointJob, claimNextJob, deleteBatchRecords, getBatch, getRecords, replaceBatchRecords, updateClaimedJob, upsertBatch } from "./repositories";
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
  }
}

export async function processJob(job: Job) {
  if (!job.idToken) throw new Error("job has no idToken; cannot call magick-master");
  const ctx: TenantContext = { idToken: job.idToken, tenantId: job.tenantId, accountId: job.accountId };
  const client = new MagickClient(ctx);
  if (!job.leaseId) throw new Error("job has no leaseId; cannot process without ownership");

  let done = job.done ?? 0;
  const startBatch = job.batchIndex ?? 0;
  for (let batchIndex = startBatch; batchIndex < job.batchIds.length; batchIndex += 1) {
    const batchId = job.batchIds[batchIndex];
    const batchDone = job.cursor ?? 0;
    const completedDone = done - batchDone;
    const batchRows = await ingestBatch(client, ctx, job.jobId, job.leaseId, batchId, batchIndex, batchDone, completedDone);
    done = completedDone + batchRows;
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
  initialDone: number,
): Promise<number> {
  const batch = await getBatch(ctx.tenantId, ctx.accountId, batchId);
  if (!batch) throw new Error(`batch ${batchId} not found (list campaigns first)`);

  const startedAt = Date.now();
  log().info({ batchId, offset: initialOffset, selType: batch.selType, channel: batch.channel }, "[worker] ingesting batch");
  await upsertBatch({ ...batch, ingestStatus: "ingesting", updatedAt: new Date().toISOString() });
  if (initialOffset === 0) await deleteBatchRecords(ctx.tenantId, ctx.accountId, batchId);

  let offset = initialOffset;
  for (;;) {
    let page: NormalizedRecord[];
    let total = 0;
    if (batch.selType === "message") {
      const response = await client.listMessages({ batchId: batch.sourceId, limit: PAGE_SIZE, offset });
      total = response.total ?? 0;
      const channel = batch.channel as "whatsapp" | "telegram" | "email";
      page = (response.messages ?? []).map((raw) => normalizeMessage(raw, ctx, { channel, batchId, fingerprint: batch.fingerprint }));
    } else {
      const params = batch.sourceId ? { jobId: batch.sourceId } : { batchId };
      const response = await client.listCalls({ ...params, limit: PAGE_SIZE, offset });
      total = response.total ?? 0;
      const selType = batch.selType as "ai" | "ivr";
      page = (response.calls ?? []).map((raw) => normalizeCall(raw, ctx, { selType, batchId, fingerprint: batch.fingerprint }));
    }
    if (page.length === 0) break;
    await replaceBatchRecords(ctx.tenantId, ctx.accountId, batchId, page);
    offset += page.length;
    const checkpoint = await checkpointJob(jobId, leaseId, {
      done: initialDone + offset,
      cursor: offset,
      batchIndex,
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    });
    if (!checkpoint) throw new Error("job lease lost while checkpointing");
    if (page.length < PAGE_SIZE || (total > 0 && offset >= total)) break;
  }

  const records = await getRecords(ctx.tenantId, ctx.accountId, [batchId]);
  const freshFp = fingerprint([
    records.length,
    ...records
      .map((r) => r.status)
      .sort()
      .filter((s, i, a) => a.indexOf(s) === i)
      .map((s) => `${s}:${records.filter((r) => r.status === s).length}`),
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
    ingestStatus: "ready",
    total: records.length || batch.total,
  });
  await upsertBatch(rebuilt);
  const transitioned = await checkpointJob(jobId, leaseId, { done: initialDone + offset, cursor: 0, batchIndex: batchIndex + 1 });
  if (!transitioned) throw new Error("job lease lost during batch transition");
  log().info({ batchId, records: records.length, durationMs: Date.now() - startedAt }, "[worker] batch ingested");
  return offset;
}
