import { NextResponse } from "next/server";
import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getRecords, setAggregates } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";
import { aggregatesKey } from "@/lib/server/fingerprint";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Compute (or return cached) analytics aggregates for a set of batches.
 *  Requires the batches to have been ingested (records present in Mongo). */
export const POST = withLogging("analytics", async (req: Request) => {
  if (!isBackendConfigured()) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: string[]; refresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const batchIds = (body.batchIds ?? []).filter(Boolean);
  if (batchIds.length === 0) return NextResponse.json({ error: "no_batches" }, { status: 400 });

  const key = aggregatesKey(batchIds);
  if (!body.refresh) {
    const cached = await getAggregates(ctx.tenantId, ctx.accountId, key);
    if (cached) {
      log().info({ batchCount: batchIds.length, key, cached: true }, "analytics served from cache");
      return NextResponse.json({ aggregates: cached, cached: true });
    }
  }

  const records = await getRecords(ctx.tenantId, ctx.accountId, batchIds);
  if (records.length === 0) {
    log().warn({ batchCount: batchIds.length }, "analytics requested for un-ingested batches");
    return NextResponse.json({ error: "not_ingested", message: "Run ingestion for these batches first." }, { status: 409 });
  }
  const agg = computeAggregates(records, batchIds, ctx, key);
  await setAggregates(agg);
  log().info(
    { batchCount: batchIds.length, recordCount: records.length, key, refresh: Boolean(body.refresh) },
    "analytics aggregates computed",
  );
  return NextResponse.json({ aggregates: agg, cached: false });
});
