import { describe, expect, it } from "vitest";
import {
  VOLUME_CHART_MARGIN,
  VOLUME_Y_AXIS_WIDTH,
  formatCountTick,
  niceCountTicks,
  seriesMax,
  toFiniteNumber,
} from "@/lib/chart-axis";
import { fmtCompact } from "@/lib/data";

describe("VOLUME_CHART_MARGIN", () => {
  it("keeps Y-axis labels inside the chart (no negative left clip)", () => {
    expect(VOLUME_CHART_MARGIN.left).toBeGreaterThanOrEqual(0);
    expect(VOLUME_Y_AXIS_WIDTH).toBeGreaterThan(48);
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
  it("always starts at 0 and is strictly increasing", () => {
    for (const max of [1, 11, 1984, 11000, 22000, 143234]) {
      const ticks = niceCountTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
      }
    }
  });

  it("covers the reported ~22K daily peak without the clipped 5.5K-step labels", () => {
    const ticks = niceCountTicks(22000);
    const labels = ticks.map(formatCountTick);
    expect(labels).toEqual(["0", "10.0K", "20.0K", "30.0K"]);
    // The live screenshot's "2.0K / 6.5K / 11.0K / 5.5K / 0" is 22.0K / 16.5K /
    // 11.0K / 5.5K / 0 with the leading digit clipped. Round 10K steps stay intact.
    expect(labels).not.toEqual(["0", "5.5K", "11.0K", "16.5K", "22.0K"]);
  });

  it("keeps compact labels unique and in numeric order", () => {
    const ticks = niceCountTicks(22000);
    const labels = ticks.map(fmtCompact);
    expect(new Set(labels).size).toBe(labels.length);
    expect([...labels].sort((a, b) => ticks[labels.indexOf(a)] - ticks[labels.indexOf(b)])).toEqual(labels);
  });

  it("handles a zero series", () => {
    expect(niceCountTicks(0)).toEqual([0, 1]);
  });
});

describe("seriesMax", () => {
  it("reads the larger of calls and messages, including numeric strings", () => {
    expect(seriesMax([0, "11000", 22000, null])).toBe(22000);
  });
});
