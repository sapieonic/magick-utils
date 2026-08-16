import { fmtCompact } from "./data";

/**
 * Positive left margin so right-aligned Y-axis labels are not clipped by the
 * SVG viewport. Negative `margin.left` (the old -16) shifted "22.0K" to x < 0
 * and the leading digit disappeared, which is what the dashboard screenshot
 * showed as 2.0K / 6.5K / 11.0K / 5.5K / 0.
 */
export const VOLUME_CHART_MARGIN = { top: 6, right: 8, left: 8, bottom: 0 } as const;

/** Wide enough for compact labels like "100.0K" / "12.5L" at 11px. */
export const VOLUME_Y_AXIS_WIDTH = 64;

/** Extra room for a ₹/$ prefix on the cost chart ("₹100.0K"). */
export const COST_Y_AXIS_WIDTH = 72;

const NICE_STEPS = [1, 2, 5, 10];

export function toFiniteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Compact tick label; empty for non-finite values so Recharts never paints "NaN". */
export function formatCountTick(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return fmtCompact(n);
}

/**
 * Monotonic integer 0…max ticks on a 1-2-5 step so compact labels stay unique.
 * Fractional 2.5 steps collapsed under fmtCompact (max=10 → 0, 2.5, 5, 7.5, 10
 * painted as 0, 3, 5, 8, 10). Count charts never need sub-1 ticks.
 */
export function niceCountTicks(maxValue: number, tickCount = 5): number[] {
  const max = Math.max(0, toFiniteNumber(maxValue));
  if (max <= 0) return [0, 1];
  const buckets = Math.max(2, tickCount) - 1;
  const rough = max / buckets;
  const exp = Math.floor(Math.log10(rough));
  const mag = 10 ** exp;
  const norm = rough / mag;
  const stepNorm = NICE_STEPS.find((step) => step >= norm - 1e-12) ?? 10;
  const step = Math.max(1, stepNorm * mag);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

export function countYAxisScale(maxValue: number) {
  const ticks = niceCountTicks(maxValue);
  const top = ticks[ticks.length - 1] ?? 1;
  return { ticks, top, domain: [0, top] as [number, number] };
}

export function seriesMax(values: unknown[]): number {
  let max = 0;
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n > max) max = n;
  }
  return max;
}
