import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));

const sessionDestroy = vi.fn();
vi.mock("@/lib/server/session", () => ({
  getTenantContext: vi.fn(),
  getSession: vi.fn(async () => ({ destroy: sessionDestroy })),
}));

const listBulkJobs = vi.fn();
/** Mirrors the real MagickClient.iterateBulkJobs paging contract (page size 100,
 *  stop on a short page or once offset passes `total`) so route tests exercise
 *  the same multi-page behaviour the client provides. */
const PAGE_SIZE = 100;
class MagickApiError extends Error {
  status: number;
  constructor(status: number, message = "err") {
    super(message);
    this.name = "MagickApiError";
    this.status = status;
  }
}
vi.mock("@/lib/server/magick-client", () => ({
  MagickClient: class {
    listBulkJobs = listBulkJobs;
    async *iterateBulkJobs() {
      let offset = 0;
      for (;;) {
        const page = await listBulkJobs({ limit: PAGE_SIZE, offset });
        const jobs = page.jobs ?? [];
        for (const job of jobs) yield job;
        if (jobs.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        const total = page.total ?? 0;
        if (total > 0 && offset >= total) break;
      }
    }
  },
  MagickApiError,
}));

const refreshBatchFromSource = vi.hoisted(() => vi.fn(async (doc) => doc));
vi.mock("@/lib/server/repositories", () => ({
  getBatch: vi.fn(),
  refreshBatchFromSource,
}));

vi.mock("@/lib/server/map", () => ({
  bulkJobToBatchDoc: vi.fn((job: { id: string }) => ({ sourceId: String(job.id), name: "n" })),
  batchDocToBatch: vi.fn((doc: { sourceId: string }) => ({ id: doc.sourceId, dayAgo: Number(doc.sourceId) })),
}));

import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getBatch } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

/** An ISO timestamp `days` days before now. */
function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** `count` jobs with sequential ids starting at `from`. */
function jobPage(from: number, count: number, createdAt?: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(from + i),
    ...(createdAt ? { created_at: createdAt } : {}),
  }));
}

async function get(url = "http://localhost/api/campaigns") {
  const { GET } = await import("@/app/api/campaigns/route");
  return GET(new Request(url));
}

function ready() {
  vi.mocked(isBackendConfigured).mockReturnValue(true);
  vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
  vi.mocked(getBatch).mockResolvedValue(null as never);
}

