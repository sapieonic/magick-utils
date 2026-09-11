import { NextResponse } from "next/server";
import { isDashboardRange, inDashboardRange, type DashboardRange } from "@/lib/date-range";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext } from "@/lib/server/session";
import { MagickClient, MagickApiError, type RawBulkJob } from "@/lib/server/magick-client";
import { getBatch, refreshBatchFromSource } from "@/lib/server/repositories";
import { batchDocToBatch, bulkJobToBatchDoc } from "@/lib/server/map";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

/** Hard ceiling on how many bulk-dispatch jobs one listing will pull from
 *  magick-master (25 upstream pages of 100). The `/bulk-dispatch-jobs` endpoint
 *  takes no date parameters and guarantees no ordering, so an out-of-range job
 *  is NOT proof that later pages are out of range too — we cannot stop early and
 *  must page through and filter here. This bound is what keeps "All time" from
 *  becoming an unbounded loop against a live upstream; reaching it is logged
 *  (see below) rather than silently truncating the customer's history. */
const MAX_BULK_JOBS_SCANNED = 2_500;

/** How many jobs are refreshed at once. Each one is a Mongo read plus an upsert,
 *  so fanning the whole (now much larger) list into a single Promise.all would
 *  open hundreds of simultaneous operations on a big account. */
const REFRESH_CONCURRENCY = 25;

/** The date a job is filtered on. Mirrors `bulkJobToBatchDoc`, which falls back
 *  to "now" when the upstream omits `created_at` — so an undated job stays
 *  visible in every range instead of disappearing from all of them. */
function jobInRange(job: RawBulkJob, range: DashboardRange, now: Date): boolean {
  const created = job.created_at;
  if (!created || Number.isNaN(new Date(created).getTime())) return true;
  return inDashboardRange(created, range, now);
}

/** List campaigns/batches for the active workspace. Pulls bulk-dispatch jobs from
 *  magick-master (calls + messages), refreshes the cached BatchDoc summaries, and
 *  returns them in the frontend `Batch` shape. An optional `?range=` narrows the
 *  listing to the Topbar's date range; omitting it means "All time". */
export const GET = withLogging("campaigns", async (req: Request) => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  // Unfiltered callers (Dashboard, Analytics) omit the param and keep the old
  // meaning: every campaign we can reach.
  const range = new URL(req.url).searchParams.get("range") ?? "All time";
  if (!isDashboardRange(range)) return NextResponse.json({ error: "invalid_range" }, { status: 400 });

  const client = new MagickClient(ctx);
  try {
    const now = new Date();
    const jobs: RawBulkJob[] = [];
    let scanned = 0;
    for await (const job of client.iterateBulkJobs()) {
      scanned += 1;
      if (jobInRange(job, range, now)) jobs.push(job);
      if (scanned >= MAX_BULK_JOBS_SCANNED) break;
    }
    if (scanned >= MAX_BULK_JOBS_SCANNED) {
      log().warn(
        { scanned, cap: MAX_BULK_JOBS_SCANNED, range },
        "campaigns scan cap reached — older jobs may be missing from this listing",
      );
    }

    // Chunked instead of one big Promise.all: see REFRESH_CONCURRENCY.
    const docs: Array<Awaited<ReturnType<typeof refreshBatchFromSource>> | null> = [];
    for (let i = 0; i < jobs.length; i += REFRESH_CONCURRENCY) {
      const chunk = await Promise.all(
        jobs.slice(i, i + REFRESH_CONCURRENCY).map(async (job) => {
          const sourceId = (job.id ?? "").toString();
          if (!sourceId) return null;
          // BatchDoc is keyed by sourceId, so this lookup preserves prior ingested
          // figures (spend, exact breakdown) across refreshes.
          const existing = await getBatch(ctx.tenantId, ctx.accountId, sourceId).catch(() => null);
          const doc = bulkJobToBatchDoc(job, ctx, existing);
          return refreshBatchFromSource(doc, existing?.updatedAt ?? null);
        }),
      );
      docs.push(...chunk);
    }
    const batches = docs
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map(batchDocToBatch)
      .sort((a, b) => a.dayAgo - b.dayAgo);
    log().info(
      { jobCount: jobs.length, scanned, range, batchCount: batches.length },
      "campaigns listed",
    );
    return NextResponse.json({ batches });
  } catch (err) {
    // An expired/invalid magick-master token surfaces as a 401. The stored
    // session is now useless, so clear it and signal the client to re-login
    // rather than masking it as a generic upstream failure.
    if (err instanceof MagickApiError && err.status === 401) {
      const session = await getSession();
      session.destroy();
      log().warn({ err }, "campaigns fetch hit 401 — session expired, cleared");
      return NextResponse.json({ error: "session_expired", detail: String(err) }, { status: 401 });
    }
    log().error({ err }, "campaigns fetch failed");
    return NextResponse.json({ error: "fetch_failed", detail: String(err) }, { status: 502 });
  }
});
