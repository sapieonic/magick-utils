"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { fmtCompact } from "@/lib/data";
import { ChartTip } from "./ChartTip";

type DonutSeg = { key: string; name: string; value: number; color: string };

export function StatusDonut({ data }: { data: DonutSeg[] }) {
  const total = data.reduce((a, b) => a + b.value, 0);
  return (
    <div className="flex flex-col items-center">
      <div style={{ height: 178, width: "100%" }} className="relative">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={56} outerRadius={84} paddingAngle={2} stroke="none">
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip suffix=" records" />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-[22px] font-extrabold text-slate-900 tabnum leading-none">{fmtCompact(total)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">records</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 w-full">
        {data.map((d, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.color }} />
            <span className="truncate">{d.name}</span>
            <span className="ml-auto tabnum font-semibold text-slate-700">{Math.round((d.value / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
