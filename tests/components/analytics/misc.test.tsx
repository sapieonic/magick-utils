// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { Legend } from "@/components/screens/analytics/Legend";
import { Num } from "@/components/screens/analytics/Num";
import { ChartTip } from "@/components/screens/analytics/ChartTip";
import { MODELS } from "@/components/screens/analytics/models";
import { ModelSelect } from "@/components/screens/analytics/ModelSelect";

describe("analytics/Legend", () => {
  it("renders one entry per item with its label and color swatch", () => {
    const { container } = render(
      <Legend items={[{ c: "#f00", l: "Calls" }, { c: "#00f", l: "Messages" }]} />,
    );
    expect(screen.getByText("Calls")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    const swatches = container.querySelectorAll("span[style]");
    expect(swatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("analytics/Num", () => {
  it("renders children with default accent styling (no tone)", () => {
    render(<Num>42</Num>);
    const el = screen.getByText("42");
    expect(el).toHaveClass("text-[var(--accent-strong)]");
    expect(el).toHaveClass("bg-[var(--accent-soft)]");
  });

  it("applies good tone classes", () => {
    render(<Num tone="good">+5%</Num>);
    expect(screen.getByText("+5%")).toHaveClass("text-emerald-700");
  });

  it("applies bad tone classes", () => {
    render(<Num tone="bad">-5%</Num>);
    expect(screen.getByText("-5%")).toHaveClass("text-red-700");
  });
});

describe("analytics/ChartTip", () => {
  it("returns null when inactive", () => {
    const { container } = render(<ChartTip active={false} payload={[{ name: "x", value: 1 }]} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when payload empty", () => {
    const { container } = render(<ChartTip active payload={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders label and formatted value with suffix when active", () => {
    render(<ChartTip active label="Mon" payload={[{ name: "calls", value: 1234, color: "#f00" }]} suffix=" records" />);
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.getByText("calls")).toBeInTheDocument();
    // fmtNum(1234) en-IN grouping + suffix
    expect(screen.getByText(/1,234 records/)).toBeInTheDocument();
  });
});

describe("analytics/models + ModelSelect", () => {
  it("MODELS has the expected ids", () => {
    expect(MODELS.map((m) => m.id)).toEqual(["claude", "deepseek", "kimi"]);
  });

  it("shows the selected model name in the trigger", () => {
    render(<ModelSelect model="deepseek" setModel={() => {}} />);
    expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
  });

  it("opens the menu and calls setModel with the chosen id", async () => {
    const setModel = vi.fn();
    render(<ModelSelect model="claude" setModel={setModel} />);
    // open dropdown via the trigger button
    await userEvent.click(screen.getByText("Claude Sonnet 4.5"));
    await userEvent.click(screen.getByText("Kimi K2"));
    expect(setModel).toHaveBeenCalledWith("kimi");
  });
});
