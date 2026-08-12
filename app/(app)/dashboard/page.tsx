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
  STATUS,
} from "@/lib/data";
import { useApp } from "@/lib/store";
import type { Batch, StatusKey } from "@/lib/types";
import { listCampaigns } from "@/lib/api";
import { inDashboardRange, isDashboardRange, rangeStart, type DashboardRange } from "@/lib/date-range";
import { dashboardVolumeFromCampaigns, fillDashboardDays } from "@/lib/dashboard";
import { Legend } from "@/components/screens/dashboard/Legend";
import { VolumeChart } from "@/components/screens/dashboard/VolumeChart";
import { StatusDonut } from "@/components/screens/dashboard/StatusDonut";

export default function DashboardScreen() {
  const { currency, dateRange, setAnalyzeTargets, user } = useApp();
  const router = useRouter();
  const selectedRange: DashboardRange = isDashboardRange(dateRange) ? dateRange : "Last 30 days";
  const [loadedRange, setLoadedRange] = useState<DashboardRange | null>(null);
  const loading = loadedRange !== selectedRange;
  // Start empty — never seed with mock. listCampaigns() supplies mock only when
  // the backend is off; on a live backend mock data never enters this screen.
  const [batches, setBatches] = useState<Batch[]>([]);
  const [source, setSource] = useState<"live" | "mock">("mock");

  // load via the data seam — returns mock when the backend is off, live data when on
  useEffect(() => {
    let active = true;
    const range: DashboardRange = isDashboardRange(dateRange) ? dateRange : "Last 30 days";
    listCampaigns()
      .then((result) => {
        if (!active) return;
        setBatches(result.batches);
        setSource(result.source);
      })
      .catch(() => {
        if (!active) return;
        setBatches([]);
        // A failed configured backend must never expose demo data as live data.
        setSource("live");
      })
      .finally(() => {
        if (active) setLoadedRange(range);
      });
    return () => {
      active = false;
    };
  }, [dateRange]);

  const rangeBatches = useMemo(
    () => batches.filter((batch) => inDashboardRange(batch.date, selectedRange)),
    [batches, selectedRange],
  );
  const agg = useMemo(() => aggregate(rangeBatches), [rangeBatches]);
  const campaignVolume = useMemo(
    () => dashboardVolumeFromCampaigns(rangeBatches, selectedRange),
    [rangeBatches, selectedRange],
  );
  const timeData = useMemo(() => {
    if (source === "mock") {
      const now = new Date();
      const start = rangeStart(selectedRange, now);
      const mockDays = selectedRange === "Last 7 days" ? 7
        : selectedRange === "Last 30 days" ? 30
          : start ? Math.max(1, Math.floor((now.getTime() - start.getTime()) / 86_400_000) + 1)
            : 180;
      return callsOverTime(mockDays);
    }
    return fillDashboardDays(campaignVolume).map((point) => ({
      ...point,
      date: new Date(`${point.date}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: selectedRange === "All time" ? "numeric" : undefined,
        timeZone: "UTC",
      }),
    }));
  }, [campaignVolume, selectedRange, source]);
  const mix = useMemo(
    () => source === "mock"
      ? statusMix(rangeBatches)
      : campaignVolume.statusMix.map(({ key, value }) => ({
          key,
          value,
          name: STATUS[key as StatusKey]?.label ?? key,
          color: STATUS[key as StatusKey]?.color ?? "#94a3b8",
        })),
    [campaignVolume.statusMix, rangeBatches, source],
  );
  const recent = useMemo(
    () => [...rangeBatches].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 6),
    [rangeBatches],
  );

  // Greet the signed-in user by first name, time-of-day aware. Falls back to a
  // nameless greeting on the mock/no-backend path where no session user exists.
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const first = user?.name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0];
    return first ? `Good ${part}, ${first} 👋` : `Good ${part} 👋`;
  }, [user]);

  const calls = source === "mock" ? agg.totalCalls : campaignVolume.totalCalls;
  const messages = source === "mock" ? agg.totalMessages : campaignVolume.totalMessages;
  const successRate = source === "mock" ? agg.successRate : campaignVolume.successRate;
  const spendInr = source === "mock" ? agg.spendInr : campaignVolume.spendInr;
  const stats = [
    { label: "Campaigns started", value: fmtNum(agg.totalCampaigns), icon: "Layers", delta: source === "mock" ? 12 : null, sub: "batch start date in this period", spark: source === "mock" ? sparkline(11, 14, 18, 8) : undefined },
    { label: "Total calls", value: fmtCompact(calls), icon: "PhoneCall", delta: source === "mock" ? 8 : null, sub: fmtNum(calls) + " from campaigns started in this period", spark: source === "mock" ? sparkline(22, 14, 60, 30) : undefined },
    { label: "Total messages", value: fmtCompact(messages), icon: "MessageSquare", delta: source === "mock" ? 23 : null, sub: fmtNum(messages) + " from campaigns started in this period", spark: source === "mock" ? sparkline(33, 14, 70, 40) : undefined },
    { label: "Success / answer rate", value: fmtPct(successRate), icon: "Target", delta: source === "mock" ? -3 : null, deltaGood: true, sub: "weighted across campaigns in this period", spark: source === "mock" ? sparkline(44, 14, 55, 14) : undefined },
    { label: "Total spend", value: fmtMoney(spendInr, currency), icon: currency === "usd" ? "DollarSign" : "IndianRupee", delta: source === "mock" ? 6 : null, deltaGood: false, sub: fmtMoneyFull(spendInr, currency), spark: source === "mock" ? sparkline(55, 14, 50, 22) : undefined },
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
        <Button variant="secondary" icon="FileDown" className="hidden sm:inline-flex" disabled>
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
          subtitle={`Daily volume by campaign start date · ${dateRange.toLowerCase()} · UTC`}
          action={<Legend items={[{ c: "var(--accent)", l: "Calls" }, { c: "#94a3b8", l: "Messages" }]} />}
        >
          {loading ? (
            <div className="skeleton h-[260px] w-full" />
          ) : timeData.length === 0 ? (
            <div className="flex h-[260px] items-center justify-center px-6 text-center text-sm text-slate-500">
              No campaigns were started in this period.
            </div>
          ) : (
            <VolumeChart data={timeData} />
          )}
        </ChartCard>

        <ChartCard title="Status mix" subtitle="All records this period">
          {loading ? (
            <div className="skeleton h-[260px] w-full" />
          ) : (
            <StatusDonut data={mix} />
          )}
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
                : recent.map((c: Batch) => (
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
