import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";
import { listTenantAccounts, MagickApiError, type RawAccount } from "@/lib/server/magick-client";

/** List the accounts a user can pick within a tenant — powers the cascading
 *  account picker on the workspace screen. magick-master returns no nested
 *  accounts in /auth/session, so the picker fetches them here once a tenant is
 *  chosen. Tenant is validated against the session; membership is re-enforced
 *  upstream. */
export async function GET(req: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  const tenantId = new URL(req.url).searchParams.get("tenantId")?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: "missing_tenant_id" }, { status: 400 });
  }

  const session = await getSession();
  if (!session.idToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const known = (session.tenants ?? []).some((t) => t.id === tenantId);
  if (session.tenants && session.tenants.length > 0 && !known) {
    return NextResponse.json({ error: "tenant_not_accessible" }, { status: 403 });
  }

  try {
    const res = await listTenantAccounts(session.idToken, tenantId);
    const accounts = (res.accounts ?? [])
      .filter((a: RawAccount) => a.status !== "deleted")
      .map((a: RawAccount) => ({
        id: String(a.id),
        name: a.name ?? undefined,
        slug: a.slug ?? undefined,
      }));
    return NextResponse.json({ accounts });
  } catch (err) {
    const status = err instanceof MagickApiError ? err.status : 502;
    return NextResponse.json({ error: "accounts_failed", detail: String(err) }, { status });
  }
}
