import type { DashboardVolume } from "./server/types";

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
