// Fills the Conversation tab's "Sentiment" and "Key topics" cards from core's
// post-call analysis.
//
// WHY THIS EXISTS. Every other series on that tab is derived from the records we
// ingest, which come from magick-master's `/proxy/calls` → core's calls LIST.
// That list projects a column subset which deliberately excludes the heavy
// `call_analysis` JSONB, and core's response formatter emits
// `call_analysis: null` rather than omitting the key — so from our side every
// call in the fleet looks like a call whose analysis never ran.
// `normalizeCall` therefore writes `sentiment: null` / `keyTopics: null` on
// every record, `computeAggregates` sums those to empty series, and both cards
// render their empty state while duration and talk-time (ordinary list columns)
// render fine. That is the whole of the customer-visible bug; the analysis
// itself completes normally upstream.
//
// So we ask the one endpoint that CAN see the blob: core aggregates sentiment
// and key topics in SQL out of `call_analysis` (`/calls/batch-analytics`), and
// magick-master exposes that merged across jobs at
// `POST /bulk-dispatch-jobs/analytics`. Core computes over the union of the
// selection's batches in one query, so the numbers are exact — not N per-batch
// top-10s merged approximately on this side.
//
// The trade-off this accepts: these are SELECTION-SCOPED ROLLUPS, not per-record
// fields. They cannot reach the CSV export or anything else that reads a
// `NormalizedRecord`. Closing that gap needs core to project the two values as
// scalars onto the calls list — which it already does for the WebRTC dialer list
// (`analysis_sentiment_label` in `WEBRTC_LIST_COLUMNS`), just not for AI calls.
// This module is written to survive that landing: it only ever fills a series
// that is EMPTY, so once records carry their own analysis the record-derived
// values win and this quietly becomes a no-op.

import { MagickClient, type RawBatchAnalytics } from "./magick-client";
import { MAX_TOPICS, SENTIMENT_ORDER, sentimentDisplayName } from "./aggregate";
import { log } from "./logger";
import type { AggregatesDoc, TenantContext } from "./types";
import type { SelType } from "@/lib/types";

/** Outcome of an enrichment attempt.
 *  - `skipped`  — nothing to ask for (not an AI-call selection, or no records).
 *  - `ok`       — upstream answered; an empty answer is a real answer.
 *  - `failed`   — upstream could not be reached or refused. */
export type EnrichmentStatus = "skipped" | "ok" | "failed";

export interface EnrichedAggregates {
  aggregate: AggregatesDoc;
  status: EnrichmentStatus;
  /** Whether this result may be written to the aggregates cache.
   *
   *  False only for `failed`. The cache key is a fingerprint of the batch set
   *  and its dataset, and neither moves when a *downstream* call fails — so
   *  caching a doc whose enrichment blew up would pin the empty cards in place
   *  for a key that can never be invalidated, and only an explicit Refresh
   *  would ever clear it. Recomputing on the next request is cheap; serving a
   *  customer a permanently blank chart because of one transient 502 is not. */
  cacheable: boolean;
}

/** Only `ai_voice_call` batches have post-call analysis: IVR and messaging runs
 *  have no conversation to analyse, and magick-master rejects a non-AI job id on
 *  this endpoint with a 400 rather than an empty result. `validateSelection`
 *  guarantees a selection is homogeneous, so one selType decides for all. */
function isAnalysable(selType: SelType | undefined): boolean {
  return selType === "ai";
}

/** Map core's `sentiment_distribution` onto the donut's shape.
 *
 *  Labels arrive as the analysis model wrote them, so fold case before matching
 *  and keep the canonical three in the UI's colour order. Unrecognised labels
 *  are appended rather than dropped: the donut's centre shows a total, and
 *  silently discarding a label would make it disagree with the call count
 *  beside it. */
export function toSentimentSeries(raw: RawBatchAnalytics | null): AggregatesDoc["sentiment"] {
  const counts = new Map<string, number>();
  for (const row of raw?.sentiment_distribution ?? []) {
    const label = (row?.label ?? "").trim().toLowerCase();
    const count = typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : 0;
    if (!label || count <= 0) continue;
    counts.set(label, (counts.get(label) ?? 0) + count);
  }
  const known = SENTIMENT_ORDER.filter((label) => counts.has(label));
  const extra = [...counts.keys()]
    .filter((label) => !SENTIMENT_ORDER.includes(label as (typeof SENTIMENT_ORDER)[number]))
    .sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  return [...known, ...extra].map((label) => ({
    name: sentimentDisplayName(label),
    value: counts.get(label)!,
  }));
}

/** Map core's `key_topics` onto the topic-list shape.
 *
 *  `sentiment` here is the bar's colour, not a measurement — core counts topics
 *  without attributing sentiment to them, so it stays neutral exactly as the
 *  record-derived path sets it. Upstream already orders by count desc; we sort
 *  anyway so the cap takes the real top N regardless of what upstream sends. */
export function toTopicSeries(raw: RawBatchAnalytics | null): AggregatesDoc["topics"] {
  return (raw?.key_topics ?? [])
    .map((row) => ({
      topic: (row?.topic ?? "").trim(),
      count: typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : 0,
      sentiment: "neutral",
    }))
    .filter((row) => row.topic !== "" && row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TOPICS);
}

/**
 * Return `agg` with its sentiment and topic series filled from core's post-call
 * analysis, plus whether the result is safe to cache.
 *
 * Never destructive: a series that already has values is left alone, so if the
 * records ever start carrying their own analysis (see the header note on the
 * core-side projection) the per-record numbers keep precedence and this call
 * becomes a no-op. Enrichment is best-effort by design — the rest of the tab is
 * already computed and correct, and failing the whole request over the two cards
 * this is meant to fill would be a strictly worse outcome for the customer.
 */
export async function enrichWithCallAnalysis(
  ctx: TenantContext,
  selType: SelType | undefined,
  agg: AggregatesDoc,
): Promise<EnrichedAggregates> {
  const hasSentiment = (agg.sentiment?.length ?? 0) > 0;
  const hasTopics = (agg.topics?.length ?? 0) > 0;
  if (!isAnalysable(selType) || agg.totalRecords === 0 || (hasSentiment && hasTopics)) {
    return { aggregate: agg, status: "skipped", cacheable: true };
  }

  let raw: RawBatchAnalytics | null;
  try {
    raw = await MagickClient.fromContext(ctx).batchAnalytics(agg.batchIds);
  } catch (err) {
    // Degraded, not broken: the caller still serves every other series.
    log().warn(
      { err, batchCount: agg.batchIds.length, key: agg.key },
      "call-analysis enrichment failed; serving aggregates without sentiment/topics",
    );
    return { aggregate: agg, status: "failed", cacheable: false };
  }

  const sentiment = hasSentiment ? agg.sentiment : toSentimentSeries(raw);
  const topics = hasTopics ? agg.topics : toTopicSeries(raw);
  log().info(
    {
      batchCount: agg.batchIds.length,
      key: agg.key,
      sentimentLabels: sentiment?.length ?? 0,
      topicCount: topics?.length ?? 0,
    },
    "call-analysis enrichment applied",
  );
  return { aggregate: { ...agg, sentiment, topics }, status: "ok", cacheable: true };
}
