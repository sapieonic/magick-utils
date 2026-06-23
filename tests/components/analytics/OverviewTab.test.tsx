// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    AreaChart: Pass,
    Area: Pass,
    BarChart: Pass,
    Bar: Pass,
    PieChart: Pass,
    Pie: Pass,
    Cell: Pass,
    XAxis: Pass,
    YAxis: Pass,
    CartesianGrid: Pass,
    Tooltip: Pass,
  };
});

import { OverviewTab } from "@/components/screens/analytics/OverviewTab";
import { aggregate } from "@/lib/data";
import type { Batch } from "@/lib/types";
import type { AggregatesDoc } from "@/lib/server/types";

const voiceBatch: Batch = {
  id: "cmp_1",
  batchId: "AI-2001",
  name: "Test AI",
  channel: "voice",
  callType: "ai",
  provider: "Exotel",
  date: "2026-06-01T10:00:00.000Z",
  dayAgo: 12,
  total: 100,
  breakdown: [
    { key: "completed", value: 70 },
    { key: "failed", value: 30 },
  ],
  successRate: 0.7,
  spendInr: 5000,
  telephonyInr: 4000,
  aiInr: 1000,
  avgDuration: 90,
  avgTalkTime: 60,
};

describe("OverviewTab — analytics vs agg fallback", () => {
  it("derives stat values from the analytics prop when present", () => {
    const analytics: AggregatesDoc = {
      tenantId: "t",
      accountId: "a",
      key: "k",
      batchIds: [],
      totalRecords: 12345,
      statusMix: [{ key: "completed", value: 12345 }],
      successRate: 0.812,
      spendInr: 999000,
      telephonyInr: 0,
      aiInr: 0,
      computedAt: "2026-06-13",
    };
    render(
      <OverviewTab
        targets={[voiceBatch]}
        agg={aggregate([voiceBatch])}
        currency="inr"
        hasVoice
        analytics={analytics}
      />,
    );
    // Records analyzed comes from analytics.totalRecords (12,345 in en-IN grouping)
    expect(screen.getByText("12,345")).toBeInTheDocument();
    // Answer rate from analytics.successRate
    expect(screen.getByText("81.2%")).toBeInTheDocument();
    expect(screen.getByText("Records during the campaign window")).toBeInTheDocument();
  });

  it("falls back to agg / targets when analytics is absent", () => {
    const agg = aggregate([voiceBatch]);
    render(
      <OverviewTab
        targets={[voiceBatch]}
        agg={agg}
        currency="inr"
        hasVoice
      />,
    );
    // records = totalCalls + totalMessages = 100 (also appears as a donut %; ensure present)
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    // success rate fmtPct(0.7) = 70.0%
    expect(screen.getByText("70.0%")).toBeInTheDocument();
    // avg duration from the voice target (90s -> "1m 30s")
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
  });
});
