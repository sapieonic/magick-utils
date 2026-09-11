import { describe, expect, it } from "vitest";
import { LISTING_CLOCK_SKEW_MS, inDashboardRange, inListingRange } from "@/lib/date-range";

const now = new Date("2026-08-12T12:00:00Z");

/** `ms` milliseconds after `now`, as an upstream would stamp it. */
function ahead(ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
}

describe("inListingRange", () => {
  it("keeps a campaign dated just ahead of our clock, which the dashboard drops", () => {
    const justAhead = ahead(60_000);
    // The dashboard's "started in this period" framing is right to exclude it…
    expect(inDashboardRange(justAhead, "All time", now)).toBe(false);
    // …but an inventory listing must never hide the customer's newest campaign
    // because magick-master's clock runs ahead of ours.
    expect(inListingRange(justAhead, "All time", now)).toBe(true);
    expect(inListingRange(justAhead, "Last 7 days", now)).toBe(true);
  });

  it("treats 'All time' as unbounded in both directions", () => {
    expect(inListingRange("2019-01-01T00:00:00Z", "All time", now)).toBe(true);
    expect(inListingRange(ahead(365 * 24 * 3600_000), "All time", now)).toBe(true);
  });

  it("still bounds a narrowed range at both ends, modulo the skew allowance", () => {
    expect(inListingRange("2026-08-05T18:30:00Z", "Last 7 days", now)).toBe(true);
    expect(inListingRange("2026-08-05T18:29:59Z", "Last 7 days", now)).toBe(false);
    expect(inListingRange(ahead(LISTING_CLOCK_SKEW_MS - 1_000), "Last 7 days", now)).toBe(true);
    expect(inListingRange(ahead(LISTING_CLOCK_SKEW_MS + 1_000), "Last 7 days", now)).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(inListingRange("not-a-date", "All time", now)).toBe(false);
  });
});
