import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env, isBackendConfigured, isCronConfigured } from "@/lib/server/env";
import {
  deleteAggregatesOlderThan,
  deleteInsightsOlderThan,
  deleteTerminalJobsOlderThan,
} from "@/lib/server/repositories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

// Retention windows. Each collection is a regenerable cache or operational
// history, so pruning keeps the Atlas free-tier storage + indexes small.
const AGGREGATES_RETENTION_DAYS = 7; // recomputed on the next analytics request
const JOBS_RETENTION_DAYS = 1; // done/error jobs are just history once polled
const INSIGHTS_RETENTION_DAYS = 30; // regen costs an LLM call, so keep longer

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
 * (`.github/workflows/cleanup.yml`). Prunes stale cached/derived data so the
 * free-tier Mongo stays small. Runs without a user session, so it is guarded by
 * a shared Bearer secret (CRON_SECRET) instead of the tenant cookie.
 */
export async function POST(req: Request) {
  if (!isBackendConfigured())
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  if (!isCronConfigured())
    return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (!isAuthorized(req))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = Date.now();
  const cutoff = (days: number) => new Date(now - days * DAY_MS).toISOString();

  const [aggregates, jobs, insights] = await Promise.all([
    deleteAggregatesOlderThan(cutoff(AGGREGATES_RETENTION_DAYS)),
    deleteTerminalJobsOlderThan(cutoff(JOBS_RETENTION_DAYS)),
    deleteInsightsOlderThan(cutoff(INSIGHTS_RETENTION_DAYS)),
  ]);

  return NextResponse.json({ ok: true, deleted: { aggregates, jobs, insights } });
}
