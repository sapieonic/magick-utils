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
vi.mock("@/components/screens/dashboard/StatusDonut", () => ({ StatusDonut: () => null }));
vi.mock("@/components/screens/dashboard/FunnelBars", () => ({ FunnelBars: () => null }));
vi.mock("@/components/screens/dashboard/RankedBars", () => ({ RankedBars: () => null }));
vi.mock("@/components/screens/dashboard/ShortCallCard", () => ({ ShortCallCard: () => null }));
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
