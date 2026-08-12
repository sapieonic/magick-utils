import { describe, expect, it } from "vitest";
import { dashboardVolumeFromCampaigns, fillDashboardDays } from "@/lib/dashboard";
import { inDashboardRange, rangeStart } from "@/lib/date-range";
import type { Batch } from "@/lib/types";

function campaign(over: Partial<Batch>): Batch {
  return {
    id: "b1",
    batchId: "AI-1",
    name: "Camp",
    channel: "voice",
    callType: "ai",
    provider: "exotel",
    date: "2026-08-12T10:00:00.000Z",
    dayAgo: 0,
    total: 0,
    breakdown: [],
    successRate: 0,
    spendInr: 0,
    telephonyInr: 0,
    aiInr: 0,
    avgDuration: null,
    avgTalkTime: null,
    ...over,
  };
}

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

describe("dashboardVolumeFromCampaigns", () => {
  const now = new Date("2026-08-12T12:00:00Z");

  it("buckets campaign volume by start date so uningested batches still appear", () => {
    const volume = dashboardVolumeFromCampaigns([
      campaign({
        id: "aug3",
        date: "2026-08-03T08:00:00.000Z",
        total: 1984,
        breakdown: [{ key: "completed", value: 250 }, { key: "busy", value: 1734 }],
        successRate: 250 / 1984,
      }),
      campaign({
        id: "aug12",
        date: "2026-08-12T09:00:00.000Z",
        total: 1984,
        breakdown: [{ key: "completed", value: 200 }, { key: "noanswer", value: 1784 }],
        successRate: 200 / 1984,
      }),
      campaign({
        id: "old",
        date: "2026-06-01T00:00:00.000Z",
        total: 5000,
        breakdown: [{ key: "completed", value: 5000 }],
        successRate: 1,
      }),
    ], "Last 30 days", now);

    expect(volume.totalCalls).toBe(3968);
    expect(volume.points).toEqual([
      { date: "2026-08-03", calls: 1984, messages: 0 },
      { date: "2026-08-12", calls: 1984, messages: 0 },
    ]);
    expect(volume.statusMix).toEqual(expect.arrayContaining([
      { key: "completed", value: 450 },
      { key: "busy", value: 1734 },
      { key: "noanswer", value: 1784 },
    ]));
  });

  it("falls back to campaign total when the status breakdown is empty", () => {
    const volume = dashboardVolumeFromCampaigns([
      campaign({ date: "2026-08-12T00:00:00.000Z", total: 1984, breakdown: [] }),
    ], "Last 30 days", now);
    expect(volume.totalCalls).toBe(1984);
    expect(volume.points).toEqual([{ date: "2026-08-12", calls: 1984, messages: 0 }]);
  });

  it("counts messaging campaigns separately from voice", () => {
    const volume = dashboardVolumeFromCampaigns([
      campaign({
        channel: "whatsapp",
        callType: null,
        date: "2026-08-11T00:00:00.000Z",
        total: 80,
        breakdown: [{ key: "read", value: 50 }, { key: "delivered", value: 30 }],
      }),
    ], "Last 30 days", now);
    expect(volume.totalCalls).toBe(0);
    expect(volume.totalMessages).toBe(80);
    expect(volume.points).toEqual([{ date: "2026-08-11", calls: 0, messages: 80 }]);
  });
});


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
