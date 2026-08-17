import { describe, expect, it } from "vitest";
import {
  APP_TIMEZONE,
  APP_TIMEZONE_LABEL,
  addAppDays,
  formatAppDate,
  formatAppTime,
  formatAppYmd,
  fromAppTimeParts,
  getAppTimeParts,
  parseAppYmd,
  sameAppDay,
  startOfAppDay,
  startOfAppHour,
} from "@/lib/timezone";

describe("app timezone pin", () => {
  it("is India Standard Time", () => {
    expect(APP_TIMEZONE).toBe("Asia/Kolkata");
    expect(APP_TIMEZONE_LABEL).toBe("IST");
  });

  it("converts a UTC instant to IST civil parts", () => {
    const parts = getAppTimeParts(new Date("2026-08-12T18:40:00Z"));
    expect(parts).toMatchObject({
      year: 2026,
      month: 7,
      date: 13,
      weekday: 4, // Thursday
      hours: 0,
      minutes: 10,
    });
  });

  it("treats 18:30 UTC as midnight IST", () => {
    const midnight = new Date("2026-08-05T18:30:00.000Z");
    expect(formatAppYmd(midnight)).toBe("2026-08-06");
    expect(startOfAppDay(midnight).toISOString()).toBe("2026-08-05T18:30:00.000Z");
  });

  it("does not share a calendar day across the IST midnight boundary", () => {
    const before = new Date("2026-08-05T18:29:59.000Z");
    const after = new Date("2026-08-05T18:30:00.000Z");
    expect(sameAppDay(before, after)).toBe(false);
    expect(formatAppYmd(before)).toBe("2026-08-05");
    expect(formatAppYmd(after)).toBe("2026-08-06");
  });

  it("rounds hour buckets in IST, not UTC", () => {
    const d = new Date("2026-06-23T10:05:00Z"); // 15:35 IST
    expect(startOfAppHour(d).toISOString()).toBe("2026-06-23T09:30:00.000Z");
    expect(formatAppTime(d)).toBe("3 PM");
    expect(formatAppTime(d, { minute: true })).toBe("3:35 PM");
  });

  it("round-trips IST calendar dates", () => {
    const parsed = parseAppYmd("2026-08-03");
    expect(parsed.toISOString()).toBe("2026-08-02T18:30:00.000Z");
    expect(formatAppYmd(parsed)).toBe("2026-08-03");
    expect(formatAppDate(addAppDays(parsed, 1))).toBe("Aug 4");
  });

  it("builds instants from IST parts independently of process TZ", () => {
    const previousTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const d = fromAppTimeParts(2026, 0, 1, 0, 0, 0);
      expect(d.toISOString()).toBe("2025-12-31T18:30:00.000Z");
      expect(getAppTimeParts(d)).toMatchObject({ year: 2026, month: 0, date: 1, hours: 0 });
    } finally {
      if (previousTz == null) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
