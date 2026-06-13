import { NextResponse } from "next/server";
import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { MagickClient } from "@/lib/server/magick-client";
import { getBatch, upsertBatch } from "@/lib/server/repositories";
import { batchDocToBatch, bulkJobToBatchDoc } from "@/lib/server/map";

/** List campaigns/batches for the active workspace. Pulls bulk-dispatch jobs from
 *  magick-master (calls + messages), refreshes the cached BatchDoc summaries, and
 *  returns them in the frontend `Batch` shape. */
export async function GET() {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

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
    return NextResponse.json({ batches });
  } catch (err) {
    return NextResponse.json({ error: "fetch_failed", detail: String(err) }, { status: 502 });
  }
}
