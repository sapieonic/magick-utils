"use client";
// Combine CSV — combined export builder (chips -> column picker -> preview -> job).
// Ported from the design's screens-combine.jsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  Button,
  Card,
  Dropdown,
  EmptyState,
  Icon,
  JobProgress,
  Spinner,
  TypeBadge,
  TypeDot,
} from "@/components/ui";
import {
  SEL_LABEL,
  buildPreviewRows,
  fmtMoney,
  fmtNum,
  selType,
  typeKey,
} from "@/lib/data";
import { createIngestJob, downloadCsv, getJob, isJobNotFound, jobProgressPercent, listCampaigns } from "@/lib/api";
import { useApp } from "@/lib/store";
import { formatAppClock } from "@/lib/timezone";
import type { Batch, ColumnDef, ColumnGroup, SelType } from "@/lib/types";

import { ColumnPicker, relevantGroups } from "./ColumnPicker";
import { StepBadge } from "./StepBadge";
import { SummaryRow } from "./SummaryRow";

const COMBINE_JOB_KEY = "combineJobId";
const COMBINE_PREPARED_KEY = "combinePrepared";
const COMBINE_PHASE_KEY = "combinePhase";

type CombinePhase = "build" | "working" | "done";
type PreparedExport = { batchIds: string[]; columns: string[]; totalRows: number; batchCount: number };

function readPrepared(): PreparedExport | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(COMBINE_PREPARED_KEY) ?? "null") as PreparedExport | null;
    if (parsed?.batchIds?.length && Array.isArray(parsed.columns)) return parsed;
  } catch {
    // ignore malformed resume state
  }
  return null;
}

function readCombinePhase(): CombinePhase {
  if (typeof window === "undefined") return "build";
  if (sessionStorage.getItem(COMBINE_JOB_KEY)) return "working";
  const stored = sessionStorage.getItem(COMBINE_PHASE_KEY);
  if (stored === "working") return "working";
  if (stored === "done" && readPrepared()) return "done";
  return "build";
}

