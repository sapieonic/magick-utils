import { describe, it, expect, vi, afterEach } from "vitest";
import { CAMPAIGNS } from "@/lib/data";

// --- helpers -------------------------------------------------------------

/** Build a minimal Response-like object. */
function jsonRes(body: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch mock that routes by URL. Each entry returns a Response (or throws). */
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeFetch(routes: Record<string, Route>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    for (const prefix of Object.keys(routes)) {
      if (url === prefix || url.startsWith(prefix)) {
        return routes[prefix](url, init);
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

const HEALTH_ON = { backend: true, llm: true };
const HEALTH_BACKEND_ONLY = { backend: true, llm: false };
const HEALTH_OFF = { backend: false, llm: false };

/** Import a fresh copy of the module after resetting module cache. */
async function freshApi() {
  vi.resetModules();
  return import("@/lib/api");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- backendStatus -------------------------------------------------------

describe("backendStatus", () => {
  it("parses health JSON into booleans", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_ON) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.backendStatus()).toEqual({ backend: true, llm: true });
  });

  it("coerces truthy/falsy fields to booleans", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes({ backend: 1, llm: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.backendStatus()).toEqual({ backend: true, llm: false });
  });

  it("memoizes: second call does NOT re-fetch", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_ON) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await api.backendStatus();
    await api.backendStatus();
    const healthCalls = fetchMock.mock.calls.filter((c: [string, (RequestInit | undefined)?]) => String(c[0]).startsWith("/api/health"));
    expect(healthCalls).toHaveLength(1);
  });

  it("reports health as unavailable when fetch throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.backendStatus()).rejects.toMatchObject({ code: "health_unavailable" });
  });

  it("does not cache a transient health failure", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonRes(HEALTH_ON));
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.backendStatus()).rejects.toMatchObject({ code: "health_unavailable" });
    await expect(api.backendStatus()).resolves.toEqual(HEALTH_ON);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// --- listCampaigns -------------------------------------------------------

describe("listCampaigns", () => {
  it("backend off → seeded CAMPAIGNS, source 'mock', no /api/campaigns hit", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_OFF) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.listCampaigns();
    expect(out.source).toBe("mock");
    // NOTE: freshApi() runs vi.resetModules(), so the api module's CAMPAIGNS is a
    // distinct instance from the statically-imported one here. They are deep-equal
    // (seeded RNG → deterministic), so assert structural equality + length.
    expect(out.batches).toEqual(CAMPAIGNS);
    expect(out.batches).toHaveLength(26);
    const campCalls = fetchMock.mock.calls.filter((c: [string, (RequestInit | undefined)?]) => String(c[0]).startsWith("/api/campaigns"));
    expect(campCalls).toHaveLength(0);
  });

  it("backend on + 200 → live batches, source 'live'", async () => {
    const liveBatches = [{ id: "x", batchId: "AI-1" }];
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/campaigns": () => jsonRes({ batches: liveBatches }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.listCampaigns();
    expect(out.source).toBe("live");
    expect(out.batches).toEqual(liveBatches);
  });

  it("backend on + non-ok → rejects instead of showing mock campaigns as live", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/campaigns": () => jsonRes({}, { ok: false, status: 500 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.listCampaigns()).rejects.toMatchObject({ status: 500 });
  });

  it("backend on + fetch throws → rejects instead of showing mock campaigns as live", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/campaigns": () => {
        throw new Error("boom");
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.listCampaigns()).rejects.toThrow("boom");
  });
});

// --- createIngestJob -----------------------------------------------------

