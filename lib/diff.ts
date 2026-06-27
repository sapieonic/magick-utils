// Deterministic diff of two AggregatesDoc snapshots (feature 4a — Comparative
// Insights). Pure and client-safe: imports are type-only (erased at build) so
// this module is shared by BOTH the server `/api/insights/compare` route (to
// ground the LLM on code-computed deltas) and the client DeltaGrid (so the
// numbers render even when the LLM is off). Every figure here is computed by
// code; the model only ever *explains* a change, never derives it.

import type { AggregatesDoc, AggregatesDiff, MetricDelta, ShareShift } from "@/lib/server/types";

/** Signed delta between two scalars. `relative` is null when baseline is 0 to
 *  avoid a divide-by-zero / "+∞%" the UI and prompt must not over-read. */
function metricDelta(current: number, baseline: number): MetricDelta {
  const delta = current - baseline;
  return { current, baseline, delta, relative: baseline !== 0 ? delta / baseline : null };
}

/** Per-category share-of-total shift, ordered by absolute magnitude desc.
 *  Uses shares (not raw counts) so a 10k-vs-2k comparison isn't dominated by
 *  size. Keys present on only one side are reported (share 0 on the other). */
function shareShifts(
  current: { key: string; value: number }[],
  baseline: { key: string; value: number }[],
  currentTotal: number,
  baselineTotal: number,
): ShareShift[] {
  const curMap = new Map(current.map((x) => [x.key, x.value]));
  const baseMap = new Map(baseline.map((x) => [x.key, x.value]));
  const keys = new Set<string>([...curMap.keys(), ...baseMap.keys()]);
  return [...keys]
    .map((key) => {
      const currentShare = currentTotal > 0 ? (curMap.get(key) ?? 0) / currentTotal : 0;
      const baselineShare = baselineTotal > 0 ? (baseMap.get(key) ?? 0) / baselineTotal : 0;
      return { key, currentShare, baselineShare, deltaShare: currentShare - baselineShare };
    })
    .sort((a, b) => Math.abs(b.deltaShare) - Math.abs(a.deltaShare));
}

const funnelStageValue = (funnel: AggregatesDoc["funnel"], stage: string): number =>
  funnel?.find((f) => f.stage === stage)?.value ?? 0;

/** Compute every per-metric delta between a `current` and a `baseline`
 *  aggregate. Directional: deltas are `current − baseline`; swapping the
 *  arguments flips every sign. */
export function diffAggregates(current: AggregatesDoc, baseline: AggregatesDoc): AggregatesDiff {
  const curTotal = current.totalRecords;
  const baseTotal = baseline.totalRecords;

  const successRate = {
    current: current.successRate,
    baseline: baseline.successRate,
    deltaPp: (current.successRate - baseline.successRate) * 100,
    relative: baseline.successRate !== 0 ? (current.successRate - baseline.successRate) / baseline.successRate : null,
  };

  const curTelephonyShare = current.spendInr > 0 ? current.telephonyInr / current.spendInr : 0;
  const baseTelephonyShare = baseline.spendInr > 0 ? baseline.telephonyInr / baseline.spendInr : 0;

  // Topic counts are keyed `topic`; normalize into the {key,value} shape.
  const topicShifts = shareShifts(
    (current.topics ?? []).map((t) => ({ key: t.topic, value: t.count })),
    (baseline.topics ?? []).map((t) => ({ key: t.topic, value: t.count })),
    curTotal,
    baseTotal,
  );

  const sentimentShift = shareShifts(
    (current.sentiment ?? []).map((s) => ({ key: s.name, value: s.value })),
    (baseline.sentiment ?? []).map((s) => ({ key: s.name, value: s.value })),
    curTotal,
    baseTotal,
  );

  const statusMixShift = shareShifts(current.statusMix, baseline.statusMix, curTotal, baseTotal);

  // Funnel diff only when both sides carry a funnel (message sets). Share is of
  // each side's own Sent so retention is comparable across differing volumes.
  let funnelShifts: AggregatesDiff["funnelShifts"];
  if (current.funnel && baseline.funnel) {
    const curSent = funnelStageValue(current.funnel, "Sent");
    const baseSent = funnelStageValue(baseline.funnel, "Sent");
    const stages = ["Sent", "Delivered", "Read", "Replied"];
    funnelShifts = stages.map((stage) => {
      const cur = funnelStageValue(current.funnel, stage);
      const base = funnelStageValue(baseline.funnel, stage);
      const currentShareOfSent = curSent > 0 ? cur / curSent : 0;
      const baselineShareOfSent = baseSent > 0 ? base / baseSent : 0;
      return {
        stage,
        current: cur,
        baseline: base,
        currentShareOfSent,
        baselineShareOfSent,
        deltaShareOfSent: currentShareOfSent - baselineShareOfSent,
      };
    });
  }

  return {
    current: { batchIds: current.batchIds, totalRecords: curTotal },
    baseline: { batchIds: baseline.batchIds, totalRecords: baseTotal },
    successRate,
    spendInr: metricDelta(current.spendInr, baseline.spendInr),
    telephonyInr: metricDelta(current.telephonyInr, baseline.telephonyInr),
    aiInr: metricDelta(current.aiInr, baseline.aiInr),
    costSplit: {
      currentTelephonyShare: curTelephonyShare,
      baselineTelephonyShare: baseTelephonyShare,
      deltaShare: curTelephonyShare - baseTelephonyShare,
    },
    volume: metricDelta(curTotal, baseTotal),
    topicShifts,
    statusMixShift,
    sentimentShift,
    funnelShifts,
  };
}
