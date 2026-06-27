import { describe, it, expect } from "vitest";
import { diffAggregates } from "@/lib/diff";
import type { AggregatesDoc } from "@/lib/server/types";

/** Minimal AggregatesDoc builder — only the fields the diff reads. */
function agg(over: Partial<AggregatesDoc>): AggregatesDoc {
  return {
    tenantId: "t1",
    accountId: "a1",
    key: "k",
    batchIds: ["b"],
    totalRecords: 0,
    statusMix: [],
    successRate: 0,
    spendInr: 0,
    telephonyInr: 0,
    aiInr: 0,
    computedAt: "2026-06-27T00:00:00.000Z",
    ...over,
  };
}

describe("diffAggregates — scalar deltas", () => {
  const current = agg({ batchIds: ["cur"], totalRecords: 1000, successRate: 0.44, spendInr: 12000, telephonyInr: 8000, aiInr: 4000 });
  const baseline = agg({ batchIds: ["base"], totalRecords: 800, successRate: 0.5, spendInr: 10000, telephonyInr: 7000, aiInr: 3000 });
  const d = diffAggregates(current, baseline);

  it("reports success rate change in percentage points", () => {
    expect(d.successRate.deltaPp).toBeCloseTo(-6.0, 5);
  });

  it("computes absolute + relative spend deltas", () => {
    expect(d.spendInr.delta).toBe(2000);
    expect(d.spendInr.relative).toBeCloseTo(0.2, 5);
  });

  it("computes the telephony cost-split shift", () => {
    // current 8000/12000=0.6667, baseline 7000/10000=0.70 → −0.0333
    expect(d.costSplit.currentTelephonyShare).toBeCloseTo(0.6667, 3);
    expect(d.costSplit.deltaShare).toBeCloseTo(-0.0333, 3);
  });

  it("computes the volume delta", () => {
    expect(d.volume.delta).toBe(200);
  });

  it("preserves which batchIds were current vs baseline (directional)", () => {
    expect(d.current.batchIds).toEqual(["cur"]);
    expect(d.baseline.batchIds).toEqual(["base"]);
  });
});

describe("diffAggregates — directionality & edge cases", () => {
  const a = agg({ totalRecords: 100, successRate: 0.6, spendInr: 5000, telephonyInr: 3000, aiInr: 2000 });
  const b = agg({ totalRecords: 100, successRate: 0.5, spendInr: 4000, telephonyInr: 2000, aiInr: 2000 });

  it("flips sign when current and baseline are swapped", () => {
    const forward = diffAggregates(a, b);
    const backward = diffAggregates(b, a);
    expect(forward.successRate.deltaPp).toBeCloseTo(-backward.successRate.deltaPp, 9);
    expect(forward.spendInr.delta).toBe(-backward.spendInr.delta);
  });

  it("returns relative = null (not Infinity) when baseline is zero", () => {
    const d = diffAggregates(agg({ spendInr: 500 }), agg({ spendInr: 0 }));
    expect(d.spendInr.relative).toBeNull();
  });

  it("is all-zero for identical inputs", () => {
    const d = diffAggregates(a, a);
    expect(d.successRate.deltaPp).toBe(0);
    expect(d.spendInr.delta).toBe(0);
    expect(d.volume.delta).toBe(0);
  });
});

describe("diffAggregates — share shifts use shares, not raw counts", () => {
  // Different volumes: current 1000 records, baseline 100. Raw topic counts
  // differ 10×, but share-of-records is what must be compared.
  const current = agg({
    totalRecords: 1000,
    topics: [{ topic: "dispute", count: 300, sentiment: "negative" }],
    statusMix: [{ key: "completed", value: 600 }, { key: "busy", value: 400 }],
  });
  const baseline = agg({
    totalRecords: 100,
    topics: [{ topic: "dispute", count: 10, sentiment: "negative" }],
    statusMix: [{ key: "completed", value: 50 }, { key: "busy", value: 50 }],
  });
  const d = diffAggregates(current, baseline);

  it("normalizes topic frequency to share-of-records", () => {
    const dispute = d.topicShifts.find((t) => t.key === "dispute")!;
    // 300/1000=0.30 vs 10/100=0.10 → +0.20 share, despite 30× the raw count
    expect(dispute.deltaShare).toBeCloseTo(0.2, 5);
  });

  it("orders shifts by absolute magnitude", () => {
    const mags = d.statusMixShift.map((s) => Math.abs(s.deltaShare));
    expect(mags).toEqual([...mags].sort((x, y) => y - x));
  });
});

describe("diffAggregates — funnel only when both sides are message sets", () => {
  const withFunnel = (sent: number, delivered: number, read: number, replied: number) =>
    agg({
      totalRecords: sent,
      funnel: [
        { stage: "Sent", value: sent },
        { stage: "Delivered", value: delivered },
        { stage: "Read", value: read },
        { stage: "Replied", value: replied },
      ],
    });

  it("computes per-stage retention shift (share of Sent)", () => {
    const d = diffAggregates(withFunnel(1000, 950, 600, 200), withFunnel(500, 480, 250, 50));
    const read = d.funnelShifts!.find((f) => f.stage === "Read")!;
    // 600/1000=0.60 vs 250/500=0.50 → +0.10
    expect(read.deltaShareOfSent).toBeCloseTo(0.1, 5);
  });

  it("omits funnelShifts when either side has no funnel", () => {
    const d = diffAggregates(withFunnel(1000, 950, 600, 200), agg({ totalRecords: 500 }));
    expect(d.funnelShifts).toBeUndefined();
  });
});
