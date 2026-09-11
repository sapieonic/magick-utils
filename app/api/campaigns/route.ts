import { NextResponse } from "next/server";
import { isDashboardRange, inListingRange, type DashboardRange } from "@/lib/date-range";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext } from "@/lib/server/session";
import { MagickClient, MagickApiError, type RawBulkJob } from "@/lib/server/magick-client";
import { getBatch, refreshBatchFromSource } from "@/lib/server/repositories";
import { MAX_SELECTION_BATCHES } from "@/lib/server/selection";
import type { TenantContext } from "@/lib/server/types";
import { batchDocToBatch, bulkJobToBatchDoc } from "@/lib/server/map";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

/** Hard ceiling on how many bulk-dispatch jobs one listing will pull from
 *  magick-master (25 upstream pages of 100). The `/bulk-dispatch-jobs` endpoint
 *  takes no date parameters and guarantees no ordering, so an out-of-range job
 *  is NOT proof that later pages are out of range too — we cannot stop early and
 *  must page through and filter here. This bound is what keeps "All time" from
 *  becoming an unbounded loop against a live upstream; reaching it is reported
 *  to the client as `truncated` (a server log alone is invisible to the customer,
 *  who would otherwise read a capped listing as "my old data is gone"). */
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
  return inListingRange(created, range, now);
}

/** Parse the `ids` query param. Returns null when absent (a full listing) and a
 *  deduped list when present, including the empty list for `?ids=` — asking for
 *  no campaigns is a valid, cheap answer, not a request for all of them. */
function parseIdsParam(raw: string | null): string[] | null {
  if (raw == null) return null;
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
}

/** Refresh each job's cached BatchDoc and return them in the frontend shape.
 *  Chunked instead of one big Promise.all: see REFRESH_CONCURRENCY. */
async function refreshJobsToBatches(ctx: TenantContext, jobs: RawBulkJob[]) {
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
  return docs
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map(batchDocToBatch)
    .sort((a, b) => a.dayAgo - b.dayAgo);
}

/** An expired/invalid magick-master token surfaces as a 401. The stored session
 *  is now useless, so clear it and signal the client to re-login rather than
 *  masking it as a generic upstream failure. */
async function upstreamErrorResponse(err: unknown) {
  if (err instanceof MagickApiError && err.status === 401) {
    const session = await getSession();
    session.destroy();
    log().warn({ err }, "campaigns fetch hit 401 — session expired, cleared");
    return NextResponse.json({ error: "session_expired", detail: String(err) }, { status: 401 });
  }
  log().error({ err }, "campaigns fetch failed");
  return NextResponse.json({ error: "fetch_failed", detail: String(err) }, { status: 502 });
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
  // meaning: every campaign we can reach. A value we don't recognise (a stale
  // sessionStorage range from an older build, a hand-edited URL) is treated the
  // same way: widening to "All time" shows too much, 400-ing shows nothing and
  // dead-ends the screen.
  const requested = new URL(req.url).searchParams.get("range");
  const range: DashboardRange = requested && isDashboardRange(requested) ? requested : "All time";
  if (requested && !isDashboardRange(requested)) {
    log().warn({ requested }, "campaigns got an unknown range — listing all time instead");
  }

  const client = new MagickClient(ctx);

  // Resolving a known selection does not need — and must not pay for — a full
  // inventory scan. Analytics arrives holding the ids the customer picked; it
  // only wants their names and totals. Paging thousands of unrelated jobs to
  // find a handful of them is slow, and worse, a scan that hit its cap made
  // those ids look deleted ("no longer available") when they were sitting in
  // Mongo the whole time. Fetching them directly cannot be truncated.
  const requestedIds = parseIdsParam(new URL(req.url).searchParams.get("ids"));
  if (requestedIds) {
    if (requestedIds.length === 0) return NextResponse.json({ batches: [], truncated: false });
    if (requestedIds.length > MAX_SELECTION_BATCHES) {
      return NextResponse.json({ error: "too_many_batches" }, { status: 400 });
    }
    try {
      const jobs = (
        await Promise.all(
          requestedIds.map((id) =>
            // A batch the customer can no longer see upstream is simply absent
            // from the result; the screen reports that per id rather than
            // failing the whole selection over one of them.
            client.getBulkJob(id).catch((err) => {
              if (err instanceof MagickApiError && err.status === 404) return null;
              throw err;
            }),
          ),
        )
      ).filter((job): job is RawBulkJob => Boolean(job));
      const batches = await refreshJobsToBatches(ctx, jobs);
      log().info({ requested: requestedIds.length, batchCount: batches.length }, "campaigns resolved by id");
      return NextResponse.json({ batches, truncated: false });
    } catch (err) {
      return upstreamErrorResponse(err);
    }
  }

  try {
    const now = new Date();
    const jobs: RawBulkJob[] = [];
    // The upstream is paged by offset but guarantees no ordering, so the same job
    // can be served on two pages. Undeduped it would race two upserts on one key
    // and put two rows with the same id in the table.
    const seen = new Set<string>();
    let scanned = 0;
    let truncated = false;
    for await (const job of client.iterateBulkJobs()) {
      scanned += 1;
      const sourceId = (job.id ?? "").toString();
      if (sourceId && !seen.has(sourceId)) {
        seen.add(sourceId);
        if (jobInRange(job, range, now)) jobs.push(job);
      }
      if (scanned >= MAX_BULK_JOBS_SCANNED) {
        truncated = true;
        break;
      }
    }
    if (truncated) {
      log().warn(
        { scanned, cap: MAX_BULK_JOBS_SCANNED, range },
        "campaigns scan cap reached — older jobs may be missing from this listing",
      );
    }

    const batches = await refreshJobsToBatches(ctx, jobs);
    log().info(
      { jobCount: jobs.length, scanned, range, batchCount: batches.length, truncated },
      "campaigns listed",
    );
    // `truncated` is the client's only way to tell "you have no campaigns here"
    // apart from "we stopped looking" — the screen says so rather than showing a
    // bare empty state.
    return NextResponse.json({ batches, truncated });
  } catch (err) {
    return upstreamErrorResponse(err);
  }
});
