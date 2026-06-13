import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/env", () => ({
  isBackendConfigured: vi.fn(),
  isLlmConfigured: vi.fn(),
}));

import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports ok + backend/llm flags (both on)", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(true);
    vi.mocked(isLlmConfigured).mockReturnValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, backend: true, llm: true });
  });

  it("reports flags off when not configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValue(false);
    vi.mocked(isLlmConfigured).mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, backend: false, llm: false });
  });
});
