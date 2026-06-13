import { describe, it, expect } from "vitest";
import { fmtDuration } from "@/lib/data";

describe("fmtDuration", () => {
  it("trims fractional seconds to 2 decimals", () => {
    expect(fmtDuration(37.66629547141797)).toBe("37.66s");
  });

  it("keeps whole seconds clean (no trailing zeros)", () => {
    expect(fmtDuration(45)).toBe("45s");
  });

  it("formats minutes + seconds", () => {
    expect(fmtDuration(125.5)).toBe("2m 5.5s");
  });

  it("renders em-dash for null/undefined", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(undefined)).toBe("—");
  });
});
