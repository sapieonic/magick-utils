// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChartPlaceholder } from "@/components/screens/analytics/ChartPlaceholder";

describe("analytics/ChartPlaceholder", () => {
  // The loading branch used to be the only live region, so a screen reader was
  // told the pull had started and never how it ended.
  it("keeps one live region that updates in place from loading to the outcome", () => {
    const { rerender } = render(
      <ChartPlaceholder loading title="No key topics yet" body="Nothing was ingested." />,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No key topics yet")).not.toBeInTheDocument();

    rerender(<ChartPlaceholder title="No key topics yet" body="Nothing was ingested." />);
    // same region element, new content — an update, not a region that vanished
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("No key topics yet")).toBeInTheDocument();
  });

  it("carries the loading state as aria-busy rather than announcing 'Loading…'", () => {
    render(<ChartPlaceholder loading title="No outcomes yet" />);
    // Overview renders three placeholders at once; three simultaneous
    // "Loading…" announcements would say nothing the busy state doesn't.
    expect(screen.getByText("Loading…").closest("[aria-hidden]")).not.toBeNull();
  });

  it("does not duplicate aria-live on a role=status region", () => {
    render(<ChartPlaceholder loading title="No outcomes yet" />);
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-live");
  });
});
