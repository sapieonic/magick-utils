import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isAuthConfigured: vi.fn(),
  isTokenRefreshConfigured: vi.fn(() => true),
}));

// `stampCredential` stays real: what this route is FOR is writing the credential
// fields correctly, so a double that agrees with the route would test nothing.
vi.mock("@/lib/server/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/session")>("@/lib/server/session");
  return { ...actual, getSession: vi.fn() };
});

vi.mock("@/lib/server/magick-client", async () => {
  class MagickApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "MagickApiError";
    }
  }
  return { authMe: vi.fn(), MagickApiError };
});

import { isAuthConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";
import { authMe, MagickApiError } from "@/lib/server/magick-client";

/** A structurally valid (unsigned) ID token with a chosen `exp` — only that
 *  claim is ever read, and only to cache the expiry on the session. */
function jwt(expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  return `header.${payload}.signature`;
}

const FRESH = jwt(Date.now() + 3_600_000);

function req(body?: unknown, opts?: { badJson?: boolean }) {
  return new Request("http://localhost/api/auth/refresh", {
    method: "POST",
    body: opts?.badJson ? "{not json" : JSON.stringify(body ?? {}),
  });
}

function fakeSession(initial: Record<string, unknown> = {}) {
  return {
    ...initial,
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  } as Record<string, unknown> & { save: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
}

async function post(body?: unknown, opts?: { badJson?: boolean }) {
  const { POST } = await import("@/app/api/auth/refresh/route");
  return POST(req(body, opts));
}

describe("POST /api/auth/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authMe).mockResolvedValue({ user: {} } as never);
  });

  it("503 when auth is not configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    const res = await post({ idToken: FRESH });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "auth_not_configured" });
  });

  it("400 invalid_json", async () => {
    const res = await post(undefined, { badJson: true });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("400 missing_id_token", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_id_token" });
  });

  it("401s without establishing a session when there is none", async () => {
    const session = fakeSession({});
    vi.mocked(getSession).mockResolvedValue(session as never);
    const res = await post({ idToken: FRESH, refreshToken: "r1" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "not_authenticated" });
    // Refresh extends a session; it must never mint one out of a bare token.
    expect(session.save).not.toHaveBeenCalled();
    expect(authMe).not.toHaveBeenCalled();
  });

  it("re-stamps the credential without touching tenants or the workspace", async () => {
    const session = fakeSession({
      idToken: jwt(Date.now() - 60_000),
      idTokenExp: Date.now() - 60_000,
      user: { id: "u1" },
      tenants: [{ id: "t1" }],
      tenantId: "t1",
      accountId: "a1",
    });
    vi.mocked(getSession).mockResolvedValue(session as never);

    const res = await post({ idToken: FRESH, refreshToken: "r2" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, persisted: true });
    expect(authMe).toHaveBeenCalledWith(FRESH);
    expect(session.idToken).toBe(FRESH);
    expect(session.refreshToken).toBe("r2");
    expect(session.idTokenExp).toBeGreaterThan(Date.now());
    expect(session.save).toHaveBeenCalled();
    // Re-running the login exchange here would rewrite these — and log a bogus
    // "login" line every hour.
    expect(session.tenants).toEqual([{ id: "t1" }]);
    expect(session.tenantId).toBe("t1");
    expect(session.accountId).toBe("a1");
  });

  it("keeps the stored refresh token when the client sends none", async () => {
    const session = fakeSession({ idToken: "old", refreshToken: "kept" });
    vi.mocked(getSession).mockResolvedValue(session as never);
    const res = await post({ idToken: FRESH });
    expect(res.status).toBe(200);
    expect(session.refreshToken).toBe("kept");
  });

  it("destroys the session and 401s when upstream rejects the token", async () => {
    const session = fakeSession({ idToken: "old", user: { id: "u1" } });
    vi.mocked(getSession).mockResolvedValue(session as never);
    vi.mocked(authMe).mockRejectedValue(new MagickApiError(401, "unauthorized", "http://test/auth/me"));
    const res = await post({ idToken: FRESH, refreshToken: "r1" });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "not_authenticated" });
    expect(session.destroy).toHaveBeenCalled();
    expect(session.save).not.toHaveBeenCalled();
  });

  it("leaves the session intact when the check fails transiently", async () => {
    const session = fakeSession({ idToken: "old", refreshToken: "r1" });
    vi.mocked(getSession).mockResolvedValue(session as never);
    vi.mocked(authMe).mockRejectedValue(new MagickApiError(503, "upstream down", "http://test/auth/me"));
    const res = await post({ idToken: FRESH });
    // Google or magick-master having a bad minute must not sign everybody out.
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "refresh_failed" });
    expect(session.destroy).not.toHaveBeenCalled();
    expect(session.idToken).toBe("old");
  });

  it("treats a non-MagickApiError failure as transient too", async () => {
    const session = fakeSession({ idToken: "old" });
    vi.mocked(getSession).mockResolvedValue(session as never);
    vi.mocked(authMe).mockRejectedValue(new Error("network down"));
    const res = await post({ idToken: FRESH });
    expect(res.status).toBe(502);
    expect(session.destroy).not.toHaveBeenCalled();
  });

  it("refuses a token belonging to a different user", async () => {
    const session = fakeSession({ idToken: "old", user: { id: "u1" }, tenantId: "t1", accountId: "a1" });
    vi.mocked(getSession).mockResolvedValue(session as never);
    vi.mocked(authMe).mockResolvedValue({ user: { id: "u2" } } as never);
    const res = await post({ idToken: FRESH, refreshToken: "r1" });
    // Stamping it would leave the cookie acting as u2 inside u1's selected
    // tenant/account, which this route never re-reads.
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "user_mismatch" });
    expect(session.idToken).toBe("old");
    expect(session.save).not.toHaveBeenCalled();
  });

  it("reports a rejected cookie write instead of throwing a 500", async () => {
    const session = fakeSession({ idToken: "old" });
    session.save.mockRejectedValue(new Error("Cookie length is too big, 5000 > 4096"));
    vi.mocked(getSession).mockResolvedValue(session as never);
    const res = await post({ idToken: FRESH, refreshToken: "r1" });
    // The previous cookie survives, so the session is no worse off — failing the
    // request would 500 a background call the user never made.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, persisted: false });
  });
});
