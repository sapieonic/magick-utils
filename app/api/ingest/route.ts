import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext } from "@/lib/server/session";
import { createJob, getBatch } from "@/lib/server/repositories";
import type { Job, JobType } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

/** Enqueue an ingestion (or merge) job for a set of batches. The worker picks it
 *  up, paginates magick-master, normalizes, and persists records to Mongo. */
export const POST = withLogging("ingest", async (req: Request) => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: string[]; type?: JobType };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const batchIds = (body.batchIds ?? []).filter(Boolean);
  if (batchIds.length === 0) {
    return NextResponse.json({ error: "no_batches" }, { status: 400 });
  }
  const type: JobType = body.type === "merge" ? "merge" : "ingest";

  // total = sum of known batch totals (for progress display)
  let total = 0;
  for (const id of batchIds) {
    const b = await getBatch(ctx.tenantId, ctx.accountId, id).catch(() => null);
    total += b?.total ?? 0;
  }

  const session = await getSession();
  const now = new Date().toISOString();
  const job: Job = {
    jobId: randomUUID(),
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
  await createJob(job);
  log().info(
    { jobId: job.jobId, type, batchCount: batchIds.length, total },
    "ingestion job enqueued",
  );
  return NextResponse.json({ jobId: job.jobId, total });
});
