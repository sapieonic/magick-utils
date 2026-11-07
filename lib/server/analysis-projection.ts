// Whether a batch's records were pulled from a core that projects post-call
// analysis onto the calls list, and the one bounded path that re-pulls the
// ones that were not.
//
// Background. Core's AI calls list omits the heavy `call_analysis` JSONB and
// sends `call_analysis: null`, so records ingested from it carried no sentiment
// or key topics, and the CSV export emitted those columns blank. Core now
// projects two scalars onto every list/search row — `analysis_sentiment_label`
// and `analysis_key_topics` — PRESENT (possibly null) on every row once
// deployed, ABSENT on rows from an older core.
//
// The transition problem. A core deploy that only adds list columns writes no
// call row, so master's `records_updated_at` does not move and the refresh skip
// (`bulkJobIsUnchangedSince`) proves every already-ingested AI batch unchanged
// forever — even on an explicit Refresh — leaving them blank. Making that
// refresh unconditional is not an option: every ingestion writes a complete
// duplicate dataset, and before core deploys a re-pull would only write another
// copy of the same nulls, on every click.
//
// So the upgrade is bounded on both sides:
//   - The worker stamps `BatchDoc.recordsAnalysisProjected` on every AI publish
//     (and on the short-pull "unchanged" path, which writes no records): true
//     only when EVERY row the pull returned carried the projection keys. Once
//     true, nothing here ever re-pulls that batch for this reason again.
//   - The ingest route bypasses the unchanged-stamp skip for an unmarked AI
//     batch only on an explicit user action (Refresh, or a merge for the CSV
//     export), and only after a one-row probe of the same list surface shows
//     upstream now emits the keys. Before core deploys, the probe says no and
//     nothing is re-pulled. The probe is memoised per request, so a 50-batch
//     selection costs one upstream call, not fifty.
//
// Key PRESENCE, never value: a row whose call was never analysed carries
// `analysis_sentiment_label: null`, and a batch of such rows is fully upgraded.
//
// One residual: the marker is judged on the rows a pull RETURNED, so after a
// SHORT upgrade pull the rows carried forward from the previous revision keep
// their blank analysis while the batch reads upgraded. They fill only when a
// later pull (the completeness re-pull a short batch already gets) returns
// them — rare now that core's list order has an `id` tiebreak.

import type { MagickClient, RawCall } from "./magick-client";
import { TokenRefreshPermanentError } from "./firebase-token";
import { log } from "./logger";
import type { BatchDoc, NormalizedRecord } from "./types";

/** The list-row keys whose presence marks a row as served by a core that
 *  projects post-call analysis. Both, because the contract ships them together
 *  and a records set is only "upgraded" when both columns could be filled. */
export const ANALYSIS_PROJECTION_KEYS = ["analysis_sentiment_label", "analysis_key_topics"] as const;

/** Whether one raw upstream row carries the projection (keys present, values
 *  may be null). */