describe("GET /api/campaigns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const res = await get();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "backend_not_configured" });
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("returns sorted {batches} on happy path", async () => {
    ready();
    listBulkJobs.mockResolvedValue({ jobs: [{ id: "3" }, { id: "1" }, { id: "" }, { id: "2" }] });

    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    // empty id filtered out, sorted by dayAgo asc
    expect(json.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2", "3"]);
    expect(refreshBatchFromSource).toHaveBeenCalledTimes(3);
  });

  it("502 when the client throws", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    listBulkJobs.mockRejectedValue(new Error("upstream 500"));
    const res = await get();
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "fetch_failed" });
  });

  it("401 session_expired and destroys the session on a magick-master 401", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    listBulkJobs.mockRejectedValue(new MagickApiError(401, "Invalid or expired token"));
    const res = await get();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "session_expired" });
    expect(sessionDestroy).toHaveBeenCalledOnce();
  });

  // --- pagination past the old hard 100 cap ------------------------------

  it("pages past the first 100 jobs instead of stopping at one page", async () => {
    ready();
    listBulkJobs
      .mockResolvedValueOnce({ jobs: jobPage(0, 100), total: 130 })
      .mockResolvedValueOnce({ jobs: jobPage(100, 30), total: 130 });

    const res = await get();
    const json = await res.json();
    expect(json.batches).toHaveLength(130);
    expect(listBulkJobs).toHaveBeenCalledTimes(2);
    expect(listBulkJobs).toHaveBeenNthCalledWith(1, { limit: 100, offset: 0 });
    expect(listBulkJobs).toHaveBeenNthCalledWith(2, { limit: 100, offset: 100 });
  });

  it("stops paging once offset reaches the reported total", async () => {
    ready();
    listBulkJobs
      .mockResolvedValueOnce({ jobs: jobPage(0, 100), total: 200 })
      .mockResolvedValueOnce({ jobs: jobPage(100, 100), total: 200 })
      .mockResolvedValue({ jobs: jobPage(200, 100), total: 200 });

    const res = await get();
    const json = await res.json();
    expect(json.batches).toHaveLength(200);
    expect(listBulkJobs).toHaveBeenCalledTimes(2);
  });

  // --- date filtering -----------------------------------------------------

  it("filters to the requested range, server-side", async () => {
    ready();
    listBulkJobs.mockResolvedValue({
      jobs: [
        { id: "1", created_at: daysAgoISO(1) },
        { id: "2", created_at: daysAgoISO(3) },
        { id: "3", created_at: daysAgoISO(45) },
        { id: "4", created_at: daysAgoISO(400) },
      ],
    });

    const res = await get("http://localhost/api/campaigns?range=Last+7+days");
    const json = await res.json();
    expect(json.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2"]);
    // out-of-range jobs never reach the per-job refresh fan-out
    expect(refreshBatchFromSource).toHaveBeenCalledTimes(2);
  });

  it("keeps months-old campaigns under 'All time' (and when no range is given)", async () => {
    ready();
    const jobs = [
      { id: "1", created_at: daysAgoISO(2) },
      { id: "2", created_at: daysAgoISO(120) },
      { id: "3", created_at: daysAgoISO(900) },
    ];
    listBulkJobs.mockResolvedValue({ jobs });

    const explicit = await (await get("http://localhost/api/campaigns?range=All+time")).json();
    expect(explicit.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2", "3"]);

    const implicit = await (await get()).json();
    expect(implicit.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2", "3"]);
  });

  it("keeps jobs the upstream left undated rather than dropping them", async () => {
    ready();
    listBulkJobs.mockResolvedValue({ jobs: [{ id: "1" }, { id: "2", created_at: "not-a-date" }] });
    const res = await get("http://localhost/api/campaigns?range=Last+7+days");
    const json = await res.json();
    expect(json.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2"]);
  });

  it("treats an unknown range as 'All time' instead of 400-ing into a dead screen", async () => {
    ready();
    listBulkJobs.mockResolvedValue({
      jobs: [
        { id: "1", created_at: daysAgoISO(2) },
        { id: "2", created_at: daysAgoISO(400) },
      ],
    });
    // A stale sessionStorage value reaches the route as an arbitrary string.
    const res = await get("http://localhost/api/campaigns?range=Last+decade");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.batches.map((b: { id: string }) => b.id)).toEqual(["1", "2"]);
  });

  it("keeps a campaign dated slightly ahead of our clock (upstream clock skew)", async () => {
    ready();
    // magick-master stamps created_at on its own host; a few minutes of skew must
    // not delete the newest campaign from every range, "All time" included.
    const ahead = new Date(Date.now() + 60_000).toISOString();
    listBulkJobs.mockResolvedValue({ jobs: [{ id: "1", created_at: ahead }] });

    const allTime = await (await get("http://localhost/api/campaigns?range=All+time")).json();
    expect(allTime.batches.map((b: { id: string }) => b.id)).toEqual(["1"]);
    const week = await (await get("http://localhost/api/campaigns?range=Last+7+days")).json();
    expect(week.batches.map((b: { id: string }) => b.id)).toEqual(["1"]);
  });

  // --- dedupe -------------------------------------------------------------

  it("dedupes a job the unordered upstream served on two pages", async () => {
    ready();
    // Page 2 repeats id "1" — undeduped it would upsert twice and render two rows
    // under the same React key.
    listBulkJobs
      .mockResolvedValueOnce({ jobs: [...jobPage(1, 99), { id: "1" }], total: 150 })
      .mockResolvedValueOnce({ jobs: [{ id: "1" }, { id: "200" }], total: 150 });

    const res = await get();
    const json = await res.json();
    const ids = json.batches.map((b: { id: string }) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id: string) => id === "1")).toHaveLength(1);
    // 99 from page one + the repeat collapsed + "200"
    expect(ids).toHaveLength(100);
    expect(refreshBatchFromSource).toHaveBeenCalledTimes(100);
  });

  // --- truncation ---------------------------------------------------------

  it("reports truncated:false when the whole listing was scanned", async () => {
    ready();
    listBulkJobs.mockResolvedValue({ jobs: [{ id: "1" }, { id: "2" }] });
    const json = await (await get()).json();
    expect(json.truncated).toBe(false);
  });

  // --- bound --------------------------------------------------------------

  it("bounds an endlessly-paging upstream at the scan cap", async () => {
    ready();
    // Never a short page and never a total — without the cap this would loop forever.
    let next = 0;
    listBulkJobs.mockImplementation(async () => {
      const jobs = jobPage(next, PAGE_SIZE);
      next += PAGE_SIZE;
      return { jobs };
    });

    const res = await get();
    const json = await res.json();
    expect(res.status).toBe(200);
    // 2,500 scanned = 25 upstream pages of 100.
    expect(listBulkJobs).toHaveBeenCalledTimes(25);
    expect(json.batches).toHaveLength(2_500);
    // The client cannot tell a short listing from a capped one without this.
    expect(json.truncated).toBe(true);
  });
});
