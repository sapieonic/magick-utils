import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ auth: true, refresh: true }));
const mintIdToken = vi.hoisted(() => vi.fn());
const ironSession = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/server/env", () => ({
  env: { sessionSecret: "x".repeat(32), sessionCookieName: "mu_session" },
  isAuthConfigured: () => flags.auth,
  isTokenRefreshConfigured: () => flags.refresh,
}));
vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => ironSession.current }));
// Only the network call is stubbed. The freshness maths and the permanent/
// transient error classes stay real — they are the policy under test here.
vi.mock("@/lib/server/firebase-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/firebase-token")>()),
  mintIdToken,
}));

import { TokenRefreshPermanentError, TokenRefreshTransientError } from "@/lib/server/firebase-token";
import {
  getTenantContext,
  sessionIsLive,
  sessionOptions,
  stampCredential,
  SESSION_MAX_AGE_SECONDS,
  type SessionData,
} from "@/lib/server/session";

function jwt(expMs: number): string {
  const encoded = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) }), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

const LIVE = () => jwt(Date.now() + 30 * 60 * 1000);
const NEARLY_DEAD = () => jwt(Date.now() + 60 * 1000);

interface FakeSession extends SessionData {
  save: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function session(data: SessionData): FakeSession {
  const s = { ...data, save: vi.fn(async () => {}), destroy: vi.fn() } as FakeSession;
  ironSession.current = s;
  return s;
}

beforeEach(() => {
  flags.auth = true;
  flags.refresh = true;
  mintIdToken.mockReset();
});

describe("sessionOptions", () => {
  it("pins the seal ttl and lets iron-session derive maxAge from it", () => {
    // Setting cookieOptions.maxAge ourselves takes the iron-session branch that
    // leaves ttl at its 14-day default, so the seal outlives the cookie by ~13
    // days. Passing ttl alone is what keeps the two in step.
    const opts = sessionOptions();
    expect(opts.ttl).toBe(SESSION_MAX_AGE_SECONDS);
    expect(opts.cookieOptions).not.toHaveProperty("maxAge");
  });
});

describe("stampCredential", () => {
  it("writes the token and caches its expiry", () => {
    const s: SessionData = {};
    const token = LIVE();

    stampCredential(s, token, "rt");

    expect(s.idToken).toBe(token);
    expect(s.refreshToken).toBe("rt");
    expect(s.idTokenExp).toBeGreaterThan(Date.now());
  });

  it("keeps an existing refresh token when none is supplied", () => {
    const s: SessionData = { refreshToken: "original" };

    stampCredential(s, LIVE());

    expect(s.refreshToken).toBe("original");
  });
});

describe("sessionIsLive", () => {
  it("is false without a token", () => {
    expect(sessionIsLive({})).toBe(false);
  });

  it("is true for an expired token that can still be re-minted", () => {
    expect(sessionIsLive({ idToken: "old", refreshToken: "rt", idTokenExp: Date.now() - 1000 })).toBe(true);
  });

  it("is false for an expired token with no way to replace it", () => {
    // This is the case that let the app-shell guard admit a user and then have
    // the first campaigns fetch eject them to /login mid-session.
    expect(sessionIsLive({ idToken: "old", idTokenExp: Date.now() - 1000 })).toBe(false);
  });

  it("is false for an expired token when refresh is not configured", () => {
    flags.refresh = false;
    expect(sessionIsLive({ idToken: "old", refreshToken: "rt", idTokenExp: Date.now() - 1000 })).toBe(false);
  });

  it("is true while the token is still within its own lifetime", () => {
    expect(sessionIsLive({ idToken: "tk", idTokenExp: Date.now() + 60_000 })).toBe(true);
  });
});

describe("getTenantContext", () => {
  it("returns null when auth is not configured", async () => {
    flags.auth = false;
    session({ idToken: LIVE(), tenantId: "t1", accountId: "a1" });

    expect(await getTenantContext()).toBeNull();
  });

  it("returns null when the workspace is not fully selected", async () => {
    session({ idToken: LIVE(), tenantId: "t1" });

    expect(await getTenantContext()).toBeNull();
  });

  it("passes a still-fresh token straight through without minting", async () => {
    const token = LIVE();
    const s = session({ idToken: token, refreshToken: "rt", tenantId: "t1", accountId: "a1" });

    const ctx = await getTenantContext();

    expect(ctx).toEqual({ idToken: token, refreshToken: "rt", tenantId: "t1", accountId: "a1" });
    expect(mintIdToken).not.toHaveBeenCalled();
    expect(s.save).not.toHaveBeenCalled();
  });

  it("mints, persists and returns a fresh token when the stored one is near expiry", async () => {
    const fresh = LIVE();
    mintIdToken.mockResolvedValue({ idToken: fresh, refreshToken: "rotated", expiresAt: Date.now() + 3.6e6 });
    const s = session({ idToken: NEARLY_DEAD(), refreshToken: "rt", tenantId: "t1", accountId: "a1" });

    const ctx = await getTenantContext();

    expect(mintIdToken).toHaveBeenCalledWith("rt");
    expect(ctx?.idToken).toBe(fresh);
    expect(ctx?.refreshToken).toBe("rotated");
    expect(s.idToken).toBe(fresh);
    expect(s.refreshToken).toBe("rotated");
    expect(s.save).toHaveBeenCalledTimes(1);
  });

  it("does not mint when the session carries no refresh token", async () => {
    const stale = NEARLY_DEAD();
    session({ idToken: stale, tenantId: "t1", accountId: "a1" });

    const ctx = await getTenantContext();

    expect(mintIdToken).not.toHaveBeenCalled();
    expect(ctx?.idToken).toBe(stale);
  });

  it("does not mint when the deployment has no Firebase API key", async () => {
    flags.refresh = false;
    const stale = NEARLY_DEAD();
    session({ idToken: stale, refreshToken: "rt", tenantId: "t1", accountId: "a1" });

    const ctx = await getTenantContext();

    expect(mintIdToken).not.toHaveBeenCalled();
    expect(ctx?.idToken).toBe(stale);
  });

  it("keeps the session alive on a TRANSIENT refresh failure", async () => {
    // Google being briefly unreachable must not sign everybody out; the stale
    // token's own 401 handling already exists downstream.
    mintIdToken.mockRejectedValue(new TokenRefreshTransientError("secure-token responded 503"));
    const stale = NEARLY_DEAD();
    const s = session({ idToken: stale, refreshToken: "rt", tenantId: "t1", accountId: "a1" });

    const ctx = await getTenantContext();

    expect(ctx?.idToken).toBe(stale);
    expect(s.destroy).not.toHaveBeenCalled();
  });

  it("clears the session on a PERMANENT refresh failure", async () => {
    mintIdToken.mockRejectedValue(new TokenRefreshPermanentError("TOKEN_EXPIRED"));
    const s = session({ idToken: NEARLY_DEAD(), refreshToken: "rt", tenantId: "t1", accountId: "a1" });

    const ctx = await getTenantContext();

    expect(ctx).toBeNull();
    expect(s.destroy).toHaveBeenCalledTimes(1);
  });

  it("still serves the request when persisting the refreshed token fails", async () => {
    // iron-session throws outright past 4096 bytes, and this runs on every
    // route — letting that escape would turn one oversized cookie into a 500 on
    // every screen, which is worse than the bounce this change exists to fix.
    const fresh = LIVE();
    mintIdToken.mockResolvedValue({ idToken: fresh, refreshToken: "rt", expiresAt: Date.now() + 3.6e6 });
    const s = session({ idToken: NEARLY_DEAD(), refreshToken: "rt", tenantId: "t1", accountId: "a1" });
    s.save.mockRejectedValue(new Error("iron-session: Cookie length is too big (4200 bytes)"));

    const ctx = await getTenantContext();

    expect(ctx?.idToken).toBe(fresh);
    expect(s.destroy).not.toHaveBeenCalled();
  });
});
