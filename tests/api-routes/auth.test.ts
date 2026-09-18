import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isAuthConfigured: vi.fn(),
  // The real `sessionIsLive` consults this to decide whether an expired ID token
  // can still be re-minted, so the double has to answer it or the me-route throws.
  isTokenRefreshConfigured: vi.fn(() => true),
}));

// Only `getSession` is faked: `stampCredential` and `sessionIsLive` are the real
// implementations, so these tests assert on what the routes actually write to
// (and read back from) a session rather than on a double that agrees with them.
vi.mock("@/lib/server/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/session")>("@/lib/server/session");
  return { ...actual, getSession: vi.fn() };
});

// magick-client exports authSession + MagickApiError; the session route imports both.
vi.mock("@/lib/server/magick-client", async () => {
  class MagickApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "MagickApiError";
    }
  }
  return { authSession: vi.fn(), MagickApiError };
});

import { isAuthConfigured, isTokenRefreshConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";
import { authSession, MagickApiError } from "@/lib/server/magick-client";

function req(body?: unknown, opts?: { badJson?: boolean }) {
  return new Request("http://localhost/api/auth", {
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

/** A structurally valid (unsigned) Firebase-shaped ID token with a chosen `exp`.
 *  Nothing under test verifies signatures — only the `exp` claim is read — so
 *  this is enough to drive the real expiry logic instead of stubbing it. */
function jwt(expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("POST /api/auth/session", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when auth not configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: "x" }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "auth_not_configured" });
  });

  it("400 invalid_json", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req(undefined, { badJson: true }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("400 missing_id_token", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_id_token" });
  });

  it("exchanges idToken → sets session + returns tenants/user", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authSession).mockResolvedValue({
      user: { id: "u1", email: "a@b.com", name: "Al" },
      tenants: [{ id: "t1", name: "T1", slug: "t1" }, { id: "t2" }],
    } as never);
    const session = fakeSession();
    vi.mocked(getSession).mockResolvedValue(session as never);

    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: "good-token" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user).toEqual({ id: "u1", email: "a@b.com", name: "Al" });
    expect(json.tenants).toEqual([
      { id: "t1", name: "T1", slug: "t1", accounts: [] },
      { id: "t2", name: undefined, slug: undefined, accounts: [] },
    ]);
    expect(session.idToken).toBe("good-token");
    expect(session.save).toHaveBeenCalled();
  });

  it("stores the refresh token and the token's expiry alongside the id token", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authSession).mockResolvedValue({ user: { id: "u1" }, tenants: [] } as never);
    const session = fakeSession();
    vi.mocked(getSession).mockResolvedValue(session as never);

    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: jwt(Date.now() + 3_600_000), refreshToken: "refresh-1" }));
    expect(res.status).toBe(200);
    // Without these the cookie outlives its credential by seven hours: nothing
    // can re-mint the ID token and nothing can tell that it has died.
    expect(session.refreshToken).toBe("refresh-1");
    expect(typeof session.idTokenExp).toBe("number");
  });

  it("coerces nested accounts (incl. account_id / memberships variants)", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authSession).mockResolvedValue({
      user: { id: "u1" },
      tenants: [
        // `accounts` with id + account_id variants and a name/slug
        { id: "t1", accounts: [{ id: "a1", name: "Prod" }, { account_id: "a2", slug: "mkt" }] },
        // falls back to `memberships` when `accounts` is absent
        { id: "t2", memberships: [{ id: "a9", name: "Default" }] },
        // entries without any id are dropped; no account source → []
        { id: "t3", accounts: [{ name: "no-id" }] },
      ],
    } as never);
    vi.mocked(getSession).mockResolvedValue(fakeSession() as never);

    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: "good-token" }));
    const json = await res.json();
    expect(json.tenants[0].accounts).toEqual([
      { id: "a1", name: "Prod", slug: undefined },
      { id: "a2", name: undefined, slug: "mkt" },
    ]);
    expect(json.tenants[1].accounts).toEqual([{ id: "a9", name: "Default", slug: undefined }]);
    expect(json.tenants[2].accounts).toEqual([]);
  });

  it("propagates MagickApiError status on bad token", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authSession).mockRejectedValue(new MagickApiError(401, "unauthorized", "http://test/auth"));
    vi.mocked(getSession).mockResolvedValue(fakeSession() as never);
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: "bad" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("auth_failed");
  });

  it("reports an unwritable cookie as its own failure, not as an upstream one", async () => {
    // iron-session throws outright past 4096 bytes, and this cookie carries an
    // ID token, a refresh token and the whole tenant list with its nested
    // accounts — a user with many tenants is the one who trips it. Reported as
    // `auth_failed` (502) it pointed whoever debugged it at magick-master, the
    // one system that was working fine.
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authSession).mockResolvedValue({ user: { id: "u1" }, tenants: [] } as never);
    const session = fakeSession();
    session.save.mockRejectedValue(new Error("Cookie length is too big, 5000 > 4096"));
    vi.mocked(getSession).mockResolvedValue(session as never);

    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: "good-token", refreshToken: "refresh-1" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "session_too_large" });
  });

  it("falls back to 502 for a generic thrown error", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(authSession).mockRejectedValue(new Error("network down"));
    vi.mocked(getSession).mockResolvedValue(fakeSession() as never);
    const { POST } = await import("@/app/api/auth/session/route");
    const res = await POST(req({ idToken: "x" }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "auth_failed" });
  });
});

