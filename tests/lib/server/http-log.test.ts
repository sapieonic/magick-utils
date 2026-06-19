import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withLogging } from "@/lib/server/http-log";
import { logger } from "@/lib/server/logger";
import { getRequestContext } from "@/lib/server/observability/request-context";

describe("withLogging", () => {
  const info = vi.fn();
  const error = vi.fn();

  beforeEach(() => {
    info.mockClear();
    error.mockClear();
    vi.spyOn(logger, "child").mockReturnValue({ info, error } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("can suppress health-check lifecycle logs without skipping request context", async () => {
    const wrapped = withLogging(
      "health",
      async () => Response.json(getRequestContext()),
      { logRequests: false },
    );

    const res = await wrapped(new Request("http://localhost/api/health"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      route: "health",
      method: "GET",
    });
    expect(logger.child).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs request lifecycle messages for normal routes", async () => {
    const wrapped = withLogging("campaigns", async () => new Response("ok"));

    const res = await wrapped(new Request("http://localhost/api/campaigns?limit=10"));

    expect(res.status).toBe(200);
    expect(logger.child).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "campaigns",
        method: "GET",
        path: "/api/campaigns",
      }),
    );
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(1, { search: "?limit=10" }, "→ request received");
    expect(info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 200 }),
      "← request completed",
    );
  });
});
