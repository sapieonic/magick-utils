// Shared server-side contracts. The data layer, magick-master client, ingestion
// worker, and route handlers all agree on these shapes.

import type { BreakdownSeg, CallType, Channel, SelType, StatusKey } from "@/lib/types";

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
  ingestStatus: "none" | "ingesting" | "ready" | "error";
  updatedAt: string;
}

/** A normalized call/message record — the unified schema across calls + messages
 *  used for CSV export and analytics aggregation. One doc per record. */
export interface NormalizedRecord {
  tenantId: string;
  accountId: string;
  batchId: string;
  fingerprint: string;
  recordId: string; // call_id or message_id
  selType: SelType;
  channel: Channel;
  recipientPhone?: string | null;
  recipientEmail?: string | null;
  status: StatusKey | string;
  outcome?: string | null;
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
export type JobStatus = "queued" | "running" | "done" | "error";

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
  /** For insights jobs: the selected model. */
  model?: string;
  status: JobStatus;
  total: number;
  done: number;
  cursor?: number; // resumable pagination offset
  fingerprint?: string;
  error?: string | null;
  result?: unknown; // e.g. merge → { columns, rowCount }; insights → Insight
  createdAt: string;
  updatedAt: string;
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
  computedAt: string;
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
