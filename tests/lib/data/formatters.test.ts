import { describe, it, expect } from "vitest";
import {
  FX,
  fmtNum,
  fmtCompact,
  fmtMoney,
  fmtMoneyFull,
  fmtPct,
  fmtDate,
  fmtDuration,
} from "@/lib/data";

describe("FX constant", () => {
  it("is the documented INR-per-USD rate", () => {
    expect(FX).toBe(83.4);
  });
});

describe("fmtNum", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtNum(undefined)).toBe("—");
  });

  it("rounds and groups with en-IN locale", () => {
    // en-IN groups as 1,00,000 (lakh grouping)
    expect(fmtNum(100000)).toBe("1,00,000");
    expect(fmtNum(1000)).toBe("1,000");
    expect(fmtNum(12345678)).toBe("1,23,45,678");
  });

  it("rounds fractional values before formatting", () => {
    expect(fmtNum(1234.6)).toBe("1,235");
    expect(fmtNum(1234.4)).toBe("1,234");
    expect(fmtNum(0)).toBe("0");
  });

  it("formats zero (not treated as nullish)", () => {
    expect(fmtNum(0)).toBe("0");
  });
});

describe("fmtCompact", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtCompact(null)).toBe("—");
    expect(fmtCompact(undefined)).toBe("—");
  });

  it("returns rounded integer string below 1e3", () => {
    expect(fmtCompact(0)).toBe("0");
    expect(fmtCompact(999)).toBe("999");
    expect(fmtCompact(999.4)).toBe("999");
    expect(fmtCompact(999.6)).toBe("1000");
  });

  it("uses K suffix at the 1e3 boundary", () => {
    expect(fmtCompact(1000)).toBe("1.0K");
    expect(fmtCompact(1500)).toBe("1.5K");
    expect(fmtCompact(99999)).toBe("100.0K");
  });

  it("uses L (lakh) suffix at the 1e5 boundary", () => {
    expect(fmtCompact(1e5)).toBe("1.0L");
    expect(fmtCompact(250000)).toBe("2.5L");
    expect(fmtCompact(9999999)).toBe("100.0L");
  });

  it("uses Cr (crore) suffix at the 1e7 boundary", () => {
    expect(fmtCompact(1e7)).toBe("1.0Cr");
    expect(fmtCompact(25000000)).toBe("2.5Cr");
  });

  it("boundaries are inclusive (>=)", () => {
    expect(fmtCompact(999)).toBe("999");
    expect(fmtCompact(1000)).toBe("1.0K");
    expect(fmtCompact(99999)).toBe("100.0K");
    expect(fmtCompact(100000)).toBe("1.0L");
    expect(fmtCompact(9999999)).toBe("100.0L");
    expect(fmtCompact(10000000)).toBe("1.0Cr");
  });
});

describe("fmtMoney", () => {
  it("returns em-dash for null/undefined regardless of currency", () => {
    expect(fmtMoney(null, "inr")).toBe("—");
    expect(fmtMoney(undefined, "usd")).toBe("—");
  });

  describe("INR", () => {
    it("below 1000 renders rounded rupee (no compacting)", () => {
      expect(fmtMoney(0, "inr")).toBe("₹0");
      expect(fmtMoney(999, "inr")).toBe("₹999");
      expect(fmtMoney(999.6, "inr")).toBe("₹1000");
    });

    it("at/above 1000 renders compacted rupee", () => {
      expect(fmtMoney(1000, "inr")).toBe("₹1.0K");
      expect(fmtMoney(150000, "inr")).toBe("₹1.5L");
      expect(fmtMoney(12000000, "inr")).toBe("₹1.2Cr");
    });
  });

  describe("USD", () => {
    it("converts via FX, below $1000 uses toFixed(0)", () => {
      // 8340 / 83.4 = 100
      expect(fmtMoney(8340, "usd")).toBe("$100");
      // 834 / 83.4 = 10
      expect(fmtMoney(834, "usd")).toBe("$10");
      expect(fmtMoney(0, "usd")).toBe("$0");
    });

    it("at/above $1000 uses compact formatting", () => {
      // 834000 / 83.4 = 10000 exactly -> $10.0K
      expect(fmtMoney(834000, "usd")).toBe("$10.0K");
      // 8340000 / 83.4 = 100000 exactly -> $1.0L
      expect(fmtMoney(8340000, "usd")).toBe("$1.0L");
    });

    it("FLOATING-POINT EDGE: 83400/83.4 = 999.9999... < 1000, so it does NOT compact", () => {
      // Mathematically 1000, but float division yields 999.9999999999999.
      // Therefore the >=1000 compact branch is missed and toFixed(0) rounds to "1000".
      // (Asserting the actual current behavior, not the ideal "$1.0K".)
      expect(fmtMoney(83400, "usd")).toBe("$1000");
    });

    it("rounds USD value with toFixed(0) below the threshold", () => {
      // 100 / 83.4 = 1.199... -> toFixed(0) -> "1"
      expect(fmtMoney(100, "usd")).toBe("$1");
      // 50 / 83.4 = 0.599 -> "1"
      expect(fmtMoney(50, "usd")).toBe("$1");
      // 40 / 83.4 = 0.479 -> "0"
      expect(fmtMoney(40, "usd")).toBe("$0");
    });
  });
});

describe("fmtMoneyFull", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtMoneyFull(null, "inr")).toBe("—");
    expect(fmtMoneyFull(undefined, "usd")).toBe("—");
  });

  it("INR renders full rounded value with en-IN grouping", () => {
    expect(fmtMoneyFull(1234567, "inr")).toBe("₹12,34,567");
    expect(fmtMoneyFull(999, "inr")).toBe("₹999");
    expect(fmtMoneyFull(0, "inr")).toBe("₹0");
    expect(fmtMoneyFull(1234.6, "inr")).toBe("₹1,235");
  });

  it("USD renders full converted value with en-US grouping (no decimals)", () => {
    // 834000 / 83.4 = 10000 -> "10,000"
    expect(fmtMoneyFull(834000, "usd")).toBe("$10,000");
    // 8340 / 83.4 = 100
    expect(fmtMoneyFull(8340, "usd")).toBe("$100");
  });
});

describe("fmtPct", () => {
  it("multiplies by 100 and rounds to 1 decimal with % suffix", () => {
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(1)).toBe("100.0%");
    expect(fmtPct(0.5)).toBe("50.0%");
    expect(fmtPct(0.1234)).toBe("12.3%");
    expect(fmtPct(0.1235)).toBe("12.3%"); // banker's-ish toFixed rounding
    expect(fmtPct(0.999)).toBe("99.9%");
  });

  it("handles values above 1", () => {
    expect(fmtPct(1.5)).toBe("150.0%");
  });
});

describe("fmtDate", () => {
  it("formats ISO date as 'Mon D, YYYY'", () => {
    expect(fmtDate("2026-06-09T10:00:00Z")).toBe("Jun 9, 2026");
    expect(fmtDate("2026-01-01T00:00:00Z")).toBe("Jan 1, 2026");
    expect(fmtDate("2025-12-31T12:00:00Z")).toBe("Dec 31, 2025");
  });
});

describe("fmtDuration", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(undefined)).toBe("—");
  });

  it("renders only seconds below 60s", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(59)).toBe("59s");
  });

  it("renders 'Xm Ys' at/above 60s", () => {
    expect(fmtDuration(60)).toBe("1m 0s");
    expect(fmtDuration(90)).toBe("1m 30s");
    expect(fmtDuration(125)).toBe("2m 5s");
    expect(fmtDuration(3661)).toBe("61m 1s");
  });
});
