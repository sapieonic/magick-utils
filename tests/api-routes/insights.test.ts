import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isBackendConfigured: vi.fn(),
  isLlmConfigured: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  getAggregates: vi.fn(),
  getInsight: vi.fn(),
  getRecords: vi.fn(),
  setAggregates: vi.fn().mockResolvedValue(undefined),
  setInsight: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/server/aggregate", () => ({ computeAggregates: vi.fn() }));
vi.mock("@/lib/server/fingerprint", () => ({
  aggregatesKey: vi.fn(() => "agg-key"),
  batchSetKey: vi.fn(() => "set-key"),
}));

const structured = vi.fn();
vi.mock("@/lib/server/llm", () => ({
  getLLM: () => ({ structured }),
  INSIGHT_SCHEMA: {},
}));

import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getInsight, getRecords, setInsight } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };
const AGG = {
  totalRecords: 10, successRate: 0.5, statusMix: {}, spendInr: 100,
  telephonyInr: 60, aiInr: 40, sentiment: {}, topics: [], funnel: {},
};

function req(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/insights", {
    method: "POST",
    body: badJson ? "{bad" : JSON.stringify(body ?? {}),
  });
}

describe("POST /api/insights", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/insights/route");
    expect((await POST(req({ batchIds: ["b1"] }))).status).toBe(503);
  });

  it("503 when LLM not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "llm_not_configured" });
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { POST } = await import("@/app/api/insights/route");
    expect((await POST(req({ batchIds: ["b1"] }))).status).toBe(401);
  });

  it("400 invalid_json", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/insights/route");
    expect((await POST(req(undefined, true))).status).toBe(400);
  });

  it("400 no_batches", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/insights/route");
    expect((await POST(req({ batchIds: [] }))).status).toBe(400);
  });

  it("returns cached insight when present and no refresh", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue({ narrative: "old" } as never);
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ insight: { narrative: "old" }, cached: true });
  });

  it("409 not_ingested when no aggregates and no records", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([] as never);
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "not_ingested" });
  });

  it("generates a fresh insight on happy path", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    structured.mockResolvedValue({
      narrative: "all good",
      anomalies: [{ title: "a", detail: "d", severity: "low" }],
      recommendations: [{ title: "r", detail: "d" }],
    });
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cached).toBe(false);
    expect(json.insight.narrative).toBe("all good");
    expect(json.insight.tenantId).toBe("t1");
    expect(setInsight).toHaveBeenCalled();
  });

  it("computes aggregates first when missing but records exist", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue(AGG as never);
    structured.mockResolvedValue({ narrative: "ok", anomalies: [], recommendations: [] });
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    expect(computeAggregates).toHaveBeenCalled();
  });

  it("502 llm_failed when the model throws", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    structured.mockRejectedValue(new Error("model exploded"));
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "llm_failed" });
  });
});