export function rowCarriesAnalysisProjection(raw: unknown): boolean {
  if (raw == null || typeof raw !== "object") return false;
  return ANALYSIS_PROJECTION_KEYS.every((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

/** Whether every record a pull returned came from a projecting core.
 *
 *  Read off `record.raw`, which keeps every upstream key (only
 *  `conversation_log` is dropped) — including a null-valued one, which Mongo
 *  stores and returns as a present `null`. That is what lets a RESUMED pull,
 *  whose earlier pages were staged by a previous attempt, answer the same way.
 *
 *  EVERY row, not any: pages of one pull can be served by different core
 *  replicas during a rolling deploy, and a pull that mixed old and new rows has
 *  not upgraded the old ones. Leaving such a batch unmarked lets the next
 *  explicit refresh finish the job; marking it would strand those rows blank.
 *  An empty set is not evidence either way, so it is false. */
export function recordsCarryAnalysisProjection(records: readonly Pick<NormalizedRecord, "raw">[]): boolean {
  return records.length > 0 && records.every((record) => rowCarriesAnalysisProjection(record.raw));
}

/** Whether a batch is an AI batch whose published records predate the
 *  projection, i.e. a candidate for the one-off upgrade re-pull.
 *
 *  Strictly `ai_voice_call`: only `/proxy/calls` rows carry the projection, and
 *  `selType` alone cannot say which surface a batch lists from. Read with
 *  `!== true`: the driver stores an undefined field as BSON null, and documents
 *  published before this marker existed have neither.
 *
 *  A batch whose published revision holds NO records is never a candidate.
 *  There is nothing on it to upgrade, and it could never earn the marker:
 *  `recordsCarryAnalysisProjection([])` is false, so a re-pull that again
 *  returns nothing leaves it unmarked — and once another batch of the same
 *  request has settled the memoised probe to "projects", it would be re-pulled
 *  on every Refresh and every merge, forever. `total` is the published
 *  revision's exact record count (see BatchDoc.total); both callers reach this
 *  only for a batch that has a published revision. If upstream later adds rows
 *  to the job, `records_updated_at` moves and the ordinary refresh re-pulls it. */
export function needsAnalysisUpgrade(
  batch: Pick<BatchDoc, "dispatchType" | "recordsAnalysisProjected" | "total">,
): boolean {
  return batch.dispatchType === "ai_voice_call" && batch.recordsAnalysisProjected !== true && batch.total > 0;
}

/** Whether every batch of an AI selection was published from a projecting
 *  core, so the records' own sentiment/topics describe the whole selection.
 *
 *  A batch with no published records contributes nothing to either series, so
 *  it cannot make them partial — and since it can never be marked (see
 *  `needsAnalysisUpgrade`), counting it would leave every selection that
 *  includes it non-authoritative for good. Only an explicit `total === 0` is
 *  exempt; a missing total is not evidence of an empty batch. */
export function recordsAnalysisAuthoritative(
  batches: readonly Pick<BatchDoc, "recordsAnalysisProjected" | "total">[],
): boolean {
  return (
    batches.length > 0 &&
    batches.every((batch) => batch.recordsAnalysisProjected === true || batch.total === 0)
  );
}

type ProbeAnswer = "projects" | "does_not_project" | "unavailable";

/**
 * A request-scoped probe: "does upstream's AI calls list now carry the
 * projection?", asked with ONE row of a job (`limit: 1`) on the same surface
 * the worker pages, so the probe and the pull cannot disagree about what they
 * would see.
 *
 * Memoised for the request: the answer is a property of the deployment the
 * tenant is served by, not of one batch, so the first definitive answer — and a
 * failure — is reused for every later batch of the same request. Calls are
 * serialised so concurrent callers share one in-flight request. A job that
 * returned no row says nothing, so the next candidate asks again (bounded by
 * the selection).
 *
 * A probe FAILURE answers "no upgrade". The batch has already been proven
 * unchanged by its records stamp, so its records are current in every field
 * upstream can change; the only open question is whether a new projection
 * exists, and re-pulling on "unknown" would turn every click during a master
 * outage into another full duplicate dataset. The next explicit refresh asks
 * again. A permanently dead credential is rethrown, as everywhere in the route.
 */
export function createAnalysisProjectionProbe(client: Pick<MagickClient, "listCalls">) {
  let chain: Promise<ProbeAnswer | null> = Promise.resolve(null);
  return (sourceId: string): Promise<boolean> => {
    // Never list without a job id: master would answer for the whole account.
    if (!sourceId) return Promise.resolve(false);
    const next = chain.then(async (settled): Promise<ProbeAnswer | null> => {
      if (settled !== null) return settled;
      try {
        const page = await client.listCalls({ jobId: sourceId, limit: 1, offset: 0 });
        const row: RawCall | undefined = (page.calls ?? [])[0];
        if (!row) return null;
        return rowCarriesAnalysisProjection(row) ? "projects" : "does_not_project";
      } catch (err) {
        if (err instanceof TokenRefreshPermanentError) throw err;
        log().warn({ error: err, sourceId }, "analysis projection probe failed — not re-pulling for the upgrade");
        return "unavailable";
      }
    });
    chain = next;
    return next.then((answer) => answer === "projects");
  };
}
