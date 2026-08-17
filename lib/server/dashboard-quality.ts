// Account-level dashboard quality metrics. Pure functions so the Mongo $facet
// assembler and unit tests share one definition of "short call", "hang-up",
// and IVR drop-off.
//
// Voice connect mix and the message funnel use the same status rules Analytics
// uses (`completed` / `read`). Short-call and hang-up rates count **connected**
// calls only — unanswered rings are expected to be short and would drown the
// signal.

import { normalizeStatus } from "@/lib/server/normalize";
import { APP_TIMEZONE } from "@/lib/timezone";
import type {
  DashboardVolume,
  IvrDropoff,
  NamedCount,
  ShortCallStats,
} from "@/lib/server/types";

export const SHORT_CALL_SECONDS = 15;
export const HANGUP_TALK_SECONDS = 10;
export const OUTCOME_TOP_N = 8;
export const IVR_PATH_TOP_N = 6;
export const IVR_NODE_TOP_N = 8;
export const IVR_DTMF_TOP_N = 8;

const VOICE_STATUS_ORDER = [
  "completed",
  "noanswer",
  "busy",
  "switchedoff",
  "voicemail",
  "failed",
  "inprogress",
  "pending",
] as const;

const DURATION_BUCKETS = ["0–30s", "30–60s", "1–2m", "2–3m", "3–5m", "5m+"] as const;
type DurationBucket = (typeof DURATION_BUCKETS)[number];

export const IVR_HANGUP_NODE_KEYS = [
  "hangup",
  "hang_up",
  "abandoned",
  "abandon",
  "caller_hangup",
  "user_hangup",
  "timeout",
  "no_input",
] as const;

const IVR_HANGUP_NODES = new Set<string>(IVR_HANGUP_NODE_KEYS);

export interface QualityRecord {
  selType: string;
  status: string;
  raw?: { status?: unknown } | null;
  outcome?: string | null;
  durationSeconds?: number | null;
  talkTimeSeconds?: number | null;
  replyText?: string | null;
  ivrPath?: string | null;
  completedNode?: string | null;
  dtmfInput?: string | null;
}

export function durationBucket(sec: number): DurationBucket {
  if (sec < 30) return "0–30s";
  if (sec < 60) return "30–60s";
  if (sec < 120) return "1–2m";
  if (sec < 180) return "2–3m";
  if (sec < 300) return "3–5m";
  return "5m+";
}

