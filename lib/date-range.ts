import { addAppDays, fromAppTimeParts, getAppTimeParts, startOfAppDay } from "./timezone";

export const DASHBOARD_RANGES = ["Last 7 days", "Last 30 days", "Last 90 days", "This quarter", "All time"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

export function isDashboardRange(value: string): value is DashboardRange {
  return (DASHBOARD_RANGES as readonly string[]).includes(value);
}

export function rangeStart(range: DashboardRange, now = new Date()): Date | null {
  if (range === "All time") return null;
  if (range === "This quarter") {
    const parts = getAppTimeParts(now);
    return fromAppTimeParts(parts.year, Math.floor(parts.month / 3) * 3, 1);
  }
  const days = range === "Last 7 days" ? 7 : range === "Last 90 days" ? 90 : 30;
  return addAppDays(startOfAppDay(now), -(days - 1));
}

export function inDashboardRange(iso: string, range: DashboardRange, now = new Date()): boolean {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return false;
  const start = rangeStart(range, now);
  return value <= now.getTime() && (start == null || value >= start.getTime());
}
