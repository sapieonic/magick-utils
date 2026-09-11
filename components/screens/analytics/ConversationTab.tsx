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
import { ChartCard, cx } from "@/components/ui";
import {
  TOPICS,
  durationHistogram,
  fmtNum,
  messagingFunnel,
  sentimentData,
  sparkline,
} from "@/lib/data";
import {
  VOLUME_CHART_MARGIN,
  VOLUME_Y_AXIS_WIDTH,
  countYAxisScale,
  formatCountTick,
  seriesMax,
} from "@/lib/chart-axis";
import type { AggregatesDoc } from "@/lib/server/types";
import { ChartPlaceholder } from "./ChartPlaceholder";
import { ChartTip } from "./ChartTip";
import { Legend } from "./Legend";
import { StatusDonut } from "./StatusDonut";

const SENTIMENT_COLORS: Record<string, string> = { Positive: "#16a34a", Neutral: "#94a3b8", Negative: "#dc2626" };
const FUNNEL_COLORS = ["#94a3b8", "#3b82f6", "#16a34a", "#6366f1"];

/** Shown wherever the upstream records carry no per-call AI analysis. It is the
 *  real state for plenty of selections, so say it plainly rather than filling
 *  the card with seeded intents. */
const NO_AI_ANALYSIS = "These records don't include per-call AI analysis, so nothing can be charted here.";

/** `demo` is true only when the backend is off (`lib/data.ts` seeds the whole
 *  screen). On a live backend a missing series renders an honest empty state —
 *  mock numbers must never sit beside real ones. */
