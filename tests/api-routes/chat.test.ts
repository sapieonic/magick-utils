import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isBackendConfigured: vi.fn(),
  isLlmConfigured: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  getAggregates: vi.fn(),
  getRecords: vi.fn(),
}));
vi.mock("@/lib/server/aggregate", () => ({ computeAggregates: vi.fn() }));
vi.mock("@/lib/server/fingerprint", () => ({ aggregatesKey: vi.fn(() => "agg-key") }));

const stream = vi.fn();
vi.mock("@/lib/server/llm", () => ({ getLLM: () => ({ stream }) }));

import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getRecords } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

function req(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: badJson ? "{bad" : JSON.stringify(body ?? {}),
  });
}

async function* gen(...vals: string[]) {
  for (const v of vals) yield v;
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe("POST /api/chat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/chat/route");
    expect((await POST(req({ message: "hi" }))).status).toBe(503);
  });

  it("503 when LLM not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(req({ message: "hi" }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "llm_not_configured" });
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { POST } = await import("@/app/api/chat/route");
    expect((await POST(req({ message: "hi" }))).status).toBe(401);
  });

  it("400 invalid_json", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/chat/route");
    expect((await POST(req(undefined, true))).status).toBe(400);
  });

  it("400 empty_message", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(req({ message: "   " }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "empty_message" });
  });

  it("returns an SSE stream with deltas + done on happy path (no batch context)", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    stream.mockReturnValue(gen("Hello", " world"));
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(req({ message: "hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await readAll(res);
    expect(body).toContain('data: {"delta":"Hello"}');
    expect(body).toContain('data: {"delta":" world"}');
    expect(body).toContain("event: done");
  });

  it("loads aggregates as context when batchIds provided", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getAggregates).mockResolvedValue({
      totalRecords: 5, successRate: 0.4, statusMix: {}, spendInr: 10,
      sentiment: {}, topics: [], funnel: {},
    } as never);
    stream.mockReturnValue(gen("ok"));
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(req({ message: "stats?", batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    await readAll(res);
    expect(getAggregates).toHaveBeenCalled();
    expect(getRecords).not.toHaveBeenCalled();
  });

  it("emits an error SSE event when the model stream throws", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    // eslint-disable-next-line require-yield
    stream.mockReturnValue((async function* () {
      throw new Error("boom");
    })());
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(req({ message: "hi" }));
    expect(res.status).toBe(200);
    const body = await readAll(res);
    expect(body).toContain("event: error");
    expect(body).toContain("boom");
  });
});
