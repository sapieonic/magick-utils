import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({ env: {}, isAuthConfigured: () => true }));
vi.mock("@/lib/server/logger", () => ({ log: () => ({ debug: vi.fn() }) }));

import { parseRetryAfter } from "@/lib/server/magick-client";

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
