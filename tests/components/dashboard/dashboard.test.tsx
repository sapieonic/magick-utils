// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { Legend } from "@/components/screens/dashboard/Legend";
import { ChartTip } from "@/components/screens/dashboard/ChartTip";

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
