// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  createIngestJob: vi.fn(),
  downloadCsv: vi.fn(),
  getJob: vi.fn(),
  listCampaignsByIds: vi.fn(),
}));

import { DownloadModal } from "@/components/screens/campaigns/DownloadModal";
import { createIngestJob, downloadCsv, getJob, listCampaignsByIds } from "@/lib/api";
import type { Batch } from "@/lib/types";

const campaign: Batch = {
  id: "b1", batchId: "AI-1", name: "Campaign one", channel: "voice", callType: "ai",
  provider: "provider", date: "2026-08-12T00:00:00Z", dayAgo: 0, total: 10,
  breakdown: [{ key: "completed", value: 10 }], successRate: 1, spendInr: 10,
  telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8,
};

describe("DownloadModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the read-back has nothing to say, so the listing figure stands.
    vi.mocked(listCampaignsByIds).mockResolvedValue({ batches: [], source: "mock", truncated: false });
  });
  afterEach(() => vi.useRealTimers());

  it("prepares live data before triggering a browser CSV download", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(downloadCsv).mockResolvedValue(undefined);
    render(<DownloadModal campaign={campaign} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Download \d+ columns/i }));
    await userEvent.click(await screen.findByRole("button", { name: /Download AI-1\.csv/i }));

    expect(createIngestJob).toHaveBeenCalledWith(["b1"], "merge");
    expect(downloadCsv).toHaveBeenCalledWith(["b1"], expect.arrayContaining(["record_id", "status"]));
  });

  it("keeps polling when a job lookup temporarily returns no job", async () => {
    vi.useFakeTimers();
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "j1", total: 10, ready: false });
    vi.mocked(getJob)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        jobId: "j1", type: "merge", status: "done", total: 10, done: 10,
        error: null, retryAt: null, retryCount: 0, result: null,
        createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:01Z",
      });
    render(<DownloadModal campaign={campaign} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Download \d+ columns/i }));
    await act(async () => Promise.resolve());
    expect(getJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(screen.getByRole("button", { name: /Download AI-1\.csv/i })).toBeInTheDocument();
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  // The listing's `total` at open is the dispatched CONTACT count for a batch
  // never ingested, so "Your CSV is ready · 3,475 rows" promised rows the file
  // does not hold. Once preparation finishes the row count is read back.
  it("states the rows the prepared CSV actually holds", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [{ ...campaign, total: 7, ingestStatus: "ready" }],
      source: "live",
      truncated: false,
    });
    render(<DownloadModal campaign={campaign} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Download \d+ columns/i }));
    expect(await screen.findByText(/^7 rows/)).toBeInTheDocument();
    expect(listCampaignsByIds).toHaveBeenCalledWith(["b1"]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByTestId("download-row-count")).not.toHaveTextContent(/^10 rows/);
  });

  // Never silent: a short CSV under "Export complete" is the defect this
  // exists to prevent. Same facts Combine states, from the same rule.
  it("names the shortfall when the served revision is short of upstream", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [{
        ...campaign, total: 8038, ingestStatus: "stale",
        shortfall: { listed: 8232, received: 8038, keptPrevious: false, detectedAt: "2026-10-01T00:00:00Z" },
      }],
      source: "live",
      truncated: false,
    });
    render(<DownloadModal campaign={campaign} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Download \d+ columns/i }));
    expect(await screen.findByText(/194 fewer than upstream lists/)).toBeInTheDocument();
    expect(screen.getByTestId("download-row-count")).toHaveTextContent(/^8,038 rows/);
    expect(screen.getByRole("status")).toHaveTextContent(
      /Upstream returned incomplete data\. The file is missing 194 records upstream lists for this campaign\./,
    );
  });

  it("says when the file holds an earlier revision because the latest pull was short", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [{
        ...campaign, total: 8232, ingestStatus: "stale",
        shortfall: { listed: 8232, received: 8038, keptPrevious: true, detectedAt: "2026-10-01T00:00:00Z" },
      }],
      source: "live",
      truncated: false,
    });
    render(<DownloadModal campaign={campaign} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Download \d+ columns/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/could not be refreshed, so the file holds the records loaded earlier/);
    expect(screen.queryByText(/fewer than upstream lists/)).not.toBeInTheDocument();
  });

  // Demo mode, or a read-back that fails: the listing figure stays.
  it.each([
    ["demo mode", () => vi.mocked(listCampaignsByIds).mockResolvedValue({ batches: [campaign], source: "mock", truncated: false })],
    ["a failed read-back", () => vi.mocked(listCampaignsByIds).mockRejectedValue(new Error("boom"))],
    ["a batch not yet readable", () => vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [{ ...campaign, total: 3, ingestStatus: "ingesting" }], source: "live", truncated: false,
    })],
  ])("keeps the listing's estimate on %s", async (_label, arrange) => {
    arrange();
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    render(<DownloadModal campaign={campaign} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Download \d+ columns/i }));
    await screen.findByRole("button", { name: /Download AI-1\.csv/i });
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("download-row-count")).toHaveTextContent(/^10 rows/);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
