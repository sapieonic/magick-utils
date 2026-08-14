"use client";

import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  VOLUME_CHART_MARGIN,
  VOLUME_Y_AXIS_WIDTH,
  formatCountTick,
  niceCountTicks,
  seriesMax,
  toFiniteNumber,
} from "@/lib/chart-axis";
import { ChartTip } from "./ChartTip";

type VolumePoint = { date: string; calls: number; messages: number };

export function VolumeChart({ data }: { data: VolumePoint[] }) {
  const series = useMemo(
    () =>
      data.map((point) => ({
        date: point.date,
        calls: toFiniteNumber(point.calls),
        messages: toFiniteNumber(point.messages),
      })),
    [data],
  );
  const ticks = useMemo(
    () => niceCountTicks(seriesMax(series.flatMap((point) => [point.calls, point.messages]))),
    [series],
  );
  const top = ticks[ticks.length - 1] ?? 1;

  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ ...VOLUME_CHART_MARGIN }}>
          <defs>
            <linearGradient id="gCalls" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gMsg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.28} />
              <stop offset="100%" stopColor="#94a3b8" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} interval={5} />
          <YAxis
            type="number"
            scale="linear"
            domain={[0, top]}
            ticks={ticks}
            interval={0}
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCountTick}
            width={VOLUME_Y_AXIS_WIDTH}
          />
          <Tooltip content={<ChartTip />} />
          <Area type="monotone" dataKey="messages" stroke="#94a3b8" strokeWidth={2} fill="url(#gMsg)" />
          <Area type="monotone" dataKey="calls" stroke="var(--accent)" strokeWidth={2.4} fill="url(#gCalls)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
