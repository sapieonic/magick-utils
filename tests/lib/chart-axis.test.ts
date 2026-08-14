import { describe, expect, it } from "vitest";
import {
  COST_Y_AXIS_WIDTH,
  VOLUME_CHART_MARGIN,
  VOLUME_Y_AXIS_WIDTH,
  countYAxisScale,
  formatCountTick,
  niceCountTicks,
  seriesMax,
  toFiniteNumber,
} from "@/lib/chart-axis";
import { fmtCompact } from "@/lib/data";

describe("VOLUME_CHART_MARGIN", () => {
  it("leaves enough room for a compact Y-axis label inside the SVG viewport", () => {
    expect(VOLUME_CHART_MARGIN.left).toBeGreaterThanOrEqual(0);
    expect(VOLUME_Y_AXIS_WIDTH).toBeGreaterThanOrEqual(64);
    expect(VOLUME_CHART_MARGIN.left + VOLUME_Y_AXIS_WIDTH).toBeGreaterThanOrEqual(72);
    expect(COST_Y_AXIS_WIDTH).toBeGreaterThan(VOLUME_Y_AXIS_WIDTH);
  });
});

describe("toFiniteNumber", () => {
  it("coerces numeric strings and rejects garbage", () => {
    expect(toFiniteNumber(22000)).toBe(22000);
    expect(toFiniteNumber("16500")).toBe(16500);
    expect(toFiniteNumber("nope")).toBe(0);
    expect(toFiniteNumber(undefined)).toBe(0);
    expect(toFiniteNumber(NaN)).toBe(0);
  });
});

describe("formatCountTick", () => {
  it("formats finite counts with compact units", () => {
    expect(formatCountTick(0)).toBe("0");
    expect(formatCountTick(5500)).toBe("5.5K");
    expect(formatCountTick(11000)).toBe("11.0K");
    expect(formatCountTick(22000)).toBe("22.0K");
  });

  it("does not paint NaN/Infinity on the axis", () => {
    expect(formatCountTick(NaN)).toBe("");
    expect(formatCountTick(Infinity)).toBe("");
  });
});

describe("niceCountTicks", () => {
  it("always starts at 0, is strictly increasing, and has unique compact labels", () => {
    for (const max of [1, 2, 9, 10, 11, 1984, 11000, 22000, 140000, 143234]) {
      const ticks = niceCountTicks(max);
      const labels = ticks.map(formatCountTick);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks.every((n) => Number.isInteger(n))).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
      }
    }
  });

  it("keeps small maxima as integer ticks with unique labels", () => {
    expect(niceCountTicks(1)).toEqual([0, 1]);
    expect(niceCountTicks(1).map(formatCountTick)).toEqual(["0", "1"]);
    expect(niceCountTicks(10)).toEqual([0, 5, 10]);
    expect(niceCountTicks(10).map(formatCountTick)).toEqual(["0", "5", "10"]);
    expect(niceCountTicks(10).some((n) => !Number.isInteger(n))).toBe(false);
  });

  it("covers the reported ~22K daily peak without the clipped 5.5K-step labels", () => {
    const ticks = niceCountTicks(22000);
    const labels = ticks.map(formatCountTick);
    expect(labels).toEqual(["0", "10.0K", "20.0K", "30.0K"]);
    // The live screenshot's "2.0K / 6.5K / 11.0K / 5.5K / 0" is 22.0K / 16.5K /
    // 11.0K / 5.5K / 0 with the leading digit clipped. Round 10K steps stay intact.
    expect(labels).not.toEqual(["0", "5.5K", "11.0K", "16.5K", "22.0K"]);
  });

  it("covers a 1.4L peak with unique lakh labels", () => {
    const labels = niceCountTicks(140000).map(fmtCompact);
    expect(labels[0]).toBe("0");
    expect(labels.at(-1)).toMatch(/L$/);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("handles a zero series", () => {
    expect(niceCountTicks(0)).toEqual([0, 1]);
  });
});

describe("countYAxisScale", () => {
  it("pairs domain top with the last tick", () => {
    const { ticks, top, domain } = countYAxisScale(22000);
    expect(domain).toEqual([0, top]);
    expect(top).toBe(ticks[ticks.length - 1]);
  });
});

describe("seriesMax", () => {
  it("reads the larger of calls and messages, including numeric strings", () => {
    expect(seriesMax([0, "11000", 22000, null])).toBe(22000);
  });
});
