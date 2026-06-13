// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

// Sparkline/StatCard pull in recharts; stub to plain passthrough divs so children
// render without jsdom-measuring ResponsiveContainer.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { ResponsiveContainer: Pass, AreaChart: Pass, Area: Pass };
});

import {
  Button,
  Badge,
  Card,
  ChartCard,
  Checkbox,
  EmptyState,
  Input,
  JobProgress,
  SkeletonRow,
  Spinner,
  StatCard,
  StatusStackBar,
  Tabs,
  TypeBadge,
  TypeDot,
} from "@/components/ui";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("applies size classes", () => {
    render(<Button size="sm">S</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-8");
  });

  it("applies variant classes (danger)", () => {
    render(<Button variant="danger">D</Button>);
    expect(screen.getByRole("button")).toHaveClass("text-red-600");
  });

  it("renders left icon when icon prop set", () => {
    const { container } = render(<Button icon="Download">Export</Button>);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders iconRight", () => {
    const { container } = render(<Button iconRight="ChevronRight">Next</Button>);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("fires onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled prevents click", async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Go</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading shows a spinner and disables the button", () => {
    render(<Button loading>Go</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});

describe("Checkbox", () => {
  it("renders label", () => {
    render(<Checkbox label="Agree" />);
    expect(screen.getByText("Agree")).toBeInTheDocument();
  });

  it("shows a check icon when checked", () => {
    const { container } = render(<Checkbox checked label="x" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  // The clickable target is the box span (it carries the onClick), not the label text.
  const box = (container: HTMLElement) => container.querySelector("label > span")! as HTMLElement;

  it("fires onChange with the toggled value when clicked", async () => {
    const onChange = vi.fn();
    const { container } = render(<Checkbox checked={false} onChange={onChange} label="pick me" />);
    await userEvent.click(box(container));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("fires onChange(false) when unchecking a checked box", async () => {
    const onChange = vi.fn();
    const { container } = render(<Checkbox checked onChange={onChange} label="pick me" />);
    await userEvent.click(box(container));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("disabled does not fire onChange", async () => {
    const onChange = vi.fn();
    const { container } = render(<Checkbox disabled onChange={onChange} label="pick me" />);
    await userEvent.click(box(container));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("indeterminate (unchecked) renders neither check nor crash", () => {
    const { container } = render(<Checkbox indeterminate label="part" />);
    // indeterminate shows a dash span, not the Check svg
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("Tabs", () => {
  const tabs = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta", count: 3 },
    { value: "c", label: "Gamma" },
  ];

  it("renders all tabs", () => {
    render(<Tabs tabs={tabs} value="a" onChange={() => {}} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("marks the active tab with accent class", () => {
    render(<Tabs tabs={tabs} value="b" onChange={() => {}} />);
    const beta = screen.getByText("Beta").closest("button")!;
    expect(beta).toHaveClass("text-[var(--accent-strong)]");
  });

  it("fires onChange with the clicked value", async () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} value="a" onChange={onChange} />);
    await userEvent.click(screen.getByText("Gamma"));
    expect(onChange).toHaveBeenCalledWith("c");
  });
});

describe("StatusStackBar", () => {
  const breakdown = [
    { key: "completed" as const, value: 60 },
    { key: "failed" as const, value: 40 },
  ];

  it("renders one segment per breakdown entry with proportional width", () => {
    const { container } = render(<StatusStackBar breakdown={breakdown} />);
    const segs = container.querySelectorAll("[title]");
    expect(segs).toHaveLength(2);
    expect((segs[0] as HTMLElement).style.width).toBe("60%");
    expect((segs[1] as HTMLElement).style.width).toBe("40%");
  });

  it("renders a legend row per entry when showLegend", () => {
    render(<StatusStackBar breakdown={breakdown} showLegend />);
    expect(screen.getByText(/Completed/)).toBeInTheDocument();
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
  });
});

describe("StatCard", () => {
  it("shows skeleton when loading", () => {
    const { container } = render(<StatCard loading label="Spend" value="₹1.2K" />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("₹1.2K")).not.toBeInTheDocument();
  });

  it("shows value when not loading", () => {
    render(<StatCard label="Spend" value="₹1.2K" />);
    expect(screen.getByText("₹1.2K")).toBeInTheDocument();
  });

  it("renders a delta badge when delta provided", () => {
    const { container } = render(<StatCard label="x" value="10" delta={12} />);
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("SkeletonRow", () => {
  it("renders the default number of column cells (6)", () => {
    const { container } = render(<SkeletonRow />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(6);
  });

  it("renders the requested number of cells", () => {
    const { container } = render(<SkeletonRow cols={3} />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(3);
  });
});

describe("JobProgress", () => {
  it("computes percent width from value/total", () => {
    const { container } = render(<JobProgress label="Merging" value={25} total={100} />);
    const bar = container.querySelector(".h-full")! as HTMLElement;
    expect(bar.style.width).toBe("25%");
  });

  it("caps percent at 100", () => {
    const { container } = render(<JobProgress label="x" value={200} total={100} />);
    const bar = container.querySelector(".h-full")! as HTMLElement;
    expect(bar.style.width).toBe("100%");
  });

  it("uses value directly as percent when no total", () => {
    const { container } = render(<JobProgress label="x" value={42} />);
    const bar = container.querySelector(".h-full")! as HTMLElement;
    expect(bar.style.width).toBe("42%");
  });

  it("success tone renders a check icon", () => {
    const { container } = render(<JobProgress label="Done" value={100} total={100} tone="success" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("Spinner", () => {
  it("renders with the requested size", () => {
    const { container } = render(<Spinner size={24} />);
    const span = container.querySelector("span")! as HTMLElement;
    expect(span.style.width).toBe("24px");
    expect(span.style.height).toBe("24px");
  });
});

describe("EmptyState", () => {
  it("renders title, body and action", () => {
    render(<EmptyState title="Nothing here" body="Try again" action={<button>Retry</button>} />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Badge", () => {
  it("renders children and a dot when dot set", () => {
    const { container } = render(<Badge dot color="#f00">Hot</Badge>);
    expect(screen.getByText("Hot")).toBeInTheDocument();
    // dot span + outer span
    expect(container.querySelectorAll("span").length).toBeGreaterThanOrEqual(2);
  });
});

describe("TypeBadge / TypeDot", () => {
  it("TypeBadge renders the label for a known type", () => {
    render(<TypeBadge tkey="ai" />);
    expect(screen.getByText("AI Call")).toBeInTheDocument();
  });

  it("TypeDot renders an icon for a known type", () => {
    const { container } = render(<TypeDot tkey="whatsapp" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("Card / ChartCard / Input", () => {
  it("Card renders children and merges className", () => {
    render(<Card className="my-card">inside</Card>);
    expect(screen.getByText("inside")).toBeInTheDocument();
    expect(screen.getByText("inside")).toHaveClass("my-card");
  });

  it("ChartCard renders title, subtitle, action and body", () => {
    render(
      <ChartCard title="Trend" subtitle="last 30d" action={<span>act</span>}>
        <div>body</div>
      </ChartCard>,
    );
    expect(screen.getByText("Trend")).toBeInTheDocument();
    expect(screen.getByText("last 30d")).toBeInTheDocument();
    expect(screen.getByText("act")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("Input renders an input and an icon when icon set", () => {
    const { container } = render(<Input icon="Search" placeholder="find" />);
    expect(screen.getByPlaceholderText("find")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});
