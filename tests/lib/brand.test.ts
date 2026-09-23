import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { resolveBrand, hexToRgba, brandStyleVars, mixWithWhite, brandSidebarWidth, getBrand } from "@/lib/brand";
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
  it("keeps the original accent glow, gradient CTA, and talk-time tint", () => {
    expect(vars["--shadow-accent"]).toBe("0 8px 24px -6px rgba(79, 70, 229, 0.6)");
    expect(vars["--cta-bg"]).toBe("var(--brand-grad)");
    expect(vars["--accent-muted"]).toBe("#c7d2fe");
  });
  it("leaves Tailwind's radius scale alone", () => {
    expect(Object.keys(vars).filter((k) => k.startsWith("--radius"))).toEqual([]);
  });
  it("honors a custom gradient angle", () => {
    const v = brandStyleVars({ ...DEFAULT_BRAND, style: { ...DEFAULT_BRAND.style, gradientAngle: 90 } }) as Record<string, string>;
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

describe("brandStyleVars — style levers", () => {
  const withStyle = (style: Partial<typeof DEFAULT_BRAND.style>) =>
    brandStyleVars({ ...DEFAULT_BRAND, style: { ...DEFAULT_BRAND.style, ...style } }) as Record<string, string>;

  it("scales the whole Tailwind radius scale from the base radius", () => {
    const soft = withStyle({ radius: "soft" }); // 14px base
    expect(soft["--radius-lg"]).toBe("14px");
    expect(soft["--radius-xl"]).toBe("21px");
    expect(soft["--radius-2xl"]).toBe("28px");
    expect(withStyle({ radius: "sharp" })["--radius-2xl"]).toBe("4px");
    expect(withStyle({ radius: 4 })["--radius-lg"]).toBe("4px");
  });

  it("maps elevation to the accent glow", () => {
    expect(withStyle({ elevation: "flat" })["--shadow-accent"]).toBe("none");
    expect(withStyle({ elevation: "soft" })["--shadow-accent"]).not.toContain("79, 70, 229");
  });

  it("renders gradient CTAs solid under flatButtons", () => {
    expect(withStyle({ flatButtons: true })["--cta-bg"]).toBe("var(--accent)");
  });
});

describe("resolveBrand — style levers", () => {
  it("defaults every lever to the original look", () => {
    expect(resolveBrand("acme", {}).style).toEqual(DEFAULT_BRAND.style);
  });

  it("accepts valid levers", () => {
    const s = resolveBrand("acme", { style: { radius: "soft", elevation: "flat", flatButtons: true } }).style;
    expect(s).toMatchObject({ radius: "soft", elevation: "flat", flatButtons: true });
    expect(resolveBrand("acme", { style: { radius: 12 } }).style.radius).toBe(12);
  });

  it("drops malformed levers instead of throwing", () => {
    const s = resolveBrand("acme", { style: { radius: "round", elevation: "neon", flatButtons: "yes" } }).style;
    expect(s).toEqual(DEFAULT_BRAND.style);
    expect(resolveBrand("acme", { style: { radius: 500 } }).style.radius).toBe("default");
    expect(resolveBrand("acme", { style: { radius: -1 } }).style.radius).toBe("default");
  });
});

describe("resolveBrand — originator", () => {
  it("uses a configured slug", () => {
    expect(resolveBrand("acme", { originator: "acme-insights" }).originator).toBe("acme-insights");
  });
  it("derives <id>-analytics rather than inheriting the default's attribution", () => {
    expect(resolveBrand("acme", {}).originator).toBe("acme-analytics");
    expect(resolveBrand("acme", { originator: "Not A Header!" }).originator).toBe("acme-analytics");
  });
  it("falls back to the default only when the id is not header-safe either", () => {
    expect(resolveBrand("../x", {}).originator).toBe(DEFAULT_BRAND.originator);
  });
  it("keeps magick-analytics for the default brand", () => {
    expect(resolveBrand("magickvoice", {}).originator).toBe("magick-analytics");
  });
  it("warns when a configured originator is rejected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveBrand("acme", { originator: "Acme Analytics" });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("getBrand — a pack that fails to load", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gets the default look but NOT the default's upstream attribution", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("BRAND", "no-such-brand");
    const b = getBrand();
    expect(b.name).toBe(DEFAULT_BRAND.name);
    expect(b.originator).toBe("no-such-brand-analytics");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("resolveBrand — compliance", () => {
  it("keeps the default brand's claims", () => {
    expect(resolveBrand("magickvoice", {}).compliance).toBe(DEFAULT_BRAND.compliance);
  });
  it("never lends them to a whitelabel", () => {
    expect(resolveBrand("acme", {}).compliance).toBeNull();
    expect(resolveBrand("acme", { compliance: "  " }).compliance).toBeNull();
  });
  it("uses a brand's own claims, and null hides them even on the default", () => {
    expect(resolveBrand("acme", { compliance: "ISO 27001" }).compliance).toBe("ISO 27001");
    expect(resolveBrand("magickvoice", { compliance: null }).compliance).toBeNull();
  });
});

describe("brandSidebarWidth", () => {
  const withWordmark = (lead: string, accent: string) => ({ ...DEFAULT_BRAND, wordmark: { lead, accent } });
  it("keeps the original 248px for the default brand", () => {
    expect(brandSidebarWidth(DEFAULT_BRAND)).toBe(248);
    expect((brandStyleVars(DEFAULT_BRAND) as Record<string, string>)["--sidebar-width"]).toBe("248px");
  });
  it("widens for a long wordmark, within the cap", () => {
    const w = brandSidebarWidth(withWordmark("Samarthya", "Analytics"));
    expect(w).toBeGreaterThan(248);
    expect(w).toBeLessThanOrEqual(320);
    expect(brandSidebarWidth(withWordmark("A".repeat(40), "B".repeat(40)))).toBe(320);
  });
});

describe("resolveBrand — accentMuted", () => {
  it("derives a tint of a recolored accent rather than inheriting indigo", () => {
    expect(resolveBrand("acme", { colors: { accent: "#000000" } }).colors.accentMuted).toBe(mixWithWhite("#000000", 0.7));
    expect(mixWithWhite("#000000", 0.7)).toBe("#b3b3b3");
  });
  it("keeps the default tint when the accent is untouched, and honors an explicit one", () => {
    expect(resolveBrand("acme", {}).colors.accentMuted).toBe("#c7d2fe");
    expect(resolveBrand("acme", { colors: { accent: "#000000", accentMuted: "#123456" } }).colors.accentMuted).toBe("#123456");
  });
});

describe("shipped brand packs", () => {
  const dir = path.join(process.cwd(), "brands");
  const ids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  it.each(ids)("%s has a logo and a config that resolves without falling back", (id) => {
    expect(() => readFileSync(path.join(dir, id, "logo.png"))).not.toThrow();
    const raw = JSON.parse(readFileSync(path.join(dir, id, "brand.config.json"), "utf8"));
    const b = resolveBrand(id, raw);
    expect(b.name).toBe(raw.name);
    expect(b.colors.accent).toBe(raw.colors.accent);
    if (raw.style) expect(b.style).toMatchObject(raw.style);
  });

  it("every pack has its own upstream originator", () => {
    const originators = ids.map((id) => resolveBrand(id, JSON.parse(readFileSync(path.join(dir, id, "brand.config.json"), "utf8"))).originator);
    expect(new Set(originators).size).toBe(originators.length);
  });

  it("the magickvoice pack carries no company-specific fields to copy into a new brand", () => {
    const raw = JSON.parse(readFileSync(path.join(dir, "magickvoice", "brand.config.json"), "utf8"));
    expect(raw).not.toHaveProperty("originator");
    expect(raw).not.toHaveProperty("compliance");
  });

  it("the samarthya pack sends samarthya-analytics and claims no certifications", () => {
    const b = resolveBrand("samarthya", JSON.parse(readFileSync(path.join(dir, "samarthya", "brand.config.json"), "utf8")));
    expect(b.name).toBe("Samarthya Analytics");
    expect(b.originator).toBe("samarthya-analytics");
    expect(b.compliance).toBeNull();
    expect(b.promotions).toBe(false);
  });

  it("the magickvoice pack matches the baked-in default", () => {
    const raw = JSON.parse(readFileSync(path.join(dir, "magickvoice", "brand.config.json"), "utf8"));
    expect(resolveBrand("magickvoice", raw)).toEqual(DEFAULT_BRAND);
  });
});
