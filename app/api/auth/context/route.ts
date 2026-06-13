import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession, type SessionTenant } from "@/lib/server/session";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

/** Select the active tenant/account workspace. Validates against the tenants the
 *  session knows about (from /auth/session). Manual entry of a known tenant id is
 *  allowed; the account id is trusted for V1 (magick-master enforces membership on
 *  every downstream call regardless). */
export const POST = withLogging("auth/context", async (req: Request) => {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  let body: { tenantId?: string; accountId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const tenantId = body.tenantId?.trim();
  const accountId = body.accountId?.trim();
  if (!tenantId || !accountId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  setRequestContext({ tenantId, accountId });

  const session = await getSession();
  if (!session.idToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const known = (session.tenants ?? []).some((t: SessionTenant) => t.id === tenantId);
  if (session.tenants && session.tenants.length > 0 && !known) {
    log().warn({ tenantId }, "workspace selection denied — tenant not in session");
    return NextResponse.json({ error: "tenant_not_accessible" }, { status: 403 });
  }

  session.tenantId = tenantId;
  session.accountId = accountId;
  await session.save();
  log().info({ tenantId, accountId }, "workspace context selected");
  return NextResponse.json({ ok: true, tenantId, accountId });
});
