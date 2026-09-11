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
vi.mock("@/lib/server/magick-client", () => ({
  MagickClient: vi.fn(() => ({ getBulkJob })),
}));

// hoisted so the (also-hoisted) MagickClient factory above can close over it
const { getBulkJob } = vi.hoisted(() => ({ getBulkJob: vi.fn() }));

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
    await expect(res.json()).resolves.toEqual({ jobId: null, total: 0, done: 0, ready: true, upToDate: false });
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
    vi.mocked(findActiveJobForBatches).mockResolvedValue({ jobId: "active", total: 10, done: 4, batchIds: ["b1"] } as never);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jobId: "active", total: 10, done: 4, ready: false, existing: true });
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

  it("does not re-ingest analyze batches whose normalized records already exist", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getBatch).mockResolvedValue({ total: 10, selType: "ai", ingestStatus: "ready" } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], type: "ingest" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jobId: null, total: 0, done: 0, ready: true, upToDate: false });
    expect(createJob).not.toHaveBeenCalled();
  });

  it("re-pulls ready analyze batches when refresh is true and the source moved", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({
      total: 10, selType: "ai", ingestStatus: "ready",
      sourceId: "job-1", ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
    } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    // Upstream wrote to the job after we ingested ⇒ real work to do.
    getBulkJob.mockResolvedValue({ id: "job-1", status: "completed", updated_at: "2026-09-01T11:00:00Z" });
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ total: 10, done: 0, ready: false });
    expect(typeof json.jobId).toBe("string");
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  // Each ingestion writes a complete new copy of every record, so an
  // unconditional refresh let repeated clicks fill the cluster's storage.
  it("skips a refresh whose upstream job has not been touched since ingestion", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({
      total: 10, selType: "ai", ingestStatus: "ready",
      sourceId: "job-1", ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
    } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    getBulkJob.mockResolvedValue({ id: "job-1", status: "completed", updated_at: "2026-09-01T10:00:00Z" });
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }));
    expect(res.status).toBe(200);
    // Reported distinctly so the screen can say "already up to date" rather
    // than replaying a progress bar over unchanged numbers.
    await expect(res.json()).resolves.toMatchObject({ jobId: null, ready: true, upToDate: true });
    expect(createJob).not.toHaveBeenCalled();
  });

  // A running campaign keeps producing records, and its summary fields can sit
  // still while they do — never skip one, whatever the timestamps say.
  it("re-ingests a job that has not finished, even with an unchanged timestamp", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({
      total: 10, selType: "ai", ingestStatus: "ready",
      sourceId: "job-1", ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
    } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    getBulkJob.mockResolvedValue({ id: "job-1", status: "processing", updated_at: "2026-09-01T10:00:00Z" });
    const { POST } = await import("@/app/api/ingest/route");
    expect((await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }))).status).toBe(200);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("refreshes a stale batch, which is readable but behind its source", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({
      total: 10, selType: "ai", ingestStatus: "stale",
      sourceId: "job-1", ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
    } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    getBulkJob.mockResolvedValue({ id: "job-1", status: "completed", updated_at: "2026-09-01T12:00:00Z" });
    const { POST } = await import("@/app/api/ingest/route");
    expect((await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }))).status).toBe(200);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  // The regression the two freshness signals can produce together: the listing
  // marks the batch stale because its source fingerprint moved, while
  // `updated_at` sits still. Deferring to the timestamp latches the batch stale
  // in Mongo and makes every later Refresh a no-op against that same timestamp,
  // so nothing the customer can click ever clears it.
  it("refreshes a stale batch even when its upstream timestamp has not moved", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({
      total: 10, selType: "ai", ingestStatus: "stale",
      sourceId: "job-1", ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
    } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    getBulkJob.mockResolvedValue({ id: "job-1", status: "completed", updated_at: "2026-09-01T10:00:00Z" });
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }));
    expect(res.status).toBe(200);
    // A real job, not the `{ jobId: null, upToDate: true }` skip response.
    await expect(res.json()).resolves.toMatchObject({ jobId: expect.any(String) });
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("re-ingests rather than skipping when the upstream source check fails", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({
      total: 10, selType: "ai", ingestStatus: "ready",
      sourceId: "job-1", ingestedSourceUpdatedAt: "2026-09-01T10:00:00Z",
    } as never);
    vi.mocked(countRecords).mockResolvedValue(10);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    getBulkJob.mockRejectedValue(new Error("upstream down"));
    const { POST } = await import("@/app/api/ingest/route");
    expect((await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }))).status).toBe(200);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("does not consult upstream for a batch that was never fully ingested", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getSession).mockResolvedValue({ idToken: "tk" } as never);
    vi.mocked(getBatch).mockResolvedValue({ total: 10, selType: "ai", ingestStatus: "none", sourceId: "job-1" } as never);
    vi.mocked(countRecords).mockResolvedValue(0);
    vi.mocked(findActiveJobForBatches).mockResolvedValue(null);
    const { POST } = await import("@/app/api/ingest/route");
    expect((await POST(req({ batchIds: ["b1"], type: "ingest", refresh: true }))).status).toBe(200);
    expect(getBulkJob).not.toHaveBeenCalled();
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("400 invalid_refresh", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/ingest/route");
    const res = await POST(req({ batchIds: ["b1"], refresh: "yes" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_refresh" });
  });
});
