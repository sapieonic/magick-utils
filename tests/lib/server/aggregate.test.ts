import { describe, it, expect } from "vitest";
import { computeAggregates } from "@/lib/server/aggregate";
import type { NormalizedRecord, TenantContext } from "@/lib/server/types";

const ctx: TenantContext = { tenantId: "t1", accountId: "a1", idToken: "tok" };

/** A record as it would be stored by ingestion BEFORE the granular-status fix:
 *  the persisted `status` is the old collapsed value, while `raw.status` still
 *  holds the original core status. */
function rec(stored: string, rawStatus: string): NormalizedRecord {
  return {
    tenantId: "t1", accountId: "a1", batchId: "b1", fingerprint: "f",
    recordId: Math.random().toString(36).slice(2), selType: "ai", channel: "voice",
    status: stored, raw: { status: rawStatus },
  } as NormalizedRecord;
}

const repeat = (n: number, stored: string, raw: string) =>
  Array.from({ length: n }, () => rec(stored, raw));

describe("computeAggregates — statusMix (ClickUp 86d3b6qga)", () => {
  // Records ingested under the OLD mapping, re-bucketed from raw at aggregate time.
  const records: NormalizedRecord[] = [
    ...repeat(943, "completed", "completed"),
    ...repeat(99, "failed", "failed"),
    ...repeat(794, "failed", "switched_off"), // was lumped into failed
    ...repeat(1384, "busy", "busy"),
    ...repeat(8, "noanswer", "no_answer"),
    ...repeat(666, "pending", "voicemail"), // was lumped into pending
    ...repeat(1, "pending", "in_progress"), // was lumped into pending
  ];
  const agg = computeAggregates(records, ["b1"], ctx, "k");
  const mix = Object.fromEntries(agg.statusMix.map((s) => [s.key, s.value]));

  it("splits switched_off out of failed", () => {
    expect(mix.switchedoff).toBe(794);
    expect(mix.failed).toBe(99);
  });

  it("splits voicemail and in_progress out of pending", () => {
    expect(mix.voicemail).toBe(666);
    expect(mix.inprogress).toBe(1);
    expect(mix.pending ?? 0).toBe(0);
  });

  it("leaves completed / busy / no_answer intact", () => {
    expect(mix.completed).toBe(943);
    expect(mix.busy).toBe(1384);
    expect(mix.noanswer).toBe(8);
  });

  it("sums to total and computes successRate from completed", () => {
    expect(agg.statusMix.reduce((a, s) => a + s.value, 0)).toBe(3895);
    expect(agg.successRate).toBeCloseTo(943 / 3895, 9);
  });

  it("falls back to the stored status when raw is unavailable", () => {
    const r = { ...rec("completed", ""), raw: {} } as NormalizedRecord;
    const a = computeAggregates([r], ["b1"], ctx, "k");
    expect(a.statusMix[0]?.key).toBe("completed");
  });
});
