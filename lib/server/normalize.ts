// Normalization: map magic-voice-core call/message records (as proxied by
// magick-master) into our unified NormalizedRecord shape, and build BatchDoc
// summaries from bulk-dispatch jobs / record sets.
//
// Pure server module — no React. Defensive about missing upstream fields.
// Fingerprints are NOT computed here (the ingestion worker owns that); callers
// pass `fingerprint` in and we store it on records / batch docs.

import type { BreakdownSeg, CallType, Channel, SelType, StatusKey } from "@/lib/types";
import type { RawBulkJob, RawCall, RawMessage } from "@/lib/server/magick-client";
import type { BatchDoc, NormalizedRecord, TenantContext } from "@/lib/server/types";

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------

const CALL_STATUS_MAP: Record<string, StatusKey> = {
  completed: "completed",
  failed: "failed",
  escalate_human: "failed",
  switched_off: "switchedoff",
  no_answer: "noanswer",
  busy: "busy",
  voicemail: "voicemail",
  in_progress: "inprogress",
  // Genuinely pre-answer / in-flight states collapse to "pending".
  queued: "pending",
  initiating: "pending",
  ringing: "pending",
};

const MESSAGE_STATUS_MAP: Record<string, StatusKey> = {
  read: "read",
  opened: "read",
  delivered: "delivered",
  clicked: "delivered",
  bounced: "bounced",
  undelivered: "bounced",
  complained: "bounced",
  failed: "failed",
  queued: "sent",
  sending: "sent",
  sent: "sent",
};

/** Map an upstream status string to our StatusKey. Unknown statuses pass through
 *  as-is (returned as a raw string) so we never silently drop information. */
export function normalizeStatus(raw: string, kind: "call" | "message"): StatusKey | string {
  const key = (raw ?? "").toLowerCase().trim();
  const map = kind === "call" ? CALL_STATUS_MAP : MESSAGE_STATUS_MAP;
  return map[key] ?? raw;
}

// ---------------------------------------------------------------------------
// dispatch_type → channel / callType / selType
// ---------------------------------------------------------------------------

export interface DispatchTypeMapping {
  channel: Channel;
  callType: CallType;
  selType: SelType;
}

const DISPATCH_TYPE_MAP: Record<string, DispatchTypeMapping> = {
  ai_voice_call: { channel: "voice", callType: "ai", selType: "ai" },
  ivr_call: { channel: "voice", callType: "ivr", selType: "ivr" },
  static_call: { channel: "voice", callType: "ivr", selType: "ivr" },
  whatsapp_message: { channel: "whatsapp", callType: null, selType: "message" },
  telegram_message: { channel: "telegram", callType: null, selType: "message" },
  email_message: { channel: "email", callType: null, selType: "message" },
};

/** Map a bulk-dispatch job's dispatch_type to our channel/callType/selType.
 *  Unknown types default to ai/voice. */
