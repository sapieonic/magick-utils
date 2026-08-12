// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/store", () => ({
  useApp: () => ({
    currency: "inr",
    dateRange: "Last 30 days",
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
  beforeEach(() => vi.clearAllMocks());

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
