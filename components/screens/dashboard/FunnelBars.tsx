"use client";

import { fmtNum } from "@/lib/data";

const FUNNEL_COLORS = ["#94a3b8", "#3b82f6", "#16a34a", "#6366f1"];

export function FunnelBars({ data }: { data: { stage: string; value: number; color?: string }[] }) {
  if (data.length === 0) return null;
  const max = Math.max(data[0].value, 1);
  return (
    <div className="space-y-2.5 py-1">
      {data.map((d, i) => {
        const pct = (d.value / max) * 100;
        const prev = i > 0 ? data[i - 1].value : 0;
        const dropFromPrev = i > 0 && prev > 0 ? ((prev - d.value) / prev) * 100 : 0;
        return (
          <div key={d.stage}>
            <div className="flex items-center justify-between text-[13px] mb-1">
              <span className="font-semibold text-slate-700">{d.stage}</span>
              <span className="tabnum text-slate-500">
                <span className="font-bold text-slate-800">{fmtNum(d.value)}</span>{" "}
                <span className="text-slate-400">({Math.round(pct)}%)</span>
              </span>
            </div>
            <div className="relative h-8 rounded-lg bg-slate-50 overflow-hidden">
              <div
                className="h-full rounded-lg transition-all"
                style={{ width: `${pct}%`, background: d.color ?? FUNNEL_COLORS[i % FUNNEL_COLORS.length] }}
              />
              {i > 0 && dropFromPrev > 0 && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-red-500">
                  −{Math.round(dropFromPrev)}%
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
