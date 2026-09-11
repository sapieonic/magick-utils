// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    BarChart: Pass,
    Bar: Pass,
    LineChart: Pass,
    Line: Pass,
    PieChart: Pass,
    Pie: Pass,
    Cell: Pass,
    XAxis: Pass,
    YAxis: Pass,
    CartesianGrid: Pass,
    Tooltip: Pass,
  };
});

import { ConversationTab } from "@/components/screens/analytics/ConversationTab";
import type { AggregatesDoc } from "@/lib/server/types";

const base: AggregatesDoc = {
  tenantId: "t",
  accountId: "a",
  key: "k",
  batchIds: [],
  totalRecords: 0,
  statusMix: [],
  successRate: 0,
  spendInr: 0,
  telephonyInr: 0,
  aiInr: 0,
  computedAt: "2026-06-13",
};

describe("ConversationTab — FunnelView", () => {
  it("renders nothing for the funnel when analytics.funnel is empty (hasMsg)", () => {
    render(
      <ConversationTab
        hasVoice={false}
        hasMsg
        analytics={{ ...base, funnel: [] }}
      />,
    );
    // Funnel card title still shows, but no stage rows are rendered.
    expect(screen.getByText("Delivery funnel")).toBeInTheDocument();
    expect(screen.queryByText("Sent")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
  });

  it("renders stages for non-empty funnel data (hasMsg)", () => {
    render(
      <ConversationTab
        hasVoice={false}
        hasMsg
        analytics={{
          ...base,
          funnel: [
            { stage: "Sent", value: 1000 },
            { stage: "Delivered", value: 900 },
            { stage: "Read", value: 500 },
          ],
        }}
      />,
    );
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("renders the seeded sentiment trend (not funnel) when hasMsg is false in demo mode", () => {
    render(<ConversationTab hasVoice hasMsg={false} analytics={base} demo />);
    expect(screen.getByText("Sentiment trend")).toBeInTheDocument();
    expect(screen.queryByText("Delivery funnel")).not.toBeInTheDocument();
  });

  it("renders the topic list from analytics.topics when provided", () => {
    render(
      <ConversationTab
        hasVoice={false}
        hasMsg
        analytics={{
          ...base,
          topics: [{ topic: "Custom intent X", count: 42, sentiment: "neutral" }],
          funnel: [{ stage: "Sent", value: 10 }],
        }}
      />,
    );
    expect(screen.getByText("Custom intent X")).toBeInTheDocument();
  });
});

// The production bug: every card fell back to the seeds in lib/data.ts whenever
// `analytics` was null, so a real customer saw fabricated topics/sentiment.
describe("ConversationTab — no mock data on a live backend", () => {
  it("renders empty states instead of the seeded topics/sentiment when analytics is null", () => {
    render(<ConversationTab hasVoice hasMsg={false} analytics={null} />);

    // none of the seeded TOPICS rows
    expect(screen.queryByText("Payment plan request")).not.toBeInTheDocument();
    expect(screen.queryByText("Already paid")).not.toBeInTheDocument();
    expect(screen.queryByText("1,284")).not.toBeInTheDocument();
    // no seeded duration histogram / sentiment donut
    expect(screen.queryByText("100")).not.toBeInTheDocument();
    expect(screen.queryByText("records")).not.toBeInTheDocument();

    expect(screen.getByText("No key topics yet")).toBeInTheDocument();
    expect(screen.getByText("No sentiment yet")).toBeInTheDocument();
    expect(screen.getByText("No call durations yet")).toBeInTheDocument();
    // the cause stated plainly, without over-claiming
    expect(screen.getAllByText(/don't include per-call AI analysis/).length).toBeGreaterThan(0);
  });

  it("renders empty states when a cached aggregate is missing individual chart fields", () => {
    // `[]` is a legitimate real answer and must not fall back to the seeds either.
    render(<ConversationTab hasVoice hasMsg={false} analytics={{ ...base, topics: [], sentiment: [] }} />);
    expect(screen.queryByText("Payment plan request")).not.toBeInTheDocument();
    expect(screen.getByText("No key topics yet")).toBeInTheDocument();
    expect(screen.getByText("No sentiment yet")).toBeInTheDocument();
  });

  // Sentiment-over-time isn't in AggregatesDoc, so on a live backend the card
  // could only ever apologise — it is dropped, not emptied.
  it("does not ship a sentiment trend card that can only apologise", () => {
    render(<ConversationTab hasVoice hasMsg={false} analytics={base} />);
    expect(screen.queryByText("Sentiment trend")).not.toBeInTheDocument();
    expect(screen.queryByText("No sentiment trend available")).not.toBeInTheDocument();
    // the old hardcoded claim is gone too
    expect(screen.queryByText("Positive share is climbing late-campaign")).not.toBeInTheDocument();
    expect(screen.queryByText("Wk 1")).not.toBeInTheDocument();
  });

  it("lets Key topics take the freed grid cell when the trend card is dropped", () => {
    const { rerender } = render(<ConversationTab hasVoice hasMsg={false} analytics={base} />);
    expect(screen.getByText("Key topics").closest(".fade-up")?.className).toContain("lg:col-span-2");
    // …but not in demo mode, where the trend card still shares the row.
    rerender(<ConversationTab hasVoice hasMsg={false} analytics={base} demo />);
    expect(screen.getByText("Key topics").closest(".fade-up")?.className).not.toContain("lg:col-span-2");
  });

  it("distinguishes loading from loaded-and-empty", () => {
    const { rerender } = render(<ConversationTab hasVoice hasMsg={false} analytics={null} loading />);
    const busy = screen.getAllByRole("status");
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((r) => r.getAttribute("aria-busy") === "true")).toBe(true);
    expect(screen.queryByText("No key topics yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Payment plan request")).not.toBeInTheDocument();

    // Same live regions, now settled — the outcome replaces "Loading…" in place
    // instead of the announcement stopping at the loading state.
    rerender(<ConversationTab hasVoice hasMsg={false} analytics={null} />);
    expect(screen.getAllByRole("status").every((r) => r.getAttribute("aria-busy") === "false")).toBe(true);
    expect(screen.getByText("No key topics yet")).toBeInTheDocument();
  });

  it("labels the sentiment donut centre as records only for real counts", () => {
    render(
      <ConversationTab
        hasVoice
        hasMsg={false}
        analytics={{ ...base, sentiment: [{ name: "Positive", value: 12 }, { name: "Negative", value: 5 }] }}
      />,
    );
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText("records")).toBeInTheDocument();
  });
});

describe("ConversationTab — demo mode (backend off)", () => {
  it("still renders the seeded topics and sentiment", () => {
    render(<ConversationTab hasVoice hasMsg={false} analytics={null} demo />);
    expect(screen.getByText("Payment plan request")).toBeInTheDocument();
    expect(screen.getByText("1,284")).toBeInTheDocument();
    // the seeded trend line is fine here, but its subtitle no longer asserts a trend
    expect(screen.getByText("Positive share by week")).toBeInTheDocument();
  });

  // The seed used to be percentage shares, which the donut totalled into a
  // meaningless "100 records" centre on every campaign and every filter.
  it("never shows a '100 records' sentiment centre", () => {
    render(<ConversationTab hasVoice hasMsg={false} analytics={null} demo />);
    expect(screen.queryByText("100")).not.toBeInTheDocument();
    // The seed is in record counts now, so the centre total is real.
    expect(screen.getByText("10.0K")).toBeInTheDocument();
    // …and the legend still shows each segment's share.
    expect(screen.getByText("47%")).toBeInTheDocument();
  });
});

describe("ConversationTab — duration histogram", () => {
  // `aggregate()` emits all six buckets unconditionally, so an unanswered
  // selection arrives as six zero rows rather than an empty array. Keying the
  // empty state on length alone drew an empty chart and said nothing.
  it("shows the empty state when every bucket is zero", () => {
    render(
      <ConversationTab
        hasVoice
        hasMsg={false}
        analytics={{
          ...base,
          durationHistogram: [
            { bucket: "0–30s", calls: 0, talk: 0 },
            { bucket: "30–60s", calls: 0, talk: 0 },
            { bucket: "1–2m", calls: 0, talk: 0 },
            { bucket: "2–3m", calls: 0, talk: 0 },
            { bucket: "3–5m", calls: 0, talk: 0 },
            { bucket: "5m+", calls: 0, talk: 0 },
          ],
        }}
      />,
    );
    expect(screen.getByText("No call durations yet")).toBeInTheDocument();
  });

  it("charts the histogram when talk-time alone carries a value", () => {
    render(
      <ConversationTab
        hasVoice
        hasMsg={false}
        analytics={{
          ...base,
          durationHistogram: [
            { bucket: "0–30s", calls: 0, talk: 3 },
            { bucket: "30–60s", calls: 0, talk: 0 },
          ],
        }}
      />,
    );
    expect(screen.queryByText("No call durations yet")).not.toBeInTheDocument();
  });
});
