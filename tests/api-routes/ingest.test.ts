import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));
vi.mock("@/lib/server/session", () => ({
  getTenantContext: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@/lib/server/repositories", () => ({
  acquireIngestionLocks: vi.fn().mockResolvedValue(undefined),
  createJob: vi.fn().mockResolvedValue(undefined),
  getBatch: vi.fn(),
  countRecords: vi.fn(),
  findActiveJobForBatches: vi.fn().mockResolvedValue(null),
  releaseIngestionLocks: vi.fn().mockResolvedValue(undefined),
}));

import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext, getSession } from "@/lib/server/session";
import { countRecords, createJob, findActiveJobForBatches, getBatch } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

function req(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    body: badJson ? "{bad" : JSON.stringify(body ?? {}),
  });
}

describe("POST /api/ingest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(401);
  });

  it("400 invalid_json", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req(undefined, true));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("400 no_batches", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: [] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "no_batches" });
  });

  it("creates an ingest job, sums batch totals, returns {jobId,total}", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockImplementation(
      (_t: string, _a: string, id: string) => Promise.resolve(({ total: id === "b1" ? 10 : 5 }) as never),
    );

    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1", "b2"] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(15);
    expect(typeof json.jobId).toBe("string");
    expect(createJob).toHaveBeenCalledTimes(1);
    const created = vi.mocked(createJob).mock.calls[0][0];
    expect(created.type).toBe("ingest");
    expect(created.status).toBe("queued");
    expect(created.batchIds).toEqual(["b1", "b2"]);
    expect(created.idToken).toBe("tk");
  });

  it("honors type:merge", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({ total: 10, selType: "ai", ingestStatus: "none" } as never);
    vi.mocked(countRecords).mockResolvedValue(0);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], type: "merge" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(createJob).mock.calls[0][0].type).toBe("merge");
  });

  it("does not re-ingest merge batches whose normalized records already exist", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getBatch).mockResolvedValue({ total: 10, selType: "ai", ingestStatus: "ready" } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], type: "merge" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jobId: null, total: 0, ready: true });
    expect(createJob).not.toHaveBeenCalled();
  });

  it("does not misclassify a repository outage as batch_not_found", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockRejectedValue(new Error("mongo down"));
    const { POST } = await import("@/app/api/ingest/route");
    await expect(POST(req({ batchIds: ["b1"] }))).rejects.toThrow("mongo down");
  });

  it("reattaches callers to overlapping active ingestion jobs", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({ total: 10, selType: "ai", ingestStatus: "none" } as never);
    vi.mocked(findActiveJobForBatches).mockResolvedValue({ jobId: "active", total: 10, batchIds: ["b1"] } as never);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jobId: "active", total: 10, ready: false, existing: true });
  });

  it("rejects reattachment when an overlapping job does not cover the full selection", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({ total: 10, selType: "ai", ingestStatus: "none" } as never);
    vi.mocked(findActiveJobForBatches).mockResolvedValue({ jobId: "active", total: 10, batchIds: ["b1"] } as never);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1", "b2"] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "ingestion_in_progress" });
  });
});