export function CombineScreen() {
  const router = useRouter();
  const { currency, combineTargets, setCombineTargets } = useApp();

  const [selectedCols, setSelectedCols] = useState<Set<string> | null>(null);
  const [phase, setPhase] = useState<CombinePhase>(readCombinePhase);
  const [prog, setProg] = useState(0);
  // Start empty — never seed with mock. listCampaigns() supplies mock only when
  // the backend is off; on a live backend mock data never enters this screen.
  const [batches, setBatches] = useState<Batch[]>([]);
  const [source, setSource] = useState<"live" | "mock">("mock");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : sessionStorage.getItem(COMBINE_JOB_KEY),
  );
  const [error, setError] = useState<string | null>(null);
  const [rateLimitRetryAt, setRateLimitRetryAt] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedExport | null>(readPrepared);
  const schedulingRef = useRef(false);

  useEffect(() => {
    if (jobId) {
      sessionStorage.setItem(COMBINE_JOB_KEY, jobId);
    } else {
      sessionStorage.removeItem(COMBINE_JOB_KEY);
    }
  }, [jobId]);

  useEffect(() => {
    if (prepared) sessionStorage.setItem(COMBINE_PREPARED_KEY, JSON.stringify(prepared));
    else sessionStorage.removeItem(COMBINE_PREPARED_KEY);
  }, [prepared]);

  useEffect(() => {
    if (phase === "build") sessionStorage.removeItem(COMBINE_PHASE_KEY);
    else sessionStorage.setItem(COMBINE_PHASE_KEY, phase);
  }, [phase]);

  // load live batches (falls back to mock automatically when backend is off)
  useEffect(() => {
    let alive = true;
    listCampaigns()
      .then(({ batches, source }) => {
        if (alive) {
          setBatches(batches);
          setSource(source);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : "Unable to load batches.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const campaigns = useMemo(
    () => combineTargets.map((id) => batches.find((c: Batch) => c.id === id)).filter((c): c is Batch => Boolean(c)),
    [combineTargets, batches],
  );
  const missingTargetIds = useMemo(
    () => combineTargets.filter((id) => !batches.some((batch) => batch.id === id)),
    [batches, combineTargets],
  );
  const batchType: SelType = campaigns.length ? selType(campaigns[0]) : "ai";
  const totalRows = campaigns.reduce((a: number, c: Batch) => a + c.total, 0);

  const groups = useMemo(() => relevantGroups(batchType), [batchType]);

  // init / reconcile selected columns when groups change
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSelectedCols((prev: Set<string> | null) => {
        const valid = new Set(groups.flatMap((g: ColumnGroup) => g.columns.map((c: ColumnDef) => c.key)));
        const fromPrepared = (prepared?.columns ?? []).filter((key) => valid.has(key));
        if (fromPrepared.length && phase !== "build") return new Set(fromPrepared);
        if (!prev) return new Set(groups.flatMap((g: ColumnGroup) => g.columns.filter((c: ColumnDef) => c.default).map((c: ColumnDef) => c.key)));
        return new Set([...prev].filter((k: string) => valid.has(k)));
      });
    });
    return () => {
      active = false;
    };
  }, [groups, prepared, phase]);

  const colOrder = useMemo(
    () => groups.flatMap((g: ColumnGroup) => g.columns.map((c: ColumnDef) => c.key)).filter((k: string) => selectedCols && selectedCols.has(k)),
    [groups, selectedCols],
  );
  const previewRows = useMemo(
    () => (source === "mock" && colOrder.length ? buildPreviewRows(campaigns, colOrder, 6) : []),
    [campaigns, colOrder, source],
  );

  useEffect(() => {
    if (phase !== "working" || !jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let delay = 1000;
      try {
        const job = await getJob(jobId);
        if (stopped) return;
        if (job) {
          setError(null);
          setProg((current) => Math.max(current, jobProgressPercent(job.done, job.total, job.status)));
          setRateLimitRetryAt(job.status === "rate_limited" ? job.retryAt : null);
          if (job.status === "done") {
            setProg(100);
            setPhase("done");
            setJobId(null);
            return;
          }
          if (job.status === "error") {
            setError(job.error || "Merge failed");
            setJobId(null);
            setPhase("build");
            schedulingRef.current = false;
            return;
          }
          if (job.status === "rate_limited" && job.retryAt) {
            const untilRetry = Date.parse(job.retryAt) - Date.now();
            delay = Number.isFinite(untilRetry) ? Math.max(1000, Math.min(30_000, untilRetry)) : 3000;
          }
        } else {
          setError("Unable to refresh progress. Retrying automatically…");
          delay = 3000;
        }
      } catch (pollError) {
        if (stopped) return;
        if (isJobNotFound(pollError)) {
          setJobId(null);
          schedulingRef.current = false;
          return;
        }
        setError("Unable to refresh progress. Retrying automatically…");
        delay = 3000;
      }
      if (!stopped) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, jobId]);

  // Refresh mid-schedule (phase=working, job id not saved yet) or after the
  // stored job vanished: reattach or skip-ready instead of dropping back to build.
  useEffect(() => {
    if (phase !== "working" || jobId || schedulingRef.current) return;
    const batchIds = prepared?.batchIds;
    if (!batchIds?.length) return;
    let cancelled = false;
    createIngestJob(batchIds, "merge")
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          schedulingRef.current = false;
          setPhase("build");
          setPrepared(null);
          setError("CSV download requires the live backend; demo rows cannot be exported as customer data.");
        } else if (res.ready || !res.jobId) {
          setProg(100);
          setPhase("done");
        } else {
          setProg(jobProgressPercent(res.done ?? 0, res.total || 1));
          setJobId(res.jobId);
        }
      })
      .catch(() => {
        if (cancelled) return;
        schedulingRef.current = false;
        setPhase("build");
        setError("Unable to schedule merge. Please try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [phase, jobId, prepared]);

  const onGenerate = async () => {
    if (missingTargetIds.length > 0) {
      setError(`The selection is incomplete. Missing: ${missingTargetIds.join(", ")}. Return to Campaigns and select the batches again.`);
      return;
    }
    setError(null);
    setRateLimitRetryAt(null);
    setProg(0);
    const snapshot = {
      batchIds: campaigns.map((campaign) => campaign.id),
      columns: [...colOrder],
      totalRows,
      batchCount: campaigns.length,
    };
    schedulingRef.current = true;
    sessionStorage.setItem(COMBINE_PHASE_KEY, "working");
    sessionStorage.setItem(COMBINE_PREPARED_KEY, JSON.stringify(snapshot));
    setPrepared(snapshot);
    setPhase("working");
    try {
      const res = await createIngestJob(snapshot.batchIds, "merge");
      if (!res) {
        schedulingRef.current = false;
        setPhase("build");
        setPrepared(null);
        setError("CSV download requires the live backend; demo rows cannot be exported as customer data.");
      } else if (res.ready || !res.jobId) {
        setProg(100);
        setPhase("done");
      } else {
        setProg(jobProgressPercent(res.done ?? 0, res.total || 1));
        setJobId(res.jobId);
      }
    } catch {
      schedulingRef.current = false;
      setPhase("build");
      setPrepared(null);
      setError("Unable to schedule merge. Please try again.");
    }
  };

  const reset = () => {
    schedulingRef.current = false;
    setPhase("build");
    setProg(0);
    setJobId(null);
    setPrepared(null);
    setError(null);
    setRateLimitRetryAt(null);
  };

  const editing = phase === "build";
  const removeChip = (id: string) => editing && setCombineTargets(combineTargets.filter((x) => x !== id));
  const addCampaign = (id: string) =>
    editing && setCombineTargets(combineTargets.includes(id) ? combineTargets : [...combineTargets, id]);
  // only batches of the same selection type can be added to the merge
  const available = batches.filter((c: Batch) => !combineTargets.includes(c.id) && selType(c) === batchType);

  const onDownload = async () => {
    const batchIds = prepared?.batchIds ?? campaigns.map((campaign) => campaign.id);
    const columns = prepared?.columns ?? colOrder;
    setDownloading(true);
    setError(null);
    try {
      await downloadCsv(batchIds, columns);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "CSV download failed. Please try again.");
    } finally {
      setDownloading(false);
    }
  };

  // Wait for the real batch list before deciding "nothing selected" — otherwise
  // the empty state flashes while live data loads.
  if (loading) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <Card className="flex items-center justify-center gap-2.5 py-20 text-sm font-semibold text-slate-500">
          <Spinner size={16} /> Loading batches…
        </Card>
      </div>
    );
  }

  if (loadError || missingTargetIds.length > 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <Card>
          <EmptyState
            icon="TriangleAlert"
            title={loadError ? "Batches are unavailable" : "The saved batch selection is incomplete"}
            body={loadError ?? `These selected batches are no longer available: ${missingTargetIds.join(", ")}. Nothing has been silently omitted.`}
            action={<Button icon="Table2" onClick={() => router.push("/campaigns")}>Return to Campaigns</Button>}
          />
        </Card>
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <Card>
          <EmptyState
            icon="GitMerge"
            title="No batches selected to combine"
            body="Pick batches of the same type from the Campaigns table — select a few rows and choose “Combine into one CSV”."
            action={<Button icon="Table2" onClick={() => router.push("/campaigns")}>Browse batches</Button>}
          />
        </Card>
      </div>
    );
  }

  const rowsDone = Math.round((prog / 100) * totalRows);

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* main */}
        <div className="lg:col-span-2 space-y-5">
          {/* step 1 */}
          <Card className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <StepBadge n={1} active />
              <div>
                <div className="text-[15px] font-bold text-slate-900">Selected batches</div>
                <div className="text-xs text-slate-400 flex items-center gap-1.5">
                  {campaigns.length} {SEL_LABEL[batchType]} {campaigns.length === 1 ? "batch" : "batches"} · same type
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {campaigns.map((c: Batch) => (
                <span
                  key={c.id}
                  className="group inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white pl-1.5 pr-1 py-1 hover:border-slate-300 transition-colors"
                >
                  <TypeDot tkey={typeKey(c)} size={24} />
                  <span className="text-[13px] font-semibold text-slate-700">{c.name}</span>
                  <span className="text-[11px] font-mono text-slate-400">{fmtNum(c.total)}</span>
                  <button
                    onClick={() => removeChip(c.id)}
                    disabled={!editing}
                    aria-label={`Remove ${c.name}`}
                    className="ml-0.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-md p-1 transition-colors"
                  >
                    <Icon name="X" size={13} />
                  </button>
                </span>
              ))}
              {editing && <Dropdown
                align="left"
                width={280}
                trigger={
                  <button className="inline-flex items-center gap-1.5 rounded-xl border border-dashed border-slate-300 px-3 py-2 text-[13px] font-semibold text-slate-500 hover:border-[var(--accent)] hover:text-[var(--accent-strong)] transition-colors">
                    <Icon name="Plus" size={15} /> Add batch
                  </button>
                }
              >
                {() => (
                  <div className="max-h-72 overflow-y-auto">
                    <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                      {SEL_LABEL[batchType]} batches
                    </div>
                    {available.length === 0 && (
                      <div className="px-2.5 py-3 text-sm text-slate-400 text-center">
                        No other {SEL_LABEL[batchType]} batches
                      </div>
                    )}
                    {available.map((c: Batch) => (
                      <button
                        key={c.id}
                        onClick={() => addCampaign(c.id)}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-slate-100 text-left"
                      >
                        <TypeDot tkey={typeKey(c)} size={26} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold text-slate-700 truncate">{c.name}</span>
                          <span className="block text-[11px] font-mono text-slate-400">
                            {c.batchId} · {fmtNum(c.total)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Dropdown>}
            </div>
          </Card>

          {/* step 2 */}
          <Card className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <StepBadge n={2} active />
              <div>
                <div className="text-[15px] font-bold text-slate-900">Choose columns</div>
                <div className="text-xs text-slate-400">Common columns plus type-specific fields, grouped below</div>
              </div>
            </div>
            {selectedCols && (
              <div className={editing ? undefined : "pointer-events-none opacity-60"}>
              <ColumnPicker
                groups={groups}
                selected={selectedCols}
                setSelected={(updater) => setSelectedCols((prev: Set<string> | null) => updater(prev ?? new Set()))}
              />
              </div>
            )}
          </Card>

          {/* step 3 */}
          <Card className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <StepBadge n={3} active />
              <div>
                <div className="text-[15px] font-bold text-slate-900">Preview merged rows</div>
                <div className="text-xs text-slate-400">
                  {source === "live"
                    ? `Selected schema for ${fmtNum(totalRows)} real rows`
                    : `First ${previewRows.length} of ${fmtNum(totalRows)} demo rows`} · unified across all {SEL_LABEL[batchType]} batches
                </div>
              </div>
            </div>
            {colOrder.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
                Select at least one column to preview
              </div>
            ) : source === "live" ? (
              <div className="rounded-xl border border-dashed border-slate-200 py-10 px-6 text-center text-sm text-slate-400">
                Live row values are not fabricated for preview. The downloaded CSV contains the normalized records for the selected batches and columns.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="text-[12px] min-w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      {colOrder.map((k: string) => (
                        <th key={k} className="px-3 py-2 text-left font-mono font-semibold text-slate-500 whitespace-nowrap">
                          {k}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r: Record<string, string>, i: number) => (
                      <tr key={i} className="border-b border-slate-100 last:border-0">
                        {colOrder.map((k: string) => (
                          <td
                            key={k}
                            className="px-3 py-2 font-mono text-slate-600 whitespace-nowrap max-w-[200px] truncate"
                          >
                            {r[k] || <span className="text-slate-300">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* right rail */}
        <div className="lg:col-span-1">
          <div className="sticky top-[88px] space-y-4">
            <Card className="p-5">
              <div className="text-[15px] font-bold text-slate-900 mb-4">Export summary</div>
              <dl className="space-y-3 text-sm">
                <SummaryRow label="Batches" value={campaigns.length} />
                <SummaryRow label="Total rows" value={fmtNum(totalRows)} />
                <SummaryRow label="Columns" value={selectedCols ? selectedCols.size : 0} />
                <SummaryRow label="Batch type" value={<TypeBadge tkey={typeKey(campaigns[0])} size="sm" />} />
                <div className="h-px bg-slate-100" />
                <SummaryRow
                  label="Est. file size"
                  value={`~${((totalRows * (selectedCols ? selectedCols.size : 0) * 0.02) / 1024).toFixed(1)} MB`}
                />
                <SummaryRow
                  label="Combined spend"
                  value={fmtMoney(campaigns.reduce((a: number, c: Batch) => a + c.spendInr, 0), currency)}
                />
              </dl>

              <div className="mt-5">
                {phase === "build" && (
                  <div className="space-y-2.5">
                    <Button
                      size="lg"
                      className="w-full"
                      icon="GitMerge"
                      disabled={!selectedCols || selectedCols.size === 0 || campaigns.length < 2}
                      onClick={onGenerate}
                    >
                      Generate &amp; Download
                    </Button>
                    {error && <div className="text-xs font-medium text-red-600">{error}</div>}
                  </div>
                )}
                {phase === "working" && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                    <JobProgress
                      label={`Merging ${campaigns.length} batches`}
                      value={prog}
                      total={100}
                      status={`${Math.round(prog)}%`}
                      sub={`${fmtNum(rowsDone)} / ${fmtNum(totalRows)} rows merged…`}
                    />
                    {rateLimitRetryAt && (
                      <div className="mt-3 flex items-start gap-2 text-[13px] text-amber-700">
                        <Icon name="Clock3" size={15} className="mt-0.5 shrink-0" />
                        <span>
                          Rate limit reached. This job will retry automatically at{" "}
                          {formatAppClock(rateLimitRetryAt)} IST. You can refresh this page;
                          the merge will resume.
                        </span>
                      </div>
                    )}
                    {error && (
                      <div className="mt-3 flex items-start gap-2 text-[13px] text-red-600">
                        <Icon name="TriangleAlert" size={15} className="mt-0.5 shrink-0" />
                        <span className="flex-1">{error}</span>
                        <Button variant="secondary" size="sm" icon="RotateCcw" aria-label="Reset CSV preparation" onClick={reset} />
                      </div>
                    )}
                  </div>
                )}
                {phase === "done" && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 fade-up">
                    <div className="flex items-center gap-2 text-emerald-700 font-bold text-sm mb-1">
                      <Icon name="CircleCheck" size={17} /> Download ready
                    </div>
                    <div className="text-[13px] text-slate-500 mb-3">
                      combined_export_{prepared?.batchCount ?? campaigns.length}_batches.csv · {fmtNum(prepared?.totalRows ?? totalRows)} rows
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        icon="Download"
                        loading={downloading}
                        onClick={() => void onDownload()}
                      >
                        Download CSV
                      </Button>
                      <Button variant="secondary" icon="RotateCcw" aria-label="Start another CSV" onClick={reset} />
                    </div>
                    {error && <div className="mt-3 text-[13px] text-red-600">{error}</div>}
                  </div>
                )}
              </div>
            </Card>

            {phase === "build" && (
              <div className="flex items-start gap-2.5 rounded-xl bg-[var(--accent-soft)] px-4 py-3 text-[13px] text-[var(--accent-strong)]">
                <Icon name="Info" size={15} className="mt-0.5 shrink-0" />
                <span>
                  Only <span className="font-semibold">{SEL_LABEL[batchType]}</span> batches can be merged together, so
                  every row shares the same schema. Switch type from the Campaigns table to combine a different kind.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
