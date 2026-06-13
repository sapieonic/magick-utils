import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({
  countRecords: vi.fn(),
  getBatch: vi.fn(),
  streamRecords: vi.fn(),
}));

import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { countRecords, getBatch, streamRecords } from "@/lib/server/repositories";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };

function postReq(body?: unknown, badJson = false) {
  return new Request("http://localhost/api/export", {
    method: "POST",
    body: badJson ? "{bad" : JSON.stringify(body ?? {}),
  });
}
function getReq(qs: string) {
  return new Request(`http://localhost/api/export?${qs}`);
}

function cursor(records: unknown[]) {
  const close = vi.fn().mockResolvedValue(undefined);
  const it = {
    async *[Symbol.asyncIterator]() {
      for (const r of records) yield r;
    },
    close,
  };
  return { it, close };
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

describe("POST /api/export", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/export/route");
    expect((await POST(postReq({ batchIds: ["b1"] }))).status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { POST } = await import("@/app/api/export/route");
    expect((await POST(postReq({ batchIds: ["b1"] }))).status).toBe(401);
  });

  it("400 invalid_json", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/export/route");
    expect((await POST(postReq(undefined, true))).status).toBe(400);
  });

  it("400 no_batches", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/export/route");
    const res = await POST(postReq({ batchIds: [] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "no_batches" });
  });

  it("409 not_ingested when count is 0", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(countRecords).mockResolvedValue(0 as never);
    const { POST } = await import("@/app/api/export/route");
    const res = await POST(postReq({ batchIds: ["b1"] }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "not_ingested" });
  });

  it("streams CSV with default columns + header on happy path", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(countRecords).mockResolvedValue(1 as never);
    vi.mocked(getBatch).mockResolvedValue({ name: "Camp A" } as never);
    const { it, close } = cursor([
      {
        recordId: "r1", batchId: "b1", channel: "voice", recipientPhone: "+91",
        status: "completed", outcome: "answered", timestamp: "2026-01-01", totalCostInr: 1.5,
      },
    ]);
    vi.mocked(streamRecords).mockResolvedValue(it as never);

    const { POST } = await import("@/app/api/export/route");
    const res = await POST(postReq({ batchIds: ["b1"] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="b1.csv"');
    const body = await readAll(res);
    const lines = body.trim().split("\n");
    expect(lines[0]).toBe("record_id,campaign_name,channel,recipient_phone,status,outcome,timestamp,total_cost_inr");
    expect(lines[1]).toContain("r1");
    expect(lines[1]).toContain("Camp A");
    expect(close).toHaveBeenCalled();
  });

  it("uses combined filename for multiple batches and honors custom columns", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(countRecords).mockResolvedValue(1 as never);
    vi.mocked(getBatch).mockResolvedValue(null as never);
    const { it } = cursor([{ recordId: "r1", status: "x" }]);
    vi.mocked(streamRecords).mockResolvedValue(it as never);
    const { POST } = await import("@/app/api/export/route");
    const res = await POST(postReq({ batchIds: ["b1", "b2"], columns: ["record_id", "status"] }));
    expect(res.headers.get("Content-Disposition")).toContain("combined-2-batches.csv");
    const body = await readAll(res);
    expect(body.trim().split("\n")[0]).toBe("record_id,status");
  });
});

describe("GET /api/export", () => {
  beforeEach(() => vi.clearAllMocks());

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { GET } = await import("@/app/api/export/route");
    expect((await GET(getReq("batchIds=b1"))).status).toBe(503);
  });

  it("401 when not authenticated", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    const { GET } = await import("@/app/api/export/route");
    expect((await GET(getReq("batchIds=b1"))).status).toBe(401);
  });

  it("400 no_batches when query param empty", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { GET } = await import("@/app/api/export/route");
    const res = await GET(getReq("batchIds="));
    expect(res.status).toBe(400);
  });

  it("streams CSV from query params", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(countRecords).mockResolvedValue(1 as never);
    vi.mocked(getBatch).mockResolvedValue({ name: "C" } as never);
    const { it } = cursor([{ recordId: "r1", status: "ok" }]);
    vi.mocked(streamRecords).mockResolvedValue(it as never);
    const { GET } = await import("@/app/api/export/route");
    const res = await GET(getReq("batchIds=b1,b2&columns=record_id,status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const body = await readAll(res);
    expect(body.trim().split("\n")[0]).toBe("record_id,status");
  });
});
