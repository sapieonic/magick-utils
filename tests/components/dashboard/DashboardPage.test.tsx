// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const app = vi.hoisted(() => ({ dateRange: "Last 30 days" as string }));
vi.mock("@/lib/store", () => ({
  useApp: () => ({
    currency: "inr",
    dateRange: app.dateRange,
    setAnalyzeTargets: vi.fn(),
    user: { name: "Test User", email: "test@example.com" },
  }),
}));
vi.mock("@/lib/api", () => ({
  getDashboardVolume: vi.fn(),
  listCampaigns: vi.fn(),
}));
vi.mock("@/components/screens/dashboard/Legend", () => ({ Legend: () => null }));
vi.mock("@/components/screens/dashboard/VolumeChart", () => ({ VolumeChart: () => null }));
// Recorded rather than rendered: these two are what the customer reported as
// frozen, and what matters is the data the screen hands them per range.
const donutProps = vi.hoisted(() => [] as Array<{ data: Array<{ key: string; value: number }> }>);
const shortCallProps = vi.hoisted(() => [] as Array<{ stats: { connectedWithDuration: number; shortRate: number } | null }>);
vi.mock("@/components/screens/dashboard/StatusDonut", () => ({
  StatusDonut: (props: { data: Array<{ key: string; value: number }> }) => {
    donutProps.push(props);
    return null;
  },
}));
vi.mock("@/components/screens/dashboard/FunnelBars", () => ({ FunnelBars: () => null }));
vi.mock("@/components/screens/dashboard/RankedBars", () => ({ RankedBars: () => null }));
vi.mock("@/components/screens/dashboard/ShortCallCard", () => ({
  ShortCallCard: (props: { stats: { connectedWithDuration: number; shortRate: number } | null }) => {
    shortCallProps.push(props);
    return null;
  },
}));
vi.mock("@/components/screens/dashboard/IvrDropoffCard", () => ({ IvrDropoffCard: () => null }));

import DashboardScreen from "@/app/(app)/dashboard/page";
import { getDashboardVolume, listCampaigns } from "@/lib/api";
import type { Batch } from "@/lib/types";

const campaign: Batch = {
  id: "b1", batchId: "AI-1", name: "Campaign one", channel: "voice", callType: "ai",
  provider: "provider", date: new Date().toISOString(), dayAgo: 0, total: 1984,
  breakdown: [{ key: "completed", value: 250 }, { key: "busy", value: 1734 }],
  successRate: 250 / 1984, spendInr: 10,
  telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8,
};

describe("DashboardScreen campaign volume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    app.dateRange = "Last 30 days";
  });

  // The campaigns listing caps how many upstream jobs it scans, so filtering
  // client-side from an unfiltered pull silently truncated long ranges.
  it("asks for the selected range rather than filtering a capped pull", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(getDashboardVolume).mockResolvedValue(null);
    render(<DashboardScreen />);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledWith("Last 30 days"));
  });

  it("shows campaign-list call volume without waiting on ingested records", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(getDashboardVolume).mockRejectedValue(new Error("dashboard unavailable"));
    render(<DashboardScreen />);

    await waitFor(() => {
      const card = screen.getByText("Total calls").closest("div.rounded-2xl");
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText("2.0K")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText(/1,984/)).toBeInTheDocument();
    });
    expect(screen.queryByText("Daily activity is temporarily unavailable. No estimated values are shown."))
      .not.toBeInTheDocument();
    expect(screen.getByText("Short-call activity is temporarily unavailable. No estimated values are shown."))
      .toBeInTheDocument();
  });

  it("shows zero campaign volume when the campaign list fails", async () => {
    vi.mocked(listCampaigns).mockRejectedValue(new Error("campaigns unavailable"));
    vi.mocked(getDashboardVolume).mockRejectedValue(new Error("dashboard unavailable"));
    render(<DashboardScreen />);

    await waitFor(() => {
      const card = screen.getByText("Total calls").closest("div.rounded-2xl");
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText("0")).toBeInTheDocument();
    });
  });
});

