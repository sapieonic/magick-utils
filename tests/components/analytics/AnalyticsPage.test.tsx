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
    LineChart: Pass,
    Line: Pass,
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

  // A refresh that correctly finds nothing new used to look identical to one
  // that silently failed: progress bar to 100%, same numbers, no explanation.
  it("says when a refresh found nothing new upstream", async () => {
    appState.analyzeTargets = ["b1"];
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true, upToDate: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);

    render(<Page />);

    expect(await screen.findByText("No new data upstream")).toBeInTheDocument();
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

describe("Analytics page live/demo separation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    appState.analyzeTargets = ["b1"];
  });

  it("never shows seeded analytics while a live ingest is still running", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    // the job never resolves — this is the window the customer was shown mock data in
    vi.mocked(createIngestJob).mockReturnValue(new Promise(() => {}));
    render(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Conversation/ }));
    expect(screen.queryByText("Payment plan request")).not.toBeInTheDocument();
    expect(screen.queryByText("1,284")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  // Half of the anti-mock fix: a live backend that returns no job means the
  // session lapsed, not "demo mode" — the simulated progress bar would be
  // theatre over no data at all.
  it("surfaces a lapsed session instead of simulating progress on a live backend", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue(null);
    render(<Page />);

    expect(await screen.findByText(/session may have expired/)).toBeInTheDocument();
    expect(screen.getByText("Sync failed")).toBeInTheDocument();
    // no fake progress, no aggregate fetch, and no seeded charts behind it
    expect(screen.queryByText(/Ingesting records/)).not.toBeInTheDocument();
    expect(getAnalytics).not.toHaveBeenCalled();
    expect(screen.queryByText("Payment plan request")).not.toBeInTheDocument();
  });

  it("never unlocks the seeds when the campaign list fails to load", async () => {
    vi.mocked(listCampaigns).mockRejectedValue(new Error("Upstream is unavailable"));
    render(<Page />);

    expect(await screen.findByText("Analytics are unavailable")).toBeInTheDocument();
    expect(screen.getByText("Upstream is unavailable")).toBeInTheDocument();
    // an unknown mode is treated as live: no ingest on seeded ids, no seeds
    expect(createIngestJob).not.toHaveBeenCalled();
    expect(screen.queryByText("Payment plan request")).not.toBeInTheDocument();
    expect(screen.queryByText("1,284")).not.toBeInTheDocument();
  });

  it("drops the previous selection's numbers when the selection changes", async () => {
    const second: Batch = { ...campaign, id: "b2", batchId: "AI-2", name: "Campaign two" };
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign, second], source: "live" });
    vi.mocked(createIngestJob)
      .mockResolvedValueOnce({ jobId: null, total: 0, done: 0, ready: true })
      // the second selection's ingest never settles — the window in which the
      // first campaign's charts could sit under the second campaign's header
      .mockReturnValue(new Promise(() => {}));
    vi.mocked(getAnalytics).mockResolvedValue({ ...aggregates, totalRecords: 4242 });
    const { rerender } = render(<Page />);

    expect(await screen.findByText("4,242")).toBeInTheDocument();
    expect(screen.getByText("Records ingested")).toBeInTheDocument();

    appState.analyzeTargets = ["b2"];
    rerender(<Page />);

    expect(await screen.findByRole("heading", { name: "Campaign two" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("4,242")).not.toBeInTheDocument());
    expect(screen.getByText("Records dispatched")).toBeInTheDocument();
  });

  it("keeps demo mode on the seeded data when the backend is off", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "mock" });
    vi.mocked(createIngestJob).mockResolvedValue(null);
    render(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Conversation/ }));
    expect(await screen.findByText("Payment plan request")).toBeInTheDocument();
  });

  it("labels the header count as dispatched, not as a bare record total", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);
    render(<Page />);

    expect(await screen.findByText("10 records dispatched")).toBeInTheDocument();
  });

  it("does not enqueue a second ingest when Refresh data is double-clicked", async () => {
    vi.mocked(listCampaigns).mockResolvedValue({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);
    render(<Page />);
    expect(await screen.findByText("Up to date")).toBeInTheDocument();

    const refresh = screen.getByRole("button", { name: /Refresh data/i });
    fireEvent.click(refresh);
    fireEvent.click(refresh); // same tick — the disabled flag must already be up

    await waitFor(() => expect(createIngestJob).toHaveBeenCalledWith(["b1"], "ingest", { refresh: true }));
    const refreshRuns = vi.mocked(createIngestJob).mock.calls.filter(([, , options]) => options?.refresh);
    expect(refreshRuns).toHaveLength(1);
  });
});
