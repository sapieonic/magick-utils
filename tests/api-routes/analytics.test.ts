import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  getAggregates: vi.fn(),
  getRecords: vi.fn(),
  setAggregates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/server/aggregate", () => ({ computeAggregates: vi.fn() }));
vi.mock("@/lib/server/fingerprint", () => ({ aggregatesKey: vi.fn(() => "agg-key") }));

import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getRecords, setAggregates } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

function req(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/analytics", {
    method: "POST",
    body: badJson ? "{bad" : JSON.stringify(body ?? {}),
  });
}

describe("POST /api/analytics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/analytics/route");
    expect((await POST(req({ batchIds: ["b1"] }))).status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { POST } = await import("@/app/api/analytics/route");
    expect((await POST(req({ batchIds: ["b1"] }))).status).toBe(401);
  });

  it("400 invalid_json", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req(undefined, true));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("400 no_batches", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/analytics/route");
    expect((await POST(req({ batchIds: [] }))).status).toBe(400);
  });

  it("returns cached aggregates when present and no refresh", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue({ totalRecords: 5 } as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ aggregates: { totalRecords: 5 }, cached: true });
    expect(getRecords).not.toHaveBeenCalled();
  });

  it("409 not_ingested when no records", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([] as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "not_ingested" });
  });

  it("computes + persists aggregates on cache miss", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue({ totalRecords: 1, key: "agg-key" } as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      aggregates: { totalRecords: 1, key: "agg-key" },
      cached: false,
    });
    expect(setAggregates).toHaveBeenCalled();
  });

  it("refresh:true bypasses cache and recomputes", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue({ totalRecords: 99 } as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue({ totalRecords: 1 } as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"], refresh: true }));
    expect(res.status).toBe(200);
    expect(getAggregates).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ cached: false });
  });
});
