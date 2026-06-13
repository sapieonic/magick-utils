import { describe, it, expect } from "vitest";
import {
  sparkline,
  callsOverTime,
  durationHistogram,
  sentimentData,
  messagingFunnel,
  costBreakdown,
  TOPICS,
} from "@/lib/data";

describe("sparkline", () => {
  it("returns n points (default 14) with {i, v}", () => {
    const sp = sparkline(1);
    expect(sp).toHaveLength(14);
    sp.forEach((p, idx) => {
      expect(p.i).toBe(idx);
      expect(Number.isInteger(p.v)).toBe(true);
    });
  });

  it("honors custom n", () => {
    expect(sparkline(5, 7)).toHaveLength(7);
    expect(sparkline(5, 1)).toHaveLength(1);
    expect(sparkline(5, 0)).toHaveLength(0);
  });

  it("clamps values to a floor of 8", () => {
    // try several seeds; never below 8
    for (const seed of [1, 2, 42, 9999, 123456]) {
      sparkline(seed, 30, 8, 80).forEach((p) => expect(p.v).toBeGreaterThanOrEqual(8));
    }
  });

  it("is deterministic for the same seed", () => {
    expect(sparkline(777)).toEqual(sparkline(777));
  });

  it("differs across seeds", () => {
    expect(sparkline(1)).not.toEqual(sparkline(2));
  });
});

describe("callsOverTime", () => {
  it("returns 30 entries with date/calls/messages", () => {
    const series = callsOverTime();
    expect(series).toHaveLength(30);
    series.forEach((e) => {
      expect(typeof e.date).toBe("string");
      expect(Number.isInteger(e.calls)).toBe(true);
      expect(Number.isInteger(e.messages)).toBe(true);
      expect(e.calls).toBeGreaterThan(0);
      expect(e.messages).toBeGreaterThan(0);
    });
  });

  it("is deterministic across calls", () => {
    expect(callsOverTime()).toEqual(callsOverTime());
  });

  it("ends on the anchor date Jun 9", () => {
    const series = callsOverTime();
    expect(series[series.length - 1].date).toBe("Jun 9");
  });
});

describe("durationHistogram", () => {
  const expectedBuckets = ["0–30s", "30–60s", "1–2m", "2–3m", "3–5m", "5m+"];

  it("returns 6 buckets in order with calls/talk", () => {
    const h = durationHistogram();
    expect(h).toHaveLength(6);
    expect(h.map((b) => b.bucket)).toEqual(expectedBuckets);
    h.forEach((b) => {
      expect(Number.isInteger(b.calls)).toBe(true);
      expect(Number.isInteger(b.talk)).toBe(true);
      expect(b.calls).toBeGreaterThanOrEqual(0);
      expect(b.talk).toBeGreaterThanOrEqual(0);
    });
  });

  it("is deterministic across calls", () => {
    expect(durationHistogram()).toEqual(durationHistogram());
  });
});

describe("sentimentData", () => {
  it("returns three fixed sentiment segments", () => {
    const s = sentimentData();
    expect(s).toEqual([
      { name: "Positive", value: 47, color: "#16a34a" },
      { name: "Neutral", value: 34, color: "#94a3b8" },
      { name: "Negative", value: 19, color: "#dc2626" },
    ]);
  });

  it("is deterministic and a fresh array each call", () => {
    expect(sentimentData()).toEqual(sentimentData());
    expect(sentimentData()).not.toBe(sentimentData());
  });
});

describe("messagingFunnel", () => {
  it("returns the four monotonically decreasing funnel stages", () => {
    const f = messagingFunnel();
    expect(f.map((s) => s.stage)).toEqual(["Sent", "Delivered", "Read", "Replied"]);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].value).toBeLessThan(f[i - 1].value);
    }
    f.forEach((s) => expect(s.color).toMatch(/^#[0-9a-f]{6}$/i));
  });
});

describe("costBreakdown", () => {
  it("returns 12 points with date/telephony/ai", () => {
    const c = costBreakdown();
    expect(c).toHaveLength(12);
    c.forEach((p) => {
      expect(typeof p.date).toBe("string");
      expect(Number.isInteger(p.telephony)).toBe(true);
      expect(Number.isInteger(p.ai)).toBe(true);
      expect(p.telephony).toBeGreaterThanOrEqual(8000);
      expect(p.ai).toBeGreaterThanOrEqual(3000);
    });
  });

  it("is deterministic across calls", () => {
    expect(costBreakdown()).toEqual(costBreakdown());
  });
});

describe("TOPICS", () => {
  it("is a stable list of topic/count/sentiment", () => {
    expect(TOPICS.length).toBe(9);
    TOPICS.forEach((t) => {
      expect(typeof t.topic).toBe("string");
      expect(Number.isInteger(t.count)).toBe(true);
      expect(["positive", "neutral", "negative"]).toContain(t.sentiment);
    });
  });
});
