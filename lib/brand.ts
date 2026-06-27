import { readFileSync } from "node:fs";
import path from "node:path";
import type { CSSProperties } from "react";
import { type Brand, DEFAULT_BRAND } from "./brand-types";

// Server-side brand loader. (Server-only by convention — imported only from the
// root layout and the /logo route handler; client code uses BrandProvider,
// which pulls just the pure-data brand-types module.)
//
// The active brand is chosen at RUNTIME by the `BRAND` env var (default
// "magickvoice"), read from `brands/<id>/brand.config.json`. Because MagickUtils
// deploys to a single long-running Node host (not serverless), one build serves
// any brand — set BRAND per deployment and point its domain at it. No rebuild.
//
// Fail-closed: a missing or malformed config never takes the app down; we log
// and fall back to DEFAULT_BRAND, so the worst case is "looks like MagickVoice".

/** The active brand id (BRAND env, default "magickvoice"). */
export function getBrandId(): string {
  return (process.env.BRAND ?? "magickvoice").trim() || "magickvoice";
}

// Cache per id so we read+validate the JSON once per process (the env can't
// change under a running server), while still picking up a different BRAND in
// tests/other processes.
const cache = new Map<string, Brand>();

/** Load and resolve the active brand. Cheap to call repeatedly. */
export function getBrand(): Brand {
  const id = getBrandId();
  const hit = cache.get(id);
  if (hit) return hit;
  const brand = loadBrand(id);
  cache.set(id, brand);
  return brand;
}

function loadBrand(id: string): Brand {
  if (id === DEFAULT_BRAND.id) return DEFAULT_BRAND;
  try {
    const file = path.join(process.cwd(), "brands", id, "brand.config.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return resolveBrand(id, raw);
  } catch (err) {
    console.error(`[brand] failed to load brand "${id}", falling back to "${DEFAULT_BRAND.id}":`, err instanceof Error ? err.message : err);
    return { ...DEFAULT_BRAND, id };
  }
}

// ----- resolution (every field optional → default; tokens substituted) -----

type RawObj = Record<string, unknown>;
const str = (v: unknown, fb: string): string => (typeof v === "string" && v.trim() ? v : fb);
const num = (v: unknown, fb: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
const bool = (v: unknown, fb: boolean): boolean => (typeof v === "boolean" ? v : fb);
const obj = (v: unknown): RawObj => (v && typeof v === "object" ? (v as RawObj) : {});

/** Fill a fixed-length hex tuple from raw, falling back per-slot to defaults. */
function tuple<N extends number>(v: unknown, fb: string[] & { length: N }): string[] {
  const arr = Array.isArray(v) ? v : [];
  return fb.map((d, i) => str(arr[i], d));
}

/** Substitute {company} / {name} tokens in copy. */
function fill(tpl: string, vars: { company: string; name: string }): string {
  return tpl.replace(/\{company\}/g, vars.company).replace(/\{name\}/g, vars.name);
}

/** Merge a raw parsed config over DEFAULT_BRAND. Exported for unit tests; pure
 *  (no fs/env) — `getBrand()` is the normal entry point. */
export function resolveBrand(id: string, raw: RawObj): Brand {
  const d = DEFAULT_BRAND;
  const name = str(raw.name, d.name);
  const company = str(raw.company, d.company);
  const vars = { company, name };

  const wm = obj(raw.wordmark);
  const lh = obj(raw.loginHeadline);
  const colors = obj(raw.colors);
  const style = obj(raw.style);

  // sales: explicit null disables; omitted → default; object → resolved.
  const sales = raw.sales === null ? null : { label: str(obj(raw.sales).label, d.sales?.label ?? "Talk to sales"), href: str(obj(raw.sales).href, d.sales?.href ?? "#") };

  // byline: explicit null hides; omitted → "by {company}".
  const byline = raw.byline === null ? null : str(raw.byline, `by ${company}`);

  return {
    id,
    name,
    shortName: str(raw.shortName, d.shortName),
    company,
    wordmark: { lead: str(wm.lead, d.wordmark.lead), accent: str(wm.accent, d.wordmark.accent) },
    byline: byline ? fill(byline, vars) : null,
    tagline: fill(str(raw.tagline, d.tagline), vars),
    loginTagline: fill(str(raw.loginTagline, d.loginTagline), vars),
    loginHeadline: { lead: fill(str(lh.lead, d.loginHeadline.lead), vars), accent: fill(str(lh.accent, d.loginHeadline.accent), vars) },
    sales: sales ? { label: fill(sales.label, vars), href: sales.href } : null,
    promotions: bool(raw.promotions, false),
    colors: {
      accent: str(colors.accent, d.colors.accent),
      accentStrong: str(colors.accentStrong, d.colors.accentStrong),
      accentSoft: str(colors.accentSoft, d.colors.accentSoft),
      gradient: tuple(colors.gradient, d.colors.gradient as unknown as string[] & { length: 3 }) as [string, string, string],
      panel: tuple(colors.panel, d.colors.panel as unknown as string[] & { length: 3 }) as [string, string, string],
      highlight: tuple(colors.highlight, d.colors.highlight as unknown as string[] & { length: 2 }) as [string, string],
    },
    style: { gradientAngle: num(style.gradientAngle, d.style.gradientAngle) },
  };
}

// ----- CSS variables -----

/** `#rgb`/`#rrggbb` → `rgba(r, g, b, a)`; passes other strings through.
 *  Exported for unit tests. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Brand → the CSS custom properties the design system already reads
 * (`--accent`, `--brand-grad`, …) plus the login-panel tokens. Returned as a
 * React style object so it can be set inline on <html> — inline custom props
 * win over the :root defaults in globals.css regardless of stylesheet order.
 */
export function brandStyleVars(brand: Brand): CSSProperties {
  const { accent, accentStrong, accentSoft, gradient, panel, highlight } = brand.colors;
  const ga = brand.style.gradientAngle;
  return {
    "--accent": accent,
    "--accent-strong": accentStrong,
    "--accent-soft": accentSoft,
    "--accent-ring": hexToRgba(accent, 0.35),
    "--brand-grad": `linear-gradient(${ga}deg, ${gradient[0]} 0%, ${gradient[1]} 48%, ${gradient[2]} 100%)`,
    "--login-panel": `radial-gradient(120% 120% at 0% 0%, ${panel[0]} 0%, ${panel[1]} 38%, ${panel[2]} 100%)`,
    "--login-glow": `radial-gradient(circle at 80% 20%, ${hexToRgba(gradient[0], 0.55)}, transparent 45%), radial-gradient(circle at 15% 85%, ${hexToRgba(gradient[2], 0.45)}, transparent 45%)`,
    "--login-highlight": `linear-gradient(90deg, ${highlight[0]}, ${highlight[1]})`,
  } as CSSProperties;
}
