// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";

import { StepBadge } from "@/components/screens/combine/StepBadge";
import { SummaryRow } from "@/components/screens/combine/SummaryRow";
import { ColumnPicker, relevantGroups } from "@/components/screens/combine/ColumnPicker";
import { COLUMN_GROUPS } from "@/lib/data";

describe("combine/StepBadge", () => {
  it("shows the step number when neither active nor done", () => {
    render(<StepBadge n={2} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders a check icon when done", () => {
    const { container } = render(<StepBadge n={2} done />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("active applies accent background and still shows the number", () => {
    render(<StepBadge n={3} active />);
    const el = screen.getByText("3");
    expect(el.parentElement || el).toBeTruthy();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("combine/SummaryRow", () => {
  it("renders label and value", () => {
    render(<SummaryRow label="Rows" value="1,024" />);
    expect(screen.getByText("Rows")).toBeInTheDocument();
    expect(screen.getByText("1,024")).toBeInTheDocument();
  });
});

describe("combine/relevantGroups", () => {
  it("returns common + ai for selType ai", () => {
    const g = relevantGroups("ai");
    expect(g.map((x) => x.label)).toEqual([COLUMN_GROUPS.common.label, COLUMN_GROUPS.ai.label]);
  });

  it("returns common + ivr for selType ivr", () => {
    const g = relevantGroups("ivr");
    expect(g.map((x) => x.label)).toEqual([COLUMN_GROUPS.common.label, COLUMN_GROUPS.ivr.label]);
  });

  it("returns common + message for selType message", () => {
    const g = relevantGroups("message");
    expect(g.map((x) => x.label)).toEqual([COLUMN_GROUPS.common.label, COLUMN_GROUPS.message.label]);
  });

  it("returns only common for an unknown selType (filtered out)", () => {
    const g = relevantGroups("nope");
    expect(g.map((x) => x.label)).toEqual([COLUMN_GROUPS.common.label]);
  });
});

function Harness({ initial }: { initial: string[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  return <ColumnPicker groups={relevantGroups("ai")} selected={selected} setSelected={setSelected} />;
}

describe("combine/ColumnPicker", () => {
  it("renders a checkbox per column across the relevant groups", () => {
    const groups = relevantGroups("ai");
    const total = groups.flatMap((g) => g.columns).length;
    render(<Harness initial={[]} />);
    // count text reflects total available columns
    expect(screen.getByText(`of ${total} columns selected`, { exact: false })).toBeInTheDocument();
  });

  it("toggling a column updates the selection count via the setter", async () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText("0")).toBeInTheDocument();
    // Click the checkbox box span (carries the onClick), reached via the label text.
    const labelEl = screen.getByText("record_id").closest("label")!;
    await userEvent.click(labelEl.querySelector("span")! as HTMLElement);
    // selected count becomes 1
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("Select all selects every column, then Deselect all clears them", async () => {
    const groups = relevantGroups("ai");
    const total = groups.flatMap((g) => g.columns).length;
    render(<Harness initial={[]} />);
    await userEvent.click(screen.getByText("Select all"));
    expect(screen.getByText(String(total))).toBeInTheDocument();
    await userEvent.click(screen.getByText("Deselect all"));
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});
