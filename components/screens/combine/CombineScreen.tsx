"use client";
// Combine CSV — combined export builder (chips -> column picker -> preview -> job).
// Ported from the design's screens-combine.jsx.

import { useEffect, useMemo, useState } from "react";
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
import { createIngestJob, downloadCsvUrl, getJob, listCampaigns } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Batch, ColumnDef, ColumnGroup, SelType } from "@/lib/types";

import { ColumnPicker, relevantGroups } from "./ColumnPicker";
import { StepBadge } from "./StepBadge";
import { SummaryRow } from "./SummaryRow";

export function CombineScreen() {
  const router = useRouter();
  const { currency, combineTargets, setCombineTargets } = useApp();

  const [selectedCols, setSelectedCols] = useState<Set<string> | null>(null);
  const [phase, setPhase] = useState<"build" | "working" | "done">("build");
  const [prog, setProg] = useState(0);
  // Start empty — never seed with mock. listCampaigns() supplies mock only when
  // the backend is off; on a live backend mock data never enters this screen.
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mockMode, setMockMode] = useState(false); // confirmed backend-off ⇒ run the simulation

  // load live batches (falls back to mock automatically when backend is off)
  useEffect(() => {
    let alive = true;
    listCampaigns()
      .then(({ batches }) => {
        if (alive) setBatches(batches);
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
  const batchType: SelType = campaigns.length ? selType(campaigns[0]) : "ai";
  const totalRows = campaigns.reduce((a: number, c: Batch) => a + c.total, 0);

  const groups = useMemo(() => relevantGroups(batchType), [batchType]);

  // init / reconcile selected columns when groups change
  useEffect(() => {
    setSelectedCols((prev: Set<string> | null) => {
      const valid = new Set(groups.flatMap((g: ColumnGroup) => g.columns.map((c: ColumnDef) => c.key)));
      if (!prev) return new Set(groups.flatMap((g: ColumnGroup) => g.columns.filter((c: ColumnDef) => c.default).map((c: ColumnDef) => c.key)));
      return new Set([...prev].filter((k: string) => valid.has(k)));
    });
  }, [groups]);

  const colOrder = useMemo(
    () => groups.flatMap((g: ColumnGroup) => g.columns.map((c: ColumnDef) => c.key)).filter((k: string) => selectedCols && selectedCols.has(k)),
    [groups, selectedCols],
  );
  const previewRows = useMemo(
    () => (colOrder.length ? buildPreviewRows(campaigns, colOrder, 6) : []),
    [campaigns, colOrder],
  );

  const live = jobId !== null;

  // simulated progress — only once we've CONFIRMED the backend is off (mockMode),
  // so it never races the real job before createIngestJob resolves.
  useEffect(() => {
    if (phase !== "working" || live || !mockMode) return;
    setProg(0);
    const iv = setInterval(() => {
      setProg((p: number) => {
        const next = p + Math.random() * 11 + 3;
        if (next >= 100) {
          clearInterval(iv);
          setTimeout(() => setPhase("done"), 400);
          return 100;
        }
        return next;
      });
    }, 220);
    return () => clearInterval(iv);
  }, [phase, live, mockMode]);

  // real job polling — runs once a live jobId exists. Capped so a wedged job
  // (never reaching done/error) surfaces an error instead of polling forever.
  useEffect(() => {
    if (phase !== "working" || !jobId) return;
    let stopped = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 600; // ~10 min at 1s
    const iv = setInterval(async () => {
      attempts += 1;
      const job = await getJob(jobId);
      if (stopped) return;
      if (job) {
        setProg(job.total > 0 ? (job.done / job.total) * 100 : 0);
        if (job.status === "done") {
          clearInterval(iv);
          setProg(100);
          setPhase("done");
          return;
        }
        if (job.status === "error") {
          clearInterval(iv);
          setProg(0);
          setError(job.error || "Merge failed");
          return;
        }
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(iv);
        setProg(0);
        setError("Merge timed out — please try again.");
      }
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [phase, jobId]);

  const onGenerate = async () => {
    setError(null);
    setProg(0);
    setMockMode(false);
    setPhase("working");
    // Resolve the job BEFORE the sim can start: success ⇒ set jobId (poll path);
    // null ⇒ confirmed backend-off ⇒ flip mockMode so the simulation runs.
    const res = await createIngestJob(campaigns.map((c: Batch) => c.id), "merge");
    if (res) setJobId(res.jobId);
    else setMockMode(true);
  };

  const reset = () => {
    setPhase("build");
    setProg(0);
    setJobId(null);
    setMockMode(false);
    setError(null);
  };

  const removeChip = (id: string) => setCombineTargets(combineTargets.filter((x) => x !== id));
  const addCampaign = (id: string) =>
    setCombineTargets(combineTargets.includes(id) ? combineTargets : [...combineTargets, id]);
  // only batches of the same selection type can be added to the merge
  const available = batches.filter((c: Batch) => !combineTargets.includes(c.id) && selType(c) === batchType);

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
                    className="ml-0.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-md p-1 transition-colors"
                  >
                    <Icon name="X" size={13} />
                  </button>
                </span>
              ))}
              <Dropdown
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
              </Dropdown>
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
              <ColumnPicker
                groups={groups}
                selected={selectedCols}
                setSelected={(updater) => setSelectedCols((prev: Set<string> | null) => updater(prev ?? new Set()))}
              />
            )}
          </Card>

          {/* step 3 */}
          <Card className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <StepBadge n={3} active />
              <div>
                <div className="text-[15px] font-bold text-slate-900">Preview merged rows</div>
                <div className="text-xs text-slate-400">
                  First {previewRows.length} of {fmtNum(totalRows)} rows · unified schema across all{" "}
                  {SEL_LABEL[batchType]} batches
                </div>
              </div>
            </div>
            {colOrder.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-400">
                Select at least one column to preview
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
                  <Button
                    size="lg"
                    className="w-full"
                    icon="GitMerge"
                    disabled={!selectedCols || selectedCols.size === 0}
                    onClick={onGenerate}
                  >
                    Generate &amp; Download
                  </Button>
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
                    {error && (
                      <div className="mt-3 flex items-start gap-2 text-[13px] text-red-600">
                        <Icon name="TriangleAlert" size={15} className="mt-0.5 shrink-0" />
                        <span className="flex-1">{error}</span>
                        <Button variant="secondary" size="sm" icon="RotateCcw" onClick={reset} />
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
                      combined_export_{campaigns.length}_batches.csv · {fmtNum(totalRows)} rows
                    </div>
                    <div className="flex gap-2">
                      <Button
                        className="flex-1"
                        icon="Download"
                        onClick={() => {
                          if (jobId) window.location.href = downloadCsvUrl(campaigns.map((c: Batch) => c.id), colOrder);
                        }}
                      >
                        Download CSV
                      </Button>
                      <Button variant="secondary" icon="RotateCcw" onClick={reset} />
                    </div>
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