describe("POST /api/auth/context", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when auth not configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req({ tenantId: "t1", accountId: "a1" }));
    expect(res.status).toBe(503);
  });

  it("400 invalid_json", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req(undefined, { badJson: true }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("400 missing_fields", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req({ tenantId: "t1" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_fields" });
  });

  it("401 when no idToken in session", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(fakeSession({}) as never);
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req({ tenantId: "t1", accountId: "a1" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "not_authenticated" });
  });

  it("403 when tenant not in known tenants", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({ idToken: "tk", tenants: [{ id: "other" }] }) as never,
    );
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req({ tenantId: "t1", accountId: "a1" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "tenant_not_accessible" });
  });

  it("happy path sets context + saves", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const session = fakeSession({ idToken: "tk", tenants: [{ id: "t1" }] });
    vi.mocked(getSession).mockResolvedValue(session as never);
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req({ tenantId: "t1", accountId: "a1" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, tenantId: "t1", accountId: "a1" });
    expect(session.tenantId).toBe("t1");
    expect(session.accountId).toBe("a1");
    expect(session.save).toHaveBeenCalled();
  });

  it("allows manual tenant when session has no tenants list", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const session = fakeSession({ idToken: "tk" }); // no tenants
    vi.mocked(getSession).mockResolvedValue(session as never);
    const { POST } = await import("@/app/api/auth/context/route");
    const res = await POST(req({ tenantId: "manual", accountId: "a1" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, tenantId: "manual" });
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok without touching session when auth not configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("destroys session when configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const session = fakeSession({ idToken: "tk" });
    vi.mocked(getSession).mockResolvedValue(session as never);
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(session.destroy).toHaveBeenCalled();
  });
});

describe("GET /api/auth/me", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 + configured:false when auth not configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ authenticated: false, configured: false });
  });

  it("401 when no idToken", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(fakeSession({}) as never);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
  });

  it("returns authenticated profile + context", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({
        idToken: "tk",
        user: { id: "u1", email: "a@b.com" },
        tenants: [{ id: "t1" }],
        tenantId: "t1",
        accountId: "a1",
      }) as never,
    );
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      authenticated: true,
      user: { id: "u1", email: "a@b.com" },
      tenants: [{ id: "t1" }],
      context: { tenantId: "t1", accountId: "a1" },
    });
  });

  it("401s and clears the cookie for an expired token with no way to re-mint it", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    // No refresh token: the ID token's own hour is all this session ever had, and
    // it is gone. Answering "authenticated" here is what let the app shell admit
    // the user and leave the first campaigns fetch to eject them mid-screen.
    const session = fakeSession({ idToken: jwt(Date.now() - 60_000), user: { id: "u1" } });
    vi.mocked(getSession).mockResolvedValue(session as never);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ authenticated: false });
    expect(session.destroy).toHaveBeenCalled();
  });

  it("stays authenticated on an expired token when a refresh token can re-mint it", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(isTokenRefreshConfigured).mockReturnValue(true);
    // An expired ID token is not an expired session when the server can mint a
    // new one — getTenantContext() does exactly that on the next upstream call.
    const session = fakeSession({
      idToken: jwt(Date.now() - 60_000),
      refreshToken: "refresh-1",
      tenantId: "t1",
      accountId: "a1",
    });
    vi.mocked(getSession).mockResolvedValue(session as never);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ authenticated: true });
    expect(session.destroy).not.toHaveBeenCalled();
  });

  it("401s an expired token when the deployment cannot refresh at all", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    // No Firebase Web API key server-side ⇒ the stored refresh token is unusable.
    vi.mocked(isTokenRefreshConfigured).mockReturnValue(false);
    const session = fakeSession({ idToken: jwt(Date.now() - 60_000), refreshToken: "refresh-1" });
    vi.mocked(getSession).mockResolvedValue(session as never);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(401);
    expect(session.destroy).toHaveBeenCalled();
  });

  it("context is null when workspace not selected", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(fakeSession({ idToken: "tk" }) as never);
    const { GET } = await import("@/app/api/auth/me/route");
    const res = await GET(new Request("http://localhost/api/auth/me"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.context).toBeNull();
    expect(json.user).toBeNull();
    expect(json.tenants).toEqual([]);
  });
});
