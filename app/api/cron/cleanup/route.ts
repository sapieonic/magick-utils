import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env, isBackendConfigured, isCronConfigured } from "@/lib/server/env";
import {
  deleteAggregatesOlderThan,
  deleteBatchDataOlderThan,
  deleteInsightsOlderThan,
  deleteJobsOlderThan,
  deleteRetiredRecordRevisionsOlderThan,
  SUPERSEDED_REVISION_GRACE_MS,
} from "@/lib/server/repositories";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

// One retention window for all persisted application data. Cached data can be
// regenerated; source batches older than this are removed together with every
// normalized record they own — which also makes this the limit on how far back
// the Dashboard and Analytics can see. Configured via DATA_RETENTION_DAYS.
const RETENTION_DAYS = env.dataRetentionDays;

/** Constant-time Bearer-token check against CRON_SECRET. */
function isAuthorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = env.cronSecret;
  // Length check first: timingSafeEqual throws on differing-length buffers.
  if (!token || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/**
 * Daily housekeeping endpoint, triggered by the GitHub Actions cron
 * (`.github/workflows/cleanup.yml`). Enforces the global retention window so
 * the free-tier Mongo stays small. Runs without a user session, so it is guarded
 * by a shared Bearer secret (CRON_SECRET) instead of the tenant cookie.
 */
export const POST = withLogging("cron/cleanup", async (req: Request) => {
  if (!isBackendConfigured())
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  if (!isCronConfigured())
    return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (!isAuthorized(req)) {
    log().warn("cron cleanup rejected — bad or missing CRON_SECRET");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const cutoff = (days: number) => new Date(now - days * DAY_MS).toISOString();

  const retentionCutoff = cutoff(RETENTION_DAYS);
  const [aggregates, jobs, insights, batchData] = await Promise.all([
    deleteAggregatesOlderThan(retentionCutoff),
    deleteJobsOlderThan(retentionCutoff),
    deleteInsightsOlderThan(retentionCutoff),
    deleteBatchDataOlderThan(retentionCutoff),
  ]);
  // Run after the batch cascade so records removed with an expired batch are
  // counted as batch data, not nondeterministically as retired revisions.
  //
  // Retired revisions are superseded duplicates no reader can reach, so they go
  // on the short grace window rather than the retention window — they are dead
  // weight the moment a newer revision is published, and keeping them for days
  // is what let repeated refreshes exhaust the cluster's storage. The worker
  // already reclaims them inline after each ingestion; this catches whatever a
  // crash mid-publish left behind.
  const recordRevisions = await deleteRetiredRecordRevisionsOlderThan(
    new Date(now - SUPERSEDED_REVISION_GRACE_MS),
  );

  const deleted = {
    aggregates,
    jobs,
    insights,
    batches: batchData.batches,
    records: batchData.records,
    recordRevisions,
  };
  log().info({ deleted }, "cron cleanup pruned stale data");
  return NextResponse.json({ ok: true, deleted });
});
