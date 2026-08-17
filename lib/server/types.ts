// Shared server-side contracts. The data layer, magick-master client, ingestion
// worker, and route handlers all agree on these shapes.

import type { BreakdownSeg, CallType, Channel, SelType, StatusKey } from "@/lib/types";
import type { AppTimezone } from "@/lib/timezone";

/** The authenticated tenant/account context derived from the session cookie. */
export interface TenantContext {
  tenantId: string;
  accountId: string;
  idToken: string; // Firebase ID token, forwarded as Bearer to magick-master
}

/** Cached campaign/batch metadata. Mirrors the frontend `Batch` shape so the UI
 *  maps 1:1, plus bookkeeping fields. One doc per (tenant, account, batchId). */
export interface BatchDoc {
  tenantId: string;
  accountId: string;
  batchId: string; // human id e.g. AI-9140 (also the grouping key)
  sourceId: string; // upstream batch_id / bulk-dispatch job id
  name: string;
  channel: Channel;
  callType: CallType;
  selType: SelType;
  provider: string;
  date: string; // ISO
  total: number;
  breakdown: BreakdownSeg[];
  successRate: number;
  spendInr: number;
  telephonyInr: number;
  aiInr: number;
  avgDuration: number | null;
  avgTalkTime: number | null;
  fingerprint: string; // changes when a running batch's counts change
  /** Revision of the upstream bulk-job summary, distinct from the committed
   * normalized dataset fingerprint above. */
  sourceFingerprint?: string;
  /** Immutable record revision currently visible to readers. Older documents
   * without this field use the legacy unversioned record set. */
  publishedRevision?: string;
  ingestStatus: "none" | "ingesting" | "ready" | "error";
  /** Current worker ownership, used for conditional revision publication. */
  ingestJobId?: string;
  ingestLeaseId?: string;
  /** Ordering token for batch ownership. A reclaimed worker always has a later
   * lease deadline, so a stale worker cannot overwrite its ownership marker. */
  ingestLeaseUntil?: string;
  updatedAt: string;
}

/** A normalized call/message record — the unified schema across calls + messages
 *  used for CSV export and analytics aggregation. One doc per record. */
export interface NormalizedRecord {
  tenantId: string;
  accountId: string;
  batchId: string;
  /** Staging/publication revision. Missing only on legacy records. */
  revision?: string;
  /** Creation time for grace-period cleanup of retired immutable revisions. */
  revisionCreatedAt?: Date;
  /** Set only after a newer revision is published; GC never targets staging. */
  retiredAt?: Date;
  fingerprint: string;
  recordId: string; // call_id or message_id
  selType: SelType;
  channel: Channel;
  recipientPhone?: string | null;
  recipientEmail?: string | null;
  status: StatusKey | string;
  outcome?: string | null;
  /** Timestamp at which the outbound activity was placed/sent. Analytics use
   *  this rather than completion/read time so volume and reach windows reflect
   *  when the customer actually initiated contact. */
  activityTimestamp?: string | null;
  /** Indexed canonical activity instant used by dashboard range queries. */
  activityDate?: Date | null;
  timestamp?: string | null;
  provider?: string | null;
  totalCostInr?: number | null;
  telephonyCostInr?: number | null;
  aiCostInr?: number | null;
  // call-specific
  durationSeconds?: number | null;
  talkTimeSeconds?: number | null;
  recordingUrl?: string | null;
  conversationSummary?: string | null;
  sentiment?: string | null;
  keyTopics?: string[] | null;
  transcript?: string | null;
  // ivr-specific
  dtmfInput?: string | null;
  ivrPath?: string | null;
  completedNode?: string | null;
  // message-specific
  messageId?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  replyText?: string | null;
  templateName?: string | null;
  bounceReason?: string | null;
  /** original upstream record, for columns we didn't map explicitly */
  raw?: Record<string, unknown>;
}

export type JobType = "ingest" | "merge" | "insights";
export type JobStatus = "queued" | "running" | "rate_limited" | "done" | "error";

