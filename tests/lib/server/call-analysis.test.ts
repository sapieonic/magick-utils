import { beforeEach, describe, expect, it, vi } from "vitest";

const batchAnalytics = vi.fn();

vi.mock("@/lib/server/magick-client", () => ({
  MagickClient: { fromContext: () => ({ batchAnalytics }) },
}));
vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { enrichWithCallAnalysis, toSentimentSeries, toTopicSeries } from "@/lib/server/call-analysis";
import { MAX_TOPICS } from "@/lib/server/aggregate";
import { MAX_SELECTION_BATCHES } from "@/lib/server/selection";
import type { AggregatesDoc } from "@/lib/server/types";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" } as never;

/** A computed aggregate as the record path leaves it: everything else present,
 *  sentiment and topics empty because the calls list carries no `call_analysis`. */
function agg(overrides: Partial<AggregatesDoc> = {}): AggregatesDoc {
  return {
    tenantId: "t1",
    accountId: "a1",
    key: "agg-key",
    batchIds: ["b1", "b2"],
    totalRecords: 120,
    statusMix: [],
    successRate: 0.5,
    spendInr: 0,
    telephonyInr: 0,
    aiInr: 0,
    sentiment: [],
    topics: [],
    computedAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  batchAnalytics.mockResolvedValue(null);
});

describe("toSentimentSeries", () => {
  it("title-cases and orders the known labels the way the donut colours them", () => {
    const out = toSentimentSeries({
      sentiment_distribution: [
        { label: "negative", count: 3 },
        { label: "positive", count: 10 },
        { label: "neutral", count: 5 },
      ],
    });
    expect(out).toEqual([
      { name: "Positive", value: 10 },
      { name: "Neutral", value: 5 },
      { name: "Negative", value: 3 },
    ]);
  });

  it("folds casing and whitespace from whatever the model wrote", () => {
    const out = toSentimentSeries({ sentiment_distribution: [{ label: " Positive " }, { label: "POSITIVE", count: 2 }] });
    // The first row has no count and is dropped; the second folds to the same key.
    expect(out).toEqual([{ name: "Positive", value: 2 }]);
  });

  it("keeps an unrecognised label rather than dropping it from the total", () => {
    // The donut shows a centre total, so discarding a real label would make it
    // disagree with the call count on the card beside it.
    const out = toSentimentSeries({
      sentiment_distribution: [{ label: "mixed", count: 7 }, { label: "positive", count: 1 }],
    });
    expect(out).toEqual([
      { name: "Positive", value: 1 },
      { name: "Mixed", value: 7 },
    ]);
  });

  it("drops empty, zero and non-numeric rows", () => {
    const out = toSentimentSeries({
      sentiment_distribution: [
        { label: "", count: 5 },
        { label: "positive", count: 0 },
        { label: "neutral", count: "12" as never },
        { label: "negative", count: 4 },
      ],
    });
    expect(out).toEqual([{ name: "Negative", value: 4 }]);
  });

  it("is empty for a null or field-less payload", () => {
    expect(toSentimentSeries(null)).toEqual([]);
    expect(toSentimentSeries({})).toEqual([]);
  });
});

describe("toTopicSeries", () => {
  it("maps topics to the list's shape with a neutral bar colour", () => {
    // Core counts topic frequency without attributing sentiment to a topic, so
    // `sentiment` here is the bar colour only — matching the record-derived path.
    expect(toTopicSeries({ key_topics: [{ topic: "billing", count: 12 }] })).toEqual([
      { topic: "billing", count: 12, sentiment: "neutral" },
    ]);
  });

  it("caps at the same length the record-derived path uses", () => {
    const rows = Array.from({ length: MAX_TOPICS + 4 }, (_, i) => ({ topic: `t${i}`, count: 100 - i }));
    const out = toTopicSeries({ key_topics: rows });
    expect(out).toHaveLength(MAX_TOPICS);
    expect(out?.[0].topic).toBe("t0");
  });

  it("re-sorts by count so the cap takes the real top N", () => {
    const out = toTopicSeries({ key_topics: [{ topic: "rare", count: 1 }, { topic: "common", count: 50 }] });
    expect(out?.map((t) => t.topic)).toEqual(["common", "rare"]);
  });

  it("drops blank topics and zero counts", () => {
    const out = toTopicSeries({ key_topics: [{ topic: "  ", count: 9 }, { topic: "kept", count: 2 }, { topic: "zero", count: 0 }] });
    expect(out?.map((t) => t.topic)).toEqual(["kept"]);
  });
});

