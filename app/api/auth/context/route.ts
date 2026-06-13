import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";

/** Select the active tenant/account workspace. Validates against the tenants the
 *  session knows about (from /auth/session). Manual entry of a known tenant id is
 *  allowed; the account id is trusted for V1 (magick-master enforces membership on
 *  every downstream call regardless). */
export async function POST(req: Request) {
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

  const session = await getSession();
  if (!session.idToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const known = (session.tenants ?? []).some((t) => t.id === tenantId);
  if (session.tenants && session.tenants.length > 0 && !known) {
    return NextResponse.json({ error: "tenant_not_accessible" }, { status: 403 });
  }

  session.tenantId = tenantId;
  session.accountId = accountId;
  await session.save();
  return NextResponse.json({ ok: true, tenantId, accountId });
}
