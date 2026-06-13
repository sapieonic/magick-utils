import { describe, it, expect } from "vitest";
import { computeAggregates } from "@/lib/server/aggregate";
import { makeCtx, makeRecord } from "./_factories";

const ctx = makeCtx();
const agg = (records: Parameters<typeof computeAggregates>[0], batchIds = ["b1"]) =>
  computeAggregates(records, batchIds, ctx, "k");

describe("computeAggregates — totals & status mix", () => {
  it("empty records: zeros, no funnel, empty collections", () => {
    const a = agg([]);
    expect(a.totalRecords).toBe(0);
    expect(a.statusMix).toEqual([]);
    expect(a.successRate).toBe(0);
    expect(a.spendInr).toBe(0);
    expect(a.funnel).toBeUndefined();
    expect(a.volumeOverTime).toEqual([]);
    expect(a.costOverTime).toEqual([]);
    expect(a.sentiment).toEqual([]);
    expect(a.topics).toEqual([]);
    // histogram still has all six buckets at zero
    expect(a.durationHistogram).toHaveLength(6);
    expect(a.durationHistogram!.every((h) => h.calls === 0 && h.talk === 0)).toBe(true);
  });

  it("counts status mix from raw.status (re-bucketed) and falls back to stored status", () => {
    const records = [
      makeRecord({ status: "completed", raw: { status: "completed" } }),
      makeRecord({ status: "failed", raw: { status: "switched_off" } }), // re-bucketed to switchedoff
      makeRecord({ status: "completed", raw: {} }), // no raw.status -> stored
    ];
    const mix = Object.fromEntries(agg(records).statusMix.map((s) => [s.key, s.value]));
    expect(mix.completed).toBe(2);
    expect(mix.switchedoff).toBe(1);
    expect(mix.failed ?? 0).toBe(0);
  });

  it("successRate counts completed OR read over total", () => {
    const records = [
      makeRecord({ raw: { status: "completed" } }),
      makeRecord({ selType: "message", channel: "whatsapp", raw: { status: "read" } }),
      makeRecord({ raw: { status: "failed" } }),
      makeRecord({ raw: { status: "busy" } }),
    ];
    // not a pure message set, so funnel undefined; success = completed(1)+read(1)=2 / 4
    expect(agg(records).successRate).toBe(0.5);
  });

  it("sums spend / telephony / ai", () => {
    const records = [
      makeRecord({ totalCostInr: 10, telephonyCostInr: 6, aiCostInr: 4, raw: { status: "completed" } }),
      makeRecord({ totalCostInr: 5, telephonyCostInr: 3, aiCostInr: 2, raw: { status: "failed" } }),
    ];
    const a = agg(records);
    expect(a.spendInr).toBe(15);
    expect(a.telephonyInr).toBe(9);
    expect(a.aiInr).toBe(6);
  });
});

describe("computeAggregates — duration histogram boundaries", () => {
  // durationBucket: <30 ->0-30s; <60 ->30-60s; <120 ->1-2m; <180 ->2-3m; <300 ->3-5m; else 5m+
  // Boundaries are exclusive at the top, so the boundary value falls in the UPPER bucket.
  const cases: Array<[number, string]> = [
    [0, "0–30s"],
    [29, "0–30s"],
    [30, "30–60s"], // boundary 30 -> upper bucket
    [59, "30–60s"],
    [60, "1–2m"], // boundary 60 -> upper
    [119, "1–2m"],
    [120, "2–3m"], // boundary 120 -> upper
    [179, "2–3m"],
    [180, "3–5m"], // boundary 180 -> upper
    [299, "3–5m"],
    [300, "5m+"], // boundary 300 -> upper
    [600, "5m+"],
  ];
  it.each(cases)("duration %d falls in bucket %s", (sec, bucket) => {
    const a = agg([makeRecord({ durationSeconds: sec, raw: { status: "completed" } })]);
    const hit = a.durationHistogram!.find((h) => h.bucket === bucket)!;
    expect(hit.calls).toBe(1);
    // all other buckets are 0 calls
    expect(a.durationHistogram!.filter((h) => h.calls > 0)).toHaveLength(1);
  });

  it("buckets talk time independently from calls", () => {
    const a = agg([makeRecord({ durationSeconds: 45, talkTimeSeconds: 200, raw: { status: "completed" } })]);
    expect(a.durationHistogram!.find((h) => h.bucket === "30–60s")!.calls).toBe(1);
    expect(a.durationHistogram!.find((h) => h.bucket === "3–5m")!.talk).toBe(1);
  });

  it("skips non-numeric durations", () => {
    const a = agg([makeRecord({ durationSeconds: null, talkTimeSeconds: null, raw: { status: "completed" } })]);
    expect(a.durationHistogram!.every((h) => h.calls === 0 && h.talk === 0)).toBe(true);
  });
});

