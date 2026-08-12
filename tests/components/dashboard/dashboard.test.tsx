// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { ChartTip } from "@/components/screens/dashboard/ChartTip";
import { FunnelBars } from "@/components/screens/dashboard/FunnelBars";
import { Legend } from "@/components/screens/dashboard/Legend";
import { RankedBars } from "@/components/screens/dashboard/RankedBars";

describe("dashboard/Legend", () => {
  it("renders each item label", () => {
    render(<Legend items={[{ c: "#111", l: "Calls" }, { c: "#222", l: "Messages" }]} />);
    expect(screen.getByText("Calls")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
  });
});

describe("dashboard/ChartTip", () => {
  it("returns null when inactive or empty payload", () => {
    const { container: c1 } = render(<ChartTip active={false} payload={[{ value: 1 }]} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<ChartTip active payload={[]} />);
    expect(c2.firstChild).toBeNull();
  });

  it("falls back to payload.color when top-level color absent", () => {
    const { container } = render(
      <ChartTip active payload={[{ name: "seg", value: 5, payload: { color: "#abc" } }]} />,
    );
    const swatch = container.querySelector("span[style]") as HTMLElement;
    expect(swatch.style.background).toBe("rgb(170, 187, 204)");
    expect(screen.getByText("seg")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});

describe("dashboard/FunnelBars", () => {
  it("shows stage counts and drop from the previous stage", () => {
    render(
      <FunnelBars
        data={[
          { stage: "Sent", value: 100 },
          { stage: "Delivered", value: 80 },
          { stage: "Read", value: 40 },
        ]}
      />,
    );
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("−20%")).toBeInTheDocument();
    expect(screen.getByText("−50%")).toBeInTheDocument();
  });
});

describe("dashboard/RankedBars", () => {
  it("renders ranked labels and the empty copy", () => {
    const { rerender } = render(
      <RankedBars items={[{ label: "Promise To Pay", value: 12 }, { label: "Callback", value: 4 }]} />,
    );
    expect(screen.getByText("Promise To Pay")).toBeInTheDocument();
    expect(screen.getByText("Callback")).toBeInTheDocument();
    rerender(<RankedBars items={[]} empty="No business outcomes were recorded on ingested calls in this period." />);
    expect(screen.getByText("No business outcomes were recorded on ingested calls in this period.")).toBeInTheDocument();
  });
});
