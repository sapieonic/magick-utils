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
vi.mock("@/lib/server/dataset", () => ({ datasetFingerprint: vi.fn().mockResolvedValue("dataset") }));
vi.mock("@/lib/server/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/selection")>()),
  // A real union of BOTH selections, not `[]`.
  validateSelection: vi.fn().mockResolvedValue([
    { batchId: "b1", sourceId: "job-1", selType: "ai" },
    { batchId: "b2", sourceId: "job-2", selType: "ai" },
  ]),
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
    topicShifts: [{ key: "billing", currentShare: 0.4, baselineShare: 0, deltaShare: 0.4 }],
    statusMixShift: [],
    sentimentShift: [{ key: "Positive", currentShare: 0.6, baselineShare: 0, deltaShare: 0.6 }],
    funnelShifts: undefined,
  })),
}));

vi.mock("@/lib/server/call-analysis", () => ({ enrichWithCallAnalysis: vi.fn() }));

const structured = vi.fn();
vi.mock("@/lib/server/llm", () => ({ getLLM: () => ({ structured }), INSIGHT_SCHEMA: {} }));

import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getBatch, getInsight, getRecords, setInsight } from "@/lib/server/repositories";
import { compareKey } from "@/lib/server/fingerprint";
import { SelectionError, validateSelection } from "@/lib/server/selection";
import { computeAggregates } from "@/lib/server/aggregate";
import { enrichWithCallAnalysis } from "@/lib/server/call-analysis";

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSelection).mockResolvedValue([
      { batchId: "b1", sourceId: "job-1", selType: "ai" },
      { batchId: "b2", sourceId: "job-2", selType: "ai" },
    ] as never);
    vi.mocked(enrichWithCallAnalysis).mockImplementation(
      async (_ctx, _batches, aggregate) => ({ aggregate, status: "ok", cacheable: true }),
    );
  });

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
    vi.mocked(validateSelection).mockRejectedValueOnce(new SelectionError(400, "seltype_mismatch", "Select batches of the same type."));
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "seltype_mismatch" });
  });

  it("returns a cached comparison when present and no refresh", async () => {
    authed();
    vi.mocked(getBatch).mockResolvedValue({ selType: "ai" } as never);
    vi.mocked(getAggregates).mockResolvedValue(AGG as never);
    vi.mocked(getInsight).mockResolvedValue({ narrative: "cached cmp" } as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req({ ...body, model: "client-model" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ insight: { narrative: "cached cmp" }, cached: true });
    expect(compareKey).toHaveBeenCalledWith(["cur"], ["base"], "backend-model", "dataset", "dataset");
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
    const res = await POST(req({ ...body, model: "client-model" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cached).toBe(false);
    expect(json.insight.narrative).toBe("what changed");
    expect(json.insight.tenantId).toBe("t1");
    expect(json.insight.key).toBe("compare-key");
    expect(json.insight.model).toBe("backend-model");
    expect(compareKey).toHaveBeenCalledWith(["cur"], ["base"], "backend-model", "dataset", "dataset");
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

describe("POST /api/insights/compare — call-analysis symmetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSelection).mockResolvedValue([
      { batchId: "b1", sourceId: "job-1", selType: "ai" },
      { batchId: "b2", sourceId: "job-2", selType: "ai" },
    ] as never);
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getInsight).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue(AGG as never);
    structured.mockResolvedValue({ narrative: "n", anomalies: [], recommendations: [] });
  });

  /** The prompt the model was actually handed. */
  function promptBody(): string {
    return (structured.mock.calls[0][0] as { role: string; content: string }[])[1].content;
  }

  it("hands each side only its own batches, not the validated union", async () => {
    // Passing the union would compute the baseline's rollup over the current
    // selection's jobs as well — a silently wrong comparison.
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    await POST(req({ batchIds: ["b1"], baselineBatchIds: ["b2"] }));

    const perSide = vi.mocked(enrichWithCallAnalysis).mock.calls.map((c) => c[1]);
    expect(perSide).toHaveLength(2);
    expect(perSide.map((b) => b.map((d) => d.batchId))).toEqual([["b1"], ["b2"]]);
  });

  it("keeps topic and sentiment shifts when both sides have readable analysis", async () => {
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    await POST(req({ batchIds: ["b1"], baselineBatchIds: ["b2"] }));

    expect(promptBody()).toContain("billing");
  });

  // shareShifts reports a key missing from one side as a full-magnitude swing.
  // If that side is empty only because its rollup could not be read, the model
  // is handed a change that never happened and explains it as real.
  it("drops topic and sentiment shifts when one side's analysis is unreadable", async () => {
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(enrichWithCallAnalysis)
      .mockResolvedValueOnce({ aggregate: AGG, status: "ok", cacheable: true } as never)
      .mockResolvedValueOnce({
        aggregate: { ...AGG, analysisUnavailable: true },
        status: "failed",
        cacheable: false,
      } as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req({ batchIds: ["b1"], baselineBatchIds: ["b2"] }));

    expect(res.status).toBe(200); // every other delta is still sound
    const body = promptBody();
    expect(body).not.toContain("billing");
    expect(body).toContain("successRate"); // the rest of the diff survives
  });

  it("also drops them when an unreadable side came from cache", async () => {
    // analysisUnavailable rides on the doc, so a cached settled-refusal is
    // caught too — the enrichment status of this request is not enough.
    vi.mocked(getAggregates)
      .mockResolvedValueOnce(AGG as never)
      .mockResolvedValueOnce({ ...AGG, analysisUnavailable: true } as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    await POST(req({ batchIds: ["b1"], baselineBatchIds: ["b2"] }));

    expect(promptBody()).not.toContain("billing");
  });

  // Gating the persist matters more here than the prompt strip: compareKey is
  // immovable, so a narrative generated with the shifts stripped would be served
  // on every later request, including after the rollup recovers.
  it("does not cache a comparison whose shifts were stripped", async () => {
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(enrichWithCallAnalysis)
      .mockResolvedValueOnce({ aggregate: AGG, status: "ok", cacheable: true } as never)
      .mockResolvedValueOnce({
        aggregate: { ...AGG, analysisUnavailable: true },
        status: "failed",
        cacheable: false,
      } as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    const res = await POST(req({ batchIds: ["b1"], baselineBatchIds: ["b2"] }));

    expect(res.status).toBe(200); // still answered
    expect(setInsight).not.toHaveBeenCalled();
  });

  it("caches a comparison when both sides had readable analysis", async () => {
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    const { POST } = await import("@/app/api/insights/compare/route");
    await POST(req({ batchIds: ["b1"], baselineBatchIds: ["b2"] }));

    expect(setInsight).toHaveBeenCalled();
  });
});
