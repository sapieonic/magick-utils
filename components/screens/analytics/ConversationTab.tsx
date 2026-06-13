"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ChartCard } from "@/components/ui";
import {
  TOPICS,
  durationHistogram,
  fmtCompact,
  fmtNum,
  messagingFunnel,
  sentimentData,
  sparkline,
} from "@/lib/data";
import type { AggregatesDoc } from "@/lib/server/types";
import { ChartTip } from "./ChartTip";
import { Legend } from "./Legend";
import { StatusDonut } from "./StatusDonut";

const SENTIMENT_COLORS: Record<string, string> = { Positive: "#16a34a", Neutral: "#94a3b8", Negative: "#dc2626" };
const FUNNEL_COLORS = ["#94a3b8", "#3b82f6", "#16a34a", "#6366f1"];

export function ConversationTab({ hasVoice, hasMsg, analytics }: { hasVoice: boolean; hasMsg: boolean; analytics?: AggregatesDoc | null }) {
  const dur = useMemo(
    () => (analytics?.durationHistogram ? analytics.durationHistogram : durationHistogram()),
    [analytics],
  );
  const sent = useMemo(
    () =>
      analytics?.sentiment
        ? analytics.sentiment.map((s) => ({ name: s.name, value: s.value, color: SENTIMENT_COLORS[s.name] ?? "#94a3b8" }))
        : sentimentData(),
    [analytics],
  );
  const topics = analytics?.topics ?? TOPICS;
  const funnel = useMemo(
    () =>
      analytics?.funnel
        ? analytics.funnel.map((f, i) => ({ stage: f.stage, value: f.value, color: FUNNEL_COLORS[i % FUNNEL_COLORS.length] }))
        : messagingFunnel(),
    [analytics],
  );
  return (
    <div className="space-y-4 fade-in">
      {hasVoice && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartCard
            className="lg:col-span-2"
            title="Call duration & talk-time"
            subtitle="Distribution across length buckets"
            action={<Legend items={[{ c: "var(--accent)", l: "Calls" }, { c: "#c7d2fe", l: "Talk-time" }]} />}
          >
            <DurationChart data={dur} />
          </ChartCard>
          <ChartCard title="Sentiment" subtitle="From per-call AI analysis">
            <div className="flex flex-col items-center">
              <StatusDonut data={sent} />
            </div>
          </ChartCard>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Key topics" subtitle="Most frequent intents detected by the model">
          <TopicList topics={topics} />
        </ChartCard>
        {hasMsg ? (
          <ChartCard title="Delivery funnel" subtitle="Sent → delivered → read → replied">
            <FunnelView data={funnel} />
          </ChartCard>
        ) : (
          <ChartCard title="Sentiment trend" subtitle="Positive share is climbing late-campaign">
            <SentimentTrend />
          </ChartCard>
        )}
      </div>
    </div>
  );
}

function DurationChart({ data }: { data: { bucket: string; calls: number; talk: number }[] }) {
  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 8, left: -16, bottom: 0 }} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={fmtCompact} width={48} />
          <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
          <Bar dataKey="calls" fill="var(--accent)" radius={[5, 5, 0, 0]} barSize={20} />
          <Bar dataKey="talk" fill="#c7d2fe" radius={[5, 5, 0, 0]} barSize={20} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SentimentTrend() {
  const data = sparkline(99, 12, 40, 10).map((d, i) => ({ name: `Wk ${i + 1}`, positive: Math.min(70, 35 + i * 2.5 + (d.v % 8)) }));
  return (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} unit="%" width={40} />
          <Tooltip content={<ChartTip suffix="%" />} />
          <Line type="monotone" dataKey="positive" stroke="#16a34a" strokeWidth={2.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TopicList({ topics }: { topics: { topic: string; count: number; sentiment: string }[] }) {
  const max = Math.max(...topics.map((t) => t.count));
  const tone: Record<string, string> = { positive: "#16a34a", neutral: "#94a3b8", negative: "#dc2626" };
  return (
    <div className="space-y-2.5">
      {topics.map((t, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-[13px] text-slate-400 w-5 tabnum">{i + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] font-semibold text-slate-700 truncate">{t.topic}</span>
              <span className="text-[12px] tabnum text-slate-400 ml-2">{fmtNum(t.count)}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${(t.count / max) * 100}%`, background: tone[t.sentiment] }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FunnelView({ data }: { data: { stage: string; value: number; color: string }[] }) {
  if (!data.length) return null;
  const max = data[0].value;
  return (
    <div className="space-y-2.5 py-2">
      {data.map((d, i) => {
        const pct = (d.value / max) * 100;
        const dropFromPrev = i > 0 ? ((data[i - 1].value - d.value) / data[i - 1].value) * 100 : 0;
        return (
          <div key={i}>
            <div className="flex items-center justify-between text-[13px] mb-1">
              <span className="font-semibold text-slate-700">{d.stage}</span>
              <span className="tabnum text-slate-500">
                <span className="font-bold text-slate-800">{fmtNum(d.value)}</span> <span className="text-slate-400">({Math.round(pct)}%)</span>
              </span>
            </div>
            <div className="relative h-8 rounded-lg bg-slate-50 overflow-hidden">
              <div className="h-full rounded-lg transition-all flex items-center" style={{ width: `${pct}%`, background: d.color }} />
              {i > 0 && dropFromPrev > 0 && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-red-500">−{Math.round(dropFromPrev)}%</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
