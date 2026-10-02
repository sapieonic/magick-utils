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
    listCampaignsByIds: vi.fn(),
  };
});

import Page from "@/app/(app)/analytics/page";
import { createIngestJob, getAnalytics, getJob, listCampaigns, listCampaignsByIds } from "@/lib/api";
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

/** The page resolves a known selection by id and only lists the whole account
 *  when it arrives with none, so both entry points must answer the same way. */
function mockCampaigns(result: { batches: Batch[]; source: "live" | "mock"; truncated?: boolean }) {
  vi.mocked(listCampaigns).mockResolvedValue(result);
  vi.mocked(listCampaignsByIds).mockResolvedValue(result);
}

function failCampaigns(error: Error) {
  vi.mocked(listCampaigns).mockRejectedValue(error);
  vi.mocked(listCampaignsByIds).mockRejectedValue(error);
}

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
    mockCampaigns({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true, upToDate: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);

    render(<Page />);

    expect(await screen.findByText("No new data upstream")).toBeInTheDocument();
  });

  // Resolving a two-batch selection used to page the entire account, and a scan
  // that stopped at its cap dropped those ids from the result — which this
  // screen then reported as "no longer available" for live campaigns.
  it("resolves the selected ids directly instead of listing the account", async () => {
    appState.analyzeTargets = ["b1"];
    mockCampaigns({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);

    render(<Page />);

    await waitFor(() => expect(listCampaignsByIds).toHaveBeenCalledWith(["b1"]));
    expect(listCampaigns).not.toHaveBeenCalled();
  });

  it("falls back to a listing only when it arrives with nothing selected", async () => {
    appState.analyzeTargets = [];
    mockCampaigns({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, ready: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);

    render(<Page />);

    await waitFor(() => expect(listCampaigns).toHaveBeenCalled());
    expect(listCampaignsByIds).not.toHaveBeenCalled();
  });

  // An empty result is now meaningful: the ids were looked up and are gone.
  it("reports every selected id as missing when none of them resolve", async () => {
    appState.analyzeTargets = ["b1", "missing"];
    mockCampaigns({ batches: [], source: "live" });

    render(<Page />);

    expect(await screen.findByText("The saved analysis selection is incomplete")).toBeInTheDocument();
    expect(createIngestJob).not.toHaveBeenCalled();
  });

  it("does not start ingestion for the resolved subset of an incomplete selection", async () => {
    mockCampaigns({ batches: [campaign], source: "live" });
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
    mockCampaigns({ batches: [campaign], source: "live" });
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
    mockCampaigns({ batches: [campaign], source: "live" });
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
    mockCampaigns({ batches: [campaign], source: "live" });
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
    failCampaigns(new Error("Upstream is unavailable"));
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
    mockCampaigns({ batches: [campaign, second], source: "live" });
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
    mockCampaigns({ batches: [campaign], source: "mock" });
    vi.mocked(createIngestJob).mockResolvedValue(null);
    render(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Conversation/ }));
    expect(await screen.findByText("Payment plan request")).toBeInTheDocument();
  });

  it("labels the header count as dispatched, not as a bare record total", async () => {
    mockCampaigns({ batches: [campaign], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    vi.mocked(getAnalytics).mockResolvedValue(aggregates);
    render(<Page />);

    expect(await screen.findByText("10 records dispatched")).toBeInTheDocument();
  });

  // `total` holds the dispatched figure only until a batch is ingested, after
  // which it is the exact record count — so reading it alone made this header
  // quietly stop being "dispatched", and read 0 for the IVR batches that
  // ingested nothing while upstream reported thousands.
  it("reads the dispatched count from sourceTotal, not the ingested total", async () => {
    mockCampaigns({ batches: [{ ...campaign, total: 0, sourceTotal: 3475 }], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    vi.mocked(getAnalytics).mockResolvedValue({ ...aggregates, totalRecords: 0 });
    render(<Page />);

    expect(await screen.findByText("3,475 records dispatched")).toBeInTheDocument();
  });

  // The ingest job's total is the sum of batchDoc.total, so the percentage it
  // reports is a fraction of THAT. Scaling it by the dispatched count mixed two
  // bases and rendered "3,475 / 3,475" for a batch holding 2,233 records —
  // inventing 1,242 records to claim completion over.
  it("shows ingest progress against the job's own denominator, not the dispatched count", async () => {
    mockCampaigns({ batches: [{ ...campaign, total: 2233, sourceTotal: 3475 }], source: "live" });
    vi.mocked(createIngestJob).mockResolvedValue({
      jobId: "job-1", total: 2233, done: 1117, ready: false,
    });
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1", type: "ingest", status: "running", total: 2233, done: 1117,
      retryAt: null, retryCount: 0, error: null, result: null,
      createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:01Z",
    });
    render(<Page />);

    // Both halves: a numerator scaled by the dispatched count would read
    // "1,738 / 2,233" here, which is why the denominator alone is not enough.
    expect(await screen.findByText("1,117 / 2,233 records")).toBeInTheDocument();
    // The header still reports what upstream dispatched.
    expect(screen.getByText("3,475 records dispatched")).toBeInTheDocument();
  });

  it("does not enqueue a second ingest when Refresh data is double-clicked", async () => {
    mockCampaigns({ batches: [campaign], source: "live" });
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

describe("Analytics page incomplete upstream data", () => {
  const job = (patch: Record<string, unknown>) => ({
    jobId: "job-1", type: "ingest" as const, status: "done" as const, total: 10, done: 10,
    retryAt: null, retryCount: 0, error: null, result: null,
    createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:01Z",
    ...patch,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    appState.analyzeTargets = ["b1"];
    mockCampaigns({ batches: [campaign], source: "live" });
    vi.mocked(getAnalytics).mockResolvedValue({ ...aggregates, totalRecords: 8038 });
  });

  // The partial outcome: a job that finished with a warning still renders its
  // charts — and says, rather than "Up to date", that they are short.
  it("renders the aggregate and names the shortfall when the job finished with a warning", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(
      job({
        batchIds: ["b1"],
        warnings: [{
          kind: "incomplete_upstream", batchId: "b1", name: "Campaign one", listed: 8232, received: 8038,
          keptPrevious: false, served: 8038,
          message: 'Upstream returned 8,038 of 8,232 records for "Campaign one"; only those records are included.',
        }],
      }),
    );
    render(<Page />);

    expect(await screen.findByText("8,038")).toBeInTheDocument();
    expect(await screen.findByText("Incomplete upstream data")).toBeInTheDocument();
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument();
    expect(screen.getByText(/Upstream returned 8,038 of 8,232 records for "Campaign one"/)).toBeInTheDocument();
  });

  // No job ran (the batch was already readable), so the listing's own record
  // of the shortfall is what the screen reports.
  it("reports a shortfall the listing carries when no job ran", async () => {
    mockCampaigns({
      batches: [{ ...campaign, shortfall: { listed: 8232, received: 8038, keptPrevious: true, detectedAt: "x" } }],
      source: "live",
    });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    render(<Page />);

    expect(await screen.findByText("Incomplete upstream data")).toBeInTheDocument();
    expect(screen.getByText(/previously loaded data, which holds more records, was kept/)).toBeInTheDocument();
  });

  // A job that re-pulled the batch is authoritative over the listing it was
  // started from: once its pull is whole, the stale listing warning goes.
  it("drops a listing shortfall the job's complete pull has closed", async () => {
    mockCampaigns({
      batches: [{ ...campaign, shortfall: { listed: 8232, received: 8038, keptPrevious: false, detectedAt: "x" } }],
      source: "live",
    });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(job({ batchIds: ["b1"], warnings: [] }));
    render(<Page />);

    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(screen.queryByText(/Upstream returned/)).not.toBeInTheDocument();
  });

  // A failed job used to leave an error over an empty screen, though every
  // revision published before it was still readable.
  it("keeps rendering whatever is readable when the job fails", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(job({ status: "error", error: "upstream 500" }));
    render(<Page />);

    expect(await screen.findByText(/Ingestion failed: upstream 500/)).toBeInTheDocument();
    expect(await screen.findByText("8,038")).toBeInTheDocument();
    expect(getAnalytics).toHaveBeenCalledWith(["b1"]);
    expect(screen.getByText(/The charts below show the data loaded previously/)).toBeInTheDocument();
  });

  it("shows the error alone when nothing is readable", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(job({ status: "error", error: "upstream 500" }));
    const { ApiRequestError } = await import("@/lib/api");
    vi.mocked(getAnalytics).mockRejectedValue(new ApiRequestError("not ingested", 409, "not_ingested"));
    render(<Page />);

    expect(await screen.findByText(/Ingestion failed: upstream 500/)).toBeInTheDocument();
    await waitFor(() => expect(getAnalytics).toHaveBeenCalled());
    expect(screen.queryByText("8,038")).not.toBeInTheDocument();
    expect(screen.queryByText(/data loaded previously/)).not.toBeInTheDocument();
  });

  // A refresh of the same selection keeps the aggregate on screen until the new
  // one lands, so a refresh that fails does not blank a working view.
  it("keeps the previous aggregate across a refresh that fails", async () => {
    vi.mocked(createIngestJob)
      .mockResolvedValueOnce({ jobId: null, total: 0, done: 0, ready: true })
      .mockResolvedValue({ jobId: "job-2", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(job({ jobId: "job-2", status: "error", error: "upstream 500" }));
    vi.mocked(getAnalytics).mockResolvedValueOnce({ ...aggregates, totalRecords: 8038 }).mockRejectedValue(new Error("x"));
    render(<Page />);
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText("8,038")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh data/i }));
    expect(await screen.findByText(/Ingestion failed: upstream 500/)).toBeInTheDocument();
    expect(screen.getByText("8,038")).toBeInTheDocument();
  });
  // A job can record a short pull and then fail on a later batch. The warning
  // still describes data the charts serve, so the error must not swallow it.
  it("surfaces a shortfall warning from a job that then failed", async () => {
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(
      job({
        status: "error", error: "upstream 500", batchIds: ["b1"],
        warnings: [{
          kind: "incomplete_upstream", batchId: "b1", name: "Campaign one", listed: 8232, received: 8038,
          keptPrevious: false, served: 8038,
          message: 'Upstream returned 8,038 of 8,232 records for "Campaign one"; only those records are included.',
        }],
      }),
    );
    render(<Page />);

    expect(await screen.findByText(/Ingestion failed: upstream 500/)).toBeInTheDocument();
    expect(await screen.findByText("Upstream returned incomplete data")).toBeInTheDocument();
    expect(screen.getByText(/Upstream returned 8,038 of 8,232 records for "Campaign one"/)).toBeInTheDocument();
  });

  // ...and a failed job reached only some batches, so the listing still
  // speaks for the ones it did not, even though they are in `batchIds`.
  it("keeps listing shortfalls for batches a failed job did not report on", async () => {
    mockCampaigns({
      batches: [{ ...campaign, shortfall: { listed: 8232, received: 8038, keptPrevious: true, detectedAt: "x" } }],
      source: "live",
    });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: "job-1", total: 10, done: 0, ready: false });
    vi.mocked(getJob).mockResolvedValue(job({ status: "error", error: "upstream 500", batchIds: ["b1"], warnings: [] }));
    render(<Page />);

    expect(await screen.findByText(/Ingestion failed: upstream 500/)).toBeInTheDocument();
    expect(screen.getByText(/previously loaded data, which holds more records, was kept/)).toBeInTheDocument();
  });

  // Two campaigns may share a name, and so a message; keyed by message, React
  // collapsed them into one row (with a duplicate-key warning).
  it("lists one row per batch even when two shortfall messages are identical", async () => {
    appState.analyzeTargets = ["b1", "b2"];
    const shortfall = { listed: 8232, received: 8038, keptPrevious: false, detectedAt: "x" };
    mockCampaigns({
      batches: [{ ...campaign, shortfall }, { ...campaign, id: "b2", batchId: "AI-2", shortfall }],
      source: "live",
    });
    vi.mocked(createIngestJob).mockResolvedValue({ jobId: null, total: 0, done: 0, ready: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Page />);

    expect(await screen.findByText("Upstream returned incomplete data")).toBeInTheDocument();
    expect(screen.getAllByText(/Upstream returned 8,038 of 8,232 records for "Campaign one"/)).toHaveLength(2);
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    consoleError.mockRestore();
  });
});
