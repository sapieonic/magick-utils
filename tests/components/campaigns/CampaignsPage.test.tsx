// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// dateRange is what the Topbar dropdown drives; the harness mutates it and
// re-renders, exactly as the real store would.
const store = vi.hoisted(() => ({ dateRange: "Last 30 days", setDateRange: vi.fn() }));
vi.mock("@/lib/store", () => ({
  useApp: () => ({
    currency: "inr",
    dateRange: store.dateRange,
    setDateRange: store.setDateRange,
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
    // Mirror the real store: a range change re-renders the screen with the new value.
    store.setDateRange.mockImplementation((r: string) => {
      store.dateRange = r;
    });
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
    await userEvent.click(screen.getByRole("button", { name: "Page 2" }));
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

  it("coerces a stale stored range to 'All time' instead of asking for it", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live" });
    // dateRange is hydrated from sessionStorage, so it can be anything.
    store.dateRange = "Last decade";
    render(<CampaignsScreen />);
    await waitFor(() => expect(listCampaigns).toHaveBeenCalledWith("All time"));
    expect(listCampaigns).not.toHaveBeenCalledWith("Last decade");
  });

  it("blames the date range in the empty state and clears it with the filters", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [], source: "live" });
    store.dateRange = "Last 7 days";
    render(<CampaignsScreen />);

    await waitFor(() => expect(screen.getByText("No campaigns match your filters")).toBeInTheDocument());
    // The stated cause must be the real one — the range is what emptied the list.
    expect(screen.getByText(/Only campaigns from last 7 days are listed/)).toBeInTheDocument();

    // …and the remedy has to undo it: "Clear filters" used to clear everything
    // except the one filter that was hiding the campaigns.
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(store.setDateRange).toHaveBeenCalledWith("All time");
    expect(store.dateRange).toBe("All time");
  });

  it("says nothing about filters when an unfiltered account is simply empty", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [], source: "live" });
    store.dateRange = "All time";
    render(<CampaignsScreen />);

    await waitFor(() => expect(screen.getByText("No campaigns yet")).toBeInTheDocument());
    expect(screen.queryByText("No campaigns match your filters")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("keeps the filter-bar Clear affordance while only the range is narrowed", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live" });
    store.dateRange = "Last 7 days";
    const { rerender } = render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Recent campaign")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();

    store.dateRange = "All time";
    rerender(<CampaignsScreen />);
    // No filters left → nothing to clear.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument());
  });

  it("says so when the backend could not scan every campaign", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live", truncated: true });
    render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText(/may be missing from this list/)).toBeInTheDocument());
  });

  it("stays silent about truncation when the whole listing was scanned", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live", truncated: false });
    render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Recent campaign")).toBeInTheDocument());
    expect(screen.queryByText(/may be missing from this list/)).not.toBeInTheDocument();
  });

  it("drops selected batches that the new range no longer lists", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT, OLD], source: "live" });
    const { rerender } = render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Old campaign")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Select Old campaign"));
    expect(screen.getByText("AI Call batch")).toBeInTheDocument();

    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live" });
    store.dateRange = "Last 7 days";
    rerender(<CampaignsScreen />);

    // The bulk bar counted rows nobody could see, with the type label gone.
    await waitFor(() => expect(screen.queryByText("AI Call batch")).not.toBeInTheDocument());
    expect(screen.queryByText("Combine into one CSV")).not.toBeInTheDocument();
  });

  it("keeps a selection the new range still lists", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT, OLD], source: "live" });
    const { rerender } = render(<CampaignsScreen />);
    await waitFor(() => expect(screen.getByText("Old campaign")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Select Recent campaign"));
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [RECENT], source: "live" });
    store.dateRange = "Last 7 days";
    rerender(<CampaignsScreen />);

    await waitFor(() => expect(screen.queryByText("Old campaign")).not.toBeInTheDocument());
    expect(screen.getByText("AI Call batch")).toBeInTheDocument();
  });
});

describe("CampaignsScreen pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.dateRange = "All time";
  });

  /** Page buttons only — the prev/next chevrons carry their own aria-labels. */
  function pageButtons() {
    return screen.getAllByRole("button", { name: /^Page \d+$/ });
  }

  // Once the listing stopped stopping at the upstream's first page, an account
  // could reach hundreds of pages. One button each ran the row past the edge of
  // the card, and nothing scrolled, so those pages were simply unreachable.
  it("keeps the control small when there are hundreds of pages", async () => {
    const many = Array.from({ length: 800 }, (_, i) => batch(`c${i}`, i % 20));
    vi.mocked(listCampaigns).mockResolvedValue({ batches: many, source: "live" });

    render(<CampaignsScreen />);

    await waitFor(() => expect(pageButtons().length).toBeGreaterThan(0));
    // 800 campaigns at 8 per page is 100 pages; the control shows a handful.
    expect(pageButtons().length).toBeLessThanOrEqual(7);
    expect(screen.getByText(/of 800/)).toBeInTheDocument();
  });

  it("keeps the first and last page reachable from anywhere in the range", async () => {
    const many = Array.from({ length: 800 }, (_, i) => batch(`c${i}`, i % 20));
    vi.mocked(listCampaigns).mockResolvedValue({ batches: many, source: "live" });

    render(<CampaignsScreen />);
    await waitFor(() => expect(pageButtons().length).toBeGreaterThan(0));

    const labels = () => pageButtons().map((b) => b.textContent);
    expect(labels()).toContain("1");
    expect(labels()).toContain("100");

    await userEvent.click(screen.getByRole("button", { name: "Page 100" }));
    await waitFor(() => expect(labels()).toContain("1"));
    expect(labels()).toContain("100");
  });

  it("still lists every page when a filtered list has only a few", async () => {
    const few = Array.from({ length: 20 }, (_, i) => batch(`c${i}`, i % 5));
    vi.mocked(listCampaigns).mockResolvedValue({ batches: few, source: "live" });

    render(<CampaignsScreen />);

    await waitFor(() => expect(pageButtons().length).toBe(3));
    expect(pageButtons().map((b) => b.textContent)).toEqual(["1", "2", "3"]);
  });
});
