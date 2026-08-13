"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Icon, Spinner, Tabs, TypeBadge, TypeDot, cx } from "@/components/ui";
import { aggregate, fmtNum, selType, typeKey } from "@/lib/data";
import { ApiRequestError, createIngestJob, getAnalytics, getJob, isJobNotFound, jobProgressPercent, listCampaigns } from "@/lib/api";
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

  // live batches — start empty; listCampaigns() supplies mock only when the
  // backend is off. On a live backend mock data never enters this screen.
  const [batches, setBatches] = useState<Batch[]>([]);
  // Gate ingestion until the real campaign list has resolved. Otherwise the
  // effect below fires a live ingest job using seeded mock ids (cmp_1005…),
  // which the worker can't find ("batch … not found").
  const [batchesReady, setBatchesReady] = useState(false);
  const [ingest, setIngest] = useState(0);
  const [ingesting, setIngesting] = useState(true);
  const [analytics, setAnalytics] = useState<AggregatesDoc | null>(null);
  const [live, setLive] = useState(false); // backend is on for this run
  const [ingestError, setIngestError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    listCampaigns()
      .then(({ batches }) => {
        if (alive && batches.length) setBatches(batches);
      })
      .catch((error: unknown) => {
        if (!alive) return;
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
  }, []);

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

  const totalRecords = targets.reduce((a: number, c: Batch) => a + c.total, 0);
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
    refreshRef.current = true;
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
      if (!alive || settled || !pollJobId) return;
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
            setLive(false);
            simulate();
            return;
          }
          setLive(true);
          if (job.ready || !job.jobId) {
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
      if (refresh) {
        setIngest(0);
        setAnalytics(null);
      }
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

  const ingested = Math.round((ingest / 100) * totalRecords);

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
              <span>{fmtNum(totalRecords)} records</span>
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
                  <div className="text-[11px] tabnum text-slate-400 mt-1">
                    {fmtNum(ingested)} / {fmtNum(totalRecords)}
                  </div>
                </div>
              ) : ingestError ? (
                <div className="flex items-center gap-2 text-[13px] font-semibold text-red-600">
                  <Icon name="TriangleAlert" size={16} /> Sync failed
                </div>
              ) : analytics ? (
                <div className="flex items-center gap-2 text-[13px] font-semibold text-emerald-600">
                  <Icon name="CircleCheck" size={16} /> Up to date
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
      {!ingesting && live && ingestError && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50/70 px-4 py-3 text-[13px] text-red-700">
          <Icon name="TriangleAlert" size={15} className="mt-0.5 shrink-0" />
          <span>Ingestion failed: {ingestError}. Try “Refresh data” to retry.</span>
        </div>
      )}
      {!ingesting && live && !ingestError && !analytics && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-700">
          <Icon name="Info" size={15} className="mt-0.5 shrink-0" />
          <span>No analytics available for this selection yet — the batches may have no ingested records. Charts below are illustrative.</span>
        </div>
      )}

      {tab === "overview" && <OverviewTab targets={targets} agg={agg} currency={currency} hasVoice={hasVoice} hasMsg={hasMsg} analytics={analytics} />}
      {tab === "conversation" && <ConversationTab hasVoice={hasVoice} hasMsg={hasMsg} analytics={analytics} />}
      {tab === "cost" && <CostTab targets={targets} currency={currency} analytics={analytics} />}
      {tab === "insights" && (
        <InsightsTab
          key={`${idsKey}:${analytics?.key ?? "pending"}`}
          targets={targets}
          currency={currency}
          batchIds={ids}
          analytics={analytics}
          dataLoading={ingesting}
          dataError={ingestError}
        />
      )}

      {/* Floating toggle — persistent entry point when the panel is closed. */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fade-up fixed bottom-6 right-6 z-30 flex items-center gap-2 rounded-full py-3 pl-4 pr-5 text-[14px] font-bold text-white shadow-[0_8px_24px_-6px_rgba(79,70,229,0.6)] transition-transform hover:scale-[1.03] active:scale-95"
          style={{ background: "var(--brand-grad)" }}
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
