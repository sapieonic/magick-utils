import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { authSession, MagickApiError, type RawTenant } from "@/lib/server/magick-client";
import { getSession, stampCredential, type SessionTenant } from "@/lib/server/session";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";

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

export const POST = withLogging("auth/session", async (req: Request) => {
  if (!isAuthConfigured()) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  let body: { idToken?: string; refreshToken?: string };
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
    // Stamp the credential rather than assigning `idToken`, so the session also
    // caches the token's expiry and keeps the refresh token that lets the server
    // re-mint it. A login that recorded only the ID token left the cookie holding
    // a credential that died an hour into its eight-hour life.
    stampCredential(session, body.idToken, body.refreshToken);
    session.user = {
      email: (res.user?.email as string | undefined) ?? undefined,
      name: (res.user?.name as string | undefined) ?? undefined,
      id: (res.user?.id as string | undefined) ?? undefined,
    };
    session.tenants = tenants;
    try {
      await session.save();
    } catch (err) {
      // iron-session throws outright past 4096 bytes, and this cookie carries an
      // ID token, a refresh token and the whole tenant list with its nested
      // accounts — a user with many tenants is the one who trips it. Falling
      // into the catch below would report it as "magick-master auth rejected",
      // pointing whoever debugs it at the one system that is working fine.
      log().error({ err }, "login failed — session cookie could not be written");
      return NextResponse.json({ error: "session_too_large" }, { status: 500 });
    }
    log().info(
      { userId: session.user.id, tenantCount: tenants.length },
      "session established (login)",
    );
    return NextResponse.json({ user: session.user, tenants });
  } catch (err) {
    const status = err instanceof MagickApiError ? err.status : 502;
    log().warn({ err, status }, "login failed — magick-master auth rejected");
    return NextResponse.json({ error: "auth_failed", detail: String(err) }, { status });
  }
});
