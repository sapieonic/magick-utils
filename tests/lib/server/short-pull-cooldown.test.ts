import { describe, expect, it } from "vitest";
import { SHORT_PULL_REPULL_COOLDOWN_MS, shortPullCheckedRecently } from "@/lib/server/types";

const now = Date.parse("2026-10-02T12:00:00Z");
const at = (msAgo: number) => ({
  shortPull: {
    listed: 10, received: 9, keptPrevious: false, detectedAt: new Date(now - msAgo).toISOString(),
  },
});

describe("shortPullCheckedRecently", () => {
  it("is true inside the cooldown and false once it has passed", () => {
    expect(shortPullCheckedRecently(at(0), now)).toBe(true);
    expect(shortPullCheckedRecently(at(SHORT_PULL_REPULL_COOLDOWN_MS - 1), now)).toBe(true);
    expect(shortPullCheckedRecently(at(SHORT_PULL_REPULL_COOLDOWN_MS), now)).toBe(false);
  });

  // Every uncertain case re-pulls: skipping is what can strand a batch.
  it("is false with no recorded short pull, an unparseable stamp, or a future one", () => {
    expect(shortPullCheckedRecently({ shortPull: null }, now)).toBe(false);
    expect(shortPullCheckedRecently({}, now)).toBe(false);
    expect(
      shortPullCheckedRecently({ shortPull: { listed: 1, received: 0, keptPrevious: false, detectedAt: "x" } }, now),
    ).toBe(false);
    expect(shortPullCheckedRecently(at(-60_000), now)).toBe(false);
  });

  it("is a window long enough to absorb repeated Generates", () => {
    expect(SHORT_PULL_REPULL_COOLDOWN_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(SHORT_PULL_REPULL_COOLDOWN_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
