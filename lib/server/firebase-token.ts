// Server-side Firebase ID-token minting.
//
// A Firebase ID token lives one hour. Everything this app forwards to
// magick-master is Bearer'd with one, so anything that must outlive that hour —
// an 8h session cookie, an ingest job that pages a large campaign — needs a way
// to mint a new one without a human at a login screen. That is what a refresh
// token is for, and Google's secure-token endpoint exchanges one for a fresh ID
// token over plain HTTPS: no Admin SDK, no service account, no new dependency.
//
// The Web API key below is the same public key the client bundle already
// carries. It identifies the project; it authorizes nothing on its own. The
// refresh token is the credential, which is why it never leaves the encrypted
// session cookie or the job document, and why it is redacted in logger.ts.

import { env } from "./env";
import { log } from "./logger";

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

/** Refresh is attempted this long before the ID token's own `exp`. Firebase
 *  itself refreshes at roughly five minutes out; matching that means a token we
 *  consider live is one magick-master will still accept even after the request
 *  spends a few seconds in flight. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** A mint attempt failing for a reason that will say the same thing on every
 *  retry — the refresh token is revoked, expired, or names a user that no
 *  longer exists. The only cure is a fresh interactive login.
 *
 *  Kept distinct from a transient failure (5xx, a network fault, a timeout)
 *  because the two demand opposite handling in the worker: a transient failure
 *  must reschedule the job, a permanent one must fail it. Collapsing them
 *  either retries a hopeless job forever or discards a recoverable one — the
 *  same distinction `call-analysis.ts` draws with `SETTLED_STATUSES`. */
export class TokenRefreshPermanentError extends Error {
  constructor(readonly reason: string) {
    super(`Firebase refresh token rejected: ${reason}`);
    this.name = "TokenRefreshPermanentError";
  }
}

/** A mint attempt failing for a reason that may not recur. Callers retry. */
export class TokenRefreshTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRefreshTransientError";
  }
}

/** Google's documented terminal responses for a refresh-token grant. Anything
 *  else — including an unrecognised 400 — is treated as transient, because
 *  guessing "permanent" wrongly signs a working user out. */
const PERMANENT_REASONS: ReadonlySet<string> = new Set([
  "TOKEN_EXPIRED",
  "USER_DISABLED",
  "USER_NOT_FOUND",
  "INVALID_REFRESH_TOKEN",
  "MISSING_REFRESH_TOKEN",
]);

export interface MintedToken {
  idToken: string;
  /** Google may rotate the refresh token on exchange. Callers MUST persist this
   *  value rather than keeping the one they sent: dropping a rotated token
   *  leaves the session holding a credential that will be refused next hour. */
  refreshToken: string;
  /** Epoch ms at which the new ID token expires. */
  expiresAt: number;
}

/** The `exp` claim of a Firebase ID token, in epoch ms, or null if the token is
 *  not a readable JWT.
 *
 *  This only decodes; it does NOT verify. That is deliberate and safe: the sole
 *  caller reads a token out of our own encrypted, httpOnly session cookie to
 *  decide whether it is worth refreshing. magick-master remains the only
 *  authority on whether a token is actually valid — a forged `exp` here buys an
 *  attacker nothing but a 401 from upstream. */
export function idTokenExpiresAt(idToken: string): number | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Whether an ID token is close enough to expiry to be worth replacing.
 *
 *  A token whose `exp` we cannot read is reported as expiring: it is either
 *  malformed or not a JWT at all, and in both cases minting a known-good
 *  replacement beats forwarding it upstream and collecting a 401. */
export function idTokenNeedsRefresh(idToken: string, now = Date.now()): boolean {
  const expiresAt = idTokenExpiresAt(idToken);
  if (expiresAt === null) return true;
  return expiresAt - now <= REFRESH_SKEW_MS;
}

function permanentReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message !== "string") return null;
    // Google appends detail to some codes (e.g. "TOKEN_EXPIRED : <detail>").
    const code = message.split(":")[0].trim();
    return PERMANENT_REASONS.has(code) ? code : null;
  } catch {
    // A non-JSON 4xx from a proxy in front of Google is not Google refusing the
    // grant. Only a body we can actually read may condemn a session.
    return null;
  }
}

async function exchange(refreshToken: string): Promise<MintedToken> {
  if (!env.firebaseApiKey) {
    throw new TokenRefreshTransientError("FIREBASE_API_KEY is not configured; cannot refresh ID tokens.");
  }
  if (!refreshToken) {
    throw new TokenRefreshPermanentError("MISSING_REFRESH_TOKEN");
  }

  const url = `${SECURE_TOKEN_URL}?key=${encodeURIComponent(env.firebaseApiKey)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // A network fault or timeout says nothing about the credential.
    throw new TokenRefreshTransientError(`secure-token request failed: ${String(err)}`);
  }

  const body = await res.text().catch(() => "");
  if (!res.ok) {
    const reason = permanentReason(body);
    if (reason) {
      log().warn({ status: res.status, reason }, "firebase refresh token permanently rejected");
      throw new TokenRefreshPermanentError(reason);
    }
    log().warn({ status: res.status }, "firebase token refresh failed; treating as transient");
    throw new TokenRefreshTransientError(`secure-token responded ${res.status}`);
  }

  let parsed: { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new TokenRefreshTransientError("secure-token returned a non-JSON body");
  }

  const idToken = typeof parsed.id_token === "string" ? parsed.id_token : "";
  if (!idToken) {
    throw new TokenRefreshTransientError("secure-token returned no id_token");
  }
  // Prefer the rotated token when one comes back, and fall back to the one we
  // sent when it does not (Google returns the same value unrotated).
  const rotated = typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : refreshToken;
  // `expires_in` is seconds-as-string. Trust the token's own `exp` first: it is
  // what magick-master will actually check.
  const claimExpiry = idTokenExpiresAt(idToken);
  const expiresIn = Number(parsed.expires_in);
  const expiresAt =
    claimExpiry ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + 60 * 60 * 1000);

  log().info({ expiresAt: new Date(expiresAt).toISOString() }, "minted a fresh firebase id token");
  return { idToken, refreshToken: rotated, expiresAt };
}

/** In-flight exchanges, keyed by refresh token, so N concurrent requests that
 *  all notice the same expired token mint once between them rather than N
 *  times. A dashboard load fires several API calls at once; without this, each
 *  one independently hits Google and the last writer wins the cookie. Entries
 *  are removed as soon as the exchange settles, so this never grows. */
const inFlight = new Map<string, Promise<MintedToken>>();

/** Exchange a refresh token for a fresh ID token, coalescing concurrent
 *  attempts for the same credential.
 *
 *  Throws `TokenRefreshPermanentError` when the refresh token itself is dead
 *  (re-login required) and `TokenRefreshTransientError` for anything else. */
export async function mintIdToken(refreshToken: string): Promise<MintedToken> {
  const existing = inFlight.get(refreshToken);
  if (existing) return existing;
  const pending = exchange(refreshToken).finally(() => {
    inFlight.delete(refreshToken);
  });
  inFlight.set(refreshToken, pending);
  return pending;
}
