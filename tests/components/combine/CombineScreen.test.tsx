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
    createIngestJob: vi.fn(),
    getJob: vi.fn(),
    downloadCsv: vi.fn().mockResolvedValue(undefined),
  };
});

import { CombineScreen } from "@/components/screens/combine/CombineScreen";
import { createIngestJob, getJob, listCampaigns } from "@/lib/api";
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
