import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { authSession, MagickApiError, type RawTenant } from "@/lib/server/magick-client";
import { getSession, type SessionTenant } from "@/lib/server/session";

/** Pull the accounts a user can act in for a tenant out of the raw payload.
 *  Upstream shape isn't strictly typed, so we look in the likely places
 *  (`accounts` / `account_list` / `memberships`) and tolerate field-name
 *  variants (id|account_id). Returns [] when none are present — the workspace
 *  picker then falls back to manual account entry. */
function coerceAccounts(t: RawTenant): SessionTenant["accounts"] {
  const candidate = (t.accounts ?? t.account_list ?? t.memberships) as unknown;
  if (!Array.isArray(candidate)) return [];
  const out: NonNullable<SessionTenant["accounts"]> = [];
  for (const entry of candidate) {
    const o = (entry ?? {}) as Record<string, unknown>;
    const id = (o.id ?? o.account_id ?? o.accountId) as string | number | undefined;
    if (id === undefined || id === null || id === "") continue;
    out.push({
      id: String(id),
      name: (o.name as string | undefined) ?? undefined,
      slug: (o.slug as string | undefined) ?? undefined,
    });
  }
  return out;
}

export async function POST(req: Request) {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  let body: { idToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.idToken) {
    return NextResponse.json({ error: "missing_id_token" }, { status: 400 });
  }

  try {
    const res = await authSession(body.idToken);
    const tenants: SessionTenant[] = (res.tenants ?? []).map((t: RawTenant) => ({
      id: t.id,
      name: t.name ?? undefined,
      slug: t.slug ?? undefined,
      accounts: coerceAccounts(t),
    }));
    const session = await getSession();
    session.idToken = body.idToken;
    session.user = {
      email: (res.user?.email as string | undefined) ?? undefined,
      name: (res.user?.name as string | undefined) ?? undefined,
      id: (res.user?.id as string | undefined) ?? undefined,
    };
    session.tenants = tenants;
    await session.save();
    return NextResponse.json({ user: session.user, tenants });
  } catch (err) {
    const status = err instanceof MagickApiError ? err.status : 502;
    return NextResponse.json({ error: "auth_failed", detail: String(err) }, { status });
  }
}
