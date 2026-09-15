import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  env: { llm: { model: "backend-model" } },
  isBackendConfigured: vi.fn(),
  isLlmConfigured: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  consumeAiQuota: vi.fn().mockResolvedValue(true),
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
vi.mock("@/lib/server/dataset", () => ({ datasetFingerprint: vi.fn().mockResolvedValue("dataset") }));
vi.mock("@/lib/server/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/selection")>()),
  // A real selection, not `[]` — an empty one makes the call-analysis
  // enrichment skip, which would silently hollow out every case below.
  validateSelection: vi.fn().mockResolvedValue([{ batchId: "b1", sourceId: "job-1", selType: "ai" }]),
}));
vi.mock("@/lib/server/call-analysis", () => ({ enrichWithCallAnalysis: vi.fn() }));

const structured = vi.fn();
vi.mock("@/lib/server/llm", () => ({
  getLLM: () => ({ structured }),
  INSIGHT_SCHEMA: {},
}));

import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getInsight, getRecords, setInsight } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";
import { enrichWithCallAnalysis } from "@/lib/server/call-analysis";
import { validateSelection } from "@/lib/server/selection";

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSelection).mockResolvedValue([{ batchId: "b1", sourceId: "job-1", selType: "ai" }] as never);
    vi.mocked(enrichWithCallAnalysis).mockImplementation(
      async (_ctx, _batches, aggregate) => ({ aggregate, status: "ok", cacheable: true }),
    );
  });

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
    // A real Insight doc always carries the aggregates key it was generated
    // from; a hit is only served when that still matches (see the stale-shape
    // cases below), so the fixture has to include it.
    vi.mocked(getInsight).mockResolvedValue({ narrative: "old", fingerprint: "agg-key" } as never);
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"], model: "client-model" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ insight: { narrative: "old", fingerprint: "agg-key" }, cached: true });
    expect(getInsight).toHaveBeenCalledWith("t1", "a1", "set-key:dataset:backend-model");
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
    const res = await POST(req({ batchIds: ["b1"], model: "client-model" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cached).toBe(false);
    expect(json.insight.narrative).toBe("all good");
    expect(json.insight.tenantId).toBe("t1");
    expect(json.insight.key).toBe("set-key:dataset:backend-model");
    expect(json.insight.model).toBe("backend-model");
    expect(setInsight).toHaveBeenCalled();
  });

  it("grounds time recommendations in the deterministic reach window", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue({
      ...AGG,
      reachByTimeOfDay: {
        timezone: "Asia/Kolkata",
        bandHours: 1,
        minSamples: 20,
        totalPlaced: 40,
        cells: [{ weekday: 2, band: 15, total: 40, reached: 30, rate: 0.75, lowSample: false }],
      },
    } as never);
    structured.mockResolvedValue({ narrative: "grounded", anomalies: [], recommendations: [] });
    const { POST } = await import("@/app/api/insights/route");
    expect((await POST(req({ batchIds: ["b1"] }))).status).toBe(200);

    const messages = structured.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages[1].content).toContain('"window": "3 pm–4 pm"');
    expect(messages[1].content).toContain('"timezone": "Asia/Kolkata"');
    expect(messages[0].content).toContain("Only make a best-time recommendation when `bestReachWindow` is non-null");
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
    // The prose reads agg.topics/agg.sentiment, so this path must enrich too —
    // otherwise the AI says "no key topics" beside a chart showing them.
    expect(enrichWithCallAnalysis).toHaveBeenCalledWith(
      ctx,
      [{ batchId: "b1", sourceId: "job-1", selType: "ai" }],
      AGG,
    );
  });

  // The insight key is as immovable as the aggregate key, so pinning prose
  // generated from an unreadable rollup would serve "no key topics" forever.
  it("does not cache an insight generated while the analysis rollup was unreadable", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue(AGG as never);
    vi.mocked(enrichWithCallAnalysis).mockResolvedValue({
      aggregate: { ...AGG, analysisUnavailable: true },
      status: "failed",
      cacheable: false,
    } as never);
    structured.mockResolvedValue({ narrative: "ok", anomalies: [], recommendations: [] });
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));

    expect(res.status).toBe(200); // still answered — degraded, not broken
    expect(setInsight).not.toHaveBeenCalled();
  });

  // `insightKey` carries no AGGREGATES_VERSION, so a hit can predate a bump in
  // how the aggregate it describes was computed. Without this the reporting
  // customer keeps reading "no key topics" from pre-v7 prose beside a v7 chart
  // that now shows them.
  it("ignores a cached insight generated from a different aggregate shape", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue({ narrative: "stale", fingerprint: "agg-key-v6" } as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    structured.mockResolvedValue({ narrative: "fresh", anomalies: [], recommendations: [] });
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));

    // aggregatesKey is mocked to "agg-key"; the cached doc says "agg-key-v6".
    await expect(res.json()).resolves.toMatchObject({ cached: false, insight: { narrative: "fresh" } });
    expect(structured).toHaveBeenCalled();
  });

  it("serves a cached insight whose fingerprint matches the current aggregate", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue({ narrative: "current", fingerprint: "agg-key" } as never);
    const { POST } = await import("@/app/api/insights/route");
    const res = await POST(req({ batchIds: ["b1"] }));

    await expect(res.json()).resolves.toMatchObject({ cached: true, insight: { narrative: "current" } });
    expect(structured).not.toHaveBeenCalled();
  });

  it("caches the insight normally when the rollup was readable", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    structured.mockResolvedValue({ narrative: "ok", anomalies: [], recommendations: [] });
    const { POST } = await import("@/app/api/insights/route");
    await POST(req({ batchIds: ["b1"] }));

    expect(setInsight).toHaveBeenCalled();
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
