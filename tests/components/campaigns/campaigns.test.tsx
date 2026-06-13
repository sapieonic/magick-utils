// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";

import { FilterSelect } from "@/components/screens/campaigns/FilterSelect";
import { ColumnPicker, relevantGroups } from "@/components/screens/campaigns/ColumnPicker";
import { COLUMN_GROUPS } from "@/lib/data";

describe("campaigns/FilterSelect", () => {
  const options = [
    { value: "all", label: "All channels" },
    { value: "voice", label: "Voice" },
    { value: "whatsapp", label: "WhatsApp" },
  ];

  it("shows the current option label in the trigger", () => {
    render(<FilterSelect icon="Filter" label="Channel" value="voice" onChange={() => {}} options={options} />);
    expect(screen.getByText("Voice")).toBeInTheDocument();
  });

  it("opens and renders all options, selecting calls onChange with the value", async () => {
    const onChange = vi.fn();
    render(<FilterSelect icon="Filter" label="Channel" value="all" onChange={onChange} options={options} />);
    // open menu by clicking the trigger (shows current label "All channels")
    await userEvent.click(screen.getByText("All channels"));
    // both occurrences exist now (trigger + menu item); click the WhatsApp option
    await userEvent.click(screen.getByText("WhatsApp"));
    expect(onChange).toHaveBeenCalledWith("whatsapp");
  });
});

describe("campaigns/relevantGroups", () => {
  it("returns common + message for message selType", () => {
    expect(relevantGroups("message").map((g) => g.label)).toEqual([
      COLUMN_GROUPS.common.label,
      COLUMN_GROUPS.message.label,
    ]);
  });
});

function Harness() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return <ColumnPicker groups={relevantGroups("ivr")} selected={selected} setSelected={setSelected} />;
}

describe("campaigns/ColumnPicker", () => {
  it("toggles a column via the setter", async () => {
    render(<Harness />);
    expect(screen.getByText("0")).toBeInTheDocument();
    const labelEl = screen.getByText("call_id").closest("label")!;
    await userEvent.click(labelEl.querySelector("span")! as HTMLElement);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("group 'all' link selects the whole group", async () => {
    render(<Harness />);
    const commonCount = COLUMN_GROUPS.common.columns.length;
    // the first "all" link belongs to the Common group
    const allLinks = screen.getAllByText("all");
    await userEvent.click(allLinks[0]);
    expect(screen.getByText(String(commonCount))).toBeInTheDocument();
  });
});
