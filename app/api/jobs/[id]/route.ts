import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/server/session";
import { getJob } from "@/lib/server/repositories";
import { withLogging } from "@/lib/server/http-log";
import { setRequestContext } from "@/lib/server/observability/request-context";

export const GET = withLogging(
  "jobs/[id]",
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
    setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

    const { id } = await params;
    const job = await getJob(id);
    if (!job || job.tenantId !== ctx.tenantId || job.accountId !== ctx.accountId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      total: job.total,
      done: job.done,
      retryAt: job.retryAt ?? null,
      retryCount: job.retryCount ?? 0,
      error: job.error ?? null,
      result: job.result ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  },
);
