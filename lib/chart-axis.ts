import { fmtCompact } from "./data";

/** Positive left margin so Y-axis labels are not clipped by ResponsiveContainer's overflow. */
export const VOLUME_CHART_MARGIN = { top: 6, right: 8, left: 8, bottom: 0 } as const;

/** Wide enough for compact labels like "100.0K" / "12.5L" at 11px. */
export const VOLUME_Y_AXIS_WIDTH = 64;

const NICE_STEPS = [1, 2, 2.5, 5, 10];

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
 * Monotonic 0…max ticks on a 1-2-5 step so compact labels stay unique and ordered.
 * Recharts' default adaptive ticks (0, 5.5K, 11.0K, 16.5K, 22.0K) overflow a tight
 * Y-axis and clip to the scrambled 2.0K / 6.5K / 11.0K / 5.5K / 0 the dashboard showed.
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
  const step = stepNorm * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

export function seriesMax(values: unknown[]): number {
  let max = 0;
  for (const value of values) {
    const n = toFiniteNumber(value);
    if (n > max) max = n;
  }
  return max;
}
