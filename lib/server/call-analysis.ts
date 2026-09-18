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

import { MagickApiError, MagickClient, type RawBatchAnalytics } from "./magick-client";
import { persistRefreshedCredential } from "./session";
import { MAX_TOPICS, SENTIMENT_ORDER, sentimentDisplayName } from "./aggregate";
import { log } from "./logger";
import type { AggregatesDoc, BatchDoc, TenantContext } from "./types";
import type { SelType } from "@/lib/types";

/** Outcome of an enrichment attempt.
 *  - `skipped`      — nothing to ask for (not an AI-call selection, or no records).
 *  - `ok`           — upstream answered; an empty answer is a real answer.
 *  - `unavailable`  — upstream gave a settled "no" about this selection.
 *  - `failed`       — upstream could not answer right now. */
export type EnrichmentStatus = "skipped" | "ok" | "unavailable" | "failed";

export interface EnrichedAggregates {
  aggregate: AggregatesDoc;
  status: EnrichmentStatus;
  /** Whether this result may be written to the aggregates cache.
   *
   *  The question this answers is "would asking again produce anything
   *  different?", NOT "did the call succeed?". Those come apart in both
   *  directions, and getting either backwards is expensive:
   *
   *  - A momentary failure must NOT be cached. The key is a fingerprint of the
   *    batch set and its dataset, and neither moves because a downstream call
   *    failed, so a cached blank would outlive the outage that caused it and
   *    only an explicit Refresh could clear it.
   *  - A settled refusal MUST be cached. A 400 (a dispatch type with no
   *    analysis) or a 404 (a job upstream no longer has) says the same thing on
   *    every retry. Treating it as a failure would mean the whole aggregates
   *    doc — every other series on the screen — is never cached for that
   *    selection again, and is recomputed from Mongo on every single request. */
  cacheable: boolean;
}

/** Statuses that are a statement about the SELECTION and will say the same
 *  thing on every retry, so an empty result for them is a settled answer worth
 *  caching.
 *
 *  An allow-list, not a 4xx range with holes. The range was wrong: `408 Request
 *  Timeout` is a 4xx about *this moment*, and a proxy emitting one would have
 *  pinned the cards blank under a key only Refresh can clear — the exact bug
 *  this classification exists to prevent. Anything not listed here (5xx, 408,
 *  429, 401/403, a network error, our own AbortSignal) is momentary.
 *
 *  404 qualifies only because `fetchRollup` runs first: a 404 naming jobs that
 *  upstream has lost is narrowed and re-asked there, so one reaching here means
 *  either the endpoint does not exist (a master predating it) or NO selected job
 *  still exists. Both say the same thing on every retry. */
const SETTLED_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

function isSettledRefusal(err: unknown): boolean {
  return err instanceof MagickApiError && SETTLED_STATUSES.has(err.status);
}

/** The job ids magick-master reports it could not find, or null when this is
 *  not that kind of 404.
 *
 *  `POST /bulk-dispatch-jobs/analytics` answers 404 if ANY id is unknown, and
 *  names them in `missing_job_ids`. A Fastify route-not-found 404 (a master
 *  predating the endpoint) carries no such field, which is how the two are
 *  told apart. */
function missingJobIds(err: unknown): string[] | null {
  if (!(err instanceof MagickApiError) || err.status !== 404) return null;
  try {
    const parsed = JSON.parse(err.body) as { missing_job_ids?: unknown };
    const ids = parsed?.missing_job_ids;
    if (!Array.isArray(ids)) return null;
    const known = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    return known.length > 0 ? known : null;
  } catch {
    return null;
  }
}

/** Whether an otherwise-2xx payload contradicts its own declared shape.
 *
 *  An ABSENT or null field is a legitimately empty rollup. A field that is
 *  present but not an array is upstream breaking its contract — the mappers
 *  coerce that to `[]`, which would otherwise be cached as a real "no analysis"
 *  under a key nothing can invalidate. Treated as momentary so it is retried. */
