// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const setCombineTargets = vi.fn();
vi.mock("@/lib/store", () => ({
  useApp: () => ({
    currency: "inr",
    combineTargets: ["b1", "b2"],
    setCombineTargets,
  }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    listCampaigns: vi.fn(),
    listCampaignsByIds: vi.fn(),
    createIngestJob: vi.fn(),
    getJob: vi.fn(),
    downloadCsv: vi.fn().mockResolvedValue(undefined),
  };
});

import { CombineScreen } from "@/components/screens/combine/CombineScreen";
import { createIngestJob, getJob, listCampaigns, listCampaignsByIds } from "@/lib/api";
import type { Batch } from "@/lib/types";

const batch = (id: string): Batch => ({
  id,
  batchId: id,
  name: `Batch ${id}`,
  channel: "voice",
  callType: "ai",
  provider: "provider",
  date: "2026-08-12T00:00:00Z",
  dayAgo: 0,
  total: 10,
  breakdown: [{ key: "completed", value: 10 }],
  successRate: 1,
  spendInr: 10,
  telephonyInr: 5,
  aiInr: 5,
  avgDuration: 10,
  avgTalkTime: 8,
  ingestStatus: "ready",
});

describe("CombineScreen — completed download flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [batch("b1"), batch("b2")], source: "live" });
    vi.mocked(listCampaignsByIds).mockResolvedValue({ batches: [batch("b1"), batch("b2")], source: "live" });
  });

  // The chip sum is frozen at Generate and, for a batch not yet ingested, is a
  // dispatched CONTACT count — so "Download ready · 20 rows" could promise rows
  // the CSV does not hold. Once preparation finishes the label reads the
  // batches' published record counts instead.
  it("labels a finished merge with the rows the CSV actually holds", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 20, ready: false });
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1", type: "merge", status: "done", total: 20, done: 17,
      retryAt: null, retryCount: 0, error: null, result: { rowCount: 17 },
      createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:01Z",
    });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [{ ...batch("b1"), total: 9 }, { ...batch("b2"), total: 8 }],
      source: "live",
    });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByText(/combined_export_2_batches\.csv · 17 rows/)).toBeInTheDocument();
    expect(listCampaignsByIds).toHaveBeenCalledWith(["b1", "b2"]);
  });

  // The incident: a short batch under a green "Download ready" with nothing to
  // say rows were missing. The label must name the gap.
  it("warns when a selected batch's served revision is known short", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [
        { ...batch("b1"), total: 8038, ingestStatus: "stale",
          shortfall: { listed: 8232, received: 8038, keptPrevious: false, detectedAt: "2026-10-01T00:00:00Z" } },
        { ...batch("b2"), total: 0 },
      ],
      source: "live",
    });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByText(/8,038 rows/)).toBeInTheDocument();
    expect(screen.getByText(/194 fewer than upstream lists/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Upstream returned incomplete data\. The file is missing 194 records/);
  });

  it("says when a batch could not be refreshed and the file holds earlier data", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [
        // The kept revision holds every record upstream lists; only the latest
        // pull was short. Nothing is missing, but the file is not current.
        { ...batch("b1"), total: 8232, ingestStatus: "stale",
          shortfall: { listed: 8232, received: 8038, keptPrevious: true, detectedAt: "2026-10-01T00:00:00Z" } },
        batch("b2"),
      ],
      source: "live",
    });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/1 batch could not be refreshed/);
    expect(screen.queryByText(/fewer than upstream lists/)).not.toBeInTheDocument();
  });

  it("shows no warning for a complete selection", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByText(/combined_export_2_batches\.csv · 20 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/Upstream returned incomplete data/)).not.toBeInTheDocument();
  });

  it("keeps the estimate when a selected batch is not readable yet", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockResolvedValue({
      batches: [{ ...batch("b1"), total: 9 }, { ...batch("b2"), total: 8, ingestStatus: "error" }],
      source: "live",
    });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByRole("button", { name: /Download CSV/i })).toBeInTheDocument();
    await waitFor(() => expect(listCampaignsByIds).toHaveBeenCalled());
    expect(screen.getByText(/combined_export_2_batches\.csv · 20 rows/)).toBeInTheDocument();
  });

  it("keeps the estimate when the batches cannot be re-read", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(listCampaignsByIds).mockRejectedValue(new Error("network down"));
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    await waitFor(() => expect(listCampaignsByIds).toHaveBeenCalled());
    expect(await screen.findByText(/combined_export_2_batches\.csv · 20 rows/)).toBeInTheDocument();
  });

  it("makes an already-ingested selection immediately downloadable", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByRole("button", { name: /Download CSV/i })).toBeInTheDocument();
    expect(screen.getByText(/Live row values are not fabricated for preview/i)).toBeInTheDocument();
  });

  it("keeps the download available after a background preparation job clears its id", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 20, ready: false });
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1",
      type: "merge",
      status: "done",
      total: 20,
      done: 20,
      retryAt: null,
      retryCount: 0,
      error: null,
      result: { rowCount: 20 },
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:01Z",
    });
    render(<CombineScreen />);

    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByRole("button", { name: /Download CSV/i })).toBeInTheDocument();
  });

  it("shows scheduling failures in the build state", async () => {
    vi.mocked(createIngestJob).mockRejectedValue(new Error("network down"));
    render(<CombineScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /Generate & Download/i }));
    expect(await screen.findByText(/Unable to schedule merge/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate & Download/i })).toBeInTheDocument();
  });

  it("restores download-ready after a refresh once preparation finished", async () => {
    sessionStorage.setItem("combinePhase", "done");
    sessionStorage.setItem(
      "combinePrepared",
      JSON.stringify({ batchIds: ["b1", "b2"], columns: ["record_id"], totalRows: 20, batchCount: 2 }),
    );
    render(<CombineScreen />);
    expect(await screen.findByRole("button", { name: /Download CSV/i })).toBeInTheDocument();
    expect(createIngestJob).not.toHaveBeenCalled();
  });

  it("resumes polling a persisted merge job after refresh", async () => {
    sessionStorage.setItem("combineJobId", "job-1");
    sessionStorage.setItem("combinePhase", "working");
    sessionStorage.setItem(
      "combinePrepared",
      JSON.stringify({ batchIds: ["b1", "b2"], columns: ["record_id"], totalRows: 20, batchCount: 2 }),
    );
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1",
      type: "merge",
      status: "running",
      total: 20,
      done: 8,
      retryAt: null,
      retryCount: 0,
      error: null,
      result: null,
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:01Z",
    });
    render(<CombineScreen />);
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByText(/Merging 2 batches/i)).toBeInTheDocument();
    expect(createIngestJob).not.toHaveBeenCalled();
  });

  /** A merge left mid-flight by a page refresh, resumed by polling. */
  function resumeWorkingJob(job: Partial<Record<string, unknown>>) {
    sessionStorage.setItem("combineJobId", "job-1");
    sessionStorage.setItem("combinePhase", "working");
    sessionStorage.setItem(
      "combinePrepared",
      JSON.stringify({ batchIds: ["b1", "b2"], columns: ["record_id"], totalRows: 20, batchCount: 2 }),
    );
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1",
      type: "merge",
      status: "rate_limited",
      total: 20,
      done: 8,
      retryAt: "2026-08-12T12:30:00Z",
      retryCount: 1,
      error: null,
      result: null,
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:01Z",
      ...job,
    } as never);
  }

  it("tells a throttled merge's owner to wait", async () => {
    resumeWorkingJob({ deferReason: "rate_limited" });
    render(<CombineScreen />);
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByText(/Rate limit reached/i)).toBeInTheDocument();
  });

  it("tells a merge paused on an expired sign-in to sign in again", async () => {
    // Both pauses arrive as `rate_limited`. Telling this user to simply wait
    // sends them away from the only thing that rescues the merge: signing back
    // in re-stamps the job's credential.
    resumeWorkingJob({ deferReason: "credential" });
    render(<CombineScreen />);
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByText(/sign-in expired while this merge was running/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rate limit reached/i)).not.toBeInTheDocument();
  });

  it("falls back to the throttling message when the job predates deferReason", async () => {
    // A job enqueued before this field existed, or one polled by an older route
    // build, reports no reason at all — the throttling wording is the safe read.
    resumeWorkingJob({});
    render(<CombineScreen />);
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByText(/Rate limit reached/i)).toBeInTheDocument();
  });

  it("reattaches when working state was saved before the job id", async () => {
    sessionStorage.setItem("combinePhase", "working");
    sessionStorage.setItem(
      "combinePrepared",
      JSON.stringify({ batchIds: ["b1", "b2"], columns: ["record_id"], totalRows: 20, batchCount: 2 }),
    );
    vi.mocked(createIngestJob).mockResolvedValue({
      jobId: "job-9", total: 20, done: 5, ready: false, existing: true,
    });
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-9",
      type: "merge",
      status: "running",
      total: 20,
      done: 5,
      retryAt: null,
      retryCount: 0,
      error: null,
      result: null,
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:01Z",
    });
    render(<CombineScreen />);
    await waitFor(() => expect(createIngestJob).toHaveBeenCalledWith(["b1", "b2"], "merge"));
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-9"));
  });
});