describe("computeAggregates — sentiment", () => {
  it("capitalizes names and filters out zero-value categories", () => {
    const records = [
      makeRecord({ sentiment: "positive", raw: { status: "completed" } }),
      makeRecord({ sentiment: "Positive", raw: { status: "completed" } }), // lowercased key merge
      makeRecord({ sentiment: "negative", raw: { status: "failed" } }),
    ];
    const a = agg(records);
    expect(a.sentiment).toEqual([
      { name: "Positive", value: 2 },
      { name: "Negative", value: 1 },
    ]); // Neutral dropped (0)
  });

  it("empty when no sentiment", () => {
    expect(agg([makeRecord({ raw: { status: "completed" } })]).sentiment).toEqual([]);
  });
});

describe("computeAggregates — topics", () => {
  it("returns top-9 sorted desc by count", () => {
    // 11 distinct topics with descending frequencies
    const records = [];
    for (let i = 0; i < 11; i++) {
      const topic = `t${i}`;
      const freq = 11 - i; // t0 most frequent
      for (let j = 0; j < freq; j++) {
        records.push(makeRecord({ keyTopics: [topic], raw: { status: "completed" } }));
      }
    }
    const a = agg(records);
    expect(a.topics).toHaveLength(9);
    expect(a.topics![0]).toEqual({ topic: "t0", count: 11, sentiment: "neutral" });
    expect(a.topics![8].topic).toBe("t8");
    // counts strictly descending
    const counts = a.topics!.map((t) => t.count);
    expect([...counts].sort((x, y) => y - x)).toEqual(counts);
  });

  it("ignores records with no keyTopics", () => {
    expect(agg([makeRecord({ keyTopics: null, raw: { status: "completed" } })]).topics).toEqual([]);
  });
});

describe("computeAggregates — funnel", () => {
  it("present only when every record is selType message", () => {
    const records = [
      makeRecord({ selType: "message", channel: "whatsapp", status: "read", replyText: "yes", raw: { status: "read" } }),
      makeRecord({ selType: "message", channel: "whatsapp", status: "delivered", raw: { status: "delivered" } }),
      makeRecord({ selType: "message", channel: "whatsapp", status: "sent", raw: { status: "sent" } }),
    ];
    const a = agg(records);
    expect(a.funnel).toEqual([
      { stage: "Sent", value: 3 }, // total
      { stage: "Delivered", value: 2 }, // delivered + read
      { stage: "Read", value: 1 },
      { stage: "Replied", value: 1 }, // non-empty replyText
    ]);
  });

  it("undefined when mixed selTypes", () => {
    const records = [
      makeRecord({ selType: "message", channel: "whatsapp", status: "read", raw: { status: "read" } }),
      makeRecord({ selType: "ai", status: "completed", raw: { status: "completed" } }),
    ];
    expect(agg(records).funnel).toBeUndefined();
  });

  it("replied counts only records with non-empty trimmed replyText", () => {
    const records = [
      makeRecord({ selType: "message", channel: "whatsapp", status: "read", replyText: "hi", raw: { status: "read" } }),
      makeRecord({ selType: "message", channel: "whatsapp", status: "read", replyText: "   ", raw: { status: "read" } }), // whitespace-only
      makeRecord({ selType: "message", channel: "whatsapp", status: "read", replyText: null, raw: { status: "read" } }),
    ];
    const a = agg(records);
    expect(a.funnel!.find((f) => f.stage === "Replied")!.value).toBe(1);
  });

  it("undefined for empty records (isMessageSet requires length > 0)", () => {
    expect(agg([]).funnel).toBeUndefined();
  });
});

describe("computeAggregates — volume & cost over time grouping", () => {
  it("groups by day label, splitting calls vs messages", () => {
    const d1 = "2026-01-01T10:00:00Z";
    const d2 = "2026-01-02T10:00:00Z";
    const records = [
      makeRecord({ timestamp: d1, telephonyCostInr: 5, aiCostInr: 2, raw: { status: "completed" } }),
      makeRecord({ timestamp: d1, telephonyCostInr: 1, aiCostInr: 1, raw: { status: "failed" } }),
      makeRecord({ selType: "message", channel: "whatsapp", timestamp: d2, telephonyCostInr: 0, aiCostInr: 0, raw: { status: "read" } }),
    ];
    const a = agg(records);
    const jan1 = a.volumeOverTime!.find((v) => v.date === "Jan 1")!;
    const jan2 = a.volumeOverTime!.find((v) => v.date === "Jan 2")!;
    expect(jan1).toEqual({ date: "Jan 1", calls: 2, messages: 0 });
    expect(jan2).toEqual({ date: "Jan 2", calls: 0, messages: 1 });
    const cJan1 = a.costOverTime!.find((c) => c.date === "Jan 1")!;
    expect(cJan1).toEqual({ date: "Jan 1", telephony: 6, ai: 3 });
  });

  it("null/invalid timestamps group under the '—' label", () => {
    const records = [
      makeRecord({ timestamp: null, raw: { status: "completed" } }),
      makeRecord({ timestamp: "not-a-date", raw: { status: "failed" } }),
    ];
    const a = agg(records);
    const dash = a.volumeOverTime!.find((v) => v.date === "—")!;
    expect(dash.calls).toBe(2);
  });
});
