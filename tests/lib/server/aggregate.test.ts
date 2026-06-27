import { describe, it, expect } from "vitest";
import { computeAggregates, REACH_MIN_SAMPLES } from "@/lib/server/aggregate";
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

describe("computeAggregates — reachByTimeOfDay (best-time-to-reach, 4b)", () => {
  /** A timestamped call with an explicit raw status, at a fixed UTC instant. */
  function tsRec(iso: string, rawStatus: string): NormalizedRecord {
    return {
      tenantId: "t1", accountId: "a1", batchId: "b1", fingerprint: "f",
      recordId: Math.random().toString(36).slice(2), selType: "ai", channel: "voice",
      status: rawStatus, timestamp: iso, raw: { status: rawStatus },
    } as NormalizedRecord;
  }
  // 2026-06-23 is a Tuesday (getUTCDay() === 2); 10:00 UTC → band 3 (9–12).
  const tuesday10 = (n: number, completed: number) => [
    ...Array.from({ length: completed }, () => tsRec("2026-06-23T10:00:00Z", "completed")),
    ...Array.from({ length: n - completed }, () => tsRec("2026-06-23T10:00:00Z", "no_answer")),
  ];

  it("buckets records into the correct weekday × hour-band cell", () => {
    const agg = computeAggregates(tuesday10(40, 30), ["b1"], ctx, "k");
    const cell = agg.reachByTimeOfDay!.cells.find((c) => c.weekday === 2 && c.band === 3)!;
    expect(cell.total).toBe(40);
    expect(cell.reached).toBe(30);
    expect(cell.rate).toBeCloseTo(0.75, 5);
    expect(cell.lowSample).toBe(false);
  });

  it("flags cells below the sample gate as lowSample", () => {
    const agg = computeAggregates(tuesday10(REACH_MIN_SAMPLES - 1, 5), ["b1"], ctx, "k");
    expect(agg.reachByTimeOfDay!.cells[0].lowSample).toBe(true);
  });

  it("excludes records with no usable timestamp from the matrix", () => {
    const records = [...tuesday10(25, 20), tsRec("not-a-date", "completed"), { ...tsRec("x", "completed"), timestamp: null } as NormalizedRecord];
    const agg = computeAggregates(records, ["b1"], ctx, "k");
    expect(agg.reachByTimeOfDay!.totalPlaced).toBe(25);
  });

  it("uses the same 'reached' rule as the headline success rate", () => {
    const records = tuesday10(50, 32);
    const agg = computeAggregates(records, ["b1"], ctx, "k");
    const reachedTotal = agg.reachByTimeOfDay!.cells.reduce((a, c) => a + c.reached, 0);
    // successRate * totalRecords should equal total reached across the matrix.
    expect(Math.round(agg.successRate * agg.totalRecords)).toBe(reachedTotal);
  });

  it("counts message 'read' as reached", () => {
    const msg = (status: string) => ({
      tenantId: "t1", accountId: "a1", batchId: "b1", fingerprint: "f",
      recordId: Math.random().toString(36).slice(2), selType: "message", channel: "whatsapp",
      status, timestamp: "2026-06-23T10:00:00Z", raw: { status },
    } as NormalizedRecord);
    const agg = computeAggregates([...Array.from({ length: 30 }, () => msg("read")), ...Array.from({ length: 10 }, () => msg("delivered"))], ["b1"], ctx, "k");
    const cell = agg.reachByTimeOfDay!.cells[0];
    expect(cell.reached).toBe(30);
  });
});
