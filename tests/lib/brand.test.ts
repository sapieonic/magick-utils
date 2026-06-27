import { describe, it, expect } from "vitest";
import { resolveBrand, hexToRgba, brandStyleVars } from "@/lib/brand";
import { DEFAULT_BRAND } from "@/lib/brand-types";

describe("hexToRgba", () => {
  it("converts 6-digit hex", () => {
    expect(hexToRgba("#4f46e5", 0.35)).toBe("rgba(79, 70, 229, 0.35)");
  });
  it("expands 3-digit hex", () => {
    expect(hexToRgba("#fff", 1)).toBe("rgba(255, 255, 255, 1)");
  });
  it("is case-insensitive and tolerates a missing #", () => {
    expect(hexToRgba("4F46E5", 0.5)).toBe("rgba(79, 70, 229, 0.5)");
  });
  it("passes non-hex strings through unchanged (rgb/named colors survive)", () => {
    expect(hexToRgba("rebeccapurple", 0.5)).toBe("rebeccapurple");
    expect(hexToRgba("#12345", 0.5)).toBe("#12345"); // wrong length
  });
});

describe("brandStyleVars — default-brand fidelity", () => {
  const vars = brandStyleVars(DEFAULT_BRAND) as Record<string, string>;
  it("reproduces the original globals.css :root tokens exactly", () => {
    expect(vars["--accent"]).toBe("#4f46e5");
    expect(vars["--accent-strong"]).toBe("#4338ca");
    expect(vars["--accent-soft"]).toBe("#eef2ff");
    expect(vars["--accent-ring"]).toBe("rgba(79, 70, 229, 0.35)");
    expect(vars["--brand-grad"]).toBe("linear-gradient(135deg, #8b3fd6 0%, #6366f1 48%, #3b82f6 100%)");
  });
  it("derives the login-panel tokens from the brand colors", () => {
    expect(vars["--login-panel"]).toBe("radial-gradient(120% 120% at 0% 0%, #1e1b4b 0%, #312e81 38%, #4338ca 100%)");
    expect(vars["--login-glow"]).toContain("rgba(139, 63, 214, 0.55)");
    expect(vars["--login-glow"]).toContain("rgba(59, 130, 246, 0.45)");
    expect(vars["--login-highlight"]).toBe("linear-gradient(90deg, #c4b5fd, #93c5fd)");
  });
  it("honors a custom gradient angle", () => {
    const v = brandStyleVars({ ...DEFAULT_BRAND, style: { gradientAngle: 90 } }) as Record<string, string>;
    expect(v["--brand-grad"]).toBe("linear-gradient(90deg, #8b3fd6 0%, #6366f1 48%, #3b82f6 100%)");
  });
});

describe("resolveBrand — merge, tokens, fail-closed", () => {
  it("substitutes {company} / {name} tokens in copy", () => {
    const b = resolveBrand("acme", { name: "Acme Utils", company: "Acme", tagline: "Analyze your {company} campaigns with {name}." });
    expect(b.tagline).toBe("Analyze your Acme campaigns with Acme Utils.");
    expect(b.byline).toBe("by Acme"); // default byline derives from company
  });

  it("fills every omitted field from DEFAULT_BRAND", () => {
    const b = resolveBrand("acme", { name: "Acme" });
    expect(b.shortName).toBe(DEFAULT_BRAND.shortName);
    expect(b.colors.accent).toBe(DEFAULT_BRAND.colors.accent);
    expect(b.loginHeadline.accent).toBe(DEFAULT_BRAND.loginHeadline.accent);
    expect(b.style.gradientAngle).toBe(DEFAULT_BRAND.style.gradientAngle);
  });

  it("fills partial/short/non-array color tuples per-slot from defaults", () => {
    const b = resolveBrand("acme", { colors: { accent: "#111111", gradient: ["#aaaaaa"], panel: "nope" } });
    expect(b.colors.accent).toBe("#111111");
    expect(b.colors.gradient).toEqual(["#aaaaaa", DEFAULT_BRAND.colors.gradient[1], DEFAULT_BRAND.colors.gradient[2]]);
    expect(b.colors.panel).toEqual(DEFAULT_BRAND.colors.panel); // non-array → all defaults
    expect(b.colors.highlight).toHaveLength(2);
  });

  it("treats explicit null as 'hide' for byline and sales", () => {
    const b = resolveBrand("acme", { byline: null, sales: null });
    expect(b.byline).toBeNull();
    expect(b.sales).toBeNull();
  });

  it("defaults promotions to false (whitelabels never inherit first-party promos)", () => {
    expect(resolveBrand("acme", {}).promotions).toBe(false);
  });

  it("ignores wrong-typed fields rather than throwing", () => {
    const b = resolveBrand("acme", { name: 123, promotions: "yes", style: { gradientAngle: "tilt" } });
    expect(b.name).toBe(DEFAULT_BRAND.name);
    expect(b.promotions).toBe(false);
    expect(b.style.gradientAngle).toBe(DEFAULT_BRAND.style.gradientAngle);
  });
});
