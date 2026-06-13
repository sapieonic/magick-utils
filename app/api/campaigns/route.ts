import { NextResponse } from "next/server";
import { isBackendConfigured } from "@/lib/server/env";
import { getSession, getTenantContext } from "@/lib/server/session";
import { MagickClient, MagickApiError } from "@/lib/server/magick-client";
import { getBatch, upsertBatch } from "@/lib/server/repositories";
import { batchDocToBatch, bulkJobToBatchDoc } from "@/lib/server/map";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

/** List campaigns/batches for the active workspace. Pulls bulk-dispatch jobs from
 *  magick-master (calls + messages), refreshes the cached BatchDoc summaries, and
 *  returns them in the frontend `Batch` shape. */
export const GET = withLogging("campaigns", async () => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  const client = new MagickClient(ctx);
  try {
    const { jobs } = await client.listBulkJobs({ limit: 100, offset: 0 });
    const docs = await Promise.all(
      jobs.map(async (job) => {
        const sourceId = (job.id ?? "").toString();
        if (!sourceId) return null;
        // BatchDoc is keyed by sourceId, so this lookup preserves prior ingested
        // figures (spend, exact breakdown) across refreshes.
        const existing = await getBatch(ctx.tenantId, ctx.accountId, sourceId).catch(() => null);
        const doc = bulkJobToBatchDoc(job, ctx, existing);
        await upsertBatch(doc);
        return doc;
      }),
    );
    const batches = docs
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map(batchDocToBatch)
      .sort((a, b) => a.dayAgo - b.dayAgo);
    log().info({ jobCount: jobs.length, batchCount: batches.length }, "campaigns listed");
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