export function ConversationTab({
  hasVoice,
  hasMsg,
  analytics,
  demo = false,
  loading = false,
}: {
  hasVoice: boolean;
  hasMsg: boolean;
  analytics?: AggregatesDoc | null;
  demo?: boolean;
  loading?: boolean;
}) {
  // Unlike every other series here, the duration histogram is always six rows:
  // `aggregate()` emits one per bucket whether or not anything landed in it. A
  // selection of unanswered calls — or one with no ingested records at all —
  // therefore arrives as six zeroes, and a length check alone would draw an
  // empty chart instead of saying so.
  const dur = useMemo(
    () => withSignal(
      analytics?.durationHistogram ?? (demo ? durationHistogram() : null),
      (row) => row.calls > 0 || row.talk > 0,
    ),
    [analytics, demo],
  );
  const sent = useMemo(
    () =>
      nonEmpty(
        analytics?.sentiment
          ? analytics.sentiment.map((s) => ({ name: s.name, value: s.value, color: SENTIMENT_COLORS[s.name] ?? "#94a3b8" }))
          : demo
            ? sentimentData()
            : null,
      ),
    [analytics, demo],
  );
  const topics = useMemo(() => nonEmpty(analytics?.topics ?? (demo ? TOPICS : null)), [analytics, demo]);
  const funnel = useMemo(
    () =>
      nonEmpty(
        analytics?.funnel
          ? analytics.funnel.map((f, i) => ({ stage: f.stage, value: f.value, color: FUNNEL_COLORS[i % FUNNEL_COLORS.length] }))
          : demo
            ? messagingFunnel()
            : null,
      ),
    [analytics, demo],
  );
  return (
    <div className="space-y-4 fade-in">
      {hasVoice && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ChartCard
            className="lg:col-span-2"
            title="Call duration & talk-time"
            subtitle="Distribution across length buckets"
            action={dur && <Legend items={[{ c: "var(--accent)", l: "Calls" }, { c: "#c7d2fe", l: "Talk-time" }]} />}
          >
            {dur ? (
              <DurationChart data={dur} />
            ) : (
              <ChartPlaceholder
                loading={loading}
                icon="Clock"
                title="No call durations yet"
                body="No connected calls with a recorded duration were ingested for this selection."
                height={260}
              />
            )}
          </ChartCard>
          <ChartCard title="Sentiment" subtitle="From per-call AI analysis">
            <div className="flex flex-col items-center">
              {sent ? (
                // Both the real aggregate and the demo seed are per-sentiment
                // record counts, so the donut's centre total is meaningful here.
                <StatusDonut data={sent} />
              ) : (
                <ChartPlaceholder loading={loading} icon="Smile" title="No sentiment yet" body={NO_AI_ANALYSIS} height={220} />
              )}
            </div>
          </ChartCard>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          className={cx(!hasMsg && !demo && "lg:col-span-2")}
          title="Key topics"
          subtitle="Most frequent intents detected by the model"
        >
          {topics ? (
            <TopicList topics={topics} />
          ) : (
            <ChartPlaceholder loading={loading} icon="MessagesSquare" title="No key topics yet" body={NO_AI_ANALYSIS} variant="rows" />
          )}
        </ChartCard>
        {hasMsg ? (
          <ChartCard title="Delivery funnel" subtitle="Sent → delivered → read → replied">
            {funnel ? (
              <FunnelView data={funnel} />
            ) : (
              <ChartPlaceholder
                loading={loading}
                icon="Send"
                title="No delivery funnel yet"
                body="No delivery, read or reply events have been ingested for these messages."
                variant="rows"
              />
            )}
          </ChartCard>
        ) : (
          // Sentiment-over-time isn't part of `AggregatesDoc`, so outside demo
          // mode this card could only ever apologise. Drop it entirely and let
          // "Key topics" span the row instead of leaving an empty cell.
          demo && (
            <ChartCard title="Sentiment trend" subtitle="Positive share by week">
              <SentimentTrend />
            </ChartCard>
          )
        )}
      </div>
    </div>
  );
}

/** `[]` is truthy, so an aggregate that legitimately contains an empty series
 *  would otherwise render an axis with no bars. Collapse both holes to null. */
function nonEmpty<T>(rows: T[] | null | undefined): T[] | null {
  return rows && rows.length ? rows : null;
}

/** As `nonEmpty`, for a series whose rows exist regardless of whether anything
 *  was measured: present only when at least one row carries a real value. */
function withSignal<T>(rows: T[] | null | undefined, hasValue: (row: T) => boolean): T[] | null {
  return rows && rows.some(hasValue) ? rows : null;
}

function DurationChart({ data }: { data: { bucket: string; calls: number; talk: number }[] }) {
  const { ticks, domain } = useMemo(
    () => countYAxisScale(seriesMax(data.flatMap((row) => [row.calls, row.talk]))),
    [data],
  );
  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ ...VOLUME_CHART_MARGIN }} barGap={2}>
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
          <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
          <Bar dataKey="calls" fill="var(--accent)" radius={[5, 5, 0, 0]} barSize={20} />
          <Bar dataKey="talk" fill="#c7d2fe" radius={[5, 5, 0, 0]} barSize={20} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Demo-only: the seeded rising line reads no real data, and nothing in
 *  `AggregatesDoc` can replace it — so this is rendered only when the backend
 *  is off. */
function SentimentTrend() {
  const data = useMemo(
    () => sparkline(99, 12, 40, 10).map((d, i) => ({ name: `Wk ${i + 1}`, positive: Math.min(70, 35 + i * 2.5 + (d.v % 8)) })),
    [],
  );
  return (
    <div style={{ height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ ...VOLUME_CHART_MARGIN, right: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
          <YAxis
            type="number"
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: "#94a3b8" }}
            tickLine={false}
            axisLine={false}
            unit="%"
            width={48}
          />
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
              <div className="h-full rounded-full" style={{ width: `${(t.count / (max || 1)) * 100}%`, background: tone[t.sentiment] ?? "#94a3b8" }} />
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
        const pct = max ? (d.value / max) * 100 : 0;
        const dropFromPrev = i > 0 && data[i - 1].value ? ((data[i - 1].value - d.value) / data[i - 1].value) * 100 : 0;
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
