import { describe, it, expect, vi, beforeEach } from "vitest";

// hoisted so the (also-hoisted) vi.mock factory below can reference it
const { SECRET } = vi.hoisted(() => ({ SECRET: "s3cr3t-cron-token" }));

vi.mock("@/lib/server/env", () => ({
  env: { cronSecret: SECRET },
  isBackendConfigured: vi.fn(),
  isCronConfigured: vi.fn(),
}));
vi.mock("@/lib/server/repositories", () => ({
  deleteAggregatesOlderThan: vi.fn().mockResolvedValue(2),
  deleteTerminalJobsOlderThan: vi.fn().mockResolvedValue(3),
  deleteInsightsOlderThan: vi.fn().mockResolvedValue(1),
}));

import { isBackendConfigured, isCronConfigured } from "@/lib/server/env";
import {
  deleteAggregatesOlderThan,
  deleteInsightsOlderThan,
  deleteTerminalJobsOlderThan,
} from "@/lib/server/repositories";

function req(token?: string) {
  return new Request("http://localhost/api/cron/cleanup", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("POST /api/cron/cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isCronConfigured).mockReturnValue(true);
  });

  it("503 when backend not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/cron/cleanup/route");
    expect((await POST(req(SECRET))).status).toBe(503);
  });

  it("503 when cron secret not configured", async () => {
    vi.mocked(isCronConfigured).mockReturnValue(false);
    const { POST } = await import("@/app/api/cron/cleanup/route");
    expect((await POST(req(SECRET))).status).toBe(503);
  });

  it("401 when bearer token missing", async () => {
    const { POST } = await import("@/app/api/cron/cleanup/route");
    expect((await POST(req())).status).toBe(401);
    expect(deleteAggregatesOlderThan).not.toHaveBeenCalled();
  });

  it("401 when bearer token wrong", async () => {
    const { POST } = await import("@/app/api/cron/cleanup/route");
    expect((await POST(req("nope"))).status).toBe(401);
    expect(deleteAggregatesOlderThan).not.toHaveBeenCalled();
  });

  it("prunes all three collections and returns counts", async () => {
    const { POST } = await import("@/app/api/cron/cleanup/route");
    const res = await POST(req(SECRET));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      deleted: { aggregates: 2, jobs: 3, insights: 1 },
    });
    // each pruner is called once with an ISO cutoff in the past
    for (const fn of [
      deleteAggregatesOlderThan,
      deleteTerminalJobsOlderThan,
      deleteInsightsOlderThan,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const cutoff = vi.mocked(fn).mock.calls[0][0];
      expect(new Date(cutoff).getTime()).toBeLessThan(Date.now());
    }
  });
});
