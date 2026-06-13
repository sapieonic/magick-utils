import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isAuthConfigured: vi.fn(),
}));

vi.mock("@/lib/server/session", () => ({
  getSession: vi.fn(),
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
import { getSession } from "@/lib/server/session";
import { listTenantAccounts, MagickApiError } from "@/lib/server/magick-client";

function req(tenantId?: string) {
  const qs = tenantId === undefined ? "" : `?tenantId=${encodeURIComponent(tenantId)}`;
  return new Request(`http://localhost/api/accounts${qs}`);
}

function fakeSession(initial: Record<string, unknown> = {}) {
  return { ...initial, save: vi.fn(), destroy: vi.fn() } as Record<string, unknown>;
}

describe("GET /api/accounts", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("401 when no idToken in session", async () => {
    vi.mocked(isAuthConfigured).mockReturnValue(true);
    vi.mocked(getSession).mockResolvedValue(fakeSession({}) as never);
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
