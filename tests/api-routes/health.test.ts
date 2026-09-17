import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isBackendConfigured: vi.fn(),
  isLlmConfigured: vi.fn(),
  isTokenRefreshConfigured: vi.fn(),
}));

import { isBackendConfigured, isLlmConfigured, isTokenRefreshConfigured } from "@/lib/server/env";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports ok + backend/llm/tokenRefresh flags (all on)", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(isTokenRefreshConfigured).mockReturnValue(true);
    const res = await GET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, backend: true, llm: true, tokenRefresh: true });
  });

  it("reports flags off when not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    vi.mocked(isLlmConfigured).mockReturnValue(false);
    vi.mocked(isTokenRefreshConfigured).mockReturnValue(false);
    const res = await GET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, backend: false, llm: false, tokenRefresh: false });
  });

  it("reports tokenRefresh independently of the other flags", async () => {
    // Without its own flag, "the server cannot renew ID tokens" is invisible
    // here — and its symptom (users bounced to /login about an hour in) looks
    // exactly like the bug the refresh work removed, so an operator diagnosing
    // through this endpoint could not tell a broken fix from a missing key.
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    vi.mocked(isTokenRefreshConfigured).mockReturnValue(false);
    const res = await GET(new Request("http://localhost/api/health"));
    await expect(res.json()).resolves.toEqual({ ok: true, backend: true, llm: true, tokenRefresh: false });
  });
});
