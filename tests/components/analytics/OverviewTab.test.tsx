// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Svg = ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>;
  const Empty = () => null;
  return {
    ResponsiveContainer: Pass,
    AreaChart: Svg,
    Area: Empty,
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
    expect(screen.getByText("Records during the campaign window · times in IST")).toBeInTheDocument();
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

describe("OverviewTab — no mock data on a live backend", () => {
  const liveAgg: AggregatesDoc = {
    tenantId: "t",
    accountId: "a",
    key: "k",
    batchIds: [],
    totalRecords: 6073,
    statusMix: [{ key: "completed", value: 6073 }],
    successRate: 0.5,
    spendInr: 0,
    telephonyInr: 0,
    aiInr: 0,
    computedAt: "2026-06-13",
  };

  it("leaves the volume chart empty when the aggregate carries no timeline", () => {
    render(
      <OverviewTab targets={[voiceBatch]} agg={aggregate([voiceBatch])} currency="inr" hasVoice analytics={liveAgg} />,
    );
    expect(screen.getByText("No volume timeline yet")).toBeInTheDocument();
    // the seeded callsOverTime() series would bring its own legend along
    expect(screen.queryByText("Calls")).not.toBeInTheDocument();
    expect(screen.queryByText("Messages")).not.toBeInTheDocument();
  });

  it("shows a loading state rather than an empty one while the pull is running", () => {
    render(
      <OverviewTab targets={[voiceBatch]} agg={aggregate([voiceBatch])} currency="inr" hasVoice analytics={null} loading />,
    );
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.queryByText("No volume timeline yet")).not.toBeInTheDocument();
  });

  // Three placeholders share this tab while a pull is running; each keeps its
  // own live region, so none of them may shout "Loading…" on its own.
  it("does not announce three simultaneous loading messages", () => {
    render(
      <OverviewTab
        targets={[voiceBatch]}
        agg={aggregate([voiceBatch])}
        currency="inr"
        hasVoice
        analytics={{ ...liveAgg, statusMix: [] }}
        loading
      />,
    );
    const regions = screen.getAllByRole("status");
    expect(regions).toHaveLength(3);
    expect(regions.every((r) => r.getAttribute("aria-busy") === "true")).toBe(true);
    expect(screen.getAllByText("Loading…").every((node) => node.closest("[aria-hidden]") !== null)).toBe(true);
  });

  it("renders the seeded volume series in demo mode", () => {
    render(
      <OverviewTab targets={[voiceBatch]} agg={aggregate([voiceBatch])} currency="inr" hasVoice analytics={null} demo />,
    );
    expect(screen.queryByText("No volume timeline yet")).not.toBeInTheDocument();
    expect(screen.getByText("Calls")).toBeInTheDocument();
  });

  it("names the record counts so ingested and dispatched can't be confused", () => {
    const { rerender } = render(
      <OverviewTab targets={[voiceBatch]} agg={aggregate([voiceBatch])} currency="inr" hasVoice analytics={liveAgg} />,
    );
    expect(screen.getByText("Records ingested")).toBeInTheDocument();
    expect(screen.getByText("6,073")).toBeInTheDocument();
    expect(screen.queryByText("Records analyzed")).not.toBeInTheDocument();

    rerender(<OverviewTab targets={[voiceBatch]} agg={aggregate([voiceBatch])} currency="inr" hasVoice />);
    expect(screen.getByText("Records dispatched")).toBeInTheDocument();
  });
});
