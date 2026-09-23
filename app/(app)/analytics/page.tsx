"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Icon, Spinner, Tabs, TypeBadge, TypeDot, cx } from "@/components/ui";
import { aggregate, fmtNum, selType, typeKey } from "@/lib/data";
import {
  ApiRequestError,
  createIngestJob,
  getAnalytics,
  getJob,
  isJobNotFound,
  jobProgressPercent,
  listCampaigns,
  listCampaignsByIds,
} from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Batch, TypeKey } from "@/lib/types";
import type { AggregatesDoc } from "@/lib/server/types";
import { ChatPanel } from "@/components/screens/analytics/ChatPanel";
import { ConversationTab } from "@/components/screens/analytics/ConversationTab";
import { CostTab } from "@/components/screens/analytics/CostTab";
import { InsightsTab } from "@/components/screens/analytics/InsightsTab";
import { OverviewTab } from "@/components/screens/analytics/OverviewTab";

const ANALYTICS_JOB_KEY = "mu_analytics_job_v1";

function readAnalyticsJob(idsKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(ANALYTICS_JOB_KEY) ?? "null") as { jobId?: string; idsKey?: string } | null;
    if (parsed?.idsKey === idsKey && parsed.jobId) return parsed.jobId;
  } catch {
    // ignore malformed resume state
  }
  return null;
}

function writeAnalyticsJob(idsKey: string, jobId: string | null) {
  if (typeof window === "undefined") return;
  if (jobId) {
    sessionStorage.setItem(ANALYTICS_JOB_KEY, JSON.stringify({ jobId, idsKey }));
    return;
  }
  sessionStorage.removeItem(ANALYTICS_JOB_KEY);
}