function isMalformed(raw: RawBatchAnalytics | null): boolean {
  if (raw == null) return false;
  const badShape = (v: unknown) => v != null && !Array.isArray(v);
  return badShape(raw.sentiment_distribution) || badShape(raw.key_topics);
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
  // `RawBatchAnalytics` is a declared shape, not a runtime guarantee. A truthy
  // non-array here would throw out of a function whose whole contract is to
  // degrade quietly — and take every other series on the tab down with it.
  const rows = Array.isArray(raw?.sentiment_distribution) ? raw.sentiment_distribution : [];
  for (const row of rows) {
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
  return (Array.isArray(raw?.key_topics) ? raw.key_topics : [])
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
  /** The BatchDocs for `agg.batchIds`, in any order. Taken whole rather than as
   *  a selType because the upstream ids come from here too — see `sourceId`. */
  batches: BatchDoc[],
  agg: AggregatesDoc,
): Promise<EnrichedAggregates> {
  const selType: SelType | undefined = batches[0]?.selType;
  const hasSentiment = (agg.sentiment?.length ?? 0) > 0;
  const hasTopics = (agg.topics?.length ?? 0) > 0;
  if (!isAnalysable(selType) || agg.totalRecords === 0 || (hasSentiment && hasTopics)) {
    return { aggregate: agg, status: "skipped", cacheable: true };
  }

  // `sourceId`, NOT `batchId`. They are the same string today (map.ts keys a
  // BatchDoc by its upstream id), but `batchId` is documented as the human id
  // this app still intends to prettify, and `sourceId` is the upstream job id
  // every other call here already sends. If those ever diverge, master answers
  // an unknown id with a 404 that this module would read as a settled "no
  // analysis" and cache — silent and sticky, exactly the failure that is
  // hardest to notice.
  const jobIds = batches.map((b) => b.sourceId).filter(Boolean);
  // A blank `sourceId` is a broken BatchDoc, not an empty campaign. Asking about
  // the subset that does have one would answer a different question than the one
  // the customer asked, and presenting it as the whole selection — cached, with
  // no marker — is worse than admitting we could not answer.
  if (jobIds.length !== batches.length) {
    log().warn(
      { key: agg.key, expected: batches.length, usable: jobIds.length },
      "call-analysis enrichment skipped; some batches carry no sourceId",
    );
    return { aggregate: { ...agg, analysisUnavailable: true }, status: "failed", cacheable: false };
  }

  let raw: RawBatchAnalytics | null;
  try {
    raw = await fetchRollup(ctx, jobIds, agg.key);
  } catch (err) {
    // Degraded, not broken: the caller still serves every other series. Either
    // way the two cards stay empty, so mark the doc so the UI says "could not
    // load" rather than asserting these records carry no AI analysis.
    const settled = isSettledRefusal(err);
    log().warn(
      { err, batchCount: jobIds.length, key: agg.key, settled },
      "call-analysis enrichment could not be applied; serving aggregates without sentiment/topics",
    );
    return {
      aggregate: { ...agg, analysisUnavailable: true },
      status: settled ? "unavailable" : "failed",
      cacheable: settled,
    };
  }

  if (isMalformed(raw)) {
    log().warn(
      { key: agg.key, batchCount: jobIds.length },
      "call-analysis rollup did not match its declared shape; not caching",
    );
    return { aggregate: { ...agg, analysisUnavailable: true }, status: "failed", cacheable: false };
  }

  const sentiment = hasSentiment ? agg.sentiment : toSentimentSeries(raw);
  const topics = hasTopics ? agg.topics : toTopicSeries(raw);
  log().info(
    {
      batchCount: jobIds.length,
      key: agg.key,
      sentimentLabels: sentiment?.length ?? 0,
      topicCount: topics?.length ?? 0,
    },
    "call-analysis enrichment applied",
  );
  return { aggregate: { ...agg, sentiment, topics }, status: "ok", cacheable: true };
}

/** Fetch the rollup, surviving a selection that names a job upstream has lost.
 *
 *  Master 404s the WHOLE request when any one `job_id` is unknown, so without
 *  this a single deleted campaign in a 50-batch selection blanks the Conversation
 *  tab for the other 49 — and, being a settled answer, would stay blank. It names
 *  the culprits in `missing_job_ids`, so drop those and ask again for the rest:
 *  a job upstream no longer has contributes no analysis anyway, which makes the
 *  narrowed answer the correct one rather than a partial one.
 *
 *  Retried at most once, and only for a 404 that actually names ids. Anything
 *  else — including a route-not-found 404 from a master predating the endpoint —
 *  is re-thrown for `isSettledRefusal` to classify. */
async function fetchRollup(
  ctx: TenantContext,
  jobIds: string[],
  key: string,
): Promise<RawBatchAnalytics | null> {
  // Passed the same persistence hook the routes use. Without it a 401 here
  // re-minted a working token that was then thrown away with the request, so the
  // session kept the rejected one and every later analytics, insights or chat
  // call repeated the same 401-and-exchange — and a rotated refresh token, which
  // `firebase-token.ts` says callers MUST persist, was lost outright.
  const client = MagickClient.fromContext(ctx, { onCredentialRefresh: persistRefreshedCredential });
  try {
    return await client.batchAnalytics(jobIds);
  } catch (err) {
    const missing = missingJobIds(err);
    if (!missing) throw err;
    const remaining = jobIds.filter((id) => !missing.includes(id));
    if (remaining.length === 0) {
      // Every job in the selection is gone upstream. Settled, and `batchAnalytics`
      // reads an empty list as "nothing to ask", so the empty rollup below is the
      // honest answer rather than a swallowed error.
      log().warn({ key, missing: missing.length }, "call-analysis: no selected job still exists upstream");
      throw err;
    }
    log().warn(
      { key, missing: missing.length, remaining: remaining.length },
      "call-analysis: retrying rollup without jobs upstream no longer has",
    );
    return client.batchAnalytics(remaining);
  }
}
