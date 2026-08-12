// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  createIngestJob: vi.fn(),
  downloadCsv: vi.fn(),
  getJob: vi.fn(),
}));

import { DownloadModal } from "@/components/screens/campaigns/DownloadModal";
import { createIngestJob, downloadCsv, getJob } from "@/lib/api";
import type { Batch } from "@/lib/types";

const campaign: Batch = {
  id: "b1", batchId: "AI-1", name: "Campaign one", channel: "voice", callType: "ai",
  provider: "provider", date: "2026-08-12T00:00:00Z", dayAgo: 0, total: 10,
  breakdown: [{ key: "completed", value: 10 }], successRate: 1, spendInr: 10,
  telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8,
};

describe("DownloadModal", () => {
  beforeEach(() => vi.clearAllMocks());
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
});
