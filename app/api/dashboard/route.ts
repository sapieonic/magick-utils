import { NextResponse } from "next/server";
import { isDashboardRange, rangeStart } from "@/lib/date-range";
import { isBackendConfigured } from "@/lib/server/env";
import { withLogging } from "@/lib/server/http-log";
import { getDashboardVolume } from "@/lib/server/repositories";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/server/request";
import { getTenantContext } from "@/lib/server/session";
import { setRequestContext } from "@/lib/server/observability/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withLogging("dashboard", async (req: Request) => {
  if (!isBackendConfigured()) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { range?: string };
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    const response = jsonBodyErrorResponse(error);
    if (response) return response;
    throw error;
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const range = body.range ?? "Last 30 days";
  if (!isDashboardRange(range)) return NextResponse.json({ error: "invalid_range" }, { status: 400 });

  const end = new Date();
  const volume = await getDashboardVolume(ctx.tenantId, ctx.accountId, range, rangeStart(range, end), end);
  return NextResponse.json({ volume });
});
