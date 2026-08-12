// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  generateInsights: vi.fn(),
  compareInsights: vi.fn(),
  getAnalytics: vi.fn(),
  listCampaigns: vi.fn(),
}));

import { InsightsTab } from "@/components/screens/analytics/InsightsTab";
import { compareInsights, generateInsights, getAnalytics, listCampaigns } from "@/lib/api";
import type { AggregatesDoc } from "@/lib/server/types";
import type { Batch } from "@/lib/types";

const target: Batch = {
  id: "b1", batchId: "b1", name: "Customer batch", channel: "voice", callType: "ai",
  provider: "provider", date: "2026-08-12T00:00:00Z", dayAgo: 0, total: 50,
  breakdown: [{ key: "completed", value: 20 }], successRate: 0.4, spendInr: 100,
  telephonyInr: 60, aiInr: 40, avgDuration: 10, avgTalkTime: 8,
};
const analytics: AggregatesDoc = {
  tenantId: "t1", accountId: "a1", key: "agg-1", batchIds: ["b1"], totalRecords: 50,
  statusMix: [{ key: "completed", value: 20 }], successRate: 0.4, spendInr: 100,
  telephonyInr: 60, aiInr: 40, computedAt: "2026-08-12T00:00:00Z",
};
const baseline: Batch = { ...target, id: "b2", batchId: "b2", name: "Earlier batch", successRate: 0.5 };

describe("InsightsTab — trustworthy failure behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [target], source: "live" });
  });

  it("shows an explicit error and never substitutes the old demo recommendation", async () => {
    vi.mocked(generateInsights).mockRejectedValue(new Error("AI insight generation failed."));
    render(<InsightsTab targets={[target]} currency="inr" batchIds={["b1"]} analytics={analytics} />);

    expect(await screen.findByText("AI insight is unavailable")).toBeInTheDocument();
    expect(screen.getByText("AI insight generation failed.")).toBeInTheDocument();
    expect(screen.queryByText(/11am.?1pm/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/312 calls/i)).not.toBeInTheDocument();
  });

  it("renders only the insight returned by the live API", async () => {
    vi.mocked(generateInsights).mockResolvedValue({
      tenantId: "t1", accountId: "a1", key: "i1", fingerprint: "f1", model: "model",
      narrative: "The actual grounded narrative.", anomalies: [], recommendations: [],
      createdAt: "2026-08-12T00:00:00Z",
    });
    render(<InsightsTab targets={[target]} currency="inr" batchIds={["b1"]} analytics={analytics} />);

    await waitFor(() => expect(screen.getByText("The actual grounded narrative.")).toBeInTheDocument());
    expect(screen.queryByText(/11am.?1pm/i)).not.toBeInTheDocument();
  });

  it("keeps deterministic comparison deltas when the AI narrative fails", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [target, baseline], source: "live" });
    vi.mocked(generateInsights).mockResolvedValue({
      tenantId: "t1", accountId: "a1", key: "i1", fingerprint: "f1", model: "model",
      narrative: "Current insight.", anomalies: [], recommendations: [], createdAt: "2026-08-12T00:00:00Z",
    });
    vi.mocked(getAnalytics).mockResolvedValue({ ...analytics, key: "agg-base", batchIds: ["b2"], totalRecords: 40, successRate: 0.5 });
    vi.mocked(compareInsights).mockRejectedValue(new Error("LLM unavailable"));
    render(<InsightsTab targets={[target]} currency="inr" batchIds={["b1"]} analytics={analytics} />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Choose baseline/i }),
    );

    expect(await screen.findByText("Answer rate")).toBeInTheDocument();
    expect(screen.getByText(/AI comparison narrative is unavailable/i)).toBeInTheDocument();
  });
});
