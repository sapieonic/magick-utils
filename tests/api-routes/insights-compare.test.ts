import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isBackendConfigured: vi.fn(),
  isLlmConfigured: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  getAggregates: vi.fn(),
  getBatch: vi.fn(),
  getInsight: vi.fn(),
  getRecords: vi.fn(),
  setAggregates: vi.fn().mockResolvedValue(undefined),
  setInsight: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/server/aggregate", () => ({ computeAggregates: vi.fn() }));
vi.mock("@/lib/server/fingerprint", () => ({
  aggregatesKey: vi.fn((ids: string[]) => `agg-${ids.join(",")}`),
  compareKey: vi.fn(() => "compare-key"),
}));
// diffAggregates is exercised by its own unit tests; stub a fully-shaped diff
// so the route's diffContext serialization runs without coupling to its math.
vi.mock("@/lib/diff", () => ({
  diffAggregates: vi.fn(() => ({
    current: { batchIds: ["cur"], totalRecords: 100 },
    baseline: { batchIds: ["base"], totalRecords: 80 },
    successRate: { current: 0.5, baseline: 0.45, deltaPp: 5, relative: 0.11 },
    spendInr: { current: 100, baseline: 90, delta: 10, relative: 0.11 },
    telephonyInr: { current: 60, baseline: 55, delta: 5, relative: 0.09 },
    aiInr: { current: 40, baseline: 35, delta: 5, relative: 0.14 },
    costSplit: { currentTelephonyShare: 0.6, baselineTelephonyShare: 0.61, deltaShare: -0.01 },
    volume: { current: 100, baseline: 80, delta: 20, relative: 0.25 },
    topicShifts: [],
    statusMixShift: [],
    sentimentShift: [],
    funnelShifts: undefined,
  })),
}));

const structured = vi.fn();
vi.mock("@/lib/server/llm", () => ({ getLLM: () => ({ structured }), INSIGHT_SCHEMA: {} }));

import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getBatch, getInsight, getRecords, setInsight } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };
const AGG = { totalRecords: 100, successRate: 0.5, statusMix: [], spendInr: 100, telephonyInr: 60, aiInr: 40, batchIds: ["b"] };

function req(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/insights/compare", { method: "POST", body: badJson ? "{bad" : JSON.stringify(body ?? {}) });
}

/** Authenticate + backend/LLM on. Callers override repo mocks per case. */
function authed() {
  vi.mocked(isBackendConfigured).mockReturnValue(true);
  vi.mocked(isLlmConfigured).mockReturnValue(true);
  vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
}

const body = { batchIds: ["cur"], baselineBatchIds: ["base"] };

describe("POST /api/insights/compare", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/insights/compare/route");
    expect((await POST(req(body))).status).toBe(503);
  });

  it("503 when LLM not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/insights/compare/route");
    expect((await POST(req(body))).status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { POST } = await import("@/app/api/insights/compare/route");
    expect((await POST(req(body))).status).toBe(401);
  });

  it("400 invalid_json", async () => {
    authed();
    const { POST } = await import("@/app/api/insights/compare/route");
    expect((await POST(req(undefined, true))).status).toBe(400);
  });

  it("400 no_batches when batchIds empty", async () => {
    authed();
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req({ batchIds: [], baselineBatchIds: ["base"] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "no_batches" });
  });

  it("400 no_baseline when baselineBatchIds empty", async () => {
    authed();
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req({ batchIds: ["cur"], baselineBatchIds: [] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "no_baseline" });
  });

  it("400 seltype_mismatch when the two sides are different selTypes", async () => {
    authed();
    vi.mocked(getBatch).mockImplementation((_t, _a, id) => Promise.resolve({ selType: id === "cur" ? "ai" : "message" } as never));
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "seltype_mismatch" });
  });

  it("returns a cached comparison when present and no refresh", async () => {
    authed();
    vi.mocked(getBatch).mockResolvedValue({ selType: "ai" } as never);
    vi.mocked(getInsight).mockResolvedValue({ narrative: "cached cmp" } as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ insight: { narrative: "cached cmp" }, cached: true });
    expect(structured).not.toHaveBeenCalled();
  });

  it("409 not_ingested when either side has no records", async () => {
    authed();
    vi.mocked(getBatch).mockResolvedValue({ selType: "ai" } as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([] as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req(body));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "not_ingested" });
  });

  it("generates and caches a fresh comparison on the happy path", async () => {
    authed();
    vi.mocked(getBatch).mockResolvedValue({ selType: "ai" } as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    structured.mockResolvedValue({ narrative: "what changed", anomalies: [], recommendations: [{ title: "r", detail: "d" }] });
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cached).toBe(false);
    expect(json.insight.narrative).toBe("what changed");
    expect(json.insight.tenantId).toBe("t1");
    expect(json.insight.key).toBe("compare-key");
    expect(setInsight).toHaveBeenCalled();
  });

  it("502 llm_failed when the model throws", async () => {
    authed();
    vi.mocked(getBatch).mockResolvedValue({ selType: "ai" } as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    structured.mockRejectedValue(new Error("boom"));
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req(body));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "llm_failed" });
  });
});
