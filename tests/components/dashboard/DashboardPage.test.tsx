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
  provider: "provider", date: new Date().toISOString(), dayAgo: 0, total: 10,
  breakdown: [{ key: "completed", value: 10 }], successRate: 1, spendInr: 10,
  telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8,
};

describe("DashboardScreen live-data failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows activity metrics as unavailable instead of zero", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(getDashboardVolume).mockRejectedValue(new Error("dashboard unavailable"));
    render(<DashboardScreen />);

    await waitFor(() => {
      expect(screen.getByText("Daily activity is temporarily unavailable. No estimated values are shown."))
        .toBeInTheDocument();
      expect(screen.getByText("Voice connect mix is temporarily unavailable. No estimated values are shown."))
        .toBeInTheDocument();
      expect(screen.getByText("Message delivery is temporarily unavailable. No estimated values are shown."))
        .toBeInTheDocument();
      expect(screen.getByText("Outcomes are temporarily unavailable. No estimated values are shown."))
        .toBeInTheDocument();
      expect(screen.getByText("Short-call activity is temporarily unavailable. No estimated values are shown."))
        .toBeInTheDocument();
      expect(screen.getByText("IVR drop-off is temporarily unavailable. No estimated values are shown."))
        .toBeInTheDocument();
    });

    for (const label of ["Total calls", "Total messages", "Success / answer rate", "Total spend"]) {
      const card = screen.getByText(label).closest("div.rounded-2xl");
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText("—")).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText("Activity data temporarily unavailable.")).toBeInTheDocument();
    }
  });
});
