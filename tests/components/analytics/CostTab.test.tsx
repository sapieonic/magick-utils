// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    AreaChart: Pass,
    Area: Pass,
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
