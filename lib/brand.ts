import { readFileSync } from "node:fs";
import path from "node:path";
import type { CSSProperties } from "react";
import { type Brand, type BrandElevation, type BrandRadius, DEFAULT_BRAND } from "./brand-types";

// Server-side brand loader. (Server-only by convention — imported from the root
// layout, the /logo route handler, and magick-client (the upstream originator
// header), all Node-runtime; client code uses BrandProvider, which pulls just
// the pure-data brand-types module.)
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
    // The default LOOK, but not the default's attribution — a broken pack must
    // not start reporting its traffic upstream as MagickVoice's.
    return { ...DEFAULT_BRAND, id, originator: resolveBrand(id, {}).originator };
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

/** A radius preset or a px number in [0, 64]; anything else → default. */
function radius(v: unknown, fb: BrandRadius): BrandRadius {
  if (v === "sharp" || v === "default" || v === "soft") return v;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 64) return v;
  return fb;
}

function elevation(v: unknown, fb: BrandElevation): BrandElevation {
  return v === "flat" || v === "soft" || v === "glow" ? v : fb;
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** The upstream attribution for a brand: its configured slug, else
 *  `<id>-analytics` — never the default's, or a whitelabel's traffic would be
 *  counted as MagickVoice's. The default brand keeps the value upstream has
 *  always seen, which is why it lives in DEFAULT_BRAND and not in the
 *  magickvoice pack: a pack copied to start a new brand then carries nothing
 *  to forget to change. */
function originator(v: unknown, id: string, fb: string): string {
  if (typeof v === "string" && SLUG.test(v)) return v;
  if (v !== undefined) console.warn(`[brand] "${id}": ignoring originator ${JSON.stringify(v)} — expected a lowercase slug like "acme-analytics"`);
  if (id === DEFAULT_BRAND.id) return fb;
  return SLUG.test(id) ? `${id}-analytics` : fb;
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
  const accent = str(colors.accent, d.colors.accent);

  // sales: explicit null disables; omitted → default; object → resolved.
  const sales = raw.sales === null ? null : { label: str(obj(raw.sales).label, d.sales?.label ?? "Talk to sales"), href: str(obj(raw.sales).href, d.sales?.href ?? "#") };

  // byline: explicit null hides; omitted → "by {company}".
  const byline = raw.byline === null ? null : str(raw.byline, `by ${company}`);

  return {
    id,
    name,
    originator: originator(raw.originator, id, d.originator),
    shortName: str(raw.shortName, d.shortName),
    company,
    wordmark: { lead: str(wm.lead, d.wordmark.lead), accent: str(wm.accent, d.wordmark.accent) },
    byline: byline ? fill(byline, vars) : null,
    tagline: fill(str(raw.tagline, d.tagline), vars),
    loginTagline: fill(str(raw.loginTagline, d.loginTagline), vars),
    loginHeadline: { lead: fill(str(lh.lead, d.loginHeadline.lead), vars), accent: fill(str(lh.accent, d.loginHeadline.accent), vars) },
    // compliance: explicit null or omitted → none. Claims belong to a company,
    // so like `originator` only the default brand falls back to the default's.
    compliance:
      typeof raw.compliance === "string" && raw.compliance.trim()
        ? raw.compliance
        : raw.compliance === undefined && id === d.id
          ? d.compliance
          : null,
    sales: sales ? { label: fill(sales.label, vars), href: sales.href } : null,
    promotions: bool(raw.promotions, false),
    colors: {
      accent,
      accentStrong: str(colors.accentStrong, d.colors.accentStrong),
      accentSoft: str(colors.accentSoft, d.colors.accentSoft),
      // A brand that recolors the accent but not the tint gets a tint of ITS
      // accent — falling back to the default's indigo would put an indigo
      // series beside a gold one.
      accentMuted: str(colors.accentMuted, accent === d.colors.accent ? d.colors.accentMuted : mixWithWhite(accent, 0.7)),
      gradient: tuple(colors.gradient, d.colors.gradient as unknown as string[] & { length: 3 }) as [string, string, string],
      panel: tuple(colors.panel, d.colors.panel as unknown as string[] & { length: 3 }) as [string, string, string],
      highlight: tuple(colors.highlight, d.colors.highlight as unknown as string[] & { length: 2 }) as [string, string],
    },
    style: {
      gradientAngle: num(style.gradientAngle, d.style.gradientAngle),
      radius: radius(style.radius, d.style.radius),
      elevation: elevation(style.elevation, d.style.elevation),
      flatButtons: bool(style.flatButtons, d.style.flatButtons),
    },
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

/** Blend a `#rrggbb` color toward white by `amount` (0..1) → `#rrggbb`; passes
 *  other strings through. Exported for unit tests. */
export function mixWithWhite(hex: string, amount: number): string {
  const rgba = hexToRgba(hex, 1);
  const m = /^rgba\((\d+), (\d+), (\d+), 1\)$/.exec(rgba);
  if (!m) return hex;
  return "#" + [m[1], m[2], m[3]].map((c) => Math.round(Number(c) + (255 - Number(c)) * amount).toString(16).padStart(2, "0")).join("");
}

/**
 * Width (px) of the expanded sidebar: enough for the wordmark on one line at
 * its 18px/800 size, never narrower than the original 248px and capped at
 * 320px. Long names ("Samarthya Analytics") widen the rail instead of running
 * past its padding — the wordmark is a single unbreakable run. Same approach as
 * the customer UI's `brandSidebarWidth`. Exported for unit tests.
 */
export function brandSidebarWidth(brand: Brand): number {
  const AVG_ADVANCE_PX = 18 * 0.55; // 18px display face, ~0.55em per glyph at 800 weight
  const text = (brand.wordmark.lead + brand.wordmark.accent).length * AVG_ADVANCE_PX;
  const chrome = 36 /* logo */ + 10 /* gap */ + 40 /* px-5 */ + 16 /* breathing room */;
  return Math.min(320, Math.max(248, Math.ceil(text + chrome)));
}

/** Named radius presets → the base (`rounded-lg`) radius in px. */
const RADIUS_PRESETS = { sharp: 2, default: 8, soft: 14 } as const;
const DEFAULT_RADIUS_PX = RADIUS_PRESETS.default;

/** Tailwind v4's radius scale in px. Its `rounded-*` utilities read these
 *  variables (`.rounded-xl{border-radius:var(--radius-xl)}`), so overriding
 *  them re-rounds every call site at once. */
const TAILWIND_RADII = { xs: 2, sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, "4xl": 32 } as const;

/** Base radius in px for a resolved `style.radius`. Exported for unit tests. */
export function radiusBasePx(r: BrandRadius): number {
  return typeof r === "number" ? r : RADIUS_PRESETS[r];
}

/**
 * Brand → the CSS custom properties the design system already reads
 * (`--accent`, `--brand-grad`, …) plus the login-panel tokens. Returned as a
 * React style object so it can be set inline on <html> — inline custom props
 * win over the :root defaults in globals.css regardless of stylesheet order.
 */
export function brandStyleVars(brand: Brand): CSSProperties {
  const { accent, accentStrong, accentSoft, accentMuted, gradient, panel, highlight } = brand.colors;
  const { gradientAngle: ga, elevation, flatButtons } = brand.style;
  const shadowAccent =
    elevation === "flat" ? "none" : elevation === "soft" ? "0 8px 24px -12px rgba(15, 23, 42, 0.25)" : `0 8px 24px -6px ${hexToRgba(accent, 0.6)}`;

  // Only a non-default radius touches the scale, so the default brand keeps
  // Tailwind's own values rather than an inline copy of them.
  const base = radiusBasePx(brand.style.radius);
  const radii: Record<string, string> = {};
  if (base !== DEFAULT_RADIUS_PX) {
    const k = base / DEFAULT_RADIUS_PX;
    for (const [step, px] of Object.entries(TAILWIND_RADII)) radii[`--radius-${step}`] = `${Math.round(px * k)}px`;
  }

  return {
    "--accent": accent,
    "--accent-strong": accentStrong,
    "--accent-soft": accentSoft,
    "--accent-ring": hexToRgba(accent, 0.35),
    "--accent-muted": accentMuted,
    "--shadow-accent": shadowAccent,
    "--cta-bg": flatButtons ? "var(--accent)" : "var(--brand-grad)",
    "--sidebar-width": `${brandSidebarWidth(brand)}px`,
    "--brand-grad": `linear-gradient(${ga}deg, ${gradient[0]} 0%, ${gradient[1]} 48%, ${gradient[2]} 100%)`,
    "--login-panel": `radial-gradient(120% 120% at 0% 0%, ${panel[0]} 0%, ${panel[1]} 38%, ${panel[2]} 100%)`,
    "--login-glow": `radial-gradient(circle at 80% 20%, ${hexToRgba(gradient[0], 0.55)}, transparent 45%), radial-gradient(circle at 15% 85%, ${hexToRgba(gradient[2], 0.45)}, transparent 45%)`,
    "--login-highlight": `linear-gradient(90deg, ${highlight[0]}, ${highlight[1]})`,
    ...radii,
  } as CSSProperties;
}
