// Upstream attributes this app's traffic by `x-mgkvc-originator`. It follows the
// active brand, so a whitelabel deployment's calls are not counted as
// MagickVoice's — and the default brand still sends the value upstream has
// always seen.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  env: { magickMasterBaseUrl: "https://mm.test" },
  isAuthConfigured: () => true,
  isTokenRefreshConfigured: () => false,
}));
vi.mock("@/lib/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { authSession, MagickClient } from "@/lib/server/magick-client";

function captureOriginator(): () => string | undefined {
  let seen: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>)["x-mgkvc-originator"];
      return new Response(JSON.stringify({ user: {}, tenants: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return () => seen;
}

const client = () => new MagickClient({ tenantId: "t1", accountId: "a1", idToken: "tok" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("x-mgkvc-originator", () => {
  it("is magick-analytics under the default brand", async () => {
    vi.stubEnv("BRAND", "");
    const seen = captureOriginator();
    await authSession("tok");
    expect(seen()).toBe("magick-analytics");
  });

  // One case per request builder in magick-client — auth, GET (`raw`), POST
  // (`postJson`) — so reverting any one of them to a hardcoded value fails here.
  it.each([
    ["auth session", () => authSession("tok")],
    ["GET", () => client().getBulkJob("job-1")],
    ["POST", () => client().batchAnalytics(["job-1"])],
  ])("follows the active brand pack (%s)", async (_label, call) => {
    vi.stubEnv("BRAND", "samarthya");
    const seen = captureOriginator();
    await call();
    expect(seen()).toBe("samarthya-analytics");
  });
});
