// Core domain types for MagickUtils.
// A "batch" = the result of one bulk job. Its type drives badges, the column
// schema, and which batches can be merged/analyzed together.

export type Channel = "voice" | "whatsapp" | "telegram" | "email";
export type CallType = "ai" | "ivr" | null;

/** Display type key — keeps messaging channels distinct for badges. */
export type TypeKey = "ai" | "ivr" | "whatsapp" | "telegram" | "email";

/** Selection type — groups all messaging channels as "message". The hard rule:
 *  you may only multi-select / combine / analyze-together batches that share the
 *  same selType. */
export type SelType = "ai" | "ivr" | "message";

export type StatusKey =
  | "completed"
  | "failed"
  | "switchedoff"
  | "busy"
  | "noanswer"
  | "voicemail"
  | "inprogress"
  | "pending"
  | "delivered"
  | "read"
  | "bounced"
  | "sent";

export interface BreakdownSeg {
  key: StatusKey;
  value: number;
}

export interface Batch {
  id: string;
  batchId: string; // e.g. AI-9140, IVR-3759, WA-6783
  name: string;
  channel: Channel;
  callType: CallType;
  provider: string;
  date: string; // ISO
  dayAgo: number;
  total: number; // record count
  /** Contacts the bulk job dispatched, as reported upstream. Distinct from
   *  `total`, which becomes the exact ingested record count once a batch has
   *  been ingested. Absent on seeded demo batches and on documents written
   *  before the field existed — fall back to `total` when reading it. */
  sourceTotal?: number;
  breakdown: BreakdownSeg[];
  successRate: number;
  spendInr: number;
  telephonyInr: number;
  aiInr: number;
  avgDuration: number | null;
  avgTalkTime: number | null;
  /** Present when the latest pull of this batch came back with fewer records
   *  than upstream's own list counts (see BACKEND.md → *Pull completeness*).
   *  `total` is still the served record count; this says how far short of
   *  upstream it is, or that an earlier, fuller revision is being served
   *  instead. Never set on seeded demo batches. */
  shortfall?: BatchShortfall | null;
  /** Whether normalized records are ready for analytics/export. Live batches
   *  carry this value; seeded demo batches omit it. */
  ingestStatus?: "none" | "ingesting" | "ready" | "stale" | "error";
}

export interface BatchShortfall {
  /** Records upstream's list counted for the job. */
  listed: number;
  /** Unique records the latest pull returned. */
  received: number;
  /** True when an earlier revision holding more records was kept instead. */
  keptPrevious: boolean;
  /** When the LATEST short pull was observed — re-stamped on every short
   *  re-pull, including one that wrote nothing because it matched the served
   *  revision. A merge re-pull cooldown is keyed on it
   *  (`shortPullCheckedRecently`). */
  detectedAt: string;
}

export interface Workspace {
  name: string;
  tenant: string;
  account: string;
  /** Human-readable account label when known (from the tenant's account list). */
  accountName?: string;
  role: string;
}

export interface ChannelMeta {
  key: Channel;
  label: string;
  short: string;
  icon: string;
  color: string;
  soft: string;
  text: string;
}

export interface TypeMeta {
  key: TypeKey;
  label: string;
  group: string;
  icon: string;
  color: string;
  soft: string;
  text: string;
}

export interface StatusMeta {
  label: string;
  color: string;
  soft: string;
  text: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  default: boolean;
}

export interface ColumnGroup {
  label: string;
  columns: ColumnDef[];
}

export type Currency = "inr" | "usd";
