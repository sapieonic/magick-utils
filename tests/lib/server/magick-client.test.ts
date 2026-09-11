import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  env: { magickMasterBaseUrl: "https://mm.test" },
  isAuthConfigured: () => true,
}));
vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { MagickClient, parseRetryAfter, type RawBulkJob } from "@/lib/server/magick-client";

describe("parseRetryAfter", () => {
  it("parses delta seconds without rounding early", () => {
    expect(parseRetryAfter("1.25", 0)).toBe(1250);
  });

  it("parses an HTTP date relative to now", () => {
    expect(parseRetryAfter("Wed, 12 Aug 2026 12:00:30 GMT", Date.parse("2026-08-12T12:00:00Z"))).toBe(30_000);
  });

  it("rejects invalid and negative values", () => {
    expect(parseRetryAfter("invalid", 0)).toBeNull();
    expect(parseRetryAfter("-1", 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// iterateBulkJobs
// ---------------------------------------------------------------------------

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" } as never;

/** Serve `pages` in order as JSON responses, recording the requested URLs. */
function stubPages(pages: Array<{ jobs: RawBulkJob[]; total?: number }>) {
  const urls: string[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    const page = pages[Math.min(i++, pages.length - 1)];
    return { ok: true, status: 200, json: async () => page } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return urls;
}

function jobs(from: number, count: number): RawBulkJob[] {
  return Array.from({ length: count }, (_, n) => ({ id: String(from + n) }));
}

async function drain(gen: AsyncGenerator<RawBulkJob, void, unknown>): Promise<RawBulkJob[]> {
  const out: RawBulkJob[] = [];
  for await (const job of gen) out.push(job);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MagickClient.iterateBulkJobs", () => {
  it("pages past 100 jobs, advancing the offset each time", async () => {
    const urls = stubPages([
      { jobs: jobs(0, 100), total: 250 },
      { jobs: jobs(100, 100), total: 250 },
      { jobs: jobs(200, 50), total: 250 },
    ]);
    const out = await drain(new MagickClient(ctx).iterateBulkJobs());
    expect(out).toHaveLength(250);
    expect(out.map((j) => j.id).slice(0, 3)).toEqual(["0", "1", "2"]);
    expect(urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
    expect(new URL(urls[0]).searchParams.get("limit")).toBe("100");
  });

  it("stops on a short page", async () => {
    const urls = stubPages([{ jobs: jobs(0, 7) }]);
    expect(await drain(new MagickClient(ctx).iterateBulkJobs())).toHaveLength(7);
    expect(urls).toHaveLength(1);
  });

  it("stops once the offset reaches the reported total", async () => {
    // Both pages are full, so only `total` can end the loop.
    const urls = stubPages([
      { jobs: jobs(0, 100), total: 200 },
      { jobs: jobs(100, 100), total: 200 },
      { jobs: jobs(200, 100), total: 200 },
    ]);
    expect(await drain(new MagickClient(ctx).iterateBulkJobs())).toHaveLength(200);
    expect(urls).toHaveLength(2);
  });

  it("stops on an empty page", async () => {
    const urls = stubPages([{ jobs: [] }]);
    expect(await drain(new MagickClient(ctx).iterateBulkJobs())).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("honours a caller-supplied offset and forwards filter params", async () => {
    const urls = stubPages([{ jobs: jobs(0, 3) }]);
    await drain(new MagickClient(ctx).iterateBulkJobs({ offset: 200, status: "completed", dispatchType: "ivr_call" }));
    const q = new URL(urls[0]).searchParams;
    expect(q.get("offset")).toBe("200");
    expect(q.get("status")).toBe("completed");
    expect(q.get("dispatch_type")).toBe("ivr_call");
  });
});