describe("enrichWithCallAnalysis", () => {
  it("fills both series for an AI selection", async () => {
    batchAnalytics.mockResolvedValue({
      sentiment_distribution: [{ label: "positive", count: 80 }, { label: "negative", count: 40 }],
      key_topics: [{ topic: "delivery delay", count: 31 }],
    });
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, "ai", agg());

    expect(status).toBe("ok");
    expect(cacheable).toBe(true);
    expect(batchAnalytics).toHaveBeenCalledWith(["b1", "b2"]);
    expect(aggregate.sentiment).toEqual([
      { name: "Positive", value: 80 },
      { name: "Negative", value: 40 },
    ]);
    expect(aggregate.topics).toEqual([{ topic: "delivery delay", count: 31, sentiment: "neutral" }]);
  });

  it("leaves the rest of the aggregate untouched", async () => {
    batchAnalytics.mockResolvedValue({ key_topics: [{ topic: "x", count: 1 }] });
    const input = agg({ successRate: 0.42, spendInr: 1234 });
    const { aggregate } = await enrichWithCallAnalysis(ctx, "ai", input);

    expect(aggregate.successRate).toBe(0.42);
    expect(aggregate.spendInr).toBe(1234);
    expect(aggregate.totalRecords).toBe(120);
    expect(input.topics).toEqual([]); // the input doc is not mutated
  });

  for (const selType of ["ivr", "message"] as const) {
    it(`asks nothing for a ${selType} selection`, async () => {
      // These have no conversation to analyse, and magick-master 400s a non-AI
      // job id on this endpoint rather than answering with an empty rollup.
      const { status, cacheable } = await enrichWithCallAnalysis(ctx, selType, agg());
      expect(status).toBe("skipped");
      expect(cacheable).toBe(true);
      expect(batchAnalytics).not.toHaveBeenCalled();
    });
  }

  it("asks nothing when the selection has no records", async () => {
    const { status } = await enrichWithCallAnalysis(ctx, "ai", agg({ totalRecords: 0 }));
    expect(status).toBe("skipped");
    expect(batchAnalytics).not.toHaveBeenCalled();
  });

  it("never overwrites series the records already carry", async () => {
    // Forward compatibility: once core projects sentiment/topics onto the calls
    // list, the per-record numbers are the better answer and this must no-op.
    const existing = agg({
      sentiment: [{ name: "Positive", value: 3 }],
      topics: [{ topic: "from records", count: 2, sentiment: "neutral" }],
    });
    const { aggregate, status } = await enrichWithCallAnalysis(ctx, "ai", existing);

    expect(status).toBe("skipped");
    expect(batchAnalytics).not.toHaveBeenCalled();
    expect(aggregate.sentiment).toEqual([{ name: "Positive", value: 3 }]);
    expect(aggregate.topics).toEqual([{ topic: "from records", count: 2, sentiment: "neutral" }]);
  });

  it("fills only the missing half when one series is already present", async () => {
    batchAnalytics.mockResolvedValue({
      sentiment_distribution: [{ label: "neutral", count: 9 }],
      key_topics: [{ topic: "upstream", count: 4 }],
    });
    const { aggregate } = await enrichWithCallAnalysis(ctx, "ai", agg({ sentiment: [{ name: "Positive", value: 3 }] }));

    expect(aggregate.sentiment).toEqual([{ name: "Positive", value: 3 }]);
    expect(aggregate.topics).toEqual([{ topic: "upstream", count: 4, sentiment: "neutral" }]);
  });

  it("degrades rather than failing the request when upstream errors", async () => {
    batchAnalytics.mockRejectedValue(new Error("upstream 502"));
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, "ai", agg());

    expect(status).toBe("failed");
    expect(aggregate.totalRecords).toBe(120); // every other series still served
    // The cache key is a fingerprint of the batch set and its dataset, and a
    // downstream failure moves neither — so caching this would pin the empty
    // cards to a key that nothing can invalidate.
    expect(cacheable).toBe(false);
  });

  it("caches an empty upstream answer — that is a real answer, not a failure", async () => {
    batchAnalytics.mockResolvedValue({ sentiment_distribution: [], key_topics: [] });
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, "ai", agg());

    expect(status).toBe("ok");
    expect(cacheable).toBe(true);
    expect(aggregate.sentiment).toEqual([]);
    expect(aggregate.topics).toEqual([]);
  });

  it("can never exceed the job-id cap magick-master enforces", () => {
    // Upstream rejects more than 50 job ids with a 400. Our selection ceiling is
    // the same number, so this is safe today — this assertion is what turns
    // raising one of them alone into a failing test instead of a customer-facing
    // error on large selections.
    expect(MAX_SELECTION_BATCHES).toBeLessThanOrEqual(50);
  });
});
