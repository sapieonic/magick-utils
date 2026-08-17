// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReachHeatmap } from "@/components/screens/analytics/ReachHeatmap";
import type { ReachByTimeOfDay } from "@/lib/server/types";

function reach(over: Partial<ReachByTimeOfDay> = {}): ReachByTimeOfDay {
  return {
    timezone: "Asia/Kolkata",
    bandHours: 1,
    minSamples: 20,
    totalPlaced: 40,
    cells: [{ weekday: 0, band: 15, total: 40, reached: 12, rate: 0.3, lowSample: false }],
    ...over,
  };
}

describe("ReachHeatmap", () => {
  it("labels the chart as hourly connectivity % in IST", () => {
    render(<ReachHeatmap reach={reach()} isMessage={false} />);
    expect(screen.getByText("Best time to reach")).toBeInTheDocument();
    expect(screen.getByText("Connectivity % by weekday and hour · times in IST")).toBeInTheDocument();
    expect(screen.getByText("3p")).toBeInTheDocument();
    expect(screen.getByText("30.0%")).toBeInTheDocument();
    expect(screen.getByText(/Connectivity runs/)).toBeInTheDocument();
  });

  it("keeps read rate copy for messaging selections", () => {
    render(<ReachHeatmap reach={reach()} isMessage />);
    expect(screen.getByText("Read rate by weekday and hour · times in IST")).toBeInTheDocument();
    expect(screen.getByText(/Read rate runs/)).toBeInTheDocument();
  });

  it("renders a column for every hour of the day", () => {
    render(<ReachHeatmap reach={reach()} isMessage={false} />);
    expect(screen.getByText("12a")).toBeInTheDocument();
    expect(screen.getByText("11p")).toBeInTheDocument();
  });
});
