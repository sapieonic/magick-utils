"use client";

import { useEffect, useState } from "react";
import { Button, Icon, JobProgress, Modal } from "@/components/ui";
import { fmtNum, selType } from "@/lib/data";
import { createIngestJob, downloadCsv, getJob } from "@/lib/api";
import type { Batch } from "@/lib/types";
import { ColumnPicker, relevantGroups } from "./ColumnPicker";

type Phase = "pick" | "working" | "done";

export function DownloadModal({
  campaign,
  onClose,
}: {
  campaign: Batch;
  onClose: () => void;
}) {
  const groups = relevantGroups(selType(campaign));
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(groups.flatMap((g) => g.columns.filter((c) => c.default).map((c) => c.key)))
  );
  const [phase, setPhase] = useState<Phase>("pick");
  const [prog, setProg] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (phase !== "working" || !jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const job = await getJob(jobId);
        if (stopped || !job) return;
        setProg(job.total > 0 ? Math.min(99, (job.done / job.total) * 100) : 0);
        if (job.status === "done") {
          setProg(100);
          setJobId(null);
          setPhase("done");
          return;
        }
        if (job.status === "error") {
          setError(job.error || "CSV preparation failed.");
          setJobId(null);
          setPhase("pick");
          return;
        }
      } catch (pollError) {
        if (!stopped) setError(pollError instanceof Error ? pollError.message : "Unable to refresh export progress.");
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, phase]);

  const prepare = async () => {
    setError(null);
    setProg(0);
    setPhase("working");
    try {
      const result = await createIngestJob([campaign.id], "merge");
      if (!result) throw new Error("CSV download requires the live backend; demo rows cannot be exported.");
      if (result.ready || !result.jobId) {
        setProg(100);
        setPhase("done");
      } else {
        setJobId(result.jobId);
      }
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "Unable to prepare CSV.");
      setPhase("pick");
    }
  };

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadCsv([campaign.id], [...selected]);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "CSV download failed.");
    } finally {
      setDownloading(false);
    }
  };

  const total = campaign.total;
  const rows = Math.round((prog / 100) * total);

  return (
    <Modal
      open
      onClose={onClose}
      icon="Download"
      size="lg"
      title={phase === "done" ? "Your CSV is ready" : "Download CSV"}
      subtitle={
        phase === "done" ? undefined : (
          <span>
            {campaign.name} · <span className="font-mono">{campaign.batchId}</span> · {fmtNum(campaign.total)} records
          </span>
        )
      }
      footer={
        phase === "pick" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button icon="Download" disabled={selected.size === 0} onClick={() => void prepare()}>
              Download {selected.size} columns
            </Button>
          </>
        ) : phase === "done" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button icon="Download" loading={downloading} onClick={() => void download()}>Download {campaign.batchId}.csv</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          <Icon name="TriangleAlert" size={15} className="mt-0.5" /> {error}
        </div>
      )}
      {phase === "pick" && <ColumnPicker groups={groups} selected={selected} setSelected={setSelected} />}
      {phase === "working" && (
        <div className="py-8">
          <JobProgress
            label="Preparing export…"
            value={prog}
            total={100}
            status={`${fmtNum(rows)} / ${fmtNum(total)} rows`}
            sub="Streaming rows, applying column selection, and formatting values."
          />
          <div className="mt-6 flex flex-wrap gap-1.5">
            {Array.from(selected)
              .slice(0, 12)
              .map((k) => (
                <span key={k} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-mono text-slate-500">
                  {k}
                </span>
              ))}
            {selected.size > 12 && (
              <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-mono text-slate-400">
                +{selected.size - 12} more
              </span>
            )}
          </div>
        </div>
      )}
      {phase === "done" && (
        <div className="py-6 flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-500 mb-4">
            <Icon name="FileSpreadsheet" size={28} />
          </div>
          <div className="text-[15px] font-bold text-slate-800">{campaign.batchId}.csv</div>
          <div className="text-sm text-slate-400 mt-1">
            {fmtNum(total)} rows · {selected.size} columns · ~{((total * selected.size * 0.018) / 1024).toFixed(1)} MB
          </div>
          <div className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-600">
            <Icon name="CircleCheck" size={15} /> Export complete
          </div>
        </div>
      )}
    </Modal>
  );
}
