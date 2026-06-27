"use client";

import { ChartCard, EmptyState, Icon } from "@/components/ui";
import { fmtNum, fmtPct } from "@/lib/data";
import { WEEKDAY_ROW_ORDER, WEEKDAY_SHORT, bestReachWindow, formatBand, reachLowSampleRatio } from "@/lib/reach";
import type { ReachByTimeOfDay } from "@/lib/server/types";

const HATCH = "repeating-linear-gradient(45deg, #f1f5f9, #f1f5f9 4px, #e2e8f0 4px, #e2e8f0 8px)";

/** Best-time-to-reach heatmap (4b): weekday × hour-band answer/read rate. Low
 *  confidence (sub-sample-gate) cells are hatched + greyed + explained on hover
 *  so a 100%-of-3 cell never reads as a strong signal — confidence is conveyed
 *  by pattern + text, never color alone. */
export function ReachHeatmap({ reach, isMessage }: { reach: ReachByTimeOfDay; isMessage: boolean }) {
  const rateLabel = isMessage ? "Read rate" : "Answer rate";
  const bands = [...new Set(reach.cells.map((c) => c.band))].sort((a, b) => a - b);
  const byKey = new Map(reach.cells.map((c) => [`${c.weekday}:${c.band}`, c]));
  const window = bestReachWindow(reach);
  const tooSparse = reachLowSampleRatio(reach) > 0.6 || reach.totalPlaced === 0;

  if (reach.cells.length === 0) {
    return (
      <ChartCard title="Best time to reach" subtitle={`${rateLabel} by weekday and hour · times in UTC`}>
        <EmptyState icon="CalendarClock" title="Not enough call history for a time pattern" body="We need more answered records across the week to recommend a window." />
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Best time to reach" subtitle={`${rateLabel} by weekday and hour · times in UTC`}>
      <div role="img" aria-label={window ? `${rateLabel} heatmap, best window ${window.dayRange} ${window.bandLabel}` : `${rateLabel} heatmap`}>
        {/* column headers */}
        <div className="grid gap-1 mb-1" style={{ gridTemplateColumns: `2.6rem repeat(${bands.length}, minmax(0, 1fr))` }}>
          <div />
          {bands.map((b) => (
            <div key={b} className="text-center text-[10px] font-medium text-slate-400 whitespace-nowrap">
              {formatBand(b, reach.bandHours)}
            </div>
          ))}
        </div>
        {/* rows */}
        <div className="space-y-1">
          {WEEKDAY_ROW_ORDER.map((weekday) => (
            <div key={weekday} className="grid gap-1 items-center" style={{ gridTemplateColumns: `2.6rem repeat(${bands.length}, minmax(0, 1fr))` }}>
              <div className="text-[11px] font-semibold text-slate-500">{WEEKDAY_SHORT[weekday]}</div>
              {bands.map((band) => {
                const cell = byKey.get(`${weekday}:${band}`);
                if (!cell || cell.total === 0) {
                  return <div key={band} className="h-9 rounded-md bg-slate-50" title={`${WEEKDAY_SHORT[weekday]} ${formatBand(band, reach.bandHours)} · no records`} />;
                }
                const low = cell.lowSample;
                const pct = Math.round(20 + cell.rate * 75); // 20–95% accent tint
                const bg = low ? HATCH : `color-mix(in srgb, var(--accent) ${pct}%, white)`;
                const textCls = low ? "text-slate-400" : cell.rate > 0.5 ? "text-white" : "text-slate-700";
                const label = `${WEEKDAY_SHORT[weekday]} ${formatBand(band, reach.bandHours)} · ${fmtPct(cell.rate)} · ${fmtNum(cell.total)} ${isMessage ? "messages" : "calls"}${low ? " — too few to be reliable" : ""}`;
                return (
                  <button
                    key={band}
                    title={label}
                    aria-label={label}
                    className="h-9 rounded-md flex items-center justify-center text-[11px] font-semibold tabnum focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] transition-transform hover:scale-[1.04]"
                    style={{ background: bg }}
                  >
                    <span className={textCls}>{low ? "·" : fmtPct(cell.rate)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* legend */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <span>Low</span>
            <div className="flex">
              {[20, 40, 60, 80, 95].map((p) => (
                <span key={p} className="h-3 w-4" style={{ background: `color-mix(in srgb, var(--accent) ${p}%, white)` }} />
              ))}
            </div>
            <span>High</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-4 rounded-sm" style={{ background: HATCH }} />
            <span>Too few samples (&lt;{reach.minSamples})</span>
          </div>
        </div>
      </div>

      {/* recommendation / insufficient-data banner */}
      {window && !tooSparse ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 flex items-start gap-3">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white" style={{ background: "var(--accent)" }}>
            <Icon name="Lightbulb" size={16} />
          </span>
          <div>
            <div className="text-[13.5px] font-bold text-slate-800">
              Best window: {window.dayRange}, {window.bandLabel}
            </div>
            <p className="text-[13px] leading-relaxed text-slate-500 mt-0.5">
              {isMessage ? "Read" : "Pickup"} rate runs {window.liftPp.toFixed(0)} pts above the selection average here ({fmtPct(window.rate)} vs {fmtPct(window.meanRate)}). Schedule the next run toward this window.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 flex items-start gap-2.5 text-[13px] text-slate-500">
          <Icon name="Info" size={15} className="mt-0.5 shrink-0 text-slate-400" />
          <span>Not enough answered records across the week to recommend a reliable window yet.</span>
        </div>
      )}
    </ChartCard>
  );
}
