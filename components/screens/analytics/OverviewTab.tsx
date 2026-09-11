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
import { APP_TIMEZONE_LABEL } from "@/lib/timezone";
import { ChartPlaceholder } from "./ChartPlaceholder";
import { ChartTip } from "./ChartTip";
import { Legend } from "./Legend";
import { StatusDonut } from "./StatusDonut";
import { VolumeChart } from "./VolumeChart";

/** `demo` is true only when the backend is off. On a live backend anything the
 *  aggregates don't carry renders empty — never a seeded series. Numbers taken
 *  from `targets` are the batches' own upstream summary, so they stay, but they
 *  are labelled as the dispatch-side count they actually are. */
export function OverviewTab({
  targets,
  agg,
  currency,
  hasVoice,
  analytics,
  demo = false,
  loading = false,
}: {
  targets: Batch[];
  agg: ReturnType<typeof aggregate>;
  currency: Currency;
  hasVoice: boolean;
  analytics?: AggregatesDoc | null;
  demo?: boolean;
  loading?: boolean;
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
        : // Not a seed: the selected batches' own upstream outcome breakdown.
          statusMix(targets)
      // Hide statuses with no records — an empty bucket shouldn't get a slice,
      // a legend row, or a zero-length bar.
      ).filter((m) => m.value > 0),
    [analytics, targets],
  );
  const time = useMemo(() => {
    const rows = analytics?.volumeOverTime ?? (demo ? callsOverTime() : null);
    return rows && rows.length ? rows : null;
  }, [analytics, demo]);
  const voiceTarget = targets.find((t) => t.channel === "voice");
  const records = analytics ? analytics.totalRecords : agg.totalCalls + agg.totalMessages;
  const successRate = analytics ? analytics.successRate : agg.successRate;
  const spend = analytics ? analytics.spendInr : agg.spendInr;
  const mixSource = analytics ? "ingested" : "dispatched";
  const stats: { label: string; value: string; sub?: string; icon: string; accentVal?: boolean }[] = [
    // "Ingested" (what analytics actually read) and "dispatched" (what the bulk
    // job sent) are different quantities and legitimately disagree — never
    // present either as a bare "records" count.
    analytics
      ? { label: "Records ingested", value: fmtNum(records), sub: "Pulled into analytics", icon: "Database" }
      : { label: "Records dispatched", value: fmtNum(records), sub: "From the batch summary", icon: "Database" },
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
            {s.sub && <div className="mt-1 text-xs text-slate-400">{s.sub}</div>}
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title="Outcome distribution" subtitle={`Share of ${mixSource} records`}>
          {mix.length ? (
            <StatusDonut data={mix} />
          ) : (
            <ChartPlaceholder loading={loading} icon="ChartPie" title="No outcomes yet" body="No records with an outcome were found for this selection." height={220} />
          )}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="Outcome by volume" subtitle={`Stacked ${mixSource} record counts`}>
          {mix.length ? (
            <StackedStatusBar mix={mix} />
          ) : (
            <ChartPlaceholder loading={loading} icon="ChartColumnBig" title="No outcomes yet" body="No records with an outcome were found for this selection." height={260} />
          )}
        </ChartCard>
      </div>
      <ChartCard
        title="Volume over time"
        subtitle={`Records during the campaign window · times in ${APP_TIMEZONE_LABEL}`}
        action={time && <Legend items={[{ c: "var(--accent)", l: hasVoice ? "Calls" : "Primary" }, { c: "#94a3b8", l: "Messages" }]} />}
      >
        {time ? (
          <VolumeChart data={time} />
        ) : (
          <ChartPlaceholder
            loading={loading}
            icon="CalendarClock"
            title="No volume timeline yet"
            body="These records carry no timestamps we can bucket by day, so there is nothing to plot over time."
            height={260}
          />
        )}
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