export default function Page() {
  const router = useRouter();
  const { currency, analyzeTargets } = useApp();

  // live batches — start empty; the data seam supplies mock only when the
  // backend is off. On a live backend mock data never enters this screen.
  const [batches, setBatches] = useState<Batch[]>([]);
  // Gate ingestion until the real campaign list has resolved. Otherwise the
  // effect below fires a live ingest job using seeded mock ids (cmp_1005…),
  // which the worker can't find ("batch … not found").
  const [batchesReady, setBatchesReady] = useState(false);
  const [ingest, setIngest] = useState(0);
  const [ingesting, setIngesting] = useState(true);
  const [analytics, setAnalytics] = useState<AggregatesDoc | null>(null);
  // null until we know which mode this run is in. `listCampaigns` reports it
  // (its `source` comes from backendStatus), so the flag is set before the
  // first tab renders instead of after the ingest job resolves. Only a
  // positively-known "mock" source unlocks the seeded demo charts: an unknown
  // mode must never show a customer fabricated numbers.
  const [live, setLive] = useState<boolean | null>(null);
  const liveRef = useRef<boolean | null>(null);
  const demo = live === false;
  const [ingestError, setIngestError] = useState<string | null>(null);
  // Set when a refresh checked upstream and found nothing new. Distinguishes
  // "your data is current" from a refresh that quietly did nothing — the
  // ambiguity the customer read as the numbers being unreliable.
  const [upToDate, setUpToDate] = useState(false);
  // `analyzeTargets` is set by whichever screen sent the customer here, so the
  // ids are known before this runs and only their names and totals are missing.
  // Resolve exactly those: listing the whole account to find a handful of them
  // paged thousands of unrelated jobs, and a scan that hit its cap dropped the
  // selected ids from the result — which this screen then reported as "no
  // longer available" for campaigns that were never gone. Only an arrival with
  // no selection at all still needs a listing, to pick a sensible default.
  const selectedIds = analyzeTargets ?? [];
  const selectedKey = selectedIds.join(",");
  useEffect(() => {
    let alive = true;
    const ids = selectedKey ? selectedKey.split(",") : [];
    (ids.length ? listCampaignsByIds(ids) : listCampaigns())
      .then(({ batches, source }) => {
        if (!alive) return;
        liveRef.current = source === "live";
        setLive(liveRef.current);
        // Applied even when empty: an id that resolved to nothing really is
        // gone, and `missingTargetIds` below is what tells the customer so.
        setBatches(batches);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        liveRef.current = true;
        setLive(true);
        setIngestError(error instanceof Error ? error.message : "Unable to load campaign batches.");
        setIngesting(false);
      })
      .finally(() => {
        if (alive) setBatchesReady(true);
      });
    return () => {
      alive = false;
    };
  }, [selectedKey]);

  const targets = useMemo<Batch[]>(() => {
    if (!batches.length) return [];
    if (analyzeTargets && analyzeTargets.length) {
      return analyzeTargets
        .map((id) => batches.find((campaign: Batch) => campaign.id === id))
        .filter((campaign): campaign is Batch => Boolean(campaign));
    }
    const fallback = batches.filter((c: Batch) => selType(c) === "ai")[0] || batches[0];
    return [fallback];
  }, [analyzeTargets, batches]);

  const missingTargetIds = useMemo(
    () => (analyzeTargets ?? []).filter((id) => !batches.some((batch) => batch.id === id)),
    [analyzeTargets, batches],
  );

  const ids = useMemo(() => targets.map((t: Batch) => t.id), [targets]);
  const idsKey = ids.join(",");

  // The dispatched contact count, for the header that says so.
  // `total` is only a stand-in for batches that predate `sourceTotal` (and for
  // seeded demo ones): it holds the dispatched figure until a batch is
  // ingested, and the exact record count afterwards — so reading it alone made
  // this silently switch from "dispatched" to "ingested" the moment a campaign
  // finished ingesting, and show 0 for one that ingested nothing.
  const totalRecords = targets.reduce((a: number, c: Batch) => a + (c.sourceTotal ?? c.total), 0);
  // The ingest job's own denominator. `/api/ingest` builds `job.total` by summing
  // `batchDoc.total`, so the percentage it reports is a fraction of THAT, and
  // scaling it by `totalRecords` above would mix two bases: a batch with 2,233
  // records and 3,475 dispatched reads "3,475 / 3,475" at 100%, inventing 1,242
  // records to claim completion over. Kept separate rather than folded into one
  // figure because the progress line and the header are asking different
  // questions — how far through the work we are, and how many contacts went out.
  const ingestDenominator = targets.reduce((a: number, c: Batch) => a + c.total, 0);
  const hasVoice = targets.some((t: Batch) => t.channel === "voice");
  const hasMsg = targets.some((t: Batch) => t.channel !== "voice");

  const [tab, setTab] = useState("overview");
  // Toggleable AI chat sidebar. Starts closed (a floating "Ask AI" button and a
  // header button surface it); docks beside content on xl, overlays below.
  const [chatOpen, setChatOpen] = useState(false);

  // ingestion job
  const [runToken, setRunToken] = useState(0); // bumped by "Refresh data"
  const refreshRef = useRef(false);
  const runIngest = () => {
    // The button is disabled while `ingesting`, but the effect only raised that
    // flag inside a queueMicrotask — long enough for a double-click to enqueue
    // two ingest jobs. Flip it here, synchronously, before the run is queued.
    if (ingesting) return;
    refreshRef.current = true;
    setIngesting(true);
    setRunToken((n: number) => n + 1);
  };

  // Real ingestion: reattach to an in-flight job, skip a pull when records are
  // already ready, and only enqueue a new ingest on first load or Refresh data.
  useEffect(() => {
    if (!ids.length || !batchesReady || missingTargetIds.length > 0) return;
    let alive = true;
    let settled = false;
    let simIv: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = refreshRef.current;
    refreshRef.current = false;
    let pollJobId = refresh ? null : readAnalyticsJob(idsKey);
    let polling = false;

    const fail = (error: unknown) => {
      if (!alive || settled) return;
      settled = true;
      writeAnalyticsJob(idsKey, null);
      setIngestError(error instanceof Error ? error.message : "Unable to prepare analytics. Please try again.");
      setIngesting(false);
    };

    const finish = async () => {
      if (!alive || settled) return;
      settled = true;
      writeAnalyticsJob(idsKey, null);
      try {
        const agg = await getAnalytics(ids, refresh);
        if (!alive) return;
        setAnalytics(agg);
        setIngest(100);
        setTimeout(() => alive && setIngesting(false), 400);
      } catch (error) {
        settled = false;
        fail(error);
      }
    };

    const simulate = () => {
      simIv = setInterval(() => {
        setIngest((p: number) => {
          const next = p + Math.random() * 9 + 4;
          if (next >= 100) {
            if (simIv) clearInterval(simIv);
            setTimeout(() => alive && setIngesting(false), 400);
            return 100;
          }
          return next;
        });
      }, 200);
    };

    const poll = async () => {
      if (!alive || settled) return;
      if (!pollJobId) {
        polling = false;
        return;
      }
      let delay = 1000;
      try {
        const job = await getJob(pollJobId);
        if (!alive || settled) return;
        if (job) {
          setIngestError(null);
          setIngest(jobProgressPercent(job.done, job.total || 1, job.status));
          if (job.status === "done") {
            await finish();
            return;
          }
          if (job.status === "error") {
            writeAnalyticsJob(idsKey, null);
            setIngestError(job.error || "Ingestion failed");
            setIngest(100);
            setTimeout(() => alive && setIngesting(false), 400);
            settled = true;
            return;
          }
          if (job.status === "rate_limited" && job.retryAt) {
            const untilRetry = Date.parse(job.retryAt) - Date.now();
            delay = Number.isFinite(untilRetry) ? Math.max(1000, Math.min(30_000, untilRetry)) : 3000;
          }
        } else {
          delay = 2000;
        }
      } catch (error) {
        if (isJobNotFound(error)) {
          // The loop is no longer scheduled. Clear the flag so startPolling
          // after reattach actually restarts poll() instead of freezing.
          polling = false;
          pollJobId = null;
          writeAnalyticsJob(idsKey, null);
          attach();
          return;
        }
        setIngestError(error instanceof ApiRequestError ? error.message : "Unable to refresh progress. Retrying automatically…");
        delay = 3000;
      }
      if (alive && !settled && pollJobId) timer = setTimeout(() => void poll(), delay);
    };

    const startPolling = (jobId: string, done = 0, total = 1) => {
      pollJobId = jobId;
      writeAnalyticsJob(idsKey, jobId);
      setIngest(jobProgressPercent(done, total || 1));
      if (!polling) {
        polling = true;
        void poll();
      }
    };

    const attach = () => {
      createIngestJob(ids, "ingest", refresh ? { refresh: true } : undefined)
        .then((job) => {
          if (!alive || settled) return;
          if (!job) {
            // No job only means "backend off" in demo mode. On a live backend
            // it is a lapsed session (the client is already redirecting) — the
            // simulated progress bar would be theatre over no data at all.
            if (liveRef.current === false) {
              setLive(false);
              simulate();
              return;
            }
            fail(new Error("Ingestion could not be started — your session may have expired."));
            return;
          }
          liveRef.current = true;
          setLive(true);
          if (job.ready || !job.jobId) {
            if (job.upToDate) setUpToDate(true);
            void finish();
            return;
          }
          startPolling(job.jobId, job.done ?? 0, job.total || 1);
        })
        .catch((error: unknown) => {
          if (pollJobId && polling) {
            setIngestError("Unable to schedule ingestion. Retrying against the in-progress job…");
            return;
          }
          fail(error);
        });
    };

    // Defer the reset so the effect only coordinates the external ingestion
    // process; this also lets a rapid dependency change cancel the stale run.
    queueMicrotask(() => {
      if (!alive) return;
      setIngesting(true);
      setIngestError(null);
      setUpToDate(false);
      // Drop the previous aggregate on every re-run, not only on a refresh: a
      // selection change must never leave the old campaign's charts rendered
      // under the new campaign's header.
      setAnalytics(null);
      if (refresh) setIngest(0);
    });

    if (pollJobId) {
      polling = true;
      void poll();
    }
    attach();

    return () => {
      alive = false;
      if (simIv) clearInterval(simIv);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, runToken, batchesReady]);

  const ingested = Math.round((ingest / 100) * ingestDenominator);

  const tabs = [
    { value: "overview", label: "Overview", icon: "LayoutDashboard" },
    { value: "conversation", label: hasVoice ? "Conversation" : "Engagement", icon: "MessagesSquare" },
    { value: "cost", label: "Cost", icon: "Wallet" },
    { value: "insights", label: "AI Insights", icon: "Sparkles" },
  ];

  const agg = useMemo(() => aggregate(targets), [targets]);

  // Until the real campaign list resolves, show a loading state rather than
  // rendering anything derived from an empty/seed dataset.
  if (!batchesReady) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
        <Card className="flex items-center justify-center gap-2.5 py-20 text-sm font-semibold text-slate-500">
          <Spinner size={16} /> Loading analytics…
        </Card>
      </div>
    );
  }

  if (batches.length === 0 && ingestError) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
        <Card>
          <div className="p-8 text-center">
            <Icon name="TriangleAlert" size={28} className="mx-auto mb-3 text-red-600" />
            <h2 className="text-lg font-bold text-slate-900">Analytics are unavailable</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">{ingestError}</p>
            <Button className="mt-5" icon="ArrowLeft" onClick={() => router.push("/campaigns")}>Return to Campaigns</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (batches.length === 0 && missingTargetIds.length === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
        <Card>
          <div className="p-8 text-center">
            <Icon name="ChartColumnBig" size={28} className="mx-auto mb-3 text-slate-400" />
            <h2 className="text-lg font-bold text-slate-900">No campaigns are available to analyze</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">Create or load a campaign batch, then return here to analyze its records.</p>
            <Button className="mt-5" icon="ArrowLeft" onClick={() => router.push("/campaigns")}>Return to Campaigns</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (missingTargetIds.length > 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
        <Card>
          <div className="p-8 text-center">
            <Icon name="TriangleAlert" size={28} className="mx-auto mb-3 text-amber-600" />
            <h2 className="text-lg font-bold text-slate-900">The saved analysis selection is incomplete</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">
              These selected batches are no longer available: {missingTargetIds.join(", ")}. Nothing has been silently omitted.
            </p>
            <Button className="mt-5" icon="ArrowLeft" onClick={() => router.push("/campaigns")}>Return to Campaigns</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "mx-auto max-w-[1400px] px-4 sm:px-6 py-6 pb-10 transition-[padding] duration-300 ease-out",
        // On xl+ the chat docks beside the content, so reflow to avoid overlap.
        chatOpen && "xl:pr-[416px]",
      )}
    >
      {/* header */}
      <Card className="p-5 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <button onClick={() => router.push("/campaigns")} className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-400 hover:text-slate-600 mb-2">
              <Icon name="ArrowLeft" size={14} /> Campaigns
            </button>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-[20px] font-extrabold tracking-tight text-slate-900">{targets.length === 1 ? targets[0].name : `${targets.length} campaigns`}</h2>
              {targets.length === 1 ? (
                <TypeBadge tkey={typeKey(targets[0])} size="sm" />
              ) : (
                <div className="flex gap-1">
                  {Array.from(new Set(targets.map(typeKey))).map((tk: TypeKey) => (
                    <TypeDot key={tk} tkey={tk} size={24} />
                  ))}
                </div>
              )}
            </div>
            <div className="text-[13px] text-slate-400 mt-1.5 flex items-center gap-2 flex-wrap">
              <span className="font-mono">{targets.map((t: Batch) => t.batchId).join(", ").slice(0, 60)}</span>
              <span>·</span>
              {/* The bulk job's dispatched contact count. Deliberately NOT the
                  same number as Overview's "Records ingested" — these two
                  legitimately differ, so each says which one it is. */}
              <span title="Contacts dispatched by the bulk job, as reported upstream">{fmtNum(totalRecords)} records dispatched</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* ingestion status */}
            <div className="hidden md:flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 min-w-[230px]">
              {ingesting ? (
                <div className="w-full">
                  <div className="flex items-center justify-between text-[12px] mb-1.5">
                    <span className="font-semibold text-slate-600 flex items-center gap-1.5">
                      <Spinner size={12} /> Ingesting records…
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: ingest + "%", background: "var(--accent)" }} />
                  </div>
                  {/* Both figures are the ingest job's own denominator, never the
                      dispatched count above: they have to share a base or the
                      ratio is fiction. Labelled "records" rather than
                      "dispatched" because on a refresh this counts the records
                      the job is re-pulling, not contacts that went out. */}
                  <div className="text-[11px] tabnum text-slate-400 mt-1" title="Estimated progress against the records this job is pulling">
                    {fmtNum(ingested)} / {fmtNum(ingestDenominator)} records
                  </div>
                </div>
              ) : ingestError ? (
                <div className="flex items-center gap-2 text-[13px] font-semibold text-red-600">
                  <Icon name="TriangleAlert" size={16} /> Sync failed
                </div>
              ) : analytics ? (
                <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-600">
                  <Icon name="CircleCheck" size={16} />
                  {upToDate ? "No new data upstream" : "Up to date"}
                </div>
              ) : <div className="text-[13px] font-semibold text-amber-600">No analytics available</div>}
            </div>
            <Button variant="secondary" icon="RefreshCw" onClick={runIngest} disabled={ingesting}>
              Refresh data
            </Button>
            <Button variant={chatOpen ? "soft" : "primary"} icon="Sparkles" onClick={() => setChatOpen((o: boolean) => !o)}>
              Ask AI
            </Button>
          </div>
        </div>
      </Card>

      <div className="mb-5">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
      </div>

      {/* live-data notices: surface ingest failure / no-data instead of silently
          rendering demo data on a live backend */}
      {!ingesting && !demo && ingestError && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-[13px] text-red-700">
          <Icon name="TriangleAlert" size={15} className="mt-0.5 shrink-0" />
          <span>Ingestion failed: {ingestError}. Try “Refresh data” to retry.</span>
        </div>
      )}
      {!ingesting && !demo && !ingestError && !analytics && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-700">
          <Icon name="Info" size={15} className="mt-0.5 shrink-0" />
          <span>No analytics available for this selection yet — the batches may have no ingested records. The charts below stay empty rather than showing sample data.</span>
        </div>
      )}

      {/* `demo` unlocks the seeded charts in lib/data.ts and is true only when
          the backend is off; `loading` keeps "still pulling" distinct from
          "loaded and genuinely empty". */}
      {tab === "overview" && <OverviewTab targets={targets} agg={agg} currency={currency} hasVoice={hasVoice} analytics={analytics} demo={demo} loading={ingesting} />}
      {tab === "conversation" && <ConversationTab hasVoice={hasVoice} hasMsg={hasMsg} analytics={analytics} demo={demo} loading={ingesting} />}
      {tab === "cost" && <CostTab targets={targets} currency={currency} analytics={analytics} demo={demo} loading={ingesting} />}
      {tab === "insights" && (
        <InsightsTab
          key={`${idsKey}:${analytics?.key ?? "pending"}`}
          targets={targets}
          currency={currency}
          batchIds={ids}
          analytics={analytics}
          dataLoading={ingesting}
          dataError={ingestError}
          demo={demo}
        />
      )}

      {/* Floating toggle — persistent entry point when the panel is closed. */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fade-up fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full py-3 pl-4 pr-5 text-[14px] font-bold text-white transition-transform hover:scale-[1.03] active:scale-95"
          style={{ background: "var(--cta-bg)", boxShadow: "var(--shadow-accent)" }}
          title="Ask AI about this campaign"
        >
          <Icon name="Sparkles" size={18} />
          Ask AI
        </button>
      )}

      {/* Toggleable AI chat sidebar — docks on xl, overlays as a drawer below. */}
      <ChatPanel targets={targets} batchIds={ids} open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}
