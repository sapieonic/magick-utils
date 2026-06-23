// Compute analytics aggregates from normalized records. Pure functions; the
// route handler persists the result to the `aggregates` collection.

import type { AggregatesDoc, NormalizedRecord, TenantContext } from "./types";
import { normalizeStatus } from "./normalize";

/** Status bucket for aggregation. Re-derived from the record's original upstream
 *  status (`raw.status`) rather than the persisted `status`, so changes to the
 *  status vocabulary apply to already-ingested records without re-pulling from
 *  core. Falls back to the stored normalized status when raw is unavailable. */
function statusBucket(r: NormalizedRecord): string {
  const kind = r.selType === "message" ? "message" : "call";
  const rawStatus = typeof r.raw?.status === "string" ? r.raw.status : "";
  return rawStatus ? normalizeStatus(rawStatus, kind) : r.status;
}

function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

type TimeGranularity = "minute" | "hour" | "day";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SHORT_WINDOW_MS = 2 * 60 * MINUTE_MS;
const MAX_FILLED_TIME_BUCKETS = 370;

function parseTimestamp(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const value = iso.trim();
  const hasDateTime = /^\d{4}-\d{2}-\d{2}[T ]/.test(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const utcValue = value.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  const d = new Date(hasDateTime && !hasZone ? `${utcValue}Z` : value);
  return isNaN(d.getTime()) ? null : d;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function dateRange(dates: Date[]): { min: number; max: number } | null {
  if (dates.length === 0) return null;
  let min = dates[0].getTime();
  let max = min;
  for (const d of dates) {
    const time = d.getTime();
    min = Math.min(min, time);
    max = Math.max(max, time);
  }
  return { min, max };
}

function chooseTimeGranularity(dates: Date[]): TimeGranularity {
  const range = dateRange(dates);
  if (!range) return "day";
  const { min, max } = range;
  const start = new Date(min);
  const end = new Date(max);
  if (!sameUtcDay(start, end)) return "day";
  return max - min <= SHORT_WINDOW_MS ? "minute" : "hour";
}

function bucketStart(d: Date, granularity: TimeGranularity): Date {
  const start = new Date(d);
  start.setUTCSeconds(0, 0);
  if (granularity === "hour" || granularity === "day") start.setUTCMinutes(0, 0, 0);
  if (granularity === "day") start.setUTCHours(0, 0, 0, 0);
  return start;
}

function bucketStepMs(granularity: TimeGranularity): number {
  if (granularity === "minute") return MINUTE_MS;
  if (granularity === "hour") return HOUR_MS;
  return DAY_MS;
}

function bucketLabel(d: Date, granularity: TimeGranularity): string {
  if (granularity === "minute") return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  if (granularity === "hour") return d.toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });
  return dayLabel(d.toISOString());
}

function fillTimeBuckets<T extends { date: string }>(
  map: Map<string, T>,
  dates: Date[],
  granularity: TimeGranularity,
  makeBucket: (date: string) => T,
) {
  const range = dateRange(dates);
  if (!range) return;
  const start = bucketStart(new Date(range.min), granularity).getTime();
  const end = bucketStart(new Date(range.max), granularity).getTime();
  const step = bucketStepMs(granularity);
  const bucketCount = Math.floor((end - start) / step) + 1;
  if (bucketCount > MAX_FILLED_TIME_BUCKETS) return;
  for (let time = start; time <= end; time += step) {
    const bucket = new Date(time);
    map.set(String(time), makeBucket(bucketLabel(bucket, granularity)));
  }
}

function sortedTimeValues<T>(map: Map<string, T>): T[] {
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === "invalid") return 1;
      if (b === "invalid") return -1;
      return Number(a) - Number(b);
    })
    .map(([, value]) => value);
}

function durationBucket(sec: number): string {
  if (sec < 30) return "0–30s";
  if (sec < 60) return "30–60s";
  if (sec < 120) return "1–2m";
  if (sec < 180) return "2–3m";
  if (sec < 300) return "3–5m";
  return "5m+";
}

