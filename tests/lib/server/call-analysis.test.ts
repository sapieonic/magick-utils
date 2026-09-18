import { beforeEach, describe, expect, it, vi } from "vitest";

const batchAnalytics = vi.fn();
// Hoisted: unlike `batchAnalytics` — which the old factory only dereferenced
// inside a nested arrow — these are read the moment the factory runs.
const { persistRefreshedCredential, fromContextMock } = vi.hoisted(() => ({
  persistRefreshedCredential: vi.fn(),
  fromContextMock: vi.fn(),
}));

// `MagickApiError` stays real: the module under test branches on its `status`
// to decide whether a failure is settled or momentary, which is the whole of
// the caching policy. Stubbing it out would make every error look momentary.
vi.mock("@/lib/server/magick-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/magick-client")>()),
  MagickClient: { fromContext: fromContextMock },
}));
vi.mock("@/lib/server/session", () => ({ persistRefreshedCredential }));
fromContextMock.mockImplementation(() => ({ batchAnalytics }));
vi.mock("@/lib/server/env", () => ({
  env: { magickMasterBaseUrl: "https://mm.test" },
  isAuthConfigured: () => true,
}));
vi.mock("@/lib/server/logger", () => ({
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { enrichWithCallAnalysis, toSentimentSeries, toTopicSeries } from "@/lib/server/call-analysis";
import { MagickApiError } from "@/lib/server/magick-client";
import { MAX_TOPICS } from "@/lib/server/aggregate";
import { MAX_SELECTION_BATCHES } from "@/lib/server/selection";
import type { AggregatesDoc, BatchDoc } from "@/lib/server/types";
import type { SelType } from "@/lib/types";

const ctx = { tenantId: "t1", accountId: "a1", idToken: "tk" } as never;

/** BatchDocs for the selection in `agg()` below. `batchId` and `sourceId` are
 *  deliberately DIFFERENT here: they happen to be equal in production today,
 *  which would let a regression to `batchId` pass unnoticed. */
function docs(selType: SelType = "ai"): BatchDoc[] {
  return [
    { batchId: "b1", sourceId: "job-1", selType } as BatchDoc,
    { batchId: "b2", sourceId: "job-2", selType } as BatchDoc,
  ];
}

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
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(status).toBe("ok");
    expect(cacheable).toBe(true);
    // sourceId, not batchId — see the note in enrichWithCallAnalysis.
    expect(batchAnalytics).toHaveBeenCalledWith(["job-1", "job-2"]);
    expect(aggregate.sentiment).toEqual([
      { name: "Positive", value: 80 },
      { name: "Negative", value: 40 },
    ]);
    expect(aggregate.topics).toEqual([{ topic: "delivery delay", count: 31, sentiment: "neutral" }]);
  });

  it("leaves the rest of the aggregate untouched", async () => {
    batchAnalytics.mockResolvedValue({ key_topics: [{ topic: "x", count: 1 }] });
    const input = agg({ successRate: 0.42, spendInr: 1234 });
    const { aggregate } = await enrichWithCallAnalysis(ctx, docs(), input);

    expect(aggregate.successRate).toBe(0.42);
    expect(aggregate.spendInr).toBe(1234);
    expect(aggregate.totalRecords).toBe(120);
    expect(input.topics).toEqual([]); // the input doc is not mutated
  });

  for (const selType of ["ivr", "message"] as const) {
    it(`asks nothing for a ${selType} selection`, async () => {
      // These have no conversation to analyse, and magick-master 400s a non-AI
      // job id on this endpoint rather than answering with an empty rollup.
      const { status, cacheable } = await enrichWithCallAnalysis(ctx, docs(selType), agg());
      expect(status).toBe("skipped");
      expect(cacheable).toBe(true);
      expect(batchAnalytics).not.toHaveBeenCalled();
    });
  }

  it("asks nothing when the selection has no records", async () => {
    const { status } = await enrichWithCallAnalysis(ctx, docs(), agg({ totalRecords: 0 }));
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
    const { aggregate, status } = await enrichWithCallAnalysis(ctx, docs(), existing);

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
    const { aggregate } = await enrichWithCallAnalysis(ctx, docs(), agg({ sentiment: [{ name: "Positive", value: 3 }] }));

    expect(aggregate.sentiment).toEqual([{ name: "Positive", value: 3 }]);
    expect(aggregate.topics).toEqual([{ topic: "upstream", count: 4, sentiment: "neutral" }]);
  });

  it("degrades rather than failing the request when upstream errors", async () => {
    batchAnalytics.mockRejectedValue(new Error("socket hang up"));
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(status).toBe("failed");
    expect(aggregate.totalRecords).toBe(120); // every other series still served
    // The cache key is a fingerprint of the batch set and its dataset, and a
    // downstream failure moves neither — so caching this would pin the empty
    // cards to a key that nothing can invalidate.
    expect(cacheable).toBe(false);
    // And the UI must not claim these records have no AI analysis.
    expect(aggregate.analysisUnavailable).toBe(true);
  });

  // Cacheability tracks "would asking again help?", not "did the call succeed?".
  for (const status of [500, 502, 503, 401, 403, 429]) {
    it(`treats ${status} as momentary and refuses to cache it`, async () => {
      batchAnalytics.mockRejectedValue(new MagickApiError(status, "nope", "http://mm.test/x"));
      const out = await enrichWithCallAnalysis(ctx, docs(), agg());
      expect(out.status).toBe("failed");
      expect(out.cacheable).toBe(false);
    });
  }

  for (const status of [400, 422]) {
    it(`treats ${status} as a settled answer about the selection and caches it`, async () => {
      // A 400 (dispatch type with no analysis) or 404 (job upstream no longer
      // has) says the same thing forever. Marking it uncacheable would stop the
      // WHOLE aggregates doc — every other series on the screen — from ever
      // being cached for this selection, forcing a full recompute per request.
      batchAnalytics.mockRejectedValue(new MagickApiError(status, "nope", "http://mm.test/x"));
      const out = await enrichWithCallAnalysis(ctx, docs(), agg());
      expect(out.status).toBe("unavailable");
      expect(out.cacheable).toBe(true);
      expect(out.aggregate.analysisUnavailable).toBe(true);
    });
  }

  it("leaves analysisUnavailable unset when upstream answers, even emptily", async () => {
    batchAnalytics.mockResolvedValue({ sentiment_distribution: [], key_topics: [] });
    const { aggregate } = await enrichWithCallAnalysis(ctx, docs(), agg());
    expect(aggregate.analysisUnavailable).toBeUndefined();
  });

  it("caches an empty upstream answer — that is a real answer, not a failure", async () => {
    batchAnalytics.mockResolvedValue({ sentiment_distribution: [], key_topics: [] });
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(status).toBe("ok");
    expect(cacheable).toBe(true);
    expect(aggregate.sentiment).toEqual([]);
    expect(aggregate.topics).toEqual([]);
  });

  // --- classification: allow-list, not a 4xx range with holes ---------------

  it("treats 408 as momentary, not as a statement about the selection", async () => {
    // A proxy timeout is a 4xx about this moment. The earlier range check made
    // it settled, which would have pinned the cards blank under a key only
    // Refresh can clear.
    batchAnalytics.mockRejectedValue(new MagickApiError(408, "timeout", "http://mm.test/x"));
    const out = await enrichWithCallAnalysis(ctx, docs(), agg());
    expect(out.status).toBe("failed");
    expect(out.cacheable).toBe(false);
  });

  // --- 404: a selection naming a job upstream has lost -----------------------

  it("retries without the jobs upstream reports missing, rather than blanking the selection", async () => {
    // Master 404s the whole request if ANY job id is unknown. Without the retry
    // one deleted campaign blanks the tab for every other batch in the selection.
    batchAnalytics
      .mockRejectedValueOnce(
        new MagickApiError(404, JSON.stringify({ missing_job_ids: ["job-1"] }), "http://mm.test/x"),
      )
      .mockResolvedValueOnce({ key_topics: [{ topic: "billing", count: 5 }] });
    const { aggregate, status, cacheable } = await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(batchAnalytics).toHaveBeenNthCalledWith(1, ["job-1", "job-2"]);
    expect(batchAnalytics).toHaveBeenNthCalledWith(2, ["job-2"]); // the survivor
    expect(status).toBe("ok");
    expect(cacheable).toBe(true);
    expect(aggregate.topics).toEqual([{ topic: "billing", count: 5, sentiment: "neutral" }]);
    expect(aggregate.analysisUnavailable).toBeUndefined();
  });

  it("does not retry a 404 that names no missing jobs", async () => {
    // A Fastify route-not-found 404 (a master predating the endpoint) carries no
    // `missing_job_ids`; it is settled, not something to narrow and re-ask.
    batchAnalytics.mockRejectedValue(new MagickApiError(404, '{"message":"Route not found"}', "http://mm.test/x"));
    const out = await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(batchAnalytics).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("unavailable");
    expect(out.cacheable).toBe(true);
  });

  it("gives up when every selected job is gone upstream", async () => {
    batchAnalytics.mockRejectedValue(
      new MagickApiError(404, JSON.stringify({ missing_job_ids: ["job-1", "job-2"] }), "http://mm.test/x"),
    );
    const out = await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(batchAnalytics).toHaveBeenCalledTimes(1); // nothing left to narrow to
    expect(out.status).toBe("unavailable");
    expect(out.aggregate.analysisUnavailable).toBe(true);
  });

  // --- payload integrity -----------------------------------------------------

  for (const [label, payload] of [
    ["a non-array sentiment_distribution", { sentiment_distribution: {} }],
    ["a non-array key_topics", { key_topics: "nope" }],
  ] as const) {
    it(`does not cache ${label} as a genuine empty analysis`, async () => {
      // The mappers coerce a malformed field to [], which without this guard
      // would be written to the cache as a real "no analysis" answer.
      batchAnalytics.mockResolvedValue(payload);
      const out = await enrichWithCallAnalysis(ctx, docs(), agg());

      expect(out.status).toBe("failed");
      expect(out.cacheable).toBe(false);
      expect(out.aggregate.analysisUnavailable).toBe(true);
    });
  }

  it("still treats an absent field as a legitimately empty rollup", async () => {
    // Absent/null is empty; present-but-wrong-type is upstream breaking contract.
    batchAnalytics.mockResolvedValue({ sentiment_distribution: null });
    const out = await enrichWithCallAnalysis(ctx, docs(), agg());
    expect(out.status).toBe("ok");
    expect(out.cacheable).toBe(true);
  });

  it("refuses to answer for a selection whose batches lack a sourceId", async () => {
    // Asking about only the batches that have one answers a different question
    // than the customer asked, and caching that as the whole selection is worse
    // than admitting we could not answer.
    const broken = [
      { batchId: "b1", sourceId: "job-1", selType: "ai" } as BatchDoc,
      { batchId: "b2", sourceId: "", selType: "ai" } as BatchDoc,
    ];
    const out = await enrichWithCallAnalysis(ctx, broken, agg());

    expect(batchAnalytics).not.toHaveBeenCalled();
    expect(out.status).toBe("failed");
    expect(out.cacheable).toBe(false);
    expect(out.aggregate.analysisUnavailable).toBe(true);
  });

  it("can never exceed the job-id cap magick-master enforces", () => {
    // Upstream rejects more than 50 job ids with a 400. Our selection ceiling is
    // the same number, so this is safe today — this assertion is what turns
    // raising one of them alone into a failing test instead of a customer-facing
    // error on large selections.
    expect(MAX_SELECTION_BATCHES).toBeLessThanOrEqual(50);
  });
});

describe("credential persistence", () => {
  it("gives its client the hook that writes a re-minted token back to the session", async () => {
    // Without it, a 401 here re-minted a working token that died with the
    // request: the session kept the rejected one, so every later analytics,
    // insights or chat call repeated the same 401-and-exchange, and a rotated
    // refresh token — which firebase-token.ts says callers MUST persist — was
    // lost outright.
    batchAnalytics.mockResolvedValue(null);

    await enrichWithCallAnalysis(ctx, docs(), agg());

    expect(fromContextMock).toHaveBeenCalled();
    expect(fromContextMock.mock.calls[0][1]).toMatchObject({
      onCredentialRefresh: persistRefreshedCredential,
    });
  });
});
