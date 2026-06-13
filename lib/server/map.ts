// Map server-side BatchDoc → the frontend `Batch` shape the screens consume,
// and build a BatchDoc summary directly from a magick-master bulk-dispatch job
// (used by the campaigns listing before any records are ingested).

import type { Batch, BreakdownSeg, StatusKey } from "@/lib/types";
import type { BatchDoc, TenantContext } from "./types";
import type { RawBulkJob } from "./magick-client";
import { dispatchTypeToType, normalizeStatus } from "./normalize";
import { fingerprint } from "./fingerprint";

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
    breakdown: doc.breakdown,
    successRate: doc.successRate,
    spendInr: doc.spendInr,
    telephonyInr: doc.telephonyInr,
    aiInr: doc.aiInr,
    avgDuration: doc.avgDuration,
    avgTalkTime: doc.avgTalkTime,
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
 *  Once the ingestion worker has run (existing.ingestStatus === "ready") its exact
 *  per-record figures are authoritative, so we preserve the existing breakdown,
 *  successRate, spend and averages rather than overwrite them with this estimate. */
export function bulkJobToBatchDoc(job: RawBulkJob, ctx: TenantContext, existing?: BatchDoc | null): BatchDoc {
  const map = dispatchTypeToType(job.dispatch_type);
  const sourceId = (job.id ?? "").toString();
  const total = job.total_contacts ?? 0;
  const ingested = existing?.ingestStatus === "ready";

  let breakdown: BreakdownSeg[];
  let successRate: number;

  if (ingested && existing) {
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

  const fp = fingerprint([sourceId, total, JSON.stringify(breakdown), job.status]);
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
    breakdown,
    successRate,
    // spend unknown until ingestion; preserve any previously ingested figures
    spendInr: existing?.spendInr ?? 0,
    telephonyInr: existing?.telephonyInr ?? 0,
    aiInr: existing?.aiInr ?? 0,
    avgDuration: existing?.avgDuration ?? null,
    avgTalkTime: existing?.avgTalkTime ?? null,
    fingerprint: fp,
    ingestStatus: existing?.ingestStatus ?? "none",
    updatedAt: new Date().toISOString(),
  };
}
