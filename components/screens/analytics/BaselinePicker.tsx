"use client";

import { Dropdown, Icon, cx } from "@/components/ui";
import { SEL_LABEL, fmtPct, selType } from "@/lib/data";
import type { Batch } from "@/lib/types";

/** Baseline batch picker for Comparative Insights (4a). Candidates are filtered
 *  to the SAME selType as the current selection (the hard combine/analyze rule),
 *  so an apples-to-oranges comparison is impossible by construction. Mirrors the
 *  ModelSelect dropdown pattern. */
export function BaselinePicker({
  candidates,
  selectedId,
  onSelect,
  onClear,
  selLabel,
}: {
  candidates: Batch[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  selLabel: string;
}) {
  const selected = candidates.find((c) => c.id === selectedId) ?? null;
  const disabled = candidates.length === 0;

  if (disabled && !selected) {
    return (
      <button
        disabled
        title={`No other ${selLabel} batches to compare with`}
        className="flex items-center gap-2 h-9 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-300 cursor-not-allowed"
      >
        <Icon name="GitCompareArrows" size={14} /> Compare to baseline…
      </button>
    );
  }

  return (
    <Dropdown
      align="right"
      width={296}
      trigger={
        <button className="flex items-center gap-2 h-9 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-colors">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-md" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
            <Icon name="GitCompareArrows" size={13} />
          </span>
          {selected ? (
            <>
              <span className="text-slate-400 font-medium">vs</span>
              <span className="max-w-[160px] truncate">{selected.name}</span>
              <span
                role="button"
                tabIndex={0}
                title="Clear baseline"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onClear();
                  }
                }}
                className="inline-flex h-5 w-5 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <Icon name="X" size={13} />
              </span>
            </>
          ) : (
            <>
              <span>Compare to baseline…</span>
              <Icon name="ChevronDown" size={14} className="text-slate-400" />
            </>
          )}
        </button>
      }
    >
      {(close: () => void) => (
        <>
          <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Baseline batch</div>
          <div className="px-2.5 pb-1.5 text-[11px] text-slate-400">Same type as your selection ({selLabel})</div>
          <div className="max-h-[280px] overflow-y-auto">
            {candidates.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  onSelect(c.id);
                  close();
                }}
                className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors", c.id === selectedId ? "bg-[var(--accent-soft)]" : "hover:bg-slate-100")}
              >
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg shrink-0" style={{ background: c.id === selectedId ? "var(--accent)" : "#f1f5f9", color: c.id === selectedId ? "#fff" : "#64748b" }}>
                  <Icon name={selType(c) === "message" ? "MessageSquare" : selType(c) === "ivr" ? "PhoneCall" : "AudioLines"} size={14} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-slate-800 truncate">{c.name}</span>
                  <span className="block font-mono text-[11px] text-slate-400">{c.batchId}</span>
                </span>
                <span className="text-[12px] font-semibold text-slate-500 tabnum">{fmtPct(c.successRate)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Dropdown>
  );
}
