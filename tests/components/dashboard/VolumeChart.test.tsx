// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Empty = () => null;
  return {
    ResponsiveContainer: Pass,
    AreaChart: ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>,
    Area: Empty,
    XAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: Empty,
    YAxis: ({
      type,
      domain,
      ticks,
      width,
      tickFormatter,
    }: {
      type?: string;
      domain?: [number, number];
      ticks?: number[];
      width?: number;
      tickFormatter?: (value: number) => string;
    }) => (
      <div
        data-testid="volume-yaxis"
        data-type={type}
        data-domain={JSON.stringify(domain)}
        data-width={width}
        data-ticks={JSON.stringify(ticks)}
      >
        {(ticks ?? []).map((tick) => tickFormatter?.(tick) ?? String(tick)).join("|")}
      </div>
    ),
  };
});

import { VolumeChart as DashboardVolumeChart } from "@/components/screens/dashboard/VolumeChart";
import { VolumeChart as AnalyticsVolumeChart } from "@/components/screens/analytics/VolumeChart";
import { VOLUME_Y_AXIS_WIDTH } from "@/lib/chart-axis";

describe("dashboard VolumeChart Y-axis", () => {
  it("uses a numeric 0-based scale with monotonic compact labels", () => {
    render(
      <DashboardVolumeChart
        data={[
          { date: "Jul 16", calls: 2000, messages: 0 },
          { date: "Jul 17", calls: 6500, messages: 0 },
          { date: "Jul 18", calls: 11000, messages: 0 },
          { date: "Jul 19", calls: 5500, messages: 0 },
          { date: "Jul 20", calls: 22000, messages: 0 },
          { date: "Jul 21", calls: 0, messages: 0 },
        ]}
      />,
    );

    const axis = screen.getByTestId("volume-yaxis");
    expect(axis).toHaveAttribute("data-type", "number");
    expect(axis).toHaveAttribute("data-width", String(VOLUME_Y_AXIS_WIDTH));
    expect(JSON.parse(axis.getAttribute("data-domain") ?? "[]")).toEqual([0, 30000]);
    expect(axis.textContent).toBe("0|10.0K|20.0K|30.0K");
    expect(axis.textContent).not.toContain("5.5K");
    expect(axis.textContent).not.toBe("2.0K|6.5K|11.0K|5.5K|0");
  });

  it("coerces string counts so the axis stays numeric", () => {
    render(
      <DashboardVolumeChart
        data={[
          { date: "Aug 1", calls: "16500" as unknown as number, messages: 0 },
          { date: "Aug 2", calls: 8000, messages: 0 },
        ]}
      />,
    );
    const axis = screen.getByTestId("volume-yaxis");
    expect(axis).toHaveAttribute("data-type", "number");
    expect(JSON.parse(axis.getAttribute("data-ticks") ?? "[]")[0]).toBe(0);
    expect(axis.textContent).toMatch(/10\.0K/);
  });

  it("is the same component the analytics overview chart uses", () => {
    expect(AnalyticsVolumeChart).toBe(DashboardVolumeChart);
  });
});