export function dispatchTypeToType(dispatchType: string | null | undefined): DispatchTypeMapping {
  const key = (dispatchType ?? "").toLowerCase().trim();
  return DISPATCH_TYPE_MAP[key] ?? { channel: "voice", callType: "ai", selType: "ai" };
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

function transcriptFromLog(
  log: RawCall["conversation_log"],
): string | null {
  if (!Array.isArray(log) || log.length === 0) return null;
  const lines = log
    .map((turn) => {
      const role = (turn?.role ?? "").toString().trim();
      const content = (turn?.content ?? "").toString();
      if (!content) return null;
      return role ? `${role}: ${content}` : content;
    })
    .filter((l): l is string => l !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}

export interface NormalizeCallOpts {
  selType: "ai" | "ivr";
  batchId: string;
  fingerprint: string;
}

/** Normalize a raw core call into a NormalizedRecord. Defensive about all fields. */
export function normalizeCall(
  raw: RawCall,
  ctx: TenantContext,
  opts: NormalizeCallOpts,
): NormalizedRecord {
  const common = raw.call_analysis?.common ?? null;
  const sentiment = common?.overall_sentiment?.label ?? null;
  const keyTopics = Array.isArray(common?.key_topics) ? common?.key_topics ?? null : null;
  const timestamp = raw.timestamps?.ended_at ?? raw.created_at ?? null;

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    batchId: opts.batchId,
    fingerprint: opts.fingerprint,
    recordId: raw.call_id ?? "",
    selType: opts.selType,
    channel: "voice",
    recipientPhone: raw.recipient_phone ?? null,
    recipientEmail: null,
    status: normalizeStatus(raw.status ?? "", "call"),
    outcome: raw.outcome ?? null,
    timestamp,
    provider: raw.telephony_provider ?? null,
    totalCostInr: raw.total_cost_inr ?? null,
    telephonyCostInr: raw.telephony_cost_inr ?? null,
    aiCostInr: raw.ai_cost_inr ?? null,
    durationSeconds: raw.duration_seconds ?? null,
    talkTimeSeconds: raw.talk_time_seconds ?? null,
    recordingUrl: raw.recording_url ?? null,
    conversationSummary: raw.conversation_summary ?? common?.summary ?? null,
    sentiment,
    keyTopics,
    transcript: transcriptFromLog(raw.conversation_log),
    // ivr-specific (present on static/ivr calls)
    dtmfInput: (raw.dtmf_input as string | null | undefined) ?? null,
    ivrPath: (raw.ivr_path as string | null | undefined) ?? null,
    completedNode: (raw.completed_node as string | null | undefined) ?? null,
    raw: raw as Record<string, unknown>,
  };
}

export interface NormalizeMessageOpts {
  channel: "whatsapp" | "telegram" | "email";
  batchId: string;
  fingerprint: string;
}

/** Normalize a raw messaging record into a NormalizedRecord. */
export function normalizeMessage(
  raw: RawMessage,
  ctx: TenantContext,
  opts: NormalizeMessageOpts,
): NormalizedRecord {
  const messageId = raw.message_id ?? raw.wamid ?? raw.id ?? null;
  const timestamp =
    raw.read_at ?? raw.delivered_at ?? raw.sent_at ?? raw.failed_at ?? raw.created_at ?? null;
  const bounceReason = raw.error_message ?? raw.error_code ?? null;

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    batchId: opts.batchId,
    fingerprint: opts.fingerprint,
    recordId: (messageId ?? raw.id ?? "").toString(),
    selType: "message",
    channel: opts.channel,
    recipientPhone: raw.to_phone ?? null,
    recipientEmail: raw.to_email ?? null,
    status: normalizeStatus(raw.status ?? "", "message"),
    outcome: null,
    timestamp,
    provider: raw.provider ?? opts.channel,
    totalCostInr: null,
    telephonyCostInr: null,
    aiCostInr: null,
    // message-specific
    messageId,
    deliveredAt: raw.delivered_at ?? null,
    readAt: raw.read_at ?? null,
    templateName: raw.template_name ?? null,
    bounceReason,
    raw: raw as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// BatchDoc construction
// ---------------------------------------------------------------------------

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}

/** Tally normalized statuses into a BreakdownSeg[] (known StatusKeys only). */
function computeBreakdown(records: NormalizedRecord[]): BreakdownSeg[] {
  const order: StatusKey[] = [
    "completed",
    "failed",
    "switchedoff",
    "busy",
    "noanswer",
    "voicemail",
    "inprogress",
    "pending",
    "delivered",
    "read",
    "bounced",
    "sent",
  ];
  const counts = new Map<StatusKey, number>();
  for (const r of records) {
    const s = r.status;
    if ((order as string[]).includes(s)) {
      const key = s as StatusKey;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return order
    .filter((k) => counts.has(k))
    .map((k) => ({ key: k, value: counts.get(k) ?? 0 }));
}

export interface BuildBatchDocOpts {
  batchId: string;
  sourceId: string;
  name: string;
  channel: Channel;
  callType: CallType;
  selType: SelType;
  provider: string;
  date: string; // ISO
  fingerprint: string;
  ingestStatus?: BatchDoc["ingestStatus"];
  /** Override total (e.g. from a job's total_contacts); defaults to records.length. */
  total?: number;
}

/** Build a BatchDoc summary from a set of normalized records + context.
 *  Computes breakdown, successRate, summed spend, and call averages. */
export function buildBatchDoc(
  records: NormalizedRecord[],
  ctx: TenantContext,
  opts: BuildBatchDocOpts,
): BatchDoc {
  const total = opts.total ?? records.length;
  const breakdown = computeBreakdown(records);

  const isMessage = opts.selType === "message";
  const successKey: StatusKey = isMessage ? "read" : "completed";
  const successCount = records.filter((r) => r.status === successKey).length;
  const successRate = total > 0 ? successCount / total : 0;

  let telephonyInr = 0;
  let aiInr = 0;
  let spendInr = 0;
  const durations: number[] = [];
  const talkTimes: number[] = [];
  for (const r of records) {
    telephonyInr += r.telephonyCostInr ?? 0;
    aiInr += r.aiCostInr ?? 0;
    spendInr += r.totalCostInr ?? 0;
    if (typeof r.durationSeconds === "number") durations.push(r.durationSeconds);
    if (typeof r.talkTimeSeconds === "number") talkTimes.push(r.talkTimeSeconds);
  }

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    batchId: opts.batchId,
    sourceId: opts.sourceId,
    name: opts.name,
    channel: opts.channel,
    callType: opts.callType,
    selType: opts.selType,
    provider: opts.provider,
    date: opts.date,
    total,
    breakdown,
    successRate,
    spendInr,
    telephonyInr,
    aiInr,
    avgDuration: isMessage ? null : avg(durations),
    avgTalkTime: isMessage ? null : avg(talkTimes),
    fingerprint: opts.fingerprint,
    ingestStatus: opts.ingestStatus ?? "ready",
    updatedAt: new Date().toISOString(),
  };
}

/** Convenience: derive a BuildBatchDocOpts skeleton from a bulk-dispatch job.
 *  The caller supplies batchId (human id) + fingerprint; channel/callType/selType
 *  come from dispatch_type. */
export function batchDocOptsFromJob(
  job: RawBulkJob,
  args: { batchId: string; fingerprint: string },
): BuildBatchDocOpts {
  const mapping = dispatchTypeToType(job.dispatch_type);
  return {
    batchId: args.batchId,
    sourceId: (job.id ?? "").toString(),
    name: job.name ?? (job.id ?? "").toString(),
    channel: mapping.channel,
    callType: mapping.callType,
    selType: mapping.selType,
    provider: (job.provider as string | null | undefined) ?? mapping.channel,
    date: job.created_at ?? new Date().toISOString(),
    fingerprint: args.fingerprint,
    total: job.total_contacts ?? undefined,
  };
}
