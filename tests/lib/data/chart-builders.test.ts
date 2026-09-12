import { describe, it, expect } from "vitest";
import { DASHBOARD_RANGES, inDashboardRange } from "@/lib/date-range";
import {
  CAMPAIGNS,
  aggregate,
  sparkline,
  callsOverTime,
  durationHistogram,
  sentimentData,
  messagingFunnel,
  mockDashboardQuality,
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

  it("ends on the current IST date", () => {
    const series = callsOverTime();
    expect(series[series.length - 1].date).toBe(
      new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Kolkata" }),
    );
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
      { name: "Positive", value: 4700, color: "#16a34a" },
      { name: "Neutral", value: 3400, color: "#94a3b8" },
      { name: "Negative", value: 1900, color: "#dc2626" },
    ]);
  });

  // Percentage shares here would sum to a bogus "100 records" donut centre.
  it("is expressed in record counts, matching the live aggregate's unit", () => {
    expect(sentimentData().reduce((sum, s) => sum + s.value, 0)).toBeGreaterThan(100);
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

describe("mockDashboardQuality", () => {
  it("supplies the dashboard quality panels used in demo mode", () => {
    const q = mockDashboardQuality();
    expect(q.voiceConnectMix.some((s) => s.key === "completed" && s.value > 0)).toBe(true);
    expect(q.messageFunnel.map((s) => s.stage)).toEqual(["Sent", "Delivered", "Read", "Replied"]);
    expect(q.outcomes[0]?.key).toBe("promise_to_pay");
    expect(q.shortCalls?.connectedWithDuration).toBeGreaterThan(0);
    expect(q.ivrDropoff?.topPaths[0]?.path).toContain("›");
  });

  // The reported bug: with the backend off there are no records for the date
  // filter to narrow, so these panels sat still while the stat cards, the volume
  // chart and the campaign table all moved — which reads as a broken filter.
  it("moves with the range when the range holds different data", () => {
    const week = mockDashboardQuality("Last 7 days");
    const month = mockDashboardQuality("Last 30 days");
    const connected = (q: typeof week) => q.shortCalls.connectedWithDuration;
    expect(connected(week)).toBeGreaterThan(0);
    expect(connected(week)).toBeLessThan(connected(month));
    expect(week.voiceConnectMix.reduce((a, s) => a + s.value, 0))
      .toBeLessThan(month.voiceConnectMix.reduce((a, s) => a + s.value, 0));
  });

  // The regression that scaling by day count produced: the seeded campaigns stop
  // 55 days back, so a 180-day "All time" multiplier grew the panels past their
  // own data — the connect-mix donut claimed 93,600 calls under a "Total calls"
  // card reading 77,165, on the DEFAULT range. A breakdown may never exceed the
  // figure it breaks down.
  it("never claims more than the stat cards it breaks down", () => {
    for (const range of DASHBOARD_RANGES) {
      const card = aggregate(CAMPAIGNS.filter((c) => inDashboardRange(c.date, range)));
      const q = mockDashboardQuality(range);

      const donut = q.voiceConnectMix.reduce((a, s) => a + s.value, 0);
      expect(donut).toBe(card.totalCalls);
      expect(q.messageFunnel[0].value).toBe(card.totalMessages);

      for (const stage of q.messageFunnel) expect(stage.value).toBeLessThanOrEqual(card.totalMessages);
      for (const v of [
        q.shortCalls.connectedWithDuration,
        q.shortCalls.connectedWithTalk,
        q.ivrDropoff.totalIvr,
      ]) {
        expect(v).toBeLessThanOrEqual(card.totalCalls);
      }
    }
  });

  // Scaling off the same figure the cards use means the panels can only differ
  // when the cards differ. The seeds stop at 55 days, so these three windows
  // hold identical campaigns — and must therefore render identically, rather
  // than swinging on a day count the data does not back.
  it("stands still exactly when the rest of the screen does", () => {
    const ninety = mockDashboardQuality("Last 90 days");
    const quarter = mockDashboardQuality("This quarter");
    const allTime = mockDashboardQuality("All time");
    expect(quarter).toEqual(ninety);
    expect(allTime).toEqual(ninety);
  });

  it("keeps each panel internally consistent at every range", () => {
    for (const range of DASHBOARD_RANGES) {
      const q = mockDashboardQuality(range);
      const short = q.shortCalls;
      expect(short.shortCount).toBeLessThanOrEqual(short.connectedWithDuration);
      expect(short.hangupCount).toBeLessThanOrEqual(short.connectedWithTalk);
      expect(short.shortRate).toBeCloseTo(short.shortCount / short.connectedWithDuration, 6);
      expect(short.hangupRate).toBeCloseTo(short.hangupCount / short.connectedWithTalk, 6);

      const ivr = q.ivrDropoff;
      expect(ivr.withPath).toBeLessThanOrEqual(ivr.totalIvr);
      expect(ivr.hangupCount).toBeLessThanOrEqual(ivr.withPath);
      // Over every IVR call, the same denominator assembleDashboardQuality uses
      // for the live figure (hangupCount / totalIvr) and the same one the card
      // prints in the caption under the percentage. It used to carry a third
      // denominator that matched neither.
      expect(ivr.hangupRate).toBeCloseTo(ivr.hangupCount / ivr.totalIvr, 6);
      for (const r of [short.shortRate, short.hangupRate, ivr.hangupRate]) {
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });

  // Call length is a property of the calls, not of the window you view them
  // through — scaling it with the range would be fabrication, not filtering.
  it("leaves per-call characteristics alone", () => {
    for (const range of DASHBOARD_RANGES) {
      const { shortCalls } = mockDashboardQuality(range);
      expect(shortCalls.avgDuration).toBe(78.4);
      expect(shortCalls.avgTalkTime).toBe(51.2);
      expect(shortCalls.thresholdSeconds).toBe(15);
      expect(shortCalls.hangupTalkSeconds).toBe(10);
    }
  });

  it("is stable across calls, so the demo never flickers", () => {
    const now = new Date("2026-09-12T10:00:00Z");
    expect(mockDashboardQuality("Last 7 days", now)).toEqual(mockDashboardQuality("Last 7 days", now));
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
