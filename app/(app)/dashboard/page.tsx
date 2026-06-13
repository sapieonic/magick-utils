"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, Button, TypeDot, TypeBadge, StatusStackBar, SkeletonRow, StatCard, ChartCard } from "@/components/ui";
import {
  aggregate,
  callsOverTime,
  statusMix,
  sparkline,
  typeKey,
  fmtNum,
  fmtCompact,
  fmtMoney,
  fmtMoneyFull,
  fmtPct,
  fmtDate,
} from "@/lib/data";
import { useApp } from "@/lib/store";
import type { Batch } from "@/lib/types";
import { listCampaigns } from "@/lib/api";
import { Legend } from "@/components/screens/dashboard/Legend";
import { VolumeChart } from "@/components/screens/dashboard/VolumeChart";
import { StatusDonut } from "@/components/screens/dashboard/StatusDonut";

export default function DashboardScreen() {
  const { currency, dateRange, setAnalyzeTargets, user } = useApp();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  // Start empty — never seed with mock. listCampaigns() supplies mock only when
  // the backend is off; on a live backend mock data never enters this screen.
  const [batches, setBatches] = useState<Batch[]>([]);
  const [source, setSource] = useState<"live" | "mock">("mock");

  // load via the data seam — returns mock when the backend is off, live data when on
  useEffect(() => {
    setLoading(true);
    let active = true;
    listCampaigns()
      .then((r) => {
        if (!active) return;
        setBatches(r.batches);
        setSource(r.source);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [dateRange]);

  const agg = useMemo(() => aggregate(batches), [batches]);
  const timeData = useMemo(() => {
    if (source === "mock") return callsOverTime();
    // Window to the 30 days ending at the most recent batch, matching the
    // "last 30 days" subtitle. Use breakdown sum (not b.total) so volume
    // reconciles with the stat cards, which derive from breakdown.
    const acc = new Map<string, { date: string; calls: number; messages: number; ts: number }>();
    const latest = batches.reduce((mx, b) => Math.max(mx, new Date(b.date).getTime()), 0);
    const cutoff = latest - 30 * 24 * 60 * 60 * 1000;
    batches.forEach((b) => {
      const dt = new Date(b.date);
      if (dt.getTime() < cutoff) return;
      const label = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const ts = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
      const count = b.breakdown.reduce((s, x) => s + x.value, 0);
      const cur = acc.get(label) ?? { date: label, calls: 0, messages: 0, ts };
      if (b.channel === "voice") cur.calls += count;
      else cur.messages += count;
      acc.set(label, cur);
    });
    return Array.from(acc.values())
      .sort((a, b) => a.ts - b.ts)
      .map(({ date, calls, messages }) => ({ date, calls, messages }));
  }, [batches, source]);
  const mix = useMemo(() => statusMix(batches), [batches]);
  const recent = useMemo(
    () => [...batches].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 6),
    [batches],
  );

  // Greet the signed-in user by first name, time-of-day aware. Falls back to a
  // nameless greeting on the mock/no-backend path where no session user exists.
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const first = user?.name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0];
    return first ? `Good ${part}, ${first} 👋` : `Good ${part} 👋`;
  }, [user]);

  const stats = [
    { label: "Total campaigns", value: fmtNum(agg.totalCampaigns), icon: "Layers", delta: 12, sub: "across all channels", spark: sparkline(11, 14, 18, 8) },
    { label: "Total calls", value: fmtCompact(agg.totalCalls), icon: "PhoneCall", delta: 8, sub: fmtNum(agg.totalCalls) + " calls placed", spark: sparkline(22, 14, 60, 30) },
    { label: "Total messages", value: fmtCompact(agg.totalMessages), icon: "MessageSquare", delta: 23, sub: fmtNum(agg.totalMessages) + " sent", spark: sparkline(33, 14, 70, 40) },
    { label: "Success / answer rate", value: fmtPct(agg.successRate), icon: "Target", delta: -3, deltaGood: true, sub: "weighted across batches", spark: sparkline(44, 14, 55, 14) },
    { label: "Total spend", value: fmtMoney(agg.spendInr, currency), icon: currency === "usd" ? "DollarSign" : "IndianRupee", delta: 6, deltaGood: false, sub: fmtMoneyFull(agg.spendInr, currency), spark: sparkline(55, 14, 50, 22) },
  ];

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
      <div className="flex items-end justify-between gap-4 mb-5">
        <div>
          <div className="text-sm text-slate-400">{greeting}</div>
          <div className="text-[15px] text-slate-500 mt-0.5">
            Here&apos;s what happened in your campaigns over the{" "}
            <span className="font-semibold text-slate-700">{dateRange.toLowerCase()}</span>.
          </div>
        </div>
        <Button variant="secondary" icon="FileDown" className="hidden sm:inline-flex">
          Export report
        </Button>
      </div>

      {/* stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {stats.map((s, i) => (
          <StatCard key={i} {...s} loading={loading} />
        ))}
      </div>

      {/* charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <ChartCard
          className="lg:col-span-2"
          title="Calls & messages over time"
          subtitle="Daily volume, last 30 days"
          action={<Legend items={[{ c: "var(--accent)", l: "Calls" }, { c: "#94a3b8", l: "Messages" }]} />}
        >
          {loading ? <div className="skeleton h-[260px] w-full" /> : <VolumeChart data={timeData} />}
        </ChartCard>

        <ChartCard title="Status mix" subtitle="All records this period">
          {loading ? <div className="skeleton h-[260px] w-full" /> : <StatusDonut data={mix} />}
        </ChartCard>
      </div>

      {/* recent campaigns */}
      <Card className="mt-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <div className="text-[15px] font-bold text-slate-900">Recent campaigns</div>
            <div className="text-xs text-slate-400 mt-0.5">Latest batches across all channels</div>
          </div>
          <Button variant="ghost" size="sm" iconRight="ArrowRight" onClick={() => router.push("/campaigns")}>
            View all
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                <th className="px-5 py-2.5 font-bold">Campaign</th>
                <th className="px-3 py-2.5 font-bold">Type</th>
                <th className="px-3 py-2.5 font-bold">Date</th>
                <th className="px-3 py-2.5 font-bold text-right">Records</th>
                <th className="px-3 py-2.5 font-bold">Status breakdown</th>
                <th className="px-3 py-2.5 font-bold text-right">Success</th>
                <th className="px-5 py-2.5 font-bold text-right">Spend</th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={7}>
                        <SkeletonRow cols={6} />
                      </td>
                    </tr>
                  ))
                : recent.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-slate-50 hover:bg-slate-50/70 transition-colors cursor-pointer group"
                      onClick={() => {
                        setAnalyzeTargets([c.id]);
                        router.push("/analytics");
                      }}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <TypeDot tkey={typeKey(c)} />
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-800 truncate group-hover:text-[var(--accent-strong)]">{c.name}</div>
                            <div className="text-[11px] font-mono text-slate-400">
                              {c.batchId} · {c.provider}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <TypeBadge tkey={typeKey(c)} size="sm" />
                      </td>
                      <td className="px-3 py-3 text-slate-500 whitespace-nowrap">{fmtDate(c.date)}</td>
                      <td className="px-3 py-3 text-right tabnum font-semibold text-slate-700">{fmtNum(c.total)}</td>
                      <td className="px-3 py-3">
                        <StatusStackBar breakdown={c.breakdown} />
                      </td>
                      <td className="px-3 py-3 text-right tabnum font-semibold text-slate-700">{fmtPct(c.successRate)}</td>
                      <td className="px-5 py-3 text-right tabnum font-semibold text-slate-700">{fmtMoney(c.spendInr, currency)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
