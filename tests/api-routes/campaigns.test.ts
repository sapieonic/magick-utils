import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));

const listBulkJobs = vi.fn();
vi.mock("@/lib/server/magick-client", () => ({
  MagickClient: class {
    listBulkJobs = listBulkJobs;
  },
}));

vi.mock("@/lib/server/repositories", () => ({
  getBatch: vi.fn(),
  upsertBatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server/map", () => ({
  bulkJobToBatchDoc: vi.fn((job: { id: string }) => ({ sourceId: String(job.id), name: "n" })),
  batchDocToBatch: vi.fn((doc: { sourceId: string }) => ({ id: doc.sourceId, dayAgo: Number(doc.sourceId) })),
}));

import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getBatch } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

describe("GET /api/campaigns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { GET } = await import("@/app/api/campaigns/route");
    const res = await GET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "backend_not_configured" });
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { GET } = await import("@/app/api/campaigns/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns sorted {batches} on happy path", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getBatch).mockResolvedValue(null as never);
    listBulkJobs.mockResolvedValue({ jobs: [{ id: "3" }, { id: "1" }, { id: "" }, { id: "2" }] });

    const { GET } = await import("@/app/api/campaigns/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    // empty id filtered out, sorted by dayAgo asc
    expect(json.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2", "3"]);
  });

  it("502 when the client throws", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    listBulkJobs.mockRejectedValue(new Error("upstream 500"));
    const { GET } = await import("@/app/api/campaigns/route");
    const res = await GET();
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "fetch_failed" });
  });
});
