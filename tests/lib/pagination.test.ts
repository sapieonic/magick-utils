import { describe, expect, it } from "vitest";
import { pageSlots } from "@/lib/pagination";

/** The widest the control is allowed to get, mirroring MAX_SLOTS. */
const MAX_SLOTS = 7;

describe("pageSlots", () => {
  it("lists every page while they all fit", () => {
    expect(pageSlots(1, 1)).toEqual([1]);
    expect(pageSlots(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageSlots(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  // The bug this exists for: 2,500 scanned jobs at 8 per page is ~313 buttons in
  // a flex row, which runs past the card with no way to reach what it hides.
  it("stays a fixed width however many pages there are", () => {
    for (const pages of [8, 50, 313, 5_000]) {
      for (const page of [1, 2, 3, Math.floor(pages / 2), pages - 1, pages]) {
        expect(pageSlots(page, pages).length).toBeLessThanOrEqual(MAX_SLOTS);
      }
    }
  });

  it("always keeps both ends one click away", () => {
    for (const page of [1, 2, 40, 156, 312, 313]) {
      const slots = pageSlots(page, 313);
      expect(slots[0]).toBe(1);
      expect(slots[slots.length - 1]).toBe(313);
    }
  });

  it("windows around the current page", () => {
    expect(pageSlots(50, 313)).toEqual([1, "gap", 49, 50, 51, "gap", 313]);
  });

  it("does not shrink the window at either end of the range", () => {
    expect(pageSlots(1, 313)).toEqual([1, 2, 3, 4, "gap", 313]);
    expect(pageSlots(313, 313)).toEqual([1, "gap", 310, 311, 312, 313]);
  });

  // An ellipsis standing for exactly one page is wider than the page it hides
  // and cannot be clicked — always show the number instead.
  it("never emits a gap for a single hidden page", () => {
    for (let page = 1; page <= 9; page += 1) {
      const slots = pageSlots(page, 9);
      for (let i = 1; i < slots.length - 1; i += 1) {
        if (slots[i] !== "gap") continue;
        const before = slots[i - 1] as number;
        const after = slots[i + 1] as number;
        expect(after - before).toBeGreaterThan(2);
      }
    }
  });

  it("keeps the pages it shows in ascending order, with no repeats", () => {
    for (const pages of [9, 40, 313]) {
      for (const page of [1, 2, 5, pages - 1, pages]) {
        const numbers = pageSlots(page, pages).filter((s): s is number => s !== "gap");
        expect(numbers).toEqual([...new Set(numbers)]);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
      }
    }
  });

  it("always includes the page actually being viewed", () => {
    for (const page of [1, 2, 7, 156, 312, 313]) {
      expect(pageSlots(page, 313)).toContain(page);
    }
  });

  // Reached through a stale `page` after a filter narrows the list, or a
  // hand-edited value — never render a control that omits every real page.
  it("clamps a page outside the range rather than producing nonsense", () => {
    expect(pageSlots(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageSlots(99, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageSlots(-4, 313)).toEqual([1, 2, 3, 4, "gap", 313]);
    expect(pageSlots(900, 313)).toEqual([1, "gap", 310, 311, 312, 313]);
  });

  it("survives a degenerate page count", () => {
    expect(pageSlots(1, 0)).toEqual([1]);
    expect(pageSlots(1, Number.NaN)).toEqual([1]);
    // `Math.floor(Infinity) || 1` is Infinity, which would leave the window loop
    // incrementing towards a bound it can never reach — an OOM, not a bad render.
    expect(pageSlots(1, Number.POSITIVE_INFINITY)).toEqual([1]);
    expect(pageSlots(Number.POSITIVE_INFINITY, 313)).toEqual([1, 2, 3, 4, "gap", 313]);
  });
});
