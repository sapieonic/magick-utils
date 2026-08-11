import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({ getJob: vi.fn() }));

import { getTenantContext } from "@/lib/server/session";
import { getJob } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };
const dynReq = new Request("http://localhost/api/jobs/j1");

// Next 16 dynamic route handler: params is a Promise.
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 when not authenticated", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const res = await GET(dynReq, params("j1"));
    expect(res.status).toBe(401);
  });

  it("404 when job missing", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getJob).mockResolvedValue(null);
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const res = await GET(dynReq, params("nope"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("404 when job belongs to a different tenant/account", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getJob).mockResolvedValue({
      jobId: "j1", tenantId: "other", accountId: "a1", idToken: "secret",
    } as never);
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const res = await GET(dynReq, params("j1"));
    expect(res.status).toBe(404);
  });

  it("returns the job with idToken stripped", async () => {
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getJob).mockResolvedValue({
      jobId: "j1",
      type: "ingest",
      tenantId: "t1",
      accountId: "a1",
      idToken: "secret",
      status: "running",
      total: 10,
      done: 3,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:01:00.000Z",
      cursor: 100,
      batchIndex: 1,
      leaseId: "secret-lease",
    } as never);
    const { GET } = await import("@/app/api/jobs/[id]/route");
    const res = await GET(dynReq, params("j1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      jobId: "j1",
      type: "ingest",
      status: "running",
      total: 10,
      done: 3,
      retryAt: null,
      retryCount: 0,
      error: null,
      result: null,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:01:00.000Z",
    });
  });
});