describe("createIngestJob", () => {
  it("backend off → null", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_OFF) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.createIngestJob(["AI-1"])).toBeNull();
  });

  it("backend on → POSTs {batchIds,type} and returns parsed body", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/ingest": (_u, init) => {
        captured = init;
        return jsonRes({ jobId: "job_1", total: 10 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.createIngestJob(["AI-1", "AI-2"], "merge");
    expect(out).toEqual({ jobId: "job_1", total: 10 });
    expect(captured?.method).toBe("POST");
    expect(JSON.parse(String(captured?.body))).toEqual({ batchIds: ["AI-1", "AI-2"], type: "merge" });
    expect((captured?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("defaults type to 'ingest'", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/ingest": (_u, init) => {
        captured = init;
        return jsonRes({ jobId: "j", total: 1 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await api.createIngestJob(["AI-1"]);
    expect(JSON.parse(String(captured?.body)).type).toBe("ingest");
  });

  it("includes refresh:true only when requested", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/ingest": (_u, init) => {
        captured = init;
        return jsonRes({ jobId: "j", total: 1 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await api.createIngestJob(["AI-1"], "ingest", { refresh: true });
    expect(JSON.parse(String(captured?.body))).toEqual({ batchIds: ["AI-1"], type: "ingest", refresh: true });
  });

  it("non-ok throws instead of silently entering mock mode", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/ingest": () => jsonRes({}, { ok: false, status: 500 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.createIngestJob(["AI-1"])).rejects.toMatchObject({ status: 500 });
  });
});

// --- getJob --------------------------------------------------------------

describe("getJob", () => {
  it("200 → job (fetches /api/jobs/:id)", async () => {
    const job = { jobId: "job_9", status: "running" };
    let url = "";
    const fetchMock = makeFetch({
      "/api/jobs/": (u) => {
        url = u;
        return jsonRes(job);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.getJob("job_9")).toEqual(job);
    expect(url).toBe("/api/jobs/job_9");
  });

  it("non-ok → explicit error", async () => {
    const fetchMock = makeFetch({
      "/api/jobs/": () => jsonRes({}, { ok: false, status: 404 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.getJob("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("job helpers", () => {
  it("isJobNotFound matches 404 ApiRequestError", async () => {
    const api = await freshApi();
    expect(api.isJobNotFound(new api.ApiRequestError("missing", 404, "not_found"))).toBe(true);
    expect(api.isJobNotFound(new api.ApiRequestError("nope", 500))).toBe(false);
    expect(api.isJobNotFound(new Error("nope"))).toBe(false);
  });

  it("jobProgressPercent caps in-flight work at 99", async () => {
    const api = await freshApi();
    expect(api.jobProgressPercent(0, 10)).toBe(0);
    expect(api.jobProgressPercent(5, 10)).toBe(50);
    expect(api.jobProgressPercent(10, 10)).toBe(99);
    expect(api.jobProgressPercent(10, 10, "done")).toBe(100);
    expect(api.jobProgressPercent(1, 0)).toBe(0);
  });
});

// --- getAnalytics --------------------------------------------------------

describe("getAnalytics", () => {
  it("backend off → null", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_OFF) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.getAnalytics(["AI-1"])).toBeNull();
  });

  it("backend on + ok → aggregates; POST body {batchIds,refresh}", async () => {
    let captured: RequestInit | undefined;
    const aggregates = { key: "k", totalRecords: 5 };
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/analytics": (_u, init) => {
        captured = init;
        return jsonRes({ aggregates });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.getAnalytics(["AI-1", "AI-2"], true);
    expect(out).toEqual(aggregates);
    expect(captured?.method).toBe("POST");
    expect(JSON.parse(String(captured?.body))).toEqual({ batchIds: ["AI-1", "AI-2"], refresh: true });
  });

  it("refresh defaults to false", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/analytics": (_u, init) => {
        captured = init;
        return jsonRes({ aggregates: {} });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await api.getAnalytics(["AI-1"]);
    expect(JSON.parse(String(captured?.body)).refresh).toBe(false);
  });

  it("non-ok → explicit error", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/analytics": () => jsonRes({}, { ok: false, status: 500 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.getAnalytics(["AI-1"])).rejects.toMatchObject({ status: 500 });
  });
});

// --- generateInsights ----------------------------------------------------

describe("generateInsights", () => {
  it("llm off → explicit error (even if backend on)", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_BACKEND_ONLY) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.generateInsights(["AI-1"])).rejects.toMatchObject({ code: "llm_not_configured" });
  });

  it("llm on + ok → insight; body {batchIds,refresh}", async () => {
    let captured: RequestInit | undefined;
    const insight = { key: "k", narrative: "hi" };
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/insights": (_u, init) => {
        captured = init;
        return jsonRes({ insight });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.generateInsights(["AI-1"], true);
    expect(out).toEqual(insight);
    expect(JSON.parse(String(captured?.body))).toEqual({ batchIds: ["AI-1"], refresh: true });
  });

  it("non-ok → explicit error", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/insights": () => jsonRes({}, { ok: false, status: 502 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.generateInsights(["AI-1"])).rejects.toMatchObject({ status: 502 });
  });
});

// --- compareInsights ------------------------------------------------------

describe("compareInsights", () => {
  it("llm on + ok → comparison insight; body {batchIds,baselineBatchIds,refresh}", async () => {
    let captured: RequestInit | undefined;
    const insight = { key: "k", narrative: "changed" };
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/insights/compare": (_u, init) => {
        captured = init;
        return jsonRes({ insight });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.compareInsights(["AI-1"], ["AI-0"], true);
    expect(out).toEqual(insight);
    expect(JSON.parse(String(captured?.body))).toEqual({ batchIds: ["AI-1"], baselineBatchIds: ["AI-0"], refresh: true });
  });
});

// --- streamChat ----------------------------------------------------------

/** Build a Response-like object whose body.getReader() yields the given chunks. */
function sseResponse(chunks: string[], { ok = true, withBody = true }: { ok?: boolean; withBody?: boolean } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  const body = withBody
    ? {
        getReader() {
          return {
            async read() {
              if (i < chunks.length) {
                const value = enc.encode(chunks[i++]);
                return { value, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      }
    : null;
  return { ok, body } as unknown as Response;
}

describe("streamChat", () => {
  it("llm off → explicit error", async () => {
    const fetchMock = makeFetch({ "/api/health": () => jsonRes(HEALTH_BACKEND_ONLY) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const onDelta = vi.fn();
    await expect(api.streamChat(["AI-1"], "hello", [], onDelta)).rejects.toMatchObject({ code: "llm_not_configured" });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("non-ok response → explicit error", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": () => sseResponse([], { ok: false }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.streamChat(["AI-1"], "hi", [], vi.fn())).rejects.toMatchObject({ status: undefined });
  });

  it("no body → explicit error", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": () => sseResponse([], { ok: true, withBody: false }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.streamChat(["AI-1"], "hi", [], vi.fn())).rejects.toMatchObject({ code: "empty_stream" });
  });

  it("parses SSE data frames, calls onDelta per delta, returns true", async () => {
    const chunks = [
      'data: {"delta":"Hello"}\n\n',
      'data: {"delta":" world"}\n\n',
      'event: done\ndata: {}\n\n',
    ];
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": () => sseResponse(chunks),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const onDelta = vi.fn();
    const ok = await api.streamChat(["AI-1"], "hi", [], onDelta);
    expect(ok).toBe(true);
    expect(onDelta.mock.calls.map((c: string[]) => c[0])).toEqual(["Hello", " world"]);
  });

  it("handles frames split across chunk boundaries (buffering)", async () => {
    const chunks = ['data: {"del', 'ta":"Hi"}\n\ndata: {"delta":"!"}\n\nevent: done\ndata: {}\n\n'];
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": () => sseResponse(chunks),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const onDelta = vi.fn();
    await api.streamChat(["AI-1"], "hi", [], onDelta);
    expect(onDelta.mock.calls.map((c: string[]) => c[0])).toEqual(["Hi", "!"]);
  });

  it("ignores non-data frames and unparsable/done payloads", async () => {
    const chunks = [
      "event: ping\n\n", // no data: line
      'data: {"delta":"A"}\n\n',
      "data: [DONE]\n\n", // unparsable JSON → ignored
      'data: {"foo":"bar"}\n\n', // valid JSON but no delta → no onDelta
      'event: done\ndata: {}\n\n',
    ];
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": () => sseResponse(chunks),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const onDelta = vi.fn();
    const ok = await api.streamChat(["AI-1"], "hi", [], onDelta);
    expect(ok).toBe(true);
    expect(onDelta.mock.calls.map((c: string[]) => c[0])).toEqual(["A"]);
  });

  it("POSTs {batchIds,message,history}", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": (_u, init) => {
        captured = init;
        return sseResponse(['data: {"delta":"x"}\n\nevent: done\ndata: {}\n\n']);
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const history = [{ role: "user" as const, content: "prev" }];
    await api.streamChat(["AI-1"], "hi", history, vi.fn());
    expect(captured?.method).toBe("POST");
    expect(JSON.parse(String(captured?.body))).toEqual({
      batchIds: ["AI-1"],
      message: "hi",
      history,
    });
  });

  it("rejects a stream that closes without the terminal done event", async () => {
    const fetchMock = makeFetch({
      "/api/health": () => jsonRes(HEALTH_ON),
      "/api/chat": () => sseResponse(['data: {"delta":"partial"}\n\n']),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.streamChat(["AI-1"], "hi", [], vi.fn())).rejects.toMatchObject({ code: "incomplete_stream" });
  });
});

// --- postSession ---------------------------------------------------------

describe("postSession", () => {
  it("ok → returns tenants; POSTs {idToken}", async () => {
    let captured: RequestInit | undefined;
    const tenants = [{ id: "t1", name: "Tenant 1" }];
    const fetchMock = makeFetch({
      "/api/auth/session": (_u, init) => {
        captured = init;
        return jsonRes({ tenants });
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    const out = await api.postSession("tok123");
    expect(out).toEqual({ tenants });
    expect(captured?.method).toBe("POST");
    expect(JSON.parse(String(captured?.body))).toEqual({ idToken: "tok123" });
  });

  it("ok with missing tenants → empty array", async () => {
    const fetchMock = makeFetch({ "/api/auth/session": () => jsonRes({}) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.postSession("t")).toEqual({ tenants: [] });
  });

  it("non-ok with error JSON → throws readable error message", async () => {
    const fetchMock = makeFetch({
      "/api/auth/session": () => jsonRes({ error: "bad token" }, { ok: false, status: 401 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.postSession("t")).rejects.toThrow("bad token");
  });

  it("non-ok with non-JSON body → throws status-based message", async () => {
    const fetchMock = makeFetch({
      "/api/auth/session": () =>
        ({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error("not json");
          },
        }) as unknown as Response,
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.postSession("t")).rejects.toThrow("session 500");
  });
});

// --- postContext ---------------------------------------------------------

describe("postContext", () => {
  it("ok → resolves void; POSTs {tenantId,accountId}", async () => {
    let captured: RequestInit | undefined;
    const fetchMock = makeFetch({
      "/api/auth/context": (_u, init) => {
        captured = init;
        return jsonRes({});
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.postContext("t1", "a1")).resolves.toBeUndefined();
    expect(JSON.parse(String(captured?.body))).toEqual({ tenantId: "t1", accountId: "a1" });
  });

  it("non-ok with error JSON → throws error message", async () => {
    const fetchMock = makeFetch({
      "/api/auth/context": () => jsonRes({ error: "forbidden" }, { ok: false, status: 403 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.postContext("t1", "a1")).rejects.toThrow("forbidden");
  });

  it("non-ok with non-JSON → throws status message", async () => {
    const fetchMock = makeFetch({
      "/api/auth/context": () =>
        ({
          ok: false,
          status: 418,
          json: async () => {
            throw new Error("nope");
          },
        }) as unknown as Response,
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.postContext("t1", "a1")).rejects.toThrow("context 418");
  });
});

// --- fetchMe -------------------------------------------------------------

describe("fetchMe", () => {
  it("non-ok → null", async () => {
    const fetchMock = makeFetch({
      "/api/auth/me": () => jsonRes({}, { ok: false, status: 401 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.fetchMe()).toBeNull();
  });

  it("ok → parsed body", async () => {
    const me = { authenticated: true, tenants: [], context: { tenantId: "t", accountId: "a" } };
    const fetchMock = makeFetch({ "/api/auth/me": () => jsonRes(me) });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    expect(await api.fetchMe()).toEqual(me);
  });
});

// --- downloadCsvUrl ------------------------------------------------------

describe("downloadCsvUrl", () => {
  it("builds export query with comma-joined, URL-encoded params", async () => {
    const api = await freshApi();
    const url = api.downloadCsvUrl(["AI-1", "AI-2"], ["status", "cost"]);
    expect(url).toBe("/api/export?batchIds=AI-1%2CAI-2&columns=status%2Ccost");
  });

  it("encodes special characters in columns", async () => {
    const api = await freshApi();
    const url = api.downloadCsvUrl(["B 1"], ["a&b"]);
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("batchIds")).toBe("B 1");
    expect(parsed.searchParams.get("columns")).toBe("a&b");
  });

  it("does not require backend (pure string builder, no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    api.downloadCsvUrl(["x"], ["y"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("downloadCsv", () => {
  it("surfaces export errors instead of navigating to raw JSON", async () => {
    const fetchMock = makeFetch({
      "/api/export": () => jsonRes({ error: "incomplete_ingestion", message: "Reingest first." }, { ok: false, status: 409 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await freshApi();
    await expect(api.downloadCsv(["b1"], ["status"])).rejects.toMatchObject({
      status: 409,
      code: "incomplete_ingestion",
    });
  });
});
