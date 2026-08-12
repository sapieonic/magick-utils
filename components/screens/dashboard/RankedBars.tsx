"use client";

import { fmtNum } from "@/lib/data";

export function RankedBars({
  items,
  empty = "No values in this period.",
}: {
  items: { label: string; value: number }[];
  empty?: string;
}) {
  if (items.length === 0) {
    return <div className="py-8 text-center text-sm text-slate-500">{empty}</div>;
  }
  const max = Math.max(...items.map((item) => item.value), 1);
  return (
    <div className="space-y-2.5">
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="flex items-center gap-3">
          <span className="text-[13px] text-slate-400 w-5 tabnum">{i + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1 gap-2">
              <span className="text-[13px] font-semibold text-slate-700 truncate">{item.label}</span>
              <span className="text-[12px] tabnum text-slate-400 shrink-0">{fmtNum(item.value)}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${(item.value / max) * 100}%`, background: "var(--accent)" }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