export function humanizeKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Unknown";
  return trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function parseIvrPath(path: string | null | undefined): string[] {
  if (!path) return [];
  return path
    .split(/[>\/|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function formatIvrPath(nodes: string[]): string {
  return nodes.join(" › ");
}

export function isIvrHangupNode(node: string | null | undefined): boolean {
  if (!node) return false;
  const key = node.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return IVR_HANGUP_NODES.has(key);
}

function statusBucket(r: QualityRecord): string {
  const kind = r.selType === "message" ? "message" : "call";
  const rawStatus = typeof r.raw?.status === "string" ? r.raw.status : "";
  return rawStatus ? normalizeStatus(rawStatus, kind) : r.status;
}

function isVoice(r: QualityRecord): boolean {
  return r.selType !== "message";
}

function collapseTopN(items: NamedCount[], n: number): NamedCount[] {
  if (items.length <= n) return items;
  const head = items.slice(0, n);
  const rest = items.slice(n).reduce((sum, item) => sum + item.value, 0);
  if (rest > 0) head.push({ key: "other", label: "Other", value: rest });
  return head;
}

function sortNamed(items: Map<string, number>): NamedCount[] {
  return [...items.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => ({ key, label: humanizeKey(key), value }));
}

export function emptyDashboardQuality(): Pick<
  DashboardVolume,
  "voiceConnectMix" | "messageFunnel" | "outcomes" | "shortCalls" | "ivrDropoff"
> {
  return {
    voiceConnectMix: [],
    messageFunnel: [],
    outcomes: [],
    shortCalls: null,
    ivrDropoff: null,
  };
}

export function emptyDashboardVolume(
  range: string,
  start: Date | null,
  end: Date,
): DashboardVolume {
  return {
    timezone: APP_TIMEZONE,
    range,
    start: start?.toISOString() ?? null,
    end: end.toISOString(),
    totalRecords: 0,
    totalCalls: 0,
    totalMessages: 0,
    successRate: 0,
    spendInr: 0,
    telephonyInr: 0,
    aiInr: 0,
    statusMix: [],
    points: [],
    ...emptyDashboardQuality(),
  };
}

function computeVoiceConnectMix(records: QualityRecord[]): NamedCount[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (!isVoice(r)) continue;
    const key = String(statusBucket(r));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered: NamedCount[] = [];
  for (const key of VOICE_STATUS_ORDER) {
    const value = counts.get(key) ?? 0;
    if (value > 0) ordered.push({ key, value });
    counts.delete(key);
  }
  for (const [key, value] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (value > 0) ordered.push({ key, value });
  }
  return ordered;
}

function computeMessageFunnel(records: QualityRecord[]): { stage: string; value: number }[] {
  const messages = records.filter((r) => r.selType === "message");
  if (messages.length === 0) return [];
  let delivered = 0;
  let read = 0;
  let replied = 0;
  for (const r of messages) {
    const bucket = String(statusBucket(r));
    if (bucket === "delivered" || bucket === "read") delivered += 1;
    if (bucket === "read") read += 1;
    if (r.replyText && r.replyText.trim().length > 0) replied += 1;
  }
  return [
    { stage: "Sent", value: messages.length },
    { stage: "Delivered", value: delivered },
    { stage: "Read", value: read },
    { stage: "Replied", value: replied },
  ];
}

function computeOutcomes(records: QualityRecord[]): NamedCount[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = (r.outcome ?? "").trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return collapseTopN(sortNamed(counts), OUTCOME_TOP_N);
}

function computeShortCalls(records: QualityRecord[]): ShortCallStats | null {
  let withDuration = 0;
  let shortCount = 0;
  let withTalk = 0;
  let hangupCount = 0;
  let durationSum = 0;
  let talkSum = 0;
  const histMap = new Map<string, number>(DURATION_BUCKETS.map((bucket) => [bucket, 0]));

  for (const r of records) {
    if (!isVoice(r)) continue;
    if (String(statusBucket(r)) !== "completed") continue;
    if (typeof r.durationSeconds !== "number") continue;
    withDuration += 1;
    durationSum += r.durationSeconds;
    if (r.durationSeconds < SHORT_CALL_SECONDS) shortCount += 1;
    histMap.set(durationBucket(r.durationSeconds), (histMap.get(durationBucket(r.durationSeconds)) ?? 0) + 1);
    if (typeof r.talkTimeSeconds === "number") {
      withTalk += 1;
      talkSum += r.talkTimeSeconds;
      if (r.talkTimeSeconds < HANGUP_TALK_SECONDS) hangupCount += 1;
    }
  }

  if (withDuration === 0) return null;
  return {
    connectedWithDuration: withDuration,
    shortCount,
    shortRate: shortCount / withDuration,
    connectedWithTalk: withTalk,
    hangupCount,
    hangupRate: withTalk > 0 ? hangupCount / withTalk : 0,
    avgDuration: durationSum / withDuration,
    avgTalkTime: withTalk > 0 ? talkSum / withTalk : null,
    talkRatio: durationSum > 0 && withTalk > 0 ? talkSum / durationSum : null,
    thresholdSeconds: SHORT_CALL_SECONDS,
    hangupTalkSeconds: HANGUP_TALK_SECONDS,
    durationHistogram: DURATION_BUCKETS.map((bucket) => ({ bucket, calls: histMap.get(bucket) ?? 0 })),
  };
}

function computeIvrDropoff(records: QualityRecord[]): IvrDropoff | null {
  const ivr = records.filter((r) => r.selType === "ivr");
  if (ivr.length === 0) return null;

  const nodeCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const dtmfCounts = new Map<string, number>();
  let withPath = 0;
  let hangupCount = 0;
  let d1 = 0;
  let d2 = 0;
  let d3 = 0;
  let d4 = 0;

  for (const r of ivr) {
    const nodes = parseIvrPath(r.ivrPath);
    if (nodes.length > 0) {
      withPath += 1;
      d1 += 1;
      if (nodes.length >= 2) d2 += 1;
      if (nodes.length >= 3) d3 += 1;
      if (nodes.length >= 4) d4 += 1;
      const pathKey = formatIvrPath(nodes);
      pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
    }
    const endNode = (r.completedNode ?? "").trim() || nodes[nodes.length - 1] || "";
    if (endNode) {
      const key = endNode.toLowerCase();
      nodeCounts.set(key, (nodeCounts.get(key) ?? 0) + 1);
      if (isIvrHangupNode(endNode)) hangupCount += 1;
    }
    const dtmf = (r.dtmfInput ?? "").trim();
    if (dtmf) dtmfCounts.set(dtmf, (dtmfCounts.get(dtmf) ?? 0) + 1);
  }

  return {
    totalIvr: ivr.length,
    withPath,
    hangupCount,
    hangupRate: ivr.length > 0 ? hangupCount / ivr.length : 0,
    depthFunnel: [
      { stage: "Entered IVR", value: d1 },
      { stage: "2nd node", value: d2 },
      { stage: "3rd node", value: d3 },
      { stage: "4th node+", value: d4 },
    ].filter((step, i, all) => step.value > 0 || i === 0 || all.slice(0, i).some((s) => s.value > 0)),
    completedNodes: collapseTopN(sortNamed(nodeCounts), IVR_NODE_TOP_N),
    topPaths: [...pathCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, IVR_PATH_TOP_N)
      .map(([path, value]) => ({ path, value })),
    dtmf: [...dtmfCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, IVR_DTMF_TOP_N)
      .map(([input, value]) => ({ input, value })),
  };
}

/** Canonical quality metrics from normalized records (unit-test source of truth). */
export function computeDashboardQuality(records: QualityRecord[]): ReturnType<typeof emptyDashboardQuality> {
  return {
    voiceConnectMix: computeVoiceConnectMix(records),
    messageFunnel: computeMessageFunnel(records),
    outcomes: computeOutcomes(records),
    shortCalls: computeShortCalls(records),
    ivrDropoff: computeIvrDropoff(records),
  };
}

/** Grouped Mongo $facet rows → the same quality shape `computeDashboardQuality` emits. */
export interface DashboardQualityFacet {
  voiceConnect?: { _id: string | null; value: number }[];
  messageFunnel?: {
    _id?: unknown;
    sent?: number;
    delivered?: number;
    read?: number;
    replied?: number;
  }[];
  outcomes?: { _id: string | null; value: number }[];
  shortCalls?: {
    _id?: unknown;
    withDuration?: number;
    shortCount?: number;
    hangupCount?: number;
    withTalk?: number;
    durationSum?: number;
    talkSum?: number;
  }[];
  shortCallBuckets?: { _id: string | null; calls: number }[];
  ivrEnds?: { _id: string | null; value: number }[];
  ivrPaths?: { _id: string | null; value: number }[];
  ivrDtmf?: { _id: string | null; value: number }[];
  ivrDepth?: {
    _id?: unknown;
    total?: number;
    withPath?: number;
    hangupCount?: number;
    d1?: number;
    d2?: number;
    d3?: number;
    d4?: number;
  }[];
}

export function assembleDashboardQuality(facet: DashboardQualityFacet): ReturnType<typeof emptyDashboardQuality> {
  const voiceCounts = new Map<string, number>();
  for (const row of facet.voiceConnect ?? []) {
    if (!row._id || row.value <= 0) continue;
    voiceCounts.set(row._id, (voiceCounts.get(row._id) ?? 0) + row.value);
  }
  const voiceConnectMix: NamedCount[] = [];
  for (const key of VOICE_STATUS_ORDER) {
    const value = voiceCounts.get(key) ?? 0;
    if (value > 0) voiceConnectMix.push({ key, value });
    voiceCounts.delete(key);
  }
  for (const [key, value] of [...voiceCounts.entries()].sort((a, b) => b[1] - a[1])) {
    voiceConnectMix.push({ key, value });
  }

  const funnelRow = facet.messageFunnel?.[0];
  const messageFunnel =
    funnelRow && (funnelRow.sent ?? 0) > 0
      ? [
          { stage: "Sent", value: funnelRow.sent ?? 0 },
          { stage: "Delivered", value: funnelRow.delivered ?? 0 },
          { stage: "Read", value: funnelRow.read ?? 0 },
          { stage: "Replied", value: funnelRow.replied ?? 0 },
        ]
      : [];

  const outcomeCounts = new Map<string, number>();
  for (const row of facet.outcomes ?? []) {
    const key = (row._id ?? "").trim().toLowerCase();
    if (!key || row.value <= 0) continue;
    outcomeCounts.set(key, (outcomeCounts.get(key) ?? 0) + row.value);
  }
  const outcomes = collapseTopN(sortNamed(outcomeCounts), OUTCOME_TOP_N);

  const shortRow = facet.shortCalls?.[0];
  const withDuration = shortRow?.withDuration ?? 0;
  let shortCalls: ShortCallStats | null = null;
  if (withDuration > 0 && shortRow) {
    const withTalk = shortRow.withTalk ?? 0;
    const durationSum = shortRow.durationSum ?? 0;
    const talkSum = shortRow.talkSum ?? 0;
    const hist = new Map<string, number>(DURATION_BUCKETS.map((bucket) => [bucket, 0]));
    for (const bucket of facet.shortCallBuckets ?? []) {
      if (bucket._id && hist.has(bucket._id)) hist.set(bucket._id, bucket.calls);
    }
    shortCalls = {
      connectedWithDuration: withDuration,
      shortCount: shortRow.shortCount ?? 0,
      shortRate: (shortRow.shortCount ?? 0) / withDuration,
      connectedWithTalk: withTalk,
      hangupCount: shortRow.hangupCount ?? 0,
      hangupRate: withTalk > 0 ? (shortRow.hangupCount ?? 0) / withTalk : 0,
      avgDuration: durationSum / withDuration,
      avgTalkTime: withTalk > 0 ? talkSum / withTalk : null,
      talkRatio: durationSum > 0 && withTalk > 0 ? talkSum / durationSum : null,
      thresholdSeconds: SHORT_CALL_SECONDS,
      hangupTalkSeconds: HANGUP_TALK_SECONDS,
      durationHistogram: DURATION_BUCKETS.map((bucket) => ({ bucket, calls: hist.get(bucket) ?? 0 })),
    };
  }

  const depth = facet.ivrDepth?.[0];
  const totalIvr = depth?.total ?? 0;
  let ivrDropoff: IvrDropoff | null = null;
  if (totalIvr > 0) {
    const nodeCounts = new Map<string, number>();
    for (const row of facet.ivrEnds ?? []) {
      const key = (row._id ?? "").trim().toLowerCase();
      if (!key || row.value <= 0) continue;
      nodeCounts.set(key, (nodeCounts.get(key) ?? 0) + row.value);
    }
    const d1 = depth?.d1 ?? 0;
    const d2 = depth?.d2 ?? 0;
    const d3 = depth?.d3 ?? 0;
    const d4 = depth?.d4 ?? 0;
    ivrDropoff = {
      totalIvr,
      withPath: depth?.withPath ?? 0,
      hangupCount: depth?.hangupCount ?? 0,
      hangupRate: totalIvr > 0 ? (depth?.hangupCount ?? 0) / totalIvr : 0,
      depthFunnel: [
        { stage: "Entered IVR", value: d1 },
        { stage: "2nd node", value: d2 },
        { stage: "3rd node", value: d3 },
        { stage: "4th node+", value: d4 },
      ].filter((step, i, all) => step.value > 0 || i === 0 || all.slice(0, i).some((s) => s.value > 0)),
      completedNodes: collapseTopN(sortNamed(nodeCounts), IVR_NODE_TOP_N),
      topPaths: [...(facet.ivrPaths ?? [])]
        .filter((row) => row._id && row.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, IVR_PATH_TOP_N)
        .map((row) => ({ path: formatIvrPath(parseIvrPath(row._id ?? "")), value: row.value })),
      dtmf: [...(facet.ivrDtmf ?? [])]
        .filter((row) => row._id && row.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, IVR_DTMF_TOP_N)
        .map((row) => ({ input: String(row._id), value: row.value })),
    };
  }

  return { voiceConnectMix, messageFunnel, outcomes, shortCalls, ivrDropoff };
}
