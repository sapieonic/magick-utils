// Encrypted httpOnly session (iron-session). Stores the Firebase ID token and
// the chosen tenant/account so the BFF can call magick-master on every request.

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { env, isAuthConfigured, isTokenRefreshConfigured } from "./env";
import {
  idTokenExpiresAt,
  idTokenNeedsRefresh,
  mintIdToken,
  TokenRefreshPermanentError,
} from "./firebase-token";
import { log } from "./logger";
import type { TenantContext } from "./types";

export interface SessionUser {
  id?: string;
  email?: string;
  name?: string;
}

export interface SessionTenant {
  id: string;
  name?: string;
  slug?: string;
  accounts?: { id: string; slug?: string; name?: string }[];
}

/** How long a signed-in session lasts, as the iron-session seal's `ttl`.
 *
 *  Deliberately NOT paired with an explicit `cookieOptions.maxAge`. Read
 *  `getSessionConfig` in iron-session: setting `maxAge` yourself takes a branch
 *  that leaves `ttl` at its 14-day default and derives neither from the other,
 *  so this cookie used to be dropped by the browser at 8h while its seal stayed
 *  cryptographically valid — and replayable, if the value ever leaked into a
 *  log, a HAR or a backup — for another thirteen days. Passing `ttl` alone takes
 *  the other branch, which derives `maxAge = ttl - 60`: the browser forgets the
 *  cookie a minute before the seal it carries stops being accepted. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

export interface SessionData {
  /** Firebase ID token forwarded as Bearer to magick-master. Lives ONE HOUR,
   *  which is far short of this cookie's life — `getTenantContext()` re-mints it
   *  from `refreshToken` rather than letting the session outlive its credential.
   *  Never read this field directly for an upstream call; go through
   *  `getTenantContext()` so the freshness check cannot be skipped. */
  idToken?: string;
  /** Firebase refresh token, used to mint a new `idToken` when the stored one
   *  nears expiry. Long-lived and does not expire on its own, so it stays inside
   *  this encrypted httpOnly cookie and is redacted from logs. */
  refreshToken?: string;
  /** Epoch ms `idToken` expires, cached from its `exp` claim so `/api/auth/me`
   *  can answer "is this session still usable" without a round trip. */
  idTokenExp?: number;
  user?: SessionUser;
  tenants?: SessionTenant[];
  // active workspace context
  tenantId?: string;
  accountId?: string;
}

export function sessionOptions(): SessionOptions {
  return {
    password: env.sessionSecret,
    cookieName: env.sessionCookieName,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
    ttl: SESSION_MAX_AGE_SECONDS, // 8h; iron-session derives maxAge = ttl - 60
  };
}

export async function getSession() {
  const store = await cookies();
  return getIronSession<SessionData>(store, sessionOptions());
}

type MutableSession = SessionData & { save: () => Promise<void>; destroy: () => void };

/** Write a freshly obtained credential onto a session, caching its expiry.
 *  Does NOT save — the caller decides when, so a login can stamp the token and
 *  the tenant list in one write. */
export function stampCredential(session: SessionData, idToken: string, refreshToken?: string): void {
  session.idToken = idToken;
  if (refreshToken) session.refreshToken = refreshToken;
  session.idTokenExp = idTokenExpiresAt(idToken) ?? undefined;
}

/** Whether a session still holds a credential worth acting on.
 *
 *  A session carrying an ID token that expired hours ago with no refresh token
 *  to replace it is not authenticated in any useful sense. Reporting it as
 *  authenticated is what let the app-shell guard admit a user and then have the
 *  first campaigns fetch eject them to /login mid-session. */
export function sessionIsLive(session: SessionData, now = Date.now()): boolean {
  if (!session.idToken) return false;
  if (session.refreshToken && isTokenRefreshConfigured()) return true;
  // No way to re-mint: the ID token's own lifetime is the session's lifetime.
  const exp = session.idTokenExp ?? idTokenExpiresAt(session.idToken) ?? undefined;
  return exp === undefined ? true : exp > now;
}

/** Replace a near-expired ID token in place, returning the token to use.
 *
 *  Returns null only when the refresh token is permanently dead (revoked,
 *  expired, user disabled) — the session is destroyed in that case, because
 *  holding a credential that will be refused forever is worse than asking for a
 *  fresh login. A TRANSIENT failure deliberately returns the existing token
 *  instead: Google being briefly unreachable must not sign everybody out, and
 *  the stale token's own 401 handling already exists downstream. */
