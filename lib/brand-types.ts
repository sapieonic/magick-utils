// Brand-pack types + the baked-in default brand.
//
// This module is PURE DATA (no fs, no "server-only") so it can be imported from
// both the server loader (lib/brand.ts) and client code (the BrandProvider).
// `DEFAULT_BRAND` doubles as the fail-closed fallback: if the active
// brand.config.json is missing or malformed, the app renders MagickVoice
// byte-for-byte instead of white-screening.

/** A fully-resolved brand — every template token already substituted, every
 *  optional field filled from defaults. This is what the UI consumes. */
export type Brand = {
  id: string;
  /** Full product name — browser tab title + Topbar fallback. */
  name: string;
  /** Compact label (e.g. for tight chrome). */
  shortName: string;
  /** Parent company — used in bylines/copy. */
  company: string;
  /** Two-tone wordmark: `lead` in neutral, `accent` in the brand gradient. */
  wordmark: { lead: string; accent: string };
  /** Sub-wordmark line (e.g. "by MagickVoice"); null hides it. */
  byline: string | null;
  /** One-line product description (metadata + login subtitle). */
  tagline: string;
  /** Longer login-panel blurb. */
  loginTagline: string;
  /** Login hero headline, two-tone like the wordmark. */
  loginHeadline: { lead: string; accent: string };
  /** Sales CTA on the login screen; null hides it. Gated by `promotions`. */
  sales: { label: string; href: string } | null;
  /** Opt-in flag for first-party promotional UI (e.g. the sales CTA). A
   *  whitelabel never inherits these — defaults to false. */
  promotions: boolean;
  colors: {
    accent: string;
    accentStrong: string;
    accentSoft: string;
    /** Wordmark / button / panel gradient stops (3). */
    gradient: [string, string, string];
    /** Login left-panel radial gradient stops (3). */
    panel: [string, string, string];
    /** Login headline highlight gradient stops (2). */
    highlight: [string, string];
  };
  style: {
    /** Accent gradient angle, in degrees. */
    gradientAngle: number;
  };
};

/** The default MagickVoice brand. Also the fail-closed fallback. */
export const DEFAULT_BRAND: Brand = {
  id: "magickvoice",
  name: "MagickUtils",
  shortName: "MU",
  company: "MagickVoice",
  wordmark: { lead: "Magick", accent: "Utils" },
  byline: "by MagickVoice",
  tagline: "Download, merge, and analyze your MagickVoice campaigns.",
  loginTagline: "Download, merge, and analyze your MagickVoice call & messaging campaigns — all in one workspace.",
  loginHeadline: { lead: "Turn finished campaigns into ", accent: "decisions." },
  sales: { label: "Talk to sales", href: "#" },
  promotions: true,
  colors: {
    accent: "#4f46e5",
    accentStrong: "#4338ca",
    accentSoft: "#eef2ff",
    gradient: ["#8b3fd6", "#6366f1", "#3b82f6"],
    panel: ["#1e1b4b", "#312e81", "#4338ca"],
    highlight: ["#c4b5fd", "#93c5fd"],
  },
  style: { gradientAngle: 135 },
};
