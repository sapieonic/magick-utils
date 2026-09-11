// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Topbar } from "@/components/shell/Topbar";
import { DASHBOARD_RANGES } from "@/lib/date-range";
import type { Workspace } from "@/lib/types";

const workspace: Workspace = { name: "Acme", tenant: "t_1", account: "a_1", role: "owner" };

function renderTopbar(over: Partial<React.ComponentProps<typeof Topbar>> = {}) {
  const setDateRange = vi.fn();
  render(
    <Topbar
      title="Campaigns"
      workspace={workspace}
      currency="inr"
      setCurrency={vi.fn()}
      dateRange="Last 7 days"
      setDateRange={setDateRange}
      setCollapsed={vi.fn()}
      setMobileOpen={vi.fn()}
      onSwitch={vi.fn()}
      onSignout={vi.fn()}
      {...over}
    />,
  );
  return { setDateRange };
}

/** The button that opens the date-range menu. */
function rangeTrigger(dateRange = "Last 7 days"): HTMLElement {
  return screen.getByText(dateRange).closest("button")!;
}

describe("Topbar date range", () => {
  it("keeps the range control on screen at phone width", () => {
    renderTopbar();
    const trigger = rangeTrigger();
    // `hidden sm:flex` left phones with no way to widen a narrowed range at all.
    expect(trigger.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    // …and the applied range has to be readable there, not just the icon.
    expect(trigger).toHaveTextContent("Last 7 days");
  });

  it("offers exactly the ranges the rest of the app understands", async () => {
    const { setDateRange } = renderTopbar();
    await userEvent.click(rangeTrigger());
    const labels = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    for (const range of DASHBOARD_RANGES) expect(labels).toContain(range);
    // A hand-copied list could drift from DASHBOARD_RANGES and reach the route as
    // an unknown range.
    await userEvent.click(screen.getByRole("button", { name: /^All time$/ }));
    expect(setDateRange).toHaveBeenCalledWith("All time");
  });
});
