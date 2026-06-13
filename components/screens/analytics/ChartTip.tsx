"use client";

import { fmtNum } from "@/lib/data";

type TipPayload = {
  name?: string;
  value?: number;
  color?: string;
  payload?: { color?: string };
};

export function ChartTip({
  active,
  payload,
  label,
  suffix = "",
}: {
  active?: boolean;
  payload?: TipPayload[];
  label?: string;
  suffix?: string;
}) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg text-xs">
      {label && <div className="font-bold text-slate-700 mb-1">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.payload?.color }} />
          <span className="text-slate-500 capitalize">{p.name}</span>
          <span className="ml-auto tabnum font-semibold text-slate-800">
            {fmtNum(p.value)}
            {suffix}
          </span>
        </div>
      ))}
    </div>
  );
}
