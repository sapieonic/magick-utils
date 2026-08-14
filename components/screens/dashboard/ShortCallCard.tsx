"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartCard } from "@/components/ui";
import {
  VOLUME_CHART_MARGIN,
  VOLUME_Y_AXIS_WIDTH,
  countYAxisScale,
  formatCountTick,
  seriesMax,
} from "@/lib/chart-axis";
import { fmtDuration, fmtNum, fmtPct } from "@/lib/data";
import type { ShortCallStats } from "@/lib/server/types";
import { ChartTip } from "./ChartTip";

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 text-[20px] font-extrabold tabnum tracking-tight text-slate-900">{value}</div>
      <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>
    </div>
  );
}

export function ShortCallCard({ stats }: { stats: ShortCallStats | null }) {
  const { ticks, domain } = useMemo(
    () => countYAxisScale(seriesMax((stats?.durationHistogram ?? []).map((row) => row.calls))),
    [stats],
  );
  return (
    <ChartCard
      title="Short calls & hang-ups"
      subtitle={`Connected calls only · hang-up = talk-time under ${stats?.hangupTalkSeconds ?? 10}s · short = duration under ${stats?.thresholdSeconds ?? 15}s`}
    >
      {!stats ? (
        <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-slate-500">
          No connected calls with a duration in this period.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="Hang-up rate"
              value={fmtPct(stats.hangupRate)}
              sub={`${fmtNum(stats.hangupCount)} of ${fmtNum(stats.connectedWithTalk)} with talk-time`}
            />
            <Metric
              label="Short-call rate"
              value={fmtPct(stats.shortRate)}
              sub={`${fmtNum(stats.shortCount)} under ${stats.thresholdSeconds}s`}
            />
            <Metric
              label="Avg talk / duration"
              value={stats.avgTalkTime == null ? "—" : fmtDuration(stats.avgTalkTime)}
              sub={stats.avgDuration == null ? "no duration" : `avg duration ${fmtDuration(stats.avgDuration)}`}
            />
          </div>
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.durationHistogram} margin={{ ...VOLUME_CHART_MARGIN }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <YAxis
                  type="number"
                  scale="linear"
                  domain={domain}
                  ticks={ticks}
                  interval={0}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatCountTick}
                  width={VOLUME_Y_AXIS_WIDTH}
                />
                <Tooltip content={<ChartTip suffix=" calls" />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
                <Bar dataKey="calls" fill="var(--accent)" radius={[5, 5, 0, 0]} barSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </ChartCard>
  );
}
