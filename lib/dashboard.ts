import type { Batch } from "./types";
import type { DashboardVolume } from "./server/types";
import { inDashboardRange, rangeStart, type DashboardRange } from "./date-range";

/** Fill bounded dashboard ranges with explicit zero-volume UTC days. Missing
 * points must mean zero activity, not a compressed x-axis that hides gaps. */
export function fillDashboardDays(volume: DashboardVolume): DashboardVolume["points"] {
  if (!volume.start || volume.range === "All time") return volume.points;
  const start = new Date(volume.start);
  const end = new Date(volume.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return volume.points;
  const byDate = new Map(volume.points.map((point) => [point.date, point]));
  const result: DashboardVolume["points"] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(end);
  last.setUTCHours(0, 0, 0, 0);
  while (cursor <= last) {
    const date = cursor.toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, calls: 0, messages: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

/** Prefer the reported status breakdown; fall back to the campaign total so
 * batches whose upstream summary is still empty still appear on the graph. */
function campaignVolumeCount(batch: Batch): number {
  const breakdownSum = batch.breakdown.reduce((sum, seg) => sum + seg.value, 0);
  return breakdownSum > 0 ? breakdownSum : batch.total;
}

/** Overview volume from the campaign list (start date + counts). Ingestion is
 * on-demand for analytics, so a record-only dashboard under-counted most
 * campaigns and piled the few ingested batches onto a single day. */
export function dashboardVolumeFromCampaigns(
  batches: Batch[],
  range: DashboardRange,
  now = new Date(),
): DashboardVolume {
  const start = rangeStart(range, now);
  const pointMap = new Map<string, { date: string; calls: number; messages: number }>();
  const statusMap = new Map<string, number>();
  let totalCalls = 0;
  let totalMessages = 0;
  let spendInr = 0;
  let telephonyInr = 0;
  let aiInr = 0;
  let successWeighted = 0;
  let denom = 0;

  for (const batch of batches) {
    if (!inDashboardRange(batch.date, range, now)) continue;
    const day = new Date(batch.date);
    if (Number.isNaN(day.getTime())) continue;
    const date = day.toISOString().slice(0, 10);
    const count = campaignVolumeCount(batch);
    const point = pointMap.get(date) ?? { date, calls: 0, messages: 0 };
    if (batch.channel === "voice") {
      point.calls += count;
      totalCalls += count;
    } else {
      point.messages += count;
      totalMessages += count;
    }
    pointMap.set(date, point);
    for (const seg of batch.breakdown) {
      statusMap.set(seg.key, (statusMap.get(seg.key) ?? 0) + seg.value);
    }
    spendInr += batch.spendInr;
    telephonyInr += batch.telephonyInr;
    aiInr += batch.aiInr;
    successWeighted += batch.successRate * count;
    denom += count;
  }

  const totalRecords = totalCalls + totalMessages;
  return {
    timezone: "UTC",
    range,
    start: start?.toISOString() ?? null,
    end: now.toISOString(),
    totalRecords,
    totalCalls,
    totalMessages,
    successRate: denom > 0 ? successWeighted / denom : 0,
    spendInr,
    telephonyInr,
    aiInr,
    statusMix: [...statusMap].map(([key, value]) => ({ key, value })),
    points: [...pointMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