export function computeAggregates(
  records: NormalizedRecord[],
  batchIds: string[],
  ctx: TenantContext,
  key: string,
): AggregatesDoc {
  const totalRecords = records.length;
  const isMessageSet = records.length > 0 && records.every((r) => r.selType === "message");

  // status mix
  const statusCounts = new Map<string, number>();
  let spendInr = 0,
    telephonyInr = 0,
    aiInr = 0,
    successCount = 0;
  for (const r of records) {
    const bucket = statusBucket(r);
    statusCounts.set(bucket, (statusCounts.get(bucket) ?? 0) + 1);
    spendInr += r.totalCostInr ?? 0;
    telephonyInr += r.telephonyCostInr ?? 0;
    aiInr += r.aiCostInr ?? 0;
    if (bucket === "completed" || bucket === "read") successCount += 1;
  }
  const statusMix = [...statusCounts.entries()].map(([k, value]) => ({ key: k, value }));

  // duration histogram (calls)
  const buckets = ["0–30s", "30–60s", "1–2m", "2–3m", "3–5m", "5m+"];
  const histMap = new Map(buckets.map((b) => [b, { bucket: b, calls: 0, talk: 0 }]));
  for (const r of records) {
    if (typeof r.durationSeconds === "number") histMap.get(durationBucket(r.durationSeconds))!.calls += 1;
    if (typeof r.talkTimeSeconds === "number") histMap.get(durationBucket(r.talkTimeSeconds))!.talk += 1;
  }
  const durationHistogram = buckets.map((b) => histMap.get(b)!);

  // sentiment
  const sentCounts = new Map<string, number>();
  for (const r of records) {
    if (r.sentiment) sentCounts.set(r.sentiment.toLowerCase(), (sentCounts.get(r.sentiment.toLowerCase()) ?? 0) + 1);
  }
  const sentiment = ["positive", "neutral", "negative"]
    .map((name) => ({ name: name[0].toUpperCase() + name.slice(1), value: sentCounts.get(name) ?? 0 }))
    .filter((s) => s.value > 0);

  // topics
  const topicCounts = new Map<string, number>();
  for (const r of records) {
    for (const t of r.keyTopics ?? []) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  }
  const topics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 9)
    .map(([topic, count]) => ({ topic, count, sentiment: "neutral" }));

  // messaging funnel
  let funnel: AggregatesDoc["funnel"];
  if (isMessageSet) {
    const sent = totalRecords;
    const delivered = records.filter((r) => r.status === "delivered" || r.status === "read").length;
    const read = records.filter((r) => r.status === "read").length;
    const replied = records.filter((r) => r.replyText && r.replyText.trim().length > 0).length;
    funnel = [
      { stage: "Sent", value: sent },
      { stage: "Delivered", value: delivered },
      { stage: "Read", value: read },
      { stage: "Replied", value: replied },
    ];
  }

  // volume + cost over time
  const volMap = new Map<string, { date: string; calls: number; messages: number }>();
  const costMap = new Map<string, { date: string; telephony: number; ai: number }>();
  const validDates = records.map((r) => parseTimestamp(r.timestamp)).filter((d): d is Date => Boolean(d));
  const timeGranularity = chooseTimeGranularity(validDates);
  fillTimeBuckets(volMap, validDates, timeGranularity, (date) => ({ date, calls: 0, messages: 0 }));
  fillTimeBuckets(costMap, validDates, timeGranularity, (date) => ({ date, telephony: 0, ai: 0 }));
  for (const r of records) {
    const parsed = parseTimestamp(r.timestamp);
    const bucket = parsed ? bucketStart(parsed, timeGranularity) : null;
    const key = bucket ? String(bucket.getTime()) : "invalid";
    const label = bucket ? bucketLabel(bucket, timeGranularity) : "—";
    const v = volMap.get(key) ?? { date: label, calls: 0, messages: 0 };
    if (r.selType === "message") v.messages += 1;
    else v.calls += 1;
    volMap.set(key, v);
    const c = costMap.get(key) ?? { date: label, telephony: 0, ai: 0 };
    c.telephony += r.telephonyCostInr ?? 0;
    c.ai += r.aiCostInr ?? 0;
    costMap.set(key, c);
  }
  const volumeOverTime = sortedTimeValues(volMap);
  const costOverTime = sortedTimeValues(costMap);

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    key,
    batchIds,
    totalRecords,
    statusMix,
    successRate: totalRecords > 0 ? successCount / totalRecords : 0,
    spendInr,
    telephonyInr,
    aiInr,
    durationHistogram,
    sentiment,
    topics,
    funnel,
    volumeOverTime,
    costOverTime,
    computedAt: new Date().toISOString(),
  };
}
