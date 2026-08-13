// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const appState = { currency: "inr" as const, analyzeTargets: ["b1", "missing"] as string[] };
vi.mock("@/lib/store", () => ({
  useApp: () => appState,
}));

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Svg = ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>;
  const Empty = () => null;
  return {
    ResponsiveContainer: Pass,
    AreaChart: Svg,
    Area: Empty,
    BarChart: Pass,
    Bar: Pass,
    PieChart: Pass,
    Pie: Pass,
    Cell: Pass,
    XAxis: Pass,
    YAxis: Pass,
    CartesianGrid: Pass,
    Tooltip: Pass,
  };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    createIngestJob: vi.fn(),
    getAnalytics: vi.fn(),
    getJob: vi.fn(),
    listCampaigns: vi.fn(),
  };
});

import Page from "@/app/(app)/analytics/page";
import { createIngestJob, getAnalytics, getJob, listCampaigns } from "@/lib/api";
import type { Batch } from "@/lib/types";
import type { AggregatesDoc } from "@/lib/server/types";

const campaign: Batch = {
  id: "b1", batchId: "AI-1", name: "Campaign one", channel: "voice", callType: "ai",
  provider: "provider", date: "2026-08-12T00:00:00Z", dayAgo: 0, total: 10,
  breakdown: [{ key: "completed", value: 10 }], successRate: 1, spendInr: 10,
  telephonyInr: 5, aiInr: 5, avgDuration: 10, avgTalkTime: 8, ingestStatus: "ready",
};

const aggregates: AggregatesDoc = {
  tenantId: "t", accountId: "a", key: "k", batchIds: ["b1"],
  totalRecords: 10, statusMix: [{ key: "completed", value: 10 }], successRate: 1,
  spendInr: 10, telephonyInr: 5, aiInr: 5, computedAt: "2026-08-12T00:00:00Z",
};

describe("Analytics page selection validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    appState.analyzeTargets = ["b1", "missing"];
  });

  it("does not start ingestion for the resolved subset of an incomplete selection", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    render(<Page />);

    expect(await screen.findByText("The saved analysis selection is incomplete")).toBeInTheDocument();
    expect(screen.getByText(/missing/)).toBeInTheDocument();
    expect(createIngestJob).not.toHaveBeenCalled();
  });
});

describe("Analytics page ingest resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    appState.analyzeTargets = ["b1"];
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);
  });

  it("loads analytics without polling when records are already ready", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    render(<Page />);

    await waitFor(() => expect(createIngestJob).toHaveBeenCalledWith(["b1"], "ingest", undefined));
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledWith(["b1"], false));
    expect(getJob).not.toHaveBeenCalled();
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
  });

  it("reattaches to an in-flight ingest and seeds progress", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({
      jobId: "job-1", total: 10, done: 4, ready: false, existing: true,
    });
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1", type: "ingest", status: "running", total: 10, done: 4,
      retryAt: null, retryCount: 0, error: null, result: null,
      createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:01Z",
    });
    render(<Page />);

    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-1"));
    expect(await screen.findByText(/Ingesting records/)).toBeInTheDocument();
    expect(getAnalytics).not.toHaveBeenCalled();
  });

  it("passes refresh:true when Refresh data is clicked", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    render(<Page />);
    expect(await screen.findByText("Up to date")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh data/i }));
    await waitFor(() => expect(createIngestJob).toHaveBeenCalledWith(["b1"], "ingest", { refresh: true }));
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledWith(["b1"], true));
  });

  it("restarts polling after a persisted job id disappears", async () => {
    sessionStorage.setItem("mu_analytics_job_v1", JSON.stringify({ jobId: "stale-job", idsKey: "b1" }));
    const { ApiRequestError } = await import("@/lib/api");
    vi.mocked(getJob)
      .mockRejectedValueOnce(new ApiRequestError("not found", 404, "not_found"))
      .mockResolvedValue({
        jobId: "job-2", type: "ingest", status: "running", total: 10, done: 3,
        retryAt: null, retryCount: 0, error: null, result: null,
        createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:01Z",
      });
    vi.mocked(createIngestJob).mockResolvedValue({
      jobId: "job-2", total: 10, done: 3, ready: false, existing: true,
    });
    render(<Page />);

    await waitFor(() => expect(getJob).toHaveBeenCalledWith("stale-job"));
    await waitFor(() => expect(getJob).toHaveBeenCalledWith("job-2"));
    expect(getAnalytics).not.toHaveBeenCalled();
    expect(await screen.findByText(/Ingesting records/)).toBeInTheDocument();
  });
});