async function ensureFreshIdToken(session: MutableSession): Promise<string | null> {
  const current = session.idToken;
  if (!current) return null;
  if (!session.refreshToken || !isTokenRefreshConfigured()) return current;
  if (!idTokenNeedsRefresh(current)) return current;

  try {
    const minted = await mintIdToken(session.refreshToken);
    stampCredential(session, minted.idToken, minted.refreshToken);
    // Persisting the new token is an optimisation, not a precondition: this
    // request already holds a usable credential either way. iron-session throws
    // outright when a session seals past 4096 bytes, and this runs inside
    // getTenantContext() on every single route — letting that escape would turn
    // one oversized cookie into a 500 on every screen, which is a far worse
    // failure than the 401 bounce this whole change exists to remove. The cost
    // of a swallowed save is re-minting on the next request.
    try {
      await session.save();
    } catch (saveErr) {
      log().warn({ err: saveErr }, "could not persist the refreshed id token; using it for this request only");
    }
    log().info("refreshed the session's firebase id token");
    return minted.idToken;
  } catch (err) {
    if (err instanceof TokenRefreshPermanentError) {
      log().warn({ reason: err.reason }, "session credential is unrecoverable; clearing session");
      session.destroy();
      return null;
    }
    log().warn({ err }, "id token refresh failed transiently; continuing with the existing token");
    return current;
  }
}

/** The session's ID token, refreshed if it is near expiry.
 *
 *  For the routes that legitimately act BEFORE a workspace is chosen — the
 *  account picker is the only one — where `getTenantContext()` cannot help
 *  because there is no tenant or account to return yet. Without this, that
 *  screen kept the exact 1-hour cliff the rest of this change removes: a user
 *  who idled an hour, came back to a working dashboard and then clicked "Switch
 *  workspace" was bounced to /login by the account cascade alone.
 *
 *  Every OTHER upstream call must go through `getTenantContext()`. */
export async function getFreshIdToken(): Promise<string | null> {
  if (!isAuthConfigured()) return null;
  const s = await getSession();
  if (!s.idToken) return null;
  return ensureFreshIdToken(s as MutableSession);
}

/** An `onCredentialRefresh` handler for route handlers.
 *
 *  `MagickClient` can mint a replacement token mid-request when magick-master
 *  refuses a token that still looked live — revocation, typically. Google may
 *  rotate the refresh token on that exchange, and `firebase-token.ts` is
 *  explicit that a rotated value MUST be persisted: keep the old one and the
 *  session is holding a credential that gets refused an hour later. The worker
 *  writes it back to its job document; a route has to write it back to the
 *  cookie, or the rotation lives only in that request's memory.
 *
 *  Best-effort by design — the request already holds a working token, so a
 *  failed write is a missed optimisation, not a failure worth surfacing. */
export async function persistRefreshedCredential(minted: {
  idToken: string;
  refreshToken: string;
}): Promise<void> {
  try {
    const s = await getSession();
    // The session was destroyed underneath us (a parallel request hit a
    // permanent refusal). Re-stamping would resurrect a dead cookie.
    if (!s.idToken) return;
    stampCredential(s, minted.idToken, minted.refreshToken);
    await s.save();
  } catch (err) {
    log().warn({ err }, "could not persist a mid-request credential refresh");
  }
}

/** Returns the authenticated tenant context, or null if not fully logged in
 *  (also null when auth isn't configured, so callers never hit iron-session).
 *
 *  This is the ONE place a stored ID token is checked for freshness before it is
 *  forwarded upstream, which is why every route that calls it — campaigns,
 *  ingest, export, analytics — inherits the fix without its own refresh logic.
 *  Reaching into `session.idToken` directly bypasses that and reintroduces the
 *  1-hour cliff; don't. */
export async function getTenantContext(): Promise<TenantContext | null> {
  if (!isAuthConfigured()) return null;
  const s = await getSession();
  if (!s.idToken || !s.tenantId || !s.accountId) return null;
  const idToken = await ensureFreshIdToken(s as MutableSession);
  if (!idToken) return null;
  return {
    idToken,
    refreshToken: s.refreshToken,
    tenantId: s.tenantId,
    accountId: s.accountId,
  };
}
