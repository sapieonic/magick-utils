import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({ isBackendConfigured: vi.fn() }));
vi.mock("@/lib/server/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/lib/server/repositories", () => ({ getDashboardVolume: vi.fn() }));

import { emptyDashboardQuality } from "@/lib/server/dashboard-quality";
import { isBackendConfigured } from "@/lib/server/env";
import { getDashboardVolume } from "@/lib/server/repositories";
import { getTenantContext } from "@/lib/server/session";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" };
const request = (body: unknown) => new Request("http://localhost/api/dashboard", {
  method: "POST",
  body: JSON.stringify(body),
});

describe("POST /api/dashboard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires backend configuration and authentication", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/dashboard/route");
    expect((await POST(request({ range: "Last 30 days" }))).status).toBe(503);

    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(null);
    expect((await POST(request({ range: "Last 30 days" }))).status).toBe(401);
  });

  it("rejects unsupported ranges", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    const { POST } = await import("@/app/api/dashboard/route");
    expect((await POST(request({ range: "Last 13 days" }))).status).toBe(400);
  });

  it("returns Mongo-aggregated placed/sent volume for the selected range", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(getTenantContext).mockResolvedValue(ctx as never);
    vi.mocked(getDashboardVolume).mockResolvedValue({
      timezone: "UTC",
      range: "Last 7 days",
      start: "2026-08-06T00:00:00.000Z",
      end: "2026-08-12T12:00:00.000Z",
      totalRecords: 3,
      totalCalls: 2,
      totalMessages: 1,
      successRate: 2 / 3,
      spendInr: 10,
      telephonyInr: 6,
      aiInr: 4,
      statusMix: [{ key: "completed", value: 2 }],
      points: [{ date: "2026-08-12", calls: 2, messages: 1 }],
      ...emptyDashboardQuality(),
    });
    const { POST } = await import("@/app/api/dashboard/route");
    const res = await POST(request({ range: "Last 7 days" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ volume: { totalRecords: 3, timezone: "UTC" } });
    expect(getDashboardVolume).toHaveBeenCalledWith("t1", "a1", "Last 7 days", expect.any(Date), expect.any(Date));
  });
});
