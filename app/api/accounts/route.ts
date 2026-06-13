import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession, type SessionTenant } from "@/lib/server/session";
import { listTenantAccounts, MagickApiError, type RawAccount } from "@/lib/server/magick-client";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

/** List the accounts a user can pick within a tenant — powers the cascading
 *  account picker on the workspace screen. magick-master returns no nested
 *  accounts in /auth/session, so the picker fetches them here once a tenant is
 *  chosen. Tenant is validated against the session; membership is re-enforced
 *  upstream. */
export const GET = withLogging("accounts", async (req: Request) => {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  const tenantId = new URL(req.url).searchParams.get("tenantId")?.trim();
  if (!tenantId) {
    return NextResponse.json({ error: "missing_tenant_id" }, { status: 400 });
  }
  setRequestContext({ tenantId });

  const session = await getSession();
  if (!session.idToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const known = (session.tenants ?? []).some((t: SessionTenant) => t.id === tenantId);
  if (session.tenants && session.tenants.length > 0 && !known) {
    log().warn({ tenantId }, "account list denied — tenant not in session");
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
    log().info({ tenantId, count: accounts.length }, "listed tenant accounts");
    return NextResponse.json({ accounts });
  } catch (err) {
    const status = err instanceof MagickApiError ? err.status : 502;
    log().error({ err, tenantId, status }, "failed to list tenant accounts");
    return NextResponse.json({ error: "accounts_failed", detail: String(err) }, { status });
  }
});
