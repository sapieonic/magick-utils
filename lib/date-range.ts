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

/** The Dashboard's "campaigns started in this period" predicate: bounded at both
 *  ends, so a future-dated campaign is not counted into a period that has not
 *  happened yet. */
export function inDashboardRange(iso: string, range: DashboardRange, now = new Date()): boolean {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return false;
  const start = rangeStart(range, now);
  return value <= now.getTime() && (start == null || value >= start.getTime());
}

/** How far ahead of our own clock an upstream timestamp may sit and still count
 *  as "now". `created_at` is stamped by magick-master, not by this host, so a
 *  campaign created seconds ago can legitimately arrive dated slightly in our
 *  future — dropping it would hide the customer's newest work. */
export const LISTING_CLOCK_SKEW_MS = 10 * 60 * 1000;

/** The inventory predicate used by the Campaigns listing. Unlike the dashboard's
 *  period framing, a listing exists to show what the account *has*: "All time"
 *  is unbounded in both directions, and bounded ranges tolerate clock skew at
 *  the top end rather than silently dropping just-created campaigns. */
export function inListingRange(iso: string, range: DashboardRange, now = new Date()): boolean {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return false;
  const start = rangeStart(range, now);
  if (start == null) return true;
  return value >= start.getTime() && value <= now.getTime() + LISTING_CLOCK_SKEW_MS;
}