describe("DashboardScreen range fallback and truncation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    app.dateRange = "Last 30 days";
  });

  // A range this build does not recognise — a sessionStorage value left by an
  // older one — must widen, not narrow. Falling back to a 30-day window hid
  // months of campaigns, which is the report this screen exists to have fixed.
  it("widens an unrecognised range to All time rather than 30 days", async () => {
    app.dateRange = "Last 90 days (removed)";
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(getDashboardVolume).mockResolvedValue(null);
    render(<DashboardScreen />);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledWith("All time"));
    await waitFor(() => expect(getDashboardVolume).toHaveBeenCalledWith("All time"));
  });

  it("labels the stats when the listing stopped at its scan cap", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live", truncated: true });
    vi.mocked(getDashboardVolume).mockResolvedValue(null);
    render(<DashboardScreen />);
    await waitFor(() =>
      expect(screen.getByText(/more campaigns than one listing can scan/)).toBeInTheDocument(),
    );
  });

  it("says nothing about scanning when the whole listing was read", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live", truncated: false });
    vi.mocked(getDashboardVolume).mockResolvedValue(null);
    render(<DashboardScreen />);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalled());
    expect(screen.queryByText(/more campaigns than one listing can scan/)).not.toBeInTheDocument();
  });
});

// Reported as: "the values in the Short calls & hang-ups and Voice connect mix
// widgets are not updating when filters are changed with days". With the backend
// off there are no records for the range to narrow, and the seed behind these
// panels was a fixed constant — so they were the only things on the screen that
// did not answer the date filter.
describe("DashboardScreen demo-mode date filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    donutProps.length = 0;
    shortCallProps.length = 0;
    app.dateRange = "Last 30 days";
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "mock" });
    vi.mocked(getDashboardVolume).mockResolvedValue(null);
  });

  async function renderAt(range: string) {
    app.dateRange = range;
    donutProps.length = 0;
    shortCallProps.length = 0;
    const view = render(<DashboardScreen />);
    await waitFor(() => expect(shortCallProps.at(-1)?.stats).toBeTruthy());
    const result = {
      connected: shortCallProps.at(-1)!.stats!.connectedWithDuration,
      shortRate: shortCallProps.at(-1)!.stats!.shortRate,
      voiceMix: donutProps.at(-1)?.data.reduce((sum, s) => sum + s.value, 0) ?? 0,
    };
    view.unmount();
    return result;
  }

  it("moves Short calls & hang-ups when the range changes", async () => {
    const week = await renderAt("Last 7 days");
    const month = await renderAt("Last 30 days");
    const quarter = await renderAt("Last 90 days");

    expect(week.connected).toBeGreaterThan(0);
    expect(week.connected).toBeLessThan(month.connected);
    expect(month.connected).toBeLessThan(quarter.connected);
    // The rate deliberately holds: the seed describes how calls behave, which
    // does not depend on the width of the window. What the customer sees move is
    // the counts and the histogram underneath it.
    expect(week.shortRate).toBeCloseTo(month.shortRate, 4);
  });

  // The first attempt at un-freezing these derived the prior window from the
  // screen's own campaign list — already narrowed to the current range — so it
  // matched nothing and removed all five badges instead of making them move.
  it("shows trend badges against a real prior period", async () => {
    app.dateRange = "Last 7 days";
    render(<DashboardScreen />);
    await waitFor(() => expect(screen.getByText("Total calls")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText(/^\d+%$/).length).toBeGreaterThan(0));
  });

  it("moves Voice connect mix when the range changes", async () => {
    const week = await renderAt("Last 7 days");
    const quarter = await renderAt("Last 90 days");
    expect(week.voiceMix).toBeGreaterThan(0);
    expect(week.voiceMix).toBeLessThan(quarter.voiceMix);
  });
});
