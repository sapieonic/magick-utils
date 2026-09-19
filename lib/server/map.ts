// Map server-side BatchDoc → the frontend `Batch` shape the screens consume,
// and build a BatchDoc summary directly from a magick-master bulk-dispatch job
// (used by the campaigns listing before any records are ingested).

import type { Batch, BreakdownSeg, StatusKey } from "@/lib/types";
import { isBatchReadable, type BatchDoc, type TenantContext } from "./types";
import type { RawBulkJob } from "./magick-client";
import { dispatchTypeToType, normalizeStatus } from "./normalize";
import { fingerprint, stableJson } from "./fingerprint";

const PREFIX: Record<string, string> = { ai: "AI", ivr: "IVR", whatsapp: "WA", telegram: "TG", email: "EM" };

export function dayAgo(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/** Synthesize a short human-readable batch id from selType + source id. */
export function humanBatchId(selType: string, sourceId: string): string {
  const p = PREFIX[selType] ?? "B";
  const tail = sourceId.replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase() || "0000";
  return `${p}-${tail}`;
}

export function batchDocToBatch(doc: BatchDoc): Batch {
  return {
    id: doc.batchId,
    batchId: doc.batchId,
    name: doc.name,
    channel: doc.channel,
    callType: doc.callType,
    provider: doc.provider,
    date: doc.date,
    dayAgo: dayAgo(doc.date),
    total: doc.total,
    sourceTotal: doc.sourceTotal,
    breakdown: doc.breakdown,
    successRate: doc.successRate,
    spendInr: doc.spendInr,
    telephonyInr: doc.telephonyInr,
    aiInr: doc.aiInr,
    avgDuration: doc.avgDuration,
    avgTalkTime: doc.avgTalkTime,
    ingestStatus: doc.ingestStatus,
  };
}

/** Stable display order for breakdown segments (mirrors normalize.computeBreakdown). */
const BREAKDOWN_ORDER: StatusKey[] = [
  "completed", "failed", "switchedoff", "busy", "noanswer", "voicemail", "inprogress", "pending",
  "delivered", "read", "bounced", "sent",
];

/** Convert a status→count map into ordered BreakdownSeg[], dropping zeroes. */
function toSegs(counts: Partial<Record<StatusKey, number>>): BreakdownSeg[] {
  return BREAKDOWN_ORDER
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ key: k, value: counts[k]! }));
}

/** Aggregate a job's per-batch call_status_counts into a flat status→count map.
 *  Skips the `batch_id` marker and coerces stringy counts (webhook payloads). */
function aggregateCallStatusCounts(entries: Array<Record<string, number>>): Record<string, number> {
  const agg: Record<string, number> = {};
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === "batch_id") continue;
      const n = typeof value === "number" ? value : parseInt(String(value), 10);
      if (!Number.isNaN(n)) agg[key] = (agg[key] ?? 0) + n;
    }
  }
  return agg;
}

/** Bucket a flat core-status map into call breakdown segments + completed count.
 *  Statuses are mapped via the same table normalize.ts uses for per-record
 *  normalization, so pre- and post-ingestion buckets agree. The breakdown reflects
 *  ONLY the statuses the backend actually reports — contacts in `total_contacts`
 *  that core never turned into call records are NOT synthesized into a "pending"
 *  bucket (that would invent a status the backend never sent). Segments may
 *  therefore sum to fewer than total_contacts; that gap is intentionally unshown. */
function callBreakdown(summary: Record<string, number>): { breakdown: BreakdownSeg[]; completed: number } {
  const counts: Partial<Record<StatusKey, number>> = {};
  for (const [status, raw] of Object.entries(summary)) {
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (Number.isNaN(n) || n <= 0) continue;
    const key = normalizeStatus(status, "call");
    if ((BREAKDOWN_ORDER as string[]).includes(key)) {
      counts[key as StatusKey] = (counts[key as StatusKey] ?? 0) + n;
    }
    // Unknown statuses are simply dropped — never invented as another bucket.
  }
  return { breakdown: toSegs(counts), completed: counts.completed ?? 0 };
}

/** Pre-ingestion breakdown for messaging jobs. magick-master tracks messaging at
 *  batch granularity only (no per-message status until the ingestion worker pulls
 *  delivery/read counts from core), so we derive a single bucket from job status:
 *  dispatched → "sent", failed/cancelled → "failed", otherwise → "pending". */
function messageBreakdown(status: string, total: number): BreakdownSeg[] {
  if (total <= 0) return [];
  const s = (status ?? "").toLowerCase().trim();
  let key: StatusKey;
  if (["completed", "dispatched", "partially_failed"].includes(s)) key = "sent";
  else if (["failed", "cancelled"].includes(s)) key = "failed";
  else key = "pending"; // queued, processing, unknown
  return [{ key, value: total }];
}

