// In-process ingestion worker. Boots from instrumentation.ts on the long-running
// Node host, tails the `jobs` collection, and processes ingest/merge jobs:
// paginates magick-master, normalizes records, writes them to Mongo, and rebuilds
// the BatchDoc summary. Insights/chat run synchronously in their route handlers.

import { claimNextJob, getBatch, replaceBatchRecords, updateJob, upsertBatch } from "./repositories";
import { MagickClient } from "./magick-client";
import { buildBatchDoc, normalizeCall, normalizeMessage } from "./normalize";
import { fingerprint } from "./fingerprint";
import type { Job, NormalizedRecord, TenantContext } from "./types";
import { logger } from "./logger";

const PROGRESS_FLUSH = 200;
const IDLE_DELAY_MS = 2500;

let started = false;

export function startWorker() {
  if (started) return;
  started = true;
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
      job = await claimNextJob();
    } catch (err) {
      logger.error({ err }, "[worker] claimNextJob failed");
    }
    if (!job) {
      await sleep(IDLE_DELAY_MS);
      continue;
    }
    try {
      await processJob(job);
    } catch (err) {
      logger.error({ err, jobId: job.jobId }, "[worker] job failed");
      await updateJob(job.jobId, { status: "error", error: String(err) }).catch(() => {});
    }
  }
}

async function processJob(job: Job) {
  if (!job.idToken) throw new Error("job has no idToken; cannot call magick-master");
  const ctx: TenantContext = { idToken: job.idToken, tenantId: job.tenantId, accountId: job.accountId };
  const client = new MagickClient(ctx);

  let done = 0;
  let totalRows = 0;
  for (const batchId of job.batchIds) {
    const rows = await ingestBatch(client, ctx, batchId, async (delta) => {
      done += delta;
      await updateJob(job.jobId, { done });
    });
    totalRows += rows;
  }

  const result = job.type === "merge" ? { rowCount: totalRows } : undefined;
  await updateJob(job.jobId, { status: "done", done: job.total || totalRows, result });
}

/** Ingest one batch: page through upstream records, normalize, persist, and
 *  rebuild the BatchDoc. Returns the number of records ingested. */
async function ingestBatch(
  client: MagickClient,
  ctx: TenantContext,
  batchId: string,
  onProgress: (delta: number) => Promise<void>,
): Promise<number> {
  const batch = await getBatch(ctx.tenantId, ctx.accountId, batchId);
  if (!batch) throw new Error(`batch ${batchId} not found (list campaigns first)`);

  await upsertBatch({ ...batch, ingestStatus: "ingesting", updatedAt: new Date().toISOString() });

  const fp = batch.fingerprint;
  const records: NormalizedRecord[] = [];
  let sinceFlush = 0;

  if (batch.selType === "message") {
    const channel = batch.channel as "whatsapp" | "telegram" | "email";
    for await (const raw of client.iterateMessages({ batchId: batch.sourceId })) {
      records.push(normalizeMessage(raw, ctx, { channel, batchId, fingerprint: fp }));
      if (++sinceFlush >= PROGRESS_FLUSH) {
        await onProgress(sinceFlush);
        sinceFlush = 0;
      }
    }
  } else {
    const selType = batch.selType as "ai" | "ivr";
    // calls are addressable by upstream job_id (preferred) or batch_id
    const params = batch.sourceId ? { jobId: batch.sourceId } : { batchId };
    for await (const raw of client.iterateCalls(params)) {
      records.push(normalizeCall(raw, ctx, { selType, batchId, fingerprint: fp }));
      if (++sinceFlush >= PROGRESS_FLUSH) {
        await onProgress(sinceFlush);
        sinceFlush = 0;
      }
    }
  }
  if (sinceFlush > 0) await onProgress(sinceFlush);

  await replaceBatchRecords(ctx.tenantId, ctx.accountId, batchId, records);

  // recompute a fingerprint from the actual ingested counts so a later refresh
  // can detect drift, and rebuild the summary
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

  return records.length;
}
