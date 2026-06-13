import { describe, it, expect } from "vitest";
import { aggregate, statusMix, STATUS } from "@/lib/data";
import type { Batch, BreakdownSeg } from "@/lib/types";

function makeBatch(over: Partial<Batch> & { breakdown: BreakdownSeg[] }): Batch {
  return {
    id: "cmp_x",
    batchId: "AI-1",
    name: "Test",
    channel: "voice",
    callType: "ai",
    provider: "Exotel",
    date: "2026-06-09T10:00:00.000Z",
    dayAgo: 0,
    total: 0,
    successRate: 0,
    spendInr: 0,
    telephonyInr: 0,
    aiInr: 0,
    avgDuration: null,
    avgTalkTime: null,
    ...over,
  };
}

describe("aggregate", () => {
  it("empty list yields all zeros and successRate 0 (no divide-by-zero)", () => {
    expect(aggregate([])).toEqual({
      totalCampaigns: 0,
      totalCalls: 0,
      totalMessages: 0,
      spendInr: 0,
      successRate: 0,
    });
  });

  it("counts voice breakdown sums into totalCalls (NOT batch.total)", () => {
    const b = makeBatch({
      channel: "voice",
      callType: "ai",
      total: 9999, // intentionally != breakdown sum to prove sum is used
      breakdown: [
        { key: "completed", value: 60 },
        { key: "noanswer", value: 40 },
      ],
      spendInr: 500,
      successRate: 0.6,
    });
    const r = aggregate([b]);
    expect(r.totalCalls).toBe(100);
    expect(r.totalMessages).toBe(0);
    expect(r.spendInr).toBe(500);
    expect(r.totalCampaigns).toBe(1);
  });

  it("counts non-voice breakdown sums into totalMessages", () => {
    const b = makeBatch({
      channel: "whatsapp",
      callType: null,
      total: 9999,
      breakdown: [
        { key: "read", value: 70 },
        { key: "delivered", value: 30 },
      ],
      spendInr: 200,
      successRate: 0.7,
    });
    const r = aggregate([b]);
    expect(r.totalMessages).toBe(100);
    expect(r.totalCalls).toBe(0);
    expect(r.spendInr).toBe(200);
  });

  it("splits voice vs message across a mixed list and sums spend", () => {
    const voice = makeBatch({
      channel: "voice",
      callType: "ai",
      breakdown: [{ key: "completed", value: 80 }, { key: "failed", value: 20 }],
      spendInr: 1000,
      successRate: 0.8,
    });
    const msg = makeBatch({
      channel: "telegram",
      callType: null,
      breakdown: [{ key: "read", value: 50 }, { key: "delivered", value: 150 }],
      spendInr: 250,
      successRate: 0.25,
    });
    const r = aggregate([voice, msg]);
    expect(r.totalCalls).toBe(100);
    expect(r.totalMessages).toBe(200);
    expect(r.spendInr).toBe(1250);
    expect(r.totalCampaigns).toBe(2);
  });

  it("computes weighted successRate = sum(rate*sum)/sum(sum)", () => {
    // batch A: rate 0.8, sum 100 -> 80
    // batch B: rate 0.25, sum 200 -> 50
    // total weighted = 130, denom = 300 -> 0.4333...
    const a = makeBatch({
      channel: "voice",
      breakdown: [{ key: "completed", value: 80 }, { key: "failed", value: 20 }],
      successRate: 0.8,
    });
    const b = makeBatch({
      channel: "whatsapp",
      callType: null,
      breakdown: [{ key: "read", value: 50 }, { key: "delivered", value: 150 }],
      successRate: 0.25,
    });
    const r = aggregate([a, b]);
    expect(r.successRate).toBeCloseTo(130 / 300, 10);
  });

  it("weighted successRate equals the single rate when one batch", () => {
    const a = makeBatch({
      breakdown: [{ key: "completed", value: 30 }, { key: "noanswer", value: 70 }],
      successRate: 0.3,
    });
    expect(aggregate([a]).successRate).toBeCloseTo(0.3, 10);
  });
});

describe("statusMix", () => {
  it("returns empty array for empty list", () => {
    expect(statusMix([])).toEqual([]);
  });

  it("tallies breakdown values by status key across batches", () => {
    const a = makeBatch({
      breakdown: [{ key: "completed", value: 10 }, { key: "noanswer", value: 5 }],
    });
    const b = makeBatch({
      channel: "voice",
      breakdown: [{ key: "completed", value: 20 }, { key: "busy", value: 3 }],
    });
    const mix = statusMix([a, b]);
    const byKey = Object.fromEntries(mix.map((m) => [m.key, m.value]));
    expect(byKey.completed).toBe(30);
    expect(byKey.noanswer).toBe(5);
    expect(byKey.busy).toBe(3);
  });

  it("maps each tally to STATUS label and color", () => {
    const a = makeBatch({ breakdown: [{ key: "completed", value: 10 }] });
    const mix = statusMix([a]);
    expect(mix).toHaveLength(1);
    expect(mix[0]).toEqual({
      key: "completed",
      name: STATUS.completed.label,
      value: 10,
      color: STATUS.completed.color,
    });
  });

  it("includes one entry per distinct status key encountered", () => {
    const a = makeBatch({
      channel: "whatsapp",
      callType: null,
      breakdown: [
        { key: "read", value: 1 },
        { key: "delivered", value: 2 },
        { key: "bounced", value: 3 },
      ],
    });
    const mix = statusMix([a]);
    expect(mix.map((m) => m.key).sort()).toEqual(["bounced", "delivered", "read"]);
  });
});
