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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  for (const r of records) {
    const d = dayLabel(r.timestamp);
    const v = volMap.get(d) ?? { date: d, calls: 0, messages: 0 };
    if (r.selType === "message") v.messages += 1;
    else v.calls += 1;
    volMap.set(d, v);
    const c = costMap.get(d) ?? { date: d, telephony: 0, ai: 0 };
    c.telephony += r.telephonyCostInr ?? 0;
    c.ai += r.aiCostInr ?? 0;
    costMap.set(d, c);
  }
  const volumeOverTime = [...volMap.values()];
  const costOverTime = [...costMap.values()];

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
