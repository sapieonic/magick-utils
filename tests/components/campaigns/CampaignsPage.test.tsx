// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// dateRange is what the Topbar dropdown drives; the harness mutates it and
// re-renders, exactly as the real store would.
const store = vi.hoisted(() => ({ dateRange: "Last 30 days" }));
vi.mock("@/lib/store", () => ({
  useApp: () => ({
    currency: "inr",
    dateRange: store.dateRange,
    setCombineTargets: vi.fn(),
    setAnalyzeTargets: vi.fn(),
  }),
}));
vi.mock("@/lib/api", () => ({
  listCampaigns: vi.fn(),
  // DownloadModal pulls these in at module load.
  createIngestJob: vi.fn(),
  downloadCsv: vi.fn(),
  getJob: vi.fn(),
}));

import CampaignsScreen from "@/app/(app)/campaigns/page";
import { listCampaigns } from "@/lib/api";
import type { Batch } from "@/lib/types";

function batch(name: string, dayAgo: number): Batch {
  return {
    id: name, batchId: name, name, channel: "voice", callType: "ai", provider: "provider",
    date: new Date(Date.now() - dayAgo * 86_400_000).toISOString(), dayAgo, total: 10,
    breakdown: [{ key: "completed", value: 10 }], successRate: 1, spendInr: 10,
    telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const RECENT = batch("Recent campaign", 2);
const OLD = batch("Old campaign", 200);

describe("CampaignsScreen date range", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.dateRange = "Last 30 days";
  });

  it("requests the active range and refetches when it changes", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT, OLD], source: "live" });
    const { rerender } = render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Old campaign")).toBeInTheDocument());
    expect(listCampaigns).toHaveBeenCalledWith("Last 30 days");

    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live" });
    store.dateRange = "Last 7 days";
    rerender(<CampaignsScreen />);

    await waitFor(() => expect(screen.queryByText("Old campaign")).not.toBeInTheDocument());
    expect(listCampaigns).toHaveBeenCalledWith("Last 7 days");
    expect(listCampaigns).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Recent campaign")).toBeInTheDocument();
  });

  it("counts and pages the filtered set", async () => {
    const many = Array.from({ length: 12 }, (_, i) => batch(`Campaign ${i}`, i));
    vi.mocked(listCampaigns).mockResolvedValue({ batches: many, source: "live" });
    const { rerender } = render(<CampaignsScreen />);
    // 12 rows over a page size of 8 → showing "1–8", count "12".
    await waitFor(() => expect(screen.getByText("1–8")).toBeInTheDocument());
    expect(screen.getByText("12")).toBeInTheDocument();

    // A narrower range must not strand the user on a page that no longer exists.
    await userEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("9–12")).toBeInTheDocument();

    vi.mocked(listCampaigns).mockResolvedValue({ batches: many.slice(0, 3), source: "live" });
    store.dateRange = "Last 7 days";
    rerender(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("1–3")).toBeInTheDocument());
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("drops an in-flight response that a faster range switch superseded", async () => {
    const slow = deferred<{ batches: Batch[]; source: "live" }>();
    vi.mocked(listCampaigns).mockReturnValueOnce(slow.promise);
    const { rerender } = render(<CampaignsScreen />);

    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live" });
    store.dateRange = "Last 7 days";
    rerender(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Recent campaign")).toBeInTheDocument());

    // The superseded "Last 30 days" request finally lands — it must not render.
    await act(async () => {
      slow.resolve({ batches: [OLD], source: "live" });
      await slow.promise;
    });
    expect(screen.queryByText("Old campaign")).not.toBeInTheDocument();
    expect(screen.getByText("Recent campaign")).toBeInTheDocument();
  });

  it("shows the error state instead of the previous range's rows when a refetch fails", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [OLD], source: "live" });
    const { rerender } = render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Old campaign")).toBeInTheDocument());

    vi.mocked(listCampaigns).mockRejectedValue(new Error("upstream down"));
    store.dateRange = "Last 7 days";
    rerender(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Campaigns are unavailable")).toBeInTheDocument());
    expect(screen.queryByText("Old campaign")).not.toBeInTheDocument();
  });
});
