import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { authMe, MagickApiError } from "@/lib/server/magick-client";
import { getSession, stampCredential } from "@/lib/server/session";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";

/** Re-stamp an existing session with a freshly minted Firebase ID token.
 *
 *  The interactive half of the 1-hour-token fix: the browser's Firebase SDK
 *  re-mints roughly every 55 minutes (`components/SessionRefresher.tsx`) and
 *  hands the new token here so the 8h cookie never carries a dead credential.
 *  The server-side half — a token that expires while nobody has the app open,
 *  or during a long ingest — is `getTenantContext()` re-minting from the stored
 *  refresh token.
 *
 *  Deliberately NOT `/api/auth/session`: that route runs the full login
 *  exchange, rewrites `tenants` and logs a "login" line. Routing an hourly
 *  refresh through it would fabricate a login event every hour and could drop
 *  the workspace the user is standing in if upstream returned a changed tenant
 *  list mid-session. This route touches the credential fields and nothing else.
 */
export const POST = withLogging("auth/refresh", async (req: Request) => {
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

  const session = await getSession();
  // Refresh extends a session; it never creates one. An expired or tampered
  // iron-session seal does not throw — it decrypts to `{}` — so presence of a
  // stored token is the only test there is. Note this asks whether a credential
  // is PRESENT, not whether it is still live (`sessionIsLive`): a session whose
  // ID token died an hour ago is precisely the one this route exists to fix,
  // and refusing it would make the fix unreachable.
  if (!session.idToken) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }

  let me;
  try {
    // Cheapest possible proof that the token is real and accepted upstream —
    // no tenant headers, no data fetched. Stamping an unverified token would
    // let any script running on the page swap the cookie's credential.
    me = await authMe(body.idToken);
  } catch (err) {
    const status = err instanceof MagickApiError ? err.status : 502;
    if (status === 401) {
      // Upstream refuses this credential and no newer one exists — holding the
      // cookie open only defers the bounce to the next screen the user opens.
      session.destroy();
      log().info({ userId: session.user?.id }, "session credential rejected on refresh; session cleared");
      return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
    }
    // Anything else (5xx, a network fault, a 403 on some unrelated scope) says
    // nothing about the credential. Keep the session: the existing token is no
    // worse than it was, and the client retries on its next tick.
    log().warn({ err, status }, "id token refresh check failed upstream; session left intact");
    return NextResponse.json({ error: "refresh_failed" }, { status: 502 });
  }

  // The session's tenants and workspace selection survive the token swap, which
  // is only safe while the new token names the same user — otherwise the cookie
  // would authorize calls as someone else against the previous user's selected
  // tenant/account.
  const rawId = me.user?.id;
  const refreshedUserId = typeof rawId === "string" ? rawId : undefined;
  if (session.user?.id && refreshedUserId && refreshedUserId !== session.user.id) {
    log().warn({ userId: session.user.id }, "refresh token names a different user; refusing");
    return NextResponse.json({ error: "user_mismatch" }, { status: 403 });
  }

  stampCredential(session, body.idToken, body.refreshToken);
  try {
    await session.save();
  } catch (err) {
    // iron-session refuses to write a seal over 4096 bytes, and this cookie
    // already carries a token, a refresh token and the tenant list. The previous
    // cookie survives untouched, so a failed write leaves the session exactly as
    // it was: report it rather than 500-ing a request the user never made, and
    // let the client's next hand-off try again.
    log().warn({ err }, "could not persist the refreshed credential to the session cookie");
    return NextResponse.json({ ok: true, persisted: false });
  }
  log().debug({ userId: session.user?.id }, "session credential refreshed");
  return NextResponse.json({ ok: true, persisted: true, expiresAt: session.idTokenExp ?? null });
});
