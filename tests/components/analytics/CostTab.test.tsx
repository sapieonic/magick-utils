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
    XAxis: Pass,
    YAxis: Pass,
    CartesianGrid: Pass,
    Tooltip: Pass,
  };
});

import { CostTab } from "@/components/screens/analytics/CostTab";
import type { AggregatesDoc } from "@/lib/server/types";

const baseAgg: AggregatesDoc = {
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

describe("CostTab — % of spend guard", () => {
  it("shows 0% (not NaN%) when total spend is 0", () => {
    render(<CostTab targets={[]} currency="inr" analytics={baseAgg} />);
    const zeros = screen.getAllByText("0% of spend");
    // both telephony and AI lines read 0%
    expect(zeros).toHaveLength(2);
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("shows the rounded percent split when total is nonzero", () => {
    render(
      <CostTab
        targets={[]}
        currency="inr"
        analytics={{ ...baseAgg, telephonyInr: 750, aiInr: 250 }}
      />,
    );
    expect(screen.getByText("75% of spend")).toBeInTheDocument();
    expect(screen.getByText("25% of spend")).toBeInTheDocument();
  });
});

describe("CostTab — no mock spend curve on a live backend", () => {
  it("renders an empty state when the aggregate has no cost timeline", () => {
    render(<CostTab targets={[]} currency="inr" analytics={baseAgg} />);
    expect(screen.getByText("No cost timeline yet")).toBeInTheDocument();
    // costBreakdown() would bring the telephony/AI legend with it
    expect(screen.queryByText("Telephony")).not.toBeInTheDocument();
  });

  it("shows the loading state instead while ingestion is still running", () => {
    render(<CostTab targets={[]} currency="inr" analytics={null} loading />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("No cost timeline yet")).not.toBeInTheDocument();
  });

  it("renders the seeded curve in demo mode", () => {
    render(<CostTab targets={[]} currency="inr" analytics={null} demo />);
    expect(screen.queryByText("No cost timeline yet")).not.toBeInTheDocument();
    expect(screen.getByText("Telephony")).toBeInTheDocument();
  });
});
