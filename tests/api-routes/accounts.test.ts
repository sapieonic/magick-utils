import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isAuthConfigured: vi.fn(),
}));

// `getFreshIdToken` is what the route Bearers upstream — `getSession` is now
// consulted only for the tenant allow-list. Both are mocked so a test can make
// the two disagree and prove which one reaches magick-master.
vi.mock("@/lib/server/session", () => ({
  getSession: vi.fn(),
  getFreshIdToken: vi.fn(),
}));

// The accounts route imports listTenantAccounts + MagickApiError.
vi.mock("@/lib/server/magick-client", async () => {
  class MagickApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "MagickApiError";
    }
  }
  return { listTenantAccounts: vi.fn(), MagickApiError };
});

import { isAuthConfigured } from "@/lib/server/env";
import { getFreshIdToken, getSession } from "@/lib/server/session";
import { listTenantAccounts, MagickApiError } from "@/lib/server/magick-client";

function req(tenantId?: string) {
  const qs = tenantId === undefined ? "" : `?tenantId=${encodeURIComponent(tenantId)}`;
  return new Request(`http://localhost/api/accounts${qs}`);
}

function fakeSession(initial: Record<string, unknown> = {}) {
  return { ...initial, save: vi.fn(), destroy: vi.fn() } as Record<string, unknown>;
}

describe("GET /api/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The common case: the session holds a credential and it is still good, so
    // the refresh is a no-op that hands back the token it was given.
    vi.mocked(getFreshIdToken).mockResolvedValue("tk");
  });

  it("503 when auth not configured", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(false);
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "auth_not_configured" });
  });

  it("400 missing_tenant_id", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_tenant_id" });
  });

  it("401 when the session has no usable credential", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(fakeSession({}) as never);
    // Null covers both "never signed in" and "the refresh token is permanently
    // dead, so the session was just destroyed".
    vi.mocked(getFreshIdToken).mockResolvedValue(null);
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "not_authenticated" });
  });

  it("403 when tenant not in known tenants", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({ idToken: "tk", tenants: [{ id: "other" }] }) as never,
    );
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "tenant_not_accessible" });
  });

  it("maps accounts and drops deleted ones", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({ idToken: "tk", tenants: [{ id: "t1" }] }) as never,
    );
    vi.mocked(listTenantAccounts).mockResolvedValue({
      accounts: [
        { id: "a1", tenant_id: "t1", name: "Prod", slug: "prod", status: "active" },
        { id: "a2", tenant_id: "t1", name: "Old", slug: "old", status: "deleted" },
        { id: "a3", tenant_id: "t1", status: "active" },
      ],
    } as never);
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accounts).toEqual([
      { id: "a1", name: "Prod", slug: "prod" },
      { id: "a3", name: undefined, slug: undefined },
    ]);
    expect(listTenantAccounts).toHaveBeenCalledWith("tk", "t1");
  });

  it("Bearers the REFRESHED token, not the one sitting in the cookie", async () => {
    // The workspace picker is reached after idling, so the stored token is
    // routinely past its hour by the time this route runs. Reading
    // `session.idToken` directly is what kept this one screen on the 1-hour
    // cliff after every other screen had been fixed.
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({ idToken: "expired-tk", tenants: [{ id: "t1" }] }) as never,
    );
    vi.mocked(getFreshIdToken).mockResolvedValue("fresh-tk");
    vi.mocked(listTenantAccounts).mockResolvedValue({ accounts: [] } as never);

    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));

    expect(res.status).toBe(200);
    expect(getFreshIdToken).toHaveBeenCalled();
    expect(listTenantAccounts).toHaveBeenCalledWith("fresh-tk", "t1");
    expect(listTenantAccounts).not.toHaveBeenCalledWith("expired-tk", "t1");
  });

  it("allows manual tenant when session has no tenants list", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(fakeSession({ idToken: "tk" }) as never);
    vi.mocked(listTenantAccounts).mockResolvedValue({ accounts: [] } as never);
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("manual"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ accounts: [] });
  });

  it("propagates MagickApiError status", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({ idToken: "tk", tenants: [{ id: "t1" }] }) as never,
    );
    vi.mocked(listTenantAccounts).mockRejectedValue(
      new MagickApiError(403, "forbidden", "http://test/accounts"),
    );
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "accounts_failed" });
  });

  it("falls back to 502 on a generic error", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(
      fakeSession({ idToken: "tk", tenants: [{ id: "t1" }] }) as never,
    );
    vi.mocked(listTenantAccounts).mockRejectedValue(new Error("network down"));
    const { GET } = await import("@/app/api/accounts/route");
    const res = await GET(req("t1"));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "accounts_failed" });
  });
});
