import { describe, it, expect } from "vitest";
import { bestReachWindow, formatBand, formatDayRange, reachLowSampleRatio } from "@/lib/reach";
import type { ReachByTimeOfDay, ReachCell } from "@/lib/server/types";

function cell(weekday: number, band: number, total: number, reached: number, minSamples = 20): ReachCell {
  return { weekday, band, total, reached, rate: total > 0 ? reached / total : 0, lowSample: total < minSamples };
}

function reach(cells: ReachCell[], over: Partial<ReachByTimeOfDay> = {}): ReachByTimeOfDay {
  return { timezone: "UTC", bandHours: 3, minSamples: 20, totalPlaced: cells.reduce((a, c) => a + c.total, 0), cells, ...over };
}

describe("formatBand", () => {
  it("labels 3-hour bands in am/pm", () => {
    expect(formatBand(3, 3)).toBe("9 am–12 pm");
    expect(formatBand(0, 3)).toBe("12 am–3 am");
    expect(formatBand(4, 3)).toBe("12 pm–3 pm");
    expect(formatBand(7, 3)).toBe("9 pm–12 am");
  });
});

describe("formatDayRange", () => {
  it("collapses contiguous days into a range (Mon-first)", () => {
    expect(formatDayRange([2, 3])).toBe("Tue–Wed");
    expect(formatDayRange([1, 2, 3, 4, 5])).toBe("Mon–Fri");
  });
  it("lists non-contiguous days separately", () => {
    expect(formatDayRange([1, 3])).toBe("Mon, Wed");
  });
  it("handles a single day", () => {
    expect(formatDayRange([0])).toBe("Sun");
  });
});

describe("bestReachWindow", () => {
  it("returns null when every cell is below the sample gate", () => {
    const r = reach([cell(2, 3, 3, 3), cell(4, 2, 5, 4)]); // tiny samples
    expect(bestReachWindow(r)).toBeNull();
  });

  it("never recommends a high-rate low-sample cell over a confident one", () => {
    const r = reach([
      cell(1, 3, 2, 2), // 100% but only 2 calls → lowSample
      cell(2, 3, 100, 70), // 70% confident
      cell(3, 3, 100, 68), // 68% confident
    ]);
    const win = bestReachWindow(r)!;
    expect(win.rate).toBeCloseTo(0.7, 5);
    expect(win.weekday).toBe(2);
    expect(win.bandLabel).toBe("9 am–12 pm");
  });

  it("expresses a multi-day window when neighbours at the same band are strong", () => {
    const r = reach([
      cell(2, 3, 100, 75),
      cell(3, 3, 100, 72),
      cell(5, 1, 100, 40), // pulls the mean down; different band
    ]);
    const win = bestReachWindow(r)!;
    expect(win.dayRange).toBe("Tue–Wed");
    expect(win.liftPp).toBeGreaterThan(0);
  });
});

describe("reachLowSampleRatio", () => {
  it("is 1 for empty matrices and a fraction otherwise", () => {
    expect(reachLowSampleRatio(reach([]))).toBe(1);
    expect(reachLowSampleRatio(reach([cell(1, 1, 100, 50), cell(2, 1, 3, 1)]))).toBeCloseTo(0.5, 5);
  });
});