/** Fingerprint of the upstream bulk-job summary, used to decide whether an
 *  already-ingested batch is still in step with its source — i.e. whether the
 *  campaigns listing should mark it "stale".
 *
 *  Deliberately excludes `updated_at`: magick-master bumps it on any write to
 *  the job, including enrichment that changes no record. Including it made this
 *  fingerprint churn on ordinary listings, which reset ingested batches and
 *  cost a full duplicate re-ingest every time.
 *
 *  That omission makes this signal one-directional: a change here proves the
 *  source moved, but no change does NOT prove it stood still. `status_summary`
 *  and `call_status_counts` are call-dispatch-only (see RawBulkJob), so for a
 *  messaging campaign this reduces to id/total/status and cannot see delivery
 *  receipts or replies arriving. Anything deciding whether to SKIP work must
 *  therefore use `bulkJobIsUnchangedSince` below, never this alone. */
export function bulkJobSourceFingerprint(job: RawBulkJob): string {
  return fingerprint([
    (job.id ?? "").toString(),
    job.total_contacts ?? 0,
    job.status,
    stableJson(job.status_summary ?? null),
    unorderedJson(job.call_status_counts),
  ]);
}

/** `stableJson` canonicalizes object keys but preserves array order, which is
 *  correct in general and wrong for `call_status_counts`: it is a SET of
 *  per-batch count rows assembled from webhook arrivals, so upstream is free to
 *  serve the same rows in a different order on the next listing. Comparing it
 *  positionally would read a reshuffle as a source change and cost a full
 *  duplicate re-ingest — the exact churn this fingerprint exists to stop.
 *  Sorting the canonicalized rows makes the comparison order-insensitive while
 *  still distinguishing any real change to a row's contents. */
function unorderedJson(rows: Array<Record<string, number>> | null | undefined): string {
  if (!rows) return stableJson(null);
  return `[${rows.map(stableJson).sort().join(",")}]`;
}

/** Upstream job states after which no further records or enrichment arrive.
 *  Anything else — including an unrecognised state — counts as still moving. */
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

/**
 * Whether `job` can be proven untouched since a previous ingestion recorded
 * `ingestedSourceUpdatedAt`, so re-pulling it would rewrite the same dataset.
 *
 * Requires both: the job has finished (a running campaign keeps producing
 * records), and upstream has not written to it since. `updated_at` is the whole
 * test on purpose. It is the only field that moves for the changes
 * `bulkJobSourceFingerprint` is blind to — message delivery and read receipts,
 * replies, and post-call AI enrichment such as sentiment, key topics and cost.
 * It is also a single scalar present on both the list and the detail payload,
 * so the value stamped at ingestion and the value checked here are comparable
 * even if the two endpoints differ in the richer summary fields.
 *
 * Errs toward "changed": an unknown status, an upstream that sends no
 * `updated_at`, or a batch ingested before this marker existed all return false
 * and get re-ingested. Redundant work is recoverable and self-cleaning;
 * silently serving a customer stale data is not.
 */
export function bulkJobIsUnchangedSince(
  job: RawBulkJob,
  ingestedSourceUpdatedAt: string | null | undefined,
): boolean {
  if (!ingestedSourceUpdatedAt) return false;
  if (!TERMINAL_JOB_STATUSES.has((job.status ?? "").toLowerCase().trim())) return false;
  return (job.updated_at ?? null) === ingestedSourceUpdatedAt;
}

/** Build a (pre-ingestion) BatchDoc summary from a bulk-dispatch job.
 *
 *  Counts are derived strictly from the data magick-master returns on the job —
 *  we never synthesize a status the backend didn't report:
 *   - call dispatch types use `status_summary` (per-call counts from core),
 *     falling back to `call_status_counts`, then to an empty breakdown when the
 *     backend reports no counts yet (NOT a fabricated all-pending bar);
 *   - messaging types derive a single bucket from the job's own `status`
 *     (see messageBreakdown) — that is native data, not invented.
 *
 *  Once the ingestion worker has run its exact per-record figures are
 *  authoritative, so we preserve the existing breakdown, successRate, spend,
 *  averages and record total rather than overwrite them with this estimate —
 *  including when the upstream summary has moved on (ingestStatus "stale").
 *  Downgrading an ingested batch back to "none" here used to make the record
 *  count visibly jump between page loads, 409 the next analytics call, and
 *  trigger a full re-ingest. */
