// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/store", () => ({
  useApp: () => ({ currency: "inr", analyzeTargets: ["b1", "missing"] }),
}));
vi.mock("@/lib/api", () => ({
  createIngestJob: vi.fn(),
  getAnalytics: vi.fn(),
  getJob: vi.fn(),
  listCampaigns: vi.fn(),
}));

import Page from "@/app/(app)/analytics/page";
import { createIngestJob, listCampaigns } from "@/lib/api";
import type { Batch } from "@/lib/types";

const campaign: Batch = {
  id: "b1", batchId: "AI-1", name: "Campaign one", channel: "voice", callType: "ai",
  provider: "provider", date: "2026-08-12T00:00:00Z", dayAgo: 0, total: 10,
  breakdown: [{ key: "completed", value: 10 }], successRate: 1, spendInr: 10,
  telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8,
};

describe("Analytics page selection validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not start ingestion for the resolved subset of an incomplete selection", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    render(<Page />);

    expect(await screen.findByText("The saved analysis selection is incomplete")).toBeInTheDocument();
    expect(screen.getByText(/missing/)).toBeInTheDocument();
    expect(createIngestJob).not.toHaveBeenCalled();
  });
});
