// Best-time-to-reach helpers (feature 4b). Pure and client-safe — type-only
// imports — so the heatmap UI and any server caller share one implementation.
// The matrix itself is produced server-side in lib/server/aggregate.ts; this
// module only labels cells and picks the recommended window deterministically.

import type { ReachByTimeOfDay, ReachCell } from "@/lib/server/types";

/** Indexed by `getUTCDay()` (0=Sun…6=Sat). */
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Display order for the heatmap rows — Monday-first reads better for campaigns. */
export const WEEKDAY_ROW_ORDER = [1, 2, 3, 4, 5, 6, 0];

function hourLabel(h: number): string {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 0) return "12 am";
  if (hour === 12) return "12 pm";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/** Label for an hour-band, e.g. band 3 with bandHours 3 → "9 am–12 pm". */
export function formatBand(band: number, bandHours: number): string {
  const start = band * bandHours;
  return `${hourLabel(start)}–${hourLabel(start + bandHours)}`;
}

/** Human day range from a set of weekday indices: contiguous runs collapse to
 *  "Tue–Thu"; gaps stay listed ("Mon, Wed"). Uses Mon-first ordering. */
export function formatDayRange(weekdays: number[]): string {
  if (weekdays.length === 0) return "";
  const order = WEEKDAY_ROW_ORDER;
  const positions = [...new Set(weekdays)].map((d) => order.indexOf(d)).sort((a, b) => a - b);
  const runs: string[] = [];
  let runStart = positions[0];
  let prev = positions[0];
  const flush = (start: number, end: number) => {
    runs.push(start === end ? WEEKDAY_SHORT[order[start]] : `${WEEKDAY_SHORT[order[start]]}–${WEEKDAY_SHORT[order[end]]}`);
  };
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === prev + 1) {
      prev = positions[i];
      continue;
    }
    flush(runStart, prev);
    runStart = prev = positions[i];
  }
  flush(runStart, prev);
  return runs.join(", ");
}

export interface ReachRecommendation {
  weekday: number; // peak cell's weekday
  band: number; // peak cell's hour-band
  bandLabel: string;
  dayRange: string; // strong days sharing the peak band
  rate: number; // peak cell answer/read rate
  total: number; // peak cell sample size
  meanRate: number; // volume-weighted mean across confident cells
  liftPp: number; // (rate − meanRate) * 100, percentage points
}

/** Pick the recommended window from confident (non-lowSample) cells only, so a
 *  100%-of-3 cell never wins. Returns null when no cell clears the sample gate. */
export function bestReachWindow(reach: ReachByTimeOfDay | undefined | null): ReachRecommendation | null {
  if (!reach) return null;
  const confident = reach.cells.filter((c) => !c.lowSample && c.total > 0);
  if (confident.length === 0) return null;

  const totalN = confident.reduce((a, c) => a + c.total, 0);
  const meanRate = totalN > 0 ? confident.reduce((a, c) => a + c.rate * c.total, 0) / totalN : 0;
  const peak = confident.reduce((best: ReachCell, c) => (c.rate > best.rate ? c : best), confident[0]);

  // Other confident days at the same band that also beat the mean — expresses a
  // window like "Tue–Wed mornings" rather than a single isolated cell.
  const strongDays = confident.filter((c) => c.band === peak.band && c.rate >= meanRate).map((c) => c.weekday);

  return {
    weekday: peak.weekday,
    band: peak.band,
    bandLabel: formatBand(peak.band, reach.bandHours),
    dayRange: formatDayRange(strongDays.length ? strongDays : [peak.weekday]),
    rate: peak.rate,
    total: peak.total,
    meanRate,
    liftPp: (peak.rate - meanRate) * 100,
  };
}

/** Share of populated cells that fall below the sample gate — the UI uses this
 *  to decide between the heatmap and an "insufficient history" empty state. */
export function reachLowSampleRatio(reach: ReachByTimeOfDay | undefined | null): number {
  if (!reach || reach.cells.length === 0) return 1;
  const low = reach.cells.filter((c) => c.lowSample).length;
  return low / reach.cells.length;
}
