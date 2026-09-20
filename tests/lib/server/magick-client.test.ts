import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  env: { magickMasterBaseUrl: "https://mm.test" },
  isAuthConfigured: () => true,
  isTokenRefreshConfigured: () => true,
}));
vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { MagickClient, parseRetryAfter, resolveJobDispatchType, inferJobDispatchType, JOB_LIST_SURFACE, type RawBulkJob } from "@/lib/server/magick-client";

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

  it("keeps paging past a stale-low reported total", async () => {
    // magick-master counts `total` separately from the rows it serves, so it can
    // lag behind. Trusting it here stopped the listing at the reported figure and
    // silently dropped every job beyond it — the "only 100 campaigns" report.
    const urls = stubPages([
      { jobs: jobs(0, 100), total: 100 },
      { jobs: jobs(100, 100), total: 100 },
      { jobs: jobs(200, 40), total: 100 },
    ]);
    expect(await drain(new MagickClient(ctx).iterateBulkJobs())).toHaveLength(240);
    expect(urls).toHaveLength(3);
  });

  it("stops on a short page even when the reported total is higher", async () => {
    // The short page is the authoritative end-of-list signal; an over-reported
    // total must not keep the loop running against an exhausted upstream.
    const urls = stubPages([
      { jobs: jobs(0, 100), total: 500 },
      { jobs: jobs(100, 30), total: 500 },
    ]);
    expect(await drain(new MagickClient(ctx).iterateBulkJobs())).toHaveLength(130);
    expect(urls).toHaveLength(2);
  });

  it("stops on an empty page", async () => {
    const urls = stubPages([{ jobs: [] }]);
    expect(await drain(new MagickClient(ctx).iterateBulkJobs())).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("floors a non-positive limit instead of looping forever", async () => {
    // `limit: 0` used to leave the offset pinned at 0 with `jobs.length < 0`
    // never true — an infinite loop hammering the upstream. Fail fast (rather
    // than hang the suite) if the guard is gone.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (++calls > 10) throw new Error(`iterateBulkJobs looped: ${url}`);
        const page = calls === 1 ? { jobs: jobs(0, 1) } : { jobs: [] };
        return { ok: true, status: 200, json: async () => page } as unknown as Response;
      }),
    );
    const out = await drain(new MagickClient(ctx).iterateBulkJobs({ limit: 0 }));
    expect(out).toHaveLength(1);
    expect(calls).toBe(2);
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

// ---------------------------------------------------------------------------
// batchAnalytics
// ---------------------------------------------------------------------------

describe("MagickClient.batchAnalytics", () => {
  /** Capture the single request this method makes. */
  function stubAnalytics(response: { ok: boolean; status: number; body?: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: response.ok,
          status: response.status,
          headers: { get: () => null },
          json: async () => response.body ?? {},
          text: async () => JSON.stringify(response.body ?? {}),
        } as unknown as Response;
      }),
    );
    return calls;
  }

  it("POSTs the job ids as a body and returns the rollups", async () => {
    const calls = stubAnalytics({
      ok: true,
      status: 200,
      body: { sentiment_distribution: [{ label: "positive", count: 4 }], key_topics: [{ topic: "billing", count: 9 }] },
    });
    const out = await new MagickClient(ctx).batchAnalytics(["j1", "j2"]);

    expect(out?.key_topics).toEqual([{ topic: "billing", count: 9 }]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/bulk-dispatch-jobs/analytics");
    expect(calls[0].init.method).toBe("POST");
    // The ids go in the body, not the query string: a selection of 50 batch ids
    // would otherwise be a URL long enough for an upstream proxy to reject.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ job_ids: ["j1", "j2"] });
    expect((calls[0].init.headers as Record<string, string>)["X-Tenant-Id"]).toBe("t1");
  });

  it("makes no request for an empty selection", async () => {
    const calls = stubAnalytics({ ok: true, status: 200 });
    await expect(new MagickClient(ctx).batchAnalytics([])).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  // Unlike `statusSummary`, a 404 is NOT swallowed here: the caller needs the
  // status to tell a settled refusal about the selection from a momentary
  // outage, and deciding that is its job, not this method's.
  it("surfaces a 404 as an error carrying the status", async () => {
    stubAnalytics({ ok: false, status: 404 });
    await expect(new MagickClient(ctx).batchAnalytics(["j1"])).rejects.toMatchObject({ status: 404 });
  });

  it("throws on any other non-2xx", async () => {
    stubAnalytics({ ok: false, status: 502 });
    await expect(new MagickClient(ctx).batchAnalytics(["j1"])).rejects.toThrow(/502/);
  });

  it("bounds the request with an abort signal so a stuck upstream cannot stall analytics", async () => {
    const calls = stubAnalytics({ ok: true, status: 200, body: {} });
    await new MagickClient(ctx).batchAnalytics(["j1"]);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// Job-scoped list surfaces
// ---------------------------------------------------------------------------

describe("resolveJobDispatchType", () => {
  it("JOB_LIST_SURFACE is the known-type table: path plus row key per dispatch_type", () => {
    expect(JOB_LIST_SURFACE).toEqual({
      ai_voice_call: { path: "/proxy/calls", rowsKey: "calls" },
      static_call: { path: "/proxy/static-calls", rowsKey: "calls" },
      ivr_call: { path: "/proxy/ivr-calls", rowsKey: "sessions" },
      whatsapp_message: { path: "/proxy/messaging/messages", rowsKey: "messages" },
      telegram_message: { path: "/proxy/messaging/messages", rowsKey: "messages" },
      email_message: { path: "/proxy/messaging/messages", rowsKey: "messages" },
    });
  });

  it("prefers the job payload over the stored batch field", () => {
    expect(
      resolveJobDispatchType(
        { dispatch_type: "static_call" },
        { dispatchType: "ivr_call", selType: "ivr", channel: "voice" },
      ),
    ).toBe("static_call");
  });

  it("uses the stored batch field when the job has no type", () => {
    expect(
      resolveJobDispatchType(null, { dispatchType: "ivr_call", selType: "ivr", channel: "voice" }),
    ).toBe("ivr_call");
  });

  it("infers AI and messaging from selType, but not IVR", () => {
    expect(resolveJobDispatchType(null, { selType: "ai", channel: "voice" })).toBe("ai_voice_call");
    expect(resolveJobDispatchType(null, { selType: "message", channel: "telegram" })).toBe("telegram_message");
    expect(resolveJobDispatchType(null, { selType: "message", channel: "email" })).toBe("email_message");
    expect(resolveJobDispatchType(null, { selType: "message", channel: "whatsapp" })).toBe("whatsapp_message");
    expect(inferJobDispatchType("ivr", "voice")).toBeNull();
    expect(() => resolveJobDispatchType(null, { selType: "ivr", channel: "voice", batchId: "b1" })).toThrow(
      /ambiguous/,
    );
  });
});

describe("MagickClient job-scoped lists", () => {
  function stubList(body: unknown) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
          headers: { get: () => null },
        } as unknown as Response;
      }),
    );
    return urls;
  }

  it("listCalls sends job_id to /proxy/calls", async () => {
    const urls = stubList({ calls: [], total: 0 });
    await new MagickClient(ctx).listCalls({ jobId: "job-1", limit: 100, offset: 0 });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe("/proxy/calls");
    expect(u.searchParams.get("job_id")).toBe("job-1");
    expect(u.searchParams.get("limit")).toBe("100");
    expect(u.searchParams.has("batch_id")).toBe(false);
  });

  it("listStaticCalls sends job_id to /proxy/static-calls", async () => {
    const urls = stubList({ calls: [{ call_id: "c1" }], total: 1 });
    const out = await new MagickClient(ctx).listStaticCalls({ jobId: "job-1", limit: 100, offset: 0 });
    expect(new URL(urls[0]).pathname).toBe("/proxy/static-calls");
    expect(new URL(urls[0]).searchParams.get("job_id")).toBe("job-1");
    expect(out.calls).toHaveLength(1);
  });

  it("listIvrCalls sends job_id to /proxy/ivr-calls and reads sessions", async () => {
    const urls = stubList({ sessions: [{ id: "s1" }], total: 1, calls: [{ call_id: "wrong" }] });
    const out = await new MagickClient(ctx).listIvrCalls({ jobId: "job-1", limit: 100, offset: 0 });
    expect(new URL(urls[0]).pathname).toBe("/proxy/ivr-calls");
    expect(new URL(urls[0]).searchParams.get("job_id")).toBe("job-1");
    expect(out.sessions).toEqual([{ id: "s1" }]);
  });

  it("listMessages sends job_id, not the job id as batch_id", async () => {
    const urls = stubList({ messages: [], total: 0 });
    await new MagickClient(ctx).listMessages({ jobId: "job-1", limit: 100, offset: 0 });
    const q = new URL(urls[0]).searchParams;
    expect(new URL(urls[0]).pathname).toBe("/proxy/messaging/messages");
    expect(q.get("job_id")).toBe("job-1");
    expect(q.has("batch_id")).toBe(false);
  });
});
