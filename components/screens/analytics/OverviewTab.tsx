"use client";

import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Card, ChartCard, Icon, cx } from "@/components/ui";
import {
  STATUS,
  aggregate,
  callsOverTime,
  fmtCompact,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtPct,
  statusMix,
} from "@/lib/data";
import type { Batch, Currency, StatusKey } from "@/lib/types";
import type { AggregatesDoc } from "@/lib/server/types";
import { ChartTip } from "./ChartTip";
import { Legend } from "./Legend";
import { StatusDonut } from "./StatusDonut";
import { VolumeChart } from "./VolumeChart";

export function OverviewTab({
  targets,
  agg,
  currency,
  hasVoice,
  analytics,
}: {
  targets: Batch[];
  agg: ReturnType<typeof aggregate>;
  currency: Currency;
  hasVoice: boolean;
  hasMsg?: boolean;
  analytics?: AggregatesDoc | null;
}) {
  const mix = useMemo(
    () =>
      (analytics
        ? analytics.statusMix.map((s) => ({
            key: s.key,
            name: STATUS[s.key as StatusKey]?.label ?? s.key,
            value: s.value,
            color: STATUS[s.key as StatusKey]?.color ?? "#94a3b8",
          }))
        : statusMix(targets)
      // Hide statuses with no records — an empty bucket shouldn't get a slice,
      // a legend row, or a zero-length bar.
      ).filter((m) => m.value > 0),
    [analytics, targets],
  );
  const time = useMemo(
    () => (analytics?.volumeOverTime ? analytics.volumeOverTime : callsOverTime()),
    [analytics],
  );
  const voiceTarget = targets.find((t) => t.channel === "voice");
  const records = analytics ? analytics.totalRecords : agg.totalCalls + agg.totalMessages;
  const successRate = analytics ? analytics.successRate : agg.successRate;
  const spend = analytics ? analytics.spendInr : agg.spendInr;
  const stats = [
    { label: "Records analyzed", value: fmtNum(records), icon: "Database" },
    { label: hasVoice ? "Answer rate" : "Read rate", value: fmtPct(successRate), icon: "Target", accentVal: true },
    { label: "Total spend", value: fmtMoney(spend, currency), icon: currency === "usd" ? "DollarSign" : "IndianRupee" },
    {
      label: hasVoice ? "Avg. duration" : "Channels",
      value: hasVoice ? fmtDuration(voiceTarget?.avgDuration) : String(new Set(targets.map((t) => t.channel)).size),
      icon: "Clock",
    },
  ];
  return (
    <div className="space-y-4 fade-in">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <Card key={i} className="p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium text-slate-500">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
                <Icon name={s.icon} size={15} />
              </span>
              {s.label}
            </div>
            <div className={cx("mt-2.5 text-[24px] font-extrabold tabnum tracking-tight", s.accentVal ? "" : "text-slate-900")} style={s.accentVal ? { color: "var(--accent-strong)" } : undefined}>
              {s.value}
            </div>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="Outcome distribution" subtitle="Share of all records">
          <StatusDonut data={mix} />
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="Outcome by volume" subtitle="Stacked record counts">
          <StackedStatusBar mix={mix} />
        </ChartCard>
      </div>
      <ChartCard
        title="Volume over time"
        subtitle="Daily records during the campaign window"
        action={<Legend items={[{ c: "var(--accent)", l: hasVoice ? "Calls" : "Primary" }, { c: "#94a3b8", l: "Messages" }]} />}
      >
        <VolumeChart data={time} />
      </ChartCard>
    </div>
  );
}

function StackedStatusBar({ mix }: { mix: { name: string; value: number; color: string }[] }) {
  const data = mix.map((m) => ({ name: m.name, value: m.value, color: m.color }));
  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={fmtCompact} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} tickLine={false} axisLine={false} width={86} />
          <Tooltip content={<ChartTip suffix=" records" />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={22}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
