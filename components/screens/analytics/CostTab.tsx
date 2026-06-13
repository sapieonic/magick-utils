"use client";

import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Card, ChartCard, Icon, cx } from "@/components/ui";
import { FX, costBreakdown, fmtCompact, fmtMoney, fmtMoneyFull } from "@/lib/data";
import type { Batch, Currency } from "@/lib/types";
import type { AggregatesDoc } from "@/lib/server/types";
import { Legend } from "./Legend";

type CostTipPayload = { name?: string; value?: number; color?: string };

export function CostTab({ targets, currency, analytics }: { targets: Batch[]; currency: Currency; analytics?: AggregatesDoc | null }) {
  const data = useMemo(
    () => (analytics?.costOverTime ? analytics.costOverTime : costBreakdown()),
    [analytics],
  );
  const tel = analytics ? analytics.telephonyInr : targets.reduce((a, c) => a + c.telephonyInr, 0);
  const ai = analytics ? analytics.aiInr : targets.reduce((a, c) => a + c.aiInr, 0);
  const total = tel + ai;
  return (
    <div className="space-y-4 fade-in">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <CostStat label="Total spend" value={fmtMoney(total, currency)} sub={fmtMoneyFull(total, currency)} icon="Wallet" big />
        <CostStat label="Telephony / delivery" value={fmtMoney(tel, currency)} sub={`${total ? Math.round((tel / total) * 100) : 0}% of spend`} color="var(--accent)" />
        <CostStat label="AI processing" value={fmtMoney(ai, currency)} sub={`${total ? Math.round((ai / total) * 100) : 0}% of spend`} color="#8b3fd6" />
      </div>
      <ChartCard title="Cost over time" subtitle="Telephony vs AI processing" action={<Legend items={[{ c: "var(--accent)", l: "Telephony" }, { c: "#c4b5fd", l: "AI" }]} />}>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id="cTel" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="cAi" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c4b5fd" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#c4b5fd" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (currency === "usd" ? "$" + fmtCompact(v / FX) : "₹" + fmtCompact(v))}
                width={52}
              />
              <Tooltip content={<CostTip currency={currency} />} />
              <Area type="monotone" dataKey="telephony" stackId="1" stroke="var(--accent)" strokeWidth={2} fill="url(#cTel)" />
              <Area type="monotone" dataKey="ai" stackId="1" stroke="#a78bfa" strokeWidth={2} fill="url(#cAi)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </div>
  );
}

function CostStat({ label, value, sub, color, big, icon }: { label: string; value: string; sub: string; color?: string; big?: boolean; icon?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-slate-500">
        {color ? (
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        ) : (
          icon && (
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: "var(--accent-soft)", color: "var(--accent-strong)" }}>
              <Icon name={icon} size={15} />
            </span>
          )
        )}
        {label}
      </div>
      <div className={cx("mt-2.5 font-extrabold tabnum tracking-tight text-slate-900", big ? "text-[28px]" : "text-[24px]")}>{value}</div>
      <div className="text-xs text-slate-400 mt-1">{sub}</div>
    </Card>
  );
}

function CostTip({ active, payload, label, currency }: { active?: boolean; payload?: CostTipPayload[]; label?: string; currency: Currency }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-lg text-xs">
      <div className="font-bold text-slate-700 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500 capitalize">{p.name}</span>
          <span className="ml-auto tabnum font-semibold text-slate-800">{fmtMoneyFull(p.value, currency)}</span>
        </div>
      ))}
    </div>
  );
}
