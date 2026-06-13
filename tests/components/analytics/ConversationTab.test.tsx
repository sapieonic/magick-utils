// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    BarChart: Pass,
    Bar: Pass,
    LineChart: Pass,
    Line: Pass,
    PieChart: Pass,
    Pie: Pass,
    Cell: Pass,
    XAxis: Pass,
    YAxis: Pass,
    CartesianGrid: Pass,
    Tooltip: Pass,
  };
});

import { ConversationTab } from "@/components/screens/analytics/ConversationTab";
import type { AggregatesDoc } from "@/lib/server/types";

const base: AggregatesDoc = {
  tenantId: "t",
  accountId: "a",
  key: "k",
  batchIds: [],
  totalRecords: 0,
  statusMix: [],
  successRate: 0,
  spendInr: 0,
  telephonyInr: 0,
  aiInr: 0,
  computedAt: "2026-06-13",
};

describe("ConversationTab — FunnelView", () => {
  it("renders nothing for the funnel when analytics.funnel is empty (hasMsg)", () => {
    render(
      <ConversationTab
        hasVoice={false}
        hasMsg
        analytics={{ ...base, funnel: [] }}
      />,
    );
    // Funnel card title still shows, but no stage rows are rendered.
    expect(screen.getByText("Delivery funnel")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("renders stages for non-empty funnel data (hasMsg)", () => {
    render(
      <ConversationTab
        hasVoice={false}
        hasMsg
        analytics={{
          ...base,
          funnel: [
            { stage: "Sent", value: 1000 },
            { stage: "Delivered", value: 900 },
            { stage: "Read", value: 500 },
          ],
        }}
      />,
    );
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("renders the sentiment trend (not funnel) when hasMsg is false", () => {
    render(<ConversationTab hasVoice hasMsg={false} analytics={base} />);
    expect(screen.getByText("Sentiment trend")).toBeInTheDocument();
    expect(screen.queryByText("Delivery funnel")).not.toBeInTheDocument();
  });

  it("renders the topic list from analytics.topics when provided", () => {
    render(
      <ConversationTab
        hasVoice={false}
        hasMsg
        analytics={{
          ...base,
          topics: [{ topic: "Custom intent X", count: 42, sentiment: "neutral" }],
          funnel: [{ stage: "Sent", value: 10 }],
        }}
      />,
    );
    expect(screen.getByText("Custom intent X")).toBeInTheDocument();
  });
});