export function bulkJobToBatchDoc(job: RawBulkJob, ctx: TenantContext, existing?: BatchDoc | null): BatchDoc {
  const map = dispatchTypeToType(job.dispatch_type);
  const sourceId = (job.id ?? "").toString();
  const sourceTotal = job.total_contacts ?? 0;
  const ingested = Boolean(existing && isBatchReadable(existing));
  const sourceFp = bulkJobSourceFingerprint(job);
  // Compare against what the PUBLISHED REVISION was built from, not against the
  // last summary a listing happened to see. Comparing listing-to-listing let a
  // transient upstream blip (a momentarily absent status_summary) latch a batch
  // to "stale" with no path back, since only a publish clears it. Records
  // ingested before markers existed cannot be proven current, so they read as
  // stale until the next ingestion stamps one.
  const sourceChanged = Boolean(ingested && existing?.ingestedSourceFingerprint !== sourceFp);
  // An ingested dataset stays authoritative even once upstream moves on: its
  // records are still the ones every reader sees, so its figures — the record
  // total above all — must not flip back to the coarse upstream estimate.
  const committed = Boolean(ingested && existing);
  // Once committed, unique normalized records—not a possibly stale/raw contact
  // count—are authoritative for readiness, analytics, and exports.
  const total = committed ? existing!.total : sourceTotal;
  // Never gated on `committed`: this is what upstream says it dispatched, and
  // an ingestion — however it went — is not evidence about that. Recording it
  // unconditionally is what keeps a zero-record commit from erasing the proof
  // that records are missing (see BatchDoc.sourceTotal).
  const dispatchedTotal = sourceTotal;

  let breakdown: BreakdownSeg[];
  let successRate: number;

  if (committed && existing) {
    // Exact figures already computed by ingestion — don't clobber with the estimate.
    breakdown = existing.breakdown;
    successRate = existing.successRate;
  } else if (map.selType === "message") {
    breakdown = messageBreakdown(job.status ?? "", total);
    // Success for messaging is "read", which only the ingestion worker can know.
    successRate = 0;
  } else {
    const summary =
      job.status_summary && Object.keys(job.status_summary).length > 0
        ? job.status_summary
        : job.call_status_counts && job.call_status_counts.length > 0
          ? aggregateCallStatusCounts(job.call_status_counts)
          : null;
    if (summary && Object.keys(summary).length > 0) {
      const result = callBreakdown(summary);
      breakdown = result.breakdown;
      successRate = total > 0 ? result.completed / total : 0;
    } else {
      // Backend reported no per-status counts yet — show nothing rather than
      // inventing a "pending" bar. Real statuses appear once core has them.
      breakdown = [];
      successRate = 0;
    }
  }

  // Key by the upstream source id so the campaigns listing, ingestion worker, and
  // frontend batch ids all align. (humanBatchId is kept for a future display id.)
  const batchId = existing?.batchId ?? sourceId;

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    batchId,
    sourceId,
    name: job.name ?? batchId,
    channel: map.channel,
    callType: map.callType,
    selType: map.selType,
    provider: (job.provider as string | null | undefined) ?? map.channel,
    date: job.created_at ?? new Date().toISOString(),
    total,
    sourceTotal: dispatchedTotal,
    breakdown,
    successRate,
    // spend unknown until ingestion; preserve any previously ingested figures
    spendInr: existing?.spendInr ?? 0,
    telephonyInr: existing?.telephonyInr ?? 0,
    aiInr: existing?.aiInr ?? 0,
    avgDuration: existing?.avgDuration ?? null,
    avgTalkTime: existing?.avgTalkTime ?? null,
    // An ingested fingerprint represents the exact normalized dataset. Do not
    // replace it with the coarser upstream job summary on every list refresh.
    fingerprint: ingested && existing ? existing.fingerprint : sourceFp,
    sourceFingerprint: sourceFp,
    // Preserved so a refresh can tell an unchanged source (nothing to re-pull)
    // from a genuinely moved one. Only a completed ingestion writes these.
    ingestedSourceFingerprint: existing?.ingestedSourceFingerprint,
    ingestedSourceUpdatedAt: existing?.ingestedSourceUpdatedAt,
    publishedRevision: existing?.publishedRevision,
    // "stale" keeps the published revision readable — analytics and exports
    // keep working off it — while marking that a refresh has something to pull.
    // An ingested batch is re-derived from the comparison each time rather than
    // carried forward, so a source that moves and then moves back resolves to
    // "ready" again instead of latching stale until someone forces a re-pull.
    ingestStatus: ingested ? (sourceChanged ? "stale" : "ready") : existing?.ingestStatus ?? "none",
    updatedAt: new Date().toISOString(),
  };
}
