// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    PieChart: Pass,
    Pie: Pass,
    Cell: Pass,
    Tooltip: Pass,
  };
});

import { StatusDonut } from "@/components/screens/analytics/StatusDonut";

const counts = [
  { name: "Completed", value: 4200, color: "#16a34a" },
  { name: "No answer", value: 1873, color: "#94a3b8" },
];

describe("analytics/StatusDonut", () => {
  it("totals real counts in the centre and labels them records", () => {
    render(<StatusDonut data={counts} />);
    expect(screen.getByText("6.1K")).toBeInTheDocument();
    expect(screen.getByText("records")).toBeInTheDocument();
    expect(screen.getByText("69%")).toBeInTheDocument();
  });

  it("does not divide by zero when every segment is empty", () => {
    render(<StatusDonut data={[{ name: "Completed", value: 0, color: "#16a34a" }]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });
});
