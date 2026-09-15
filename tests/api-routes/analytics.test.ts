import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  getAggregates: vi.fn(),
  getRecords: vi.fn(),
  setAggregates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/server/aggregate", () => ({ computeAggregates: vi.fn() }));
vi.mock("@/lib/server/call-analysis", () => ({ enrichWithCallAnalysis: vi.fn() }));
vi.mock("@/lib/server/fingerprint", () => ({ aggregatesKey: vi.fn(() => "agg-key") }));
vi.mock("@/lib/server/dataset", () => ({ datasetFingerprint: vi.fn().mockResolvedValue("dataset") }));
vi.mock("@/lib/server/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/selection")>()),
  validateSelection: vi.fn(),
}));

import { SelectionError, validateSelection } from "@/lib/server/selection";
import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getRecords, setAggregates } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";
import { enrichWithCallAnalysis } from "@/lib/server/call-analysis";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

function req(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/analytics", {
    method: "POST",
    body: badJson ? "{bad" : JSON.stringify(body ?? {}),
  });
}

describe("POST /api/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a selection whose batches are ready and non-empty.
    vi.mocked(validateSelection).mockResolvedValue([{ batchId: "b1", total: 10, sourceId: "job-1", selType: "ai" }] as never);
    // Default: enrichment passes the aggregate through and is safe to cache.
    vi.mocked(enrichWithCallAnalysis).mockImplementation(
      async (_ctx, _batches, aggregate) => ({ aggregate, status: "ok", cacheable: true }),
    );
  });

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

  // Batches that have not finished ingesting are rejected by validateSelection
  // (requireReady + verifyCounts) before any of this runs.
  it("delegates the un-ingested check to validateSelection", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(validateSelection).mockRejectedValue(
      new SelectionError(409, "incomplete_ingestion", "One or more selected batches are incomplete."),
    );
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "incomplete_ingestion" });
    expect(getRecords).not.toHaveBeenCalled();
  });

  // A campaign that dispatched nothing legitimately has no records. Treating
  // that as a conflict showed a hard error and pushed the client to re-ingest.
  it("serves empty aggregates for a selection that dispatched nothing", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(validateSelection).mockResolvedValue([{ batchId: "b1", total: 0, sourceId: "job-1", selType: "ai" }] as never);
    vi.mocked(getRecords).mockResolvedValue([] as never);
    vi.mocked(computeAggregates).mockReturnValue({ totalRecords: 0 } as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ aggregates: { totalRecords: 0 } });
    expect(computeAggregates).toHaveBeenCalledWith([], ["b1"], ctx, "agg-key");
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

  // Sentiment and key topics cannot come from the ingested records: core's calls
  // list projects a column subset that excludes `call_analysis` and sends the key
  // as null, so every record normalizes to no analysis. They are filled here from
  // core's own rollup instead.
  it("serves sentiment and topics from the call-analysis enrichment", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue({ totalRecords: 1, sentiment: [], topics: [] } as never);
    vi.mocked(enrichWithCallAnalysis).mockResolvedValue({
      aggregate: {
        totalRecords: 1,
        sentiment: [{ name: "Positive", value: 1 }],
        topics: [{ topic: "billing", count: 1, sentiment: "neutral" }],
      },
      status: "ok",
      cacheable: true,
    } as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));

    expect(res.status).toBe(200);
    // The route hands over the validated BatchDocs: their selType decides
    // whether there is anything to ask for, and their sourceIds are what the
    // upstream call is made with.
    expect(enrichWithCallAnalysis).toHaveBeenCalledWith(
      ctx,
      [{ batchId: "b1", total: 10, sourceId: "job-1", selType: "ai" }],
      { totalRecords: 1, sentiment: [], topics: [] },
    );
    await expect(res.json()).resolves.toMatchObject({
      aggregates: { sentiment: [{ name: "Positive", value: 1 }] },
    });
    expect(setAggregates).toHaveBeenCalled();
  });

  // The cache key is a fingerprint of the batch set and its dataset, and neither
  // moves because an upstream call failed — so persisting a failed enrichment
  // would pin the two empty cards until someone hit Refresh.
  it("serves but does not cache aggregates whose enrichment failed", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue(null as never);
    vi.mocked(getRecords).mockResolvedValue([{ recordId: "r1" }] as never);
    vi.mocked(computeAggregates).mockReturnValue({ totalRecords: 1 } as never);
    vi.mocked(enrichWithCallAnalysis).mockResolvedValue({
      aggregate: { totalRecords: 1 },
      status: "failed",
      cacheable: false,
    } as never);
    const { POST } = await import("@/app/api/analytics/route");
    const res = await POST(req({ batchIds: ["b1"] }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ aggregates: { totalRecords: 1 } });
    expect(setAggregates).not.toHaveBeenCalled();
  });
});
