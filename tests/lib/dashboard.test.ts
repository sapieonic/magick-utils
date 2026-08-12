import { describe, expect, it } from "vitest";
import { fillDashboardDays } from "@/lib/dashboard";
import { inDashboardRange, rangeStart } from "@/lib/date-range";

describe("dashboard date ranges", () => {
  const now = new Date("2026-08-12T12:00:00Z");

  it("uses inclusive UTC starts for rolling ranges", () => {
    expect(rangeStart("Last 7 days", now)?.toISOString()).toBe("2026-08-06T00:00:00.000Z");
    expect(inDashboardRange("2026-08-06T00:00:00Z", "Last 7 days", now)).toBe(true);
    expect(inDashboardRange("2026-08-05T23:59:59Z", "Last 7 days", now)).toBe(false);
    expect(inDashboardRange("2026-08-13T00:00:00Z", "Last 7 days", now)).toBe(false);
  });

  it("starts This quarter on the UTC quarter boundary", () => {
    expect(rangeStart("This quarter", now)?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("fills missing bounded days with explicit zeroes", () => {
    const points = fillDashboardDays({
      timezone: "UTC",
      range: "Last 7 days",
      start: "2026-08-10T00:00:00.000Z",
      end: "2026-08-12T12:00:00.000Z",
      totalRecords: 4,
      totalCalls: 3,
      totalMessages: 1,
      successRate: 0.5,
      spendInr: 0,
      telephonyInr: 0,
      aiInr: 0,
      statusMix: [],
      points: [
        { date: "2026-08-10", calls: 3, messages: 0 },
        { date: "2026-08-12", calls: 0, messages: 1 },
      ],
    });
    expect(points).toEqual([
      { date: "2026-08-10", calls: 3, messages: 0 },
      { date: "2026-08-11", calls: 0, messages: 0 },
      { date: "2026-08-12", calls: 0, messages: 1 },
    ]);
  });
});
