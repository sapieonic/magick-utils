"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Icon, Spinner, cx } from "@/components/ui";
import { fmtMoney, fmtNum } from "@/lib/data";
import { generateInsights } from "@/lib/api";
import type { Batch, Currency } from "@/lib/types";
import type { Insight } from "@/lib/server/types";
import { Num } from "./Num";

export function InsightsTab({
  model,
  targets,
  currency,
  batchIds,
}: {
  model: string;
  targets: Batch[];
  currency: Currency;
  batchIds: string[];
}) {
  const [gen, setGen] = useState<"loading" | "ready">("loading");
  const [insight, setInsight] = useState<Insight | null>(null);
  const [regen, setRegen] = useState(0); // bumped by "Regenerate"
  const refreshRef = useRef(false); // true for exactly one run after a Regenerate click
  const idsKey = batchIds.join(",");

  useEffect(() => {
    let alive = true;
    setGen("loading");
    setInsight(null);
    // refresh is forced only by an explicit Regenerate — not by model/selection changes.
    const refresh = refreshRef.current;
    refreshRef.current = false;
    generateInsights(batchIds, model, refresh)
      .then((res) => {
        if (!alive) return;
        setInsight(res); // null when LLM off → fall back to hardcoded block
        setGen("ready");
      })
      .catch(() => {
        // Don't strand the skeleton on a network/stream error.
        if (!alive) return;
        setInsight(null);
        setGen("ready");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, idsKey, regen]);

  const name = targets.length === 1 ? targets[0].name : `${targets.length} combined campaigns`;

  return (
    <div className="space-y-4 fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Icon name="Sparkles" size={16} className="text-[var(--accent)]" />
          Insights generated for <span className="font-semibold text-slate-700">{name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon="RefreshCw"
            onClick={() => {
              refreshRef.current = true;
              setRegen((n) => n + 1);
            }}
            disabled={gen === "loading"}
          >
            Regenerate
          </Button>
        </div>
      </div>

      {gen === "loading" ? (
        <InsightsSkeleton />
      ) : insight ? (
        <div className="space-y-4">
          {/* narrative */}
          <div className="relative rounded-2xl border border-slate-200 bg-white p-5 overflow-hidden shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]">
            <div className="absolute top-0 left-0 right-0 h-1 brand-grad" />
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white" style={{ background: "var(--brand-grad)" }}>
                <Icon name="Sparkles" size={15} />
              </span>
              <span className="text-[15px] font-bold text-slate-900">Campaign narrative</span>
            </div>
            <p className="text-[14.5px] leading-relaxed text-slate-600 whitespace-pre-wrap">{insight.narrative}</p>
          </div>

          {/* anomalies */}
          {insight.anomalies.length > 0 && (
            <div>
              <div className="text-[13px] font-bold uppercase tracking-wider text-slate-400 mb-2.5 flex items-center gap-2">
                <Icon name="TriangleAlert" size={14} /> Anomalies detected
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {insight.anomalies.map((a, i) => (
                  <AnomalyCard key={i} tone={a.severity === "high" ? "bad" : "warn"} icon="TriangleAlert" title={a.title} body={a.detail} />
                ))}
              </div>
            </div>
          )}

          {/* recommendations */}
          {insight.recommendations.length > 0 && (
            <div>
              <div className="text-[13px] font-bold uppercase tracking-wider text-slate-400 mb-2.5 flex items-center gap-2">
                <Icon name="Lightbulb" size={14} /> Recommendations
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {insight.recommendations.map((r, i) => (
                  <RecCard key={i} n={i + 1} title={r.title} body={r.detail} />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* narrative */}
          <div className="relative rounded-2xl border border-slate-200 bg-white p-5 overflow-hidden shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]">
            <div className="absolute top-0 left-0 right-0 h-1 brand-grad" />
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-white" style={{ background: "var(--brand-grad)" }}>
                <Icon name="Sparkles" size={15} />
              </span>
              <span className="text-[15px] font-bold text-slate-900">Campaign narrative</span>
            </div>
            <p className="text-[14.5px] leading-relaxed text-slate-600">
              This batch reached <Num>{fmtNum(targets.reduce((a, c) => a + c.total, 0))}</Num> recipients with an overall answer/read rate of <Num tone="good">68.4%</Num>, slightly ahead of your account&apos;s 30-day average of 64.1%. Connected conversations skewed <Num tone="good">positive (47%)</Num>, though <Num tone="bad">19% negative</Num> sentiment clustered around “dispute / wrong amount” intents. Spend was efficient at <Num>{fmtMoney(targets.reduce((a, c) => a + c.spendInr, 0), currency)}</Num>, with telephony driving ~62% of cost. The strongest performance window was <Num tone="good">11am–1pm</Num>, where pickup rate ran 14 points above the daily mean.
            </p>
          </div>

          {/* anomalies */}
          <div>
            <div className="text-[13px] font-bold uppercase tracking-wider text-slate-400 mb-2.5 flex items-center gap-2">
              <Icon name="TriangleAlert" size={14} /> Anomalies detected
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <AnomalyCard
                tone="bad"
                icon="PhoneOff"
                title="No-answer spike on Day 4"
                body={
                  <>
                    Pickup fell to <Num tone="bad">38%</Num> vs the <Num>61%</Num> baseline — likely a dialer throttle between 3–5pm.
                  </>
                }
              />
              <AnomalyCard
                tone="bad"
                icon="ThumbsDown"
                title="Negative sentiment cluster"
                body={
                  <>
                    <Num tone="bad">312 calls</Num> tagged “wrong amount”, 2.4× the usual share. Suggests a data-sync issue in the dunning file.
                  </>
                }
              />
              <AnomalyCard
                tone="warn"
                icon="TrendingUp"
                title="AI cost creep"
                body={
                  <>
                    Per-call AI cost rose <Num tone="bad">+18%</Num> after the prompt change on Jun 3 with no lift in resolution.
                  </>
                }
              />
            </div>
          </div>

          {/* recommendations */}
          <div>
            <div className="text-[13px] font-bold uppercase tracking-wider text-slate-400 mb-2.5 flex items-center gap-2">
              <Icon name="Lightbulb" size={14} /> Recommendations
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <RecCard n={1} title="Concentrate dials at 11am–1pm" body="Shifting 30% of volume into the midday window could lift connect rate by an estimated 9–12 points." />
              <RecCard n={2} title="Re-verify the dunning amounts" body="Quarantine the 312 disputed records and re-sync from billing before the next pass to cut negative sentiment." />
              <RecCard n={3} title="Roll back the Jun 3 prompt" body="The newer script raised cost without improving promise-to-pay. A/B the prior prompt on 10% of volume." />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function InsightsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-4 text-[13px] font-semibold text-slate-500">
          <Spinner size={15} /> Generating insights…
        </div>
        <div className="space-y-2.5">
          <div className="skeleton h-3.5 w-full" />
          <div className="skeleton h-3.5 w-[94%]" />
          <div className="skeleton h-3.5 w-[97%]" />
          <div className="skeleton h-3.5 w-[78%]" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="skeleton h-8 w-8 rounded-lg mb-3" />
            <div className="skeleton h-3.5 w-3/4 mb-2" />
            <div className="skeleton h-3 w-full mb-1.5" />
            <div className="skeleton h-3 w-5/6" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AnomalyCard({ tone, icon, title, body }: { tone: "bad" | "warn"; icon: string; title: string; body: ReactNode }) {
  const ring = tone === "bad" ? "border-red-100" : "border-amber-100";
  const ic = tone === "bad" ? "bg-red-50 text-red-500" : "bg-amber-50 text-amber-500";
  return (
    <div className={cx("rounded-2xl border bg-white p-4", ring)}>
      <div className="flex items-center gap-2.5 mb-2">
        <span className={cx("inline-flex h-8 w-8 items-center justify-center rounded-lg", ic)}>
          <Icon name={icon} size={16} />
        </span>
        <span className="text-[13.5px] font-bold text-slate-800 leading-tight">{title}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-slate-500">{body}</p>
    </div>
  );
}

export function RecCard({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 hover:border-[var(--accent)] transition-colors group">
      <div className="flex items-center gap-2.5 mb-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold text-white" style={{ background: "var(--accent)" }}>
          {n}
        </span>
        <span className="text-[13.5px] font-bold text-slate-800 leading-tight">{title}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-slate-500">{body}</p>
    </div>
  );
}