export interface Job {
  jobId: string;
  type: JobType;
  tenantId: string;
  accountId: string;
  /** Caller's Firebase ID token, stored so the background worker can call
   *  magick-master on the user's behalf. V1 tradeoff — see PROPOSAL (refresh
   *  tokens / service credentials are an iterate-later concern). */
  idToken?: string;
  batchIds: string[];
  /** For insights jobs: the backend-configured model. */
  model?: string;
  status: JobStatus;
  total: number;
  done: number;
  cursor?: number;
  batchIndex?: number;
  retryAt?: string | null;
  retryCount?: number;
  leaseUntil?: string | null;
  leaseId?: string | null;
  fingerprint?: string;
  error?: string | null;
  result?: unknown; // e.g. merge → { columns, rowCount }; insights → Insight
  createdAt: string;
  updatedAt: string;
}

/** Unique batch-scoped admission lock preventing overlapping ingestion jobs. */
export interface IngestionLock {
  tenantId: string;
  accountId: string;
  batchId: string;
  jobId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface AiUsageWindow {
  key: string;
  tenantId: string;
  accountId: string;
  kind: "chat" | "insight" | "comparison";
  count: number;
  createdAt: Date;
  expiresAt: Date;
}

/** One weekday×hour cell of the best-time-to-reach matrix (feature 4b).
 *  `weekday` is IST `getUTCDay()` on the +05:30-shifted instant (0=Sun…6=Sat);
 *  `band` indexes fixed-width hour bands (`band * bandHours`–`(band+1) *
 *  bandHours`, IST). A cell with `total < minSamples` is flagged `lowSample`
 *  and excluded from "best window" selection so we never recommend off a
 *  handful of records. */
export interface ReachCell {
  weekday: number; // 0–6 (IST)
  band: number; // 0…(24/bandHours - 1)
  total: number; // records placed in this window
  reached: number; // connected / read records (completed for voice, read for messages)
  rate: number; // reached / total (0 when total is 0) — connectivity % for voice
  lowSample: boolean; // total < minSamples
}

/** Connectivity (voice) / read rate bucketed by weekday × hour — the basis
 *  for the best-time-to-reach heatmap and the AI scheduling recommendation. */
export interface ReachByTimeOfDay {
  timezone: AppTimezone;
  bandHours: number; // hour-band width (1 → 24 hourly columns)
  minSamples: number; // sample gate below which a cell is lowSample
  totalPlaced: number; // records with a usable timestamp
  cells: ReachCell[]; // sparse — only weekday×band combos with records
}

/** Named count used by dashboard mix / funnel / ranked-bar widgets. */
export interface NamedCount {
  key: string;
  value: number;
  label?: string;
}

/** Connected-call length quality (short calls + immediate hang-ups).
 *  Unanswered rings are excluded — only `completed` calls with a duration. */
export interface ShortCallStats {
  connectedWithDuration: number;
  shortCount: number;
  shortRate: number;
  connectedWithTalk: number;
  hangupCount: number;
  hangupRate: number;
  avgDuration: number | null;
  avgTalkTime: number | null;
  talkRatio: number | null;
  thresholdSeconds: number;
  hangupTalkSeconds: number;
  durationHistogram: { bucket: string; calls: number }[];
}

/** IVR journey drop-off: path depth, terminal node, top paths, DTMF. */
export interface IvrDropoff {
  totalIvr: number;
  withPath: number;
  hangupCount: number;
  hangupRate: number;
  depthFunnel: { stage: string; value: number }[];
  completedNodes: NamedCount[];
  topPaths: { path: string; value: number }[];
  dtmf: { input: string; value: number }[];
}

export interface DashboardVolume {
  timezone: AppTimezone;
  range: string;
  start: string | null;
  end: string;
  totalRecords: number;
  totalCalls: number;
  totalMessages: number;
  successRate: number;
  spendInr: number;
  telephonyInr: number;
  aiInr: number;
  statusMix: { key: string; value: number }[];
  points: { date: string; calls: number; messages: number }[];
  /** Voice-only status mix (connect vs no-answer / busy / failed / …). */
  voiceConnectMix: NamedCount[];
  /** Message delivery funnel: Sent → Delivered → Read → Replied. */
  messageFunnel: { stage: string; value: number }[];
  /** Business `outcome` rollup (promise-to-pay, callback, …). */
  outcomes: NamedCount[];
  /** Null when no connected calls in the period have a duration. */
  shortCalls: ShortCallStats | null;
  /** Null when no IVR records are in the period. */
  ivrDropoff: IvrDropoff | null;
}

/** Precomputed analytics for a selection, keyed by fingerprint of the batch set. */
export interface AggregatesDoc {
  tenantId: string;
  accountId: string;
  key: string; // versioned aggregate cache key for the sorted batchId set
  batchIds: string[];
  totalRecords: number;
  statusMix: { key: string; value: number }[];
  successRate: number;
  spendInr: number;
  telephonyInr: number;
  aiInr: number;
  durationHistogram?: { bucket: string; calls: number; talk: number }[];
  sentiment?: { name: string; value: number }[];
  topics?: { topic: string; count: number; sentiment: string }[];
  funnel?: { stage: string; value: number }[];
  volumeOverTime?: { date: string; calls: number; messages: number }[];
  costOverTime?: { date: string; telephony: number; ai: number }[];
  reachByTimeOfDay?: ReachByTimeOfDay;
  computedAt: string;
}

/** A signed delta between two scalar metrics. `relative` is the fractional
 *  change (current−baseline)/baseline, or `null` when baseline is 0 (avoids a
 *  divide-by-zero / "+∞%" that the UI and LLM must not over-read). */
export interface MetricDelta {
  current: number;
  baseline: number;
  delta: number; // current − baseline (absolute)
  relative: number | null; // fractional change, null when baseline is 0
}

/** A change in one category's share-of-total between baseline and current.
 *  Shares (not raw counts) so comparisons aren't dominated by differing volume. */
export interface ShareShift {
  key: string;
  currentShare: number; // 0–1
  baselineShare: number; // 0–1
  deltaShare: number; // current − baseline (in share)
}

/** Deterministic diff of two `AggregatesDoc`s (feature 4a). Every number here is
 *  computed by code so the LLM only ever *explains* the change, never derives it. */
export interface AggregatesDiff {
  current: { batchIds: string[]; totalRecords: number };
  baseline: { batchIds: string[]; totalRecords: number };
  /** Success rate change in percentage **points** (current−baseline)*100. */
  successRate: { current: number; baseline: number; deltaPp: number; relative: number | null };
  spendInr: MetricDelta;
  telephonyInr: MetricDelta;
  aiInr: MetricDelta;
  /** Shift in telephony's share of total spend (the cost-mix change). */
  costSplit: { currentTelephonyShare: number; baselineTelephonyShare: number; deltaShare: number };
  volume: MetricDelta; // totalRecords
  topicShifts: ShareShift[]; // ordered by |deltaShare| desc
  statusMixShift: ShareShift[];
  sentimentShift: ShareShift[];
  /** Present only when both sides are message sets — per funnel stage, value
   *  delta plus the stage's share-of-Sent (retention) shift. */
  funnelShifts?: {
    stage: string;
    current: number;
    baseline: number;
    currentShareOfSent: number;
    baselineShareOfSent: number;
    deltaShareOfSent: number;
  }[];
}

export interface Anomaly {
  title: string;
  detail: string;
  severity: "low" | "medium" | "high";
}
export interface Recommendation {
  title: string;
  detail: string;
}
export interface Insight {
  tenantId: string;
  accountId: string;
  key: string; // `${fingerprint}:${model}`
  fingerprint: string;
  model: string;
  narrative: string;
  anomalies: Anomaly[];
  recommendations: Recommendation[];
  createdAt: string;
}
