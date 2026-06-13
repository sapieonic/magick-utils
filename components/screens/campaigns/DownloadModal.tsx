"use client";

import { useEffect, useState } from "react";
import { Button, Icon, JobProgress, Modal } from "@/components/ui";
import { fmtNum, selType } from "@/lib/data";
import type { Batch, Currency } from "@/lib/types";
import { ColumnPicker, relevantGroups } from "./ColumnPicker";

type Phase = "pick" | "working" | "done";

export function DownloadModal({
  campaign,
  currency,
  onClose,
}: {
  campaign: Batch;
  currency: Currency;
  onClose: () => void;
}) {
  const groups = relevantGroups(selType(campaign));
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(groups.flatMap((g) => g.columns.filter((c) => c.default).map((c) => c.key)))
  );
  const [phase, setPhase] = useState<Phase>("pick");
  const [prog, setProg] = useState(0);

  useEffect(() => {
    if (phase !== "working") return;
    setProg(0);
    const iv = setInterval(() => {
      setProg((p) => {
        const next = p + Math.random() * 16 + 4;
        if (next >= 100) {
          clearInterval(iv);
          setTimeout(() => setPhase("done"), 350);
          return 100;
        }
        return next;
      });
    }, 180);
    return () => clearInterval(iv);
  }, [phase]);

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
            <Button icon="Download" disabled={selected.size === 0} onClick={() => setPhase("working")}>
              Download {selected.size} columns
            </Button>
          </>
        ) : phase === "done" ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button icon="Download">Download {campaign.batchId}.csv</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
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
