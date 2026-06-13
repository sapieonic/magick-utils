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
  breakdown: BreakdownSeg[];
  successRate: number;
  spendInr: number;
  telephonyInr: number;
  aiInr: number;
  avgDuration: number | null;
  avgTalkTime: number | null;
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
