import { describe, expect, it } from "vitest";
import {
  ALL_TIME_DAYS,
  DASHBOARD_RANGES,
  LISTING_CLOCK_SKEW_MS,
  inDashboardRange,
  inListingRange,
  rangeDays,
} from "@/lib/date-range";

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

describe("inDashboardRange", () => {
  // `inListingRange` has this guard tested; its dashboard sibling did not.
  it("rejects a date it cannot parse rather than counting it in", () => {
    expect(inDashboardRange("not-a-date", "Last 30 days", now)).toBe(false);
    expect(inDashboardRange("", "All time", now)).toBe(false);
  });
});

describe("rangeDays", () => {
  const now = new Date("2026-09-12T10:00:00Z");

  it("counts the days a fixed range covers, inclusive of today", () => {
    expect(rangeDays("Last 7 days", now)).toBe(7);
    expect(rangeDays("Last 30 days", now)).toBe(30);
    expect(rangeDays("Last 90 days", now)).toBe(90);
  });

  it("stands in a fixed span for All time, which has no start", () => {
    expect(rangeDays("All time", now)).toBe(ALL_TIME_DAYS);
  });

  it("measures This quarter from the quarter's start", () => {
    const days = rangeDays("This quarter", now);
    // 12 Sep sits in the Jul–Sep quarter: 31 + 31 + 12 days.
    expect(days).toBe(74);
  });

  it("never returns a non-positive span", () => {
    for (const range of DASHBOARD_RANGES) {
      expect(rangeDays(range, now)).toBeGreaterThan(0);
    }
  });

  // The first day of a quarter is one day, not zero — a zero would scale every
  // demo figure to nothing.
  it("returns one on the first day of a quarter", () => {
    expect(rangeDays("This quarter", new Date("2026-07-01T06:00:00Z"))).toBe(1);
  });
});
