# Brand packs (whitelabeling)

Each subfolder is one whitelabel brand. The active brand is chosen at **runtime**
by the `BRAND` env var (default: `magickvoice`) — MagickUtils runs on a single
long-running Node host, so one build serves any brand. Set `BRAND` per
deployment and point that brand's domain at it; **no rebuild per brand.**

## Shipped brands

| id            | Product            | Notes                                                    |
| ------------- | ------------------ | -------------------------------------------------------- |
| `magickvoice` | MagickUtils        | Default + fail-closed fallback. Promotions on.           |
| `samarthya`   | Samarthya Analytics | Mirrors the customer UI's `samarthya` pack (logo, gold accent, soft/flat style). Accent and gradient darkened (`#8f6a30`, `#946f35`→`#7a5a28`) for white-text contrast on this light UI. Originator `samarthya-analytics`; no compliance claims. |

## Structure

    brands/
      <brand-id>/
        brand.config.json    # name, colors, copy, style
        logo.png             # logo; also served as the favicon (/logo)

## brand.config.json

Every field is **optional** and falls back to the MagickVoice default — a
missing or malformed config never breaks the app, it just looks like the
default brand (fail-closed, resolved in `lib/brand.ts`). Copy strings may use
`{company}` and `{name}` tokens.

Two fields are **company-specific and never fall back to MagickVoice's** for a
non-default brand: `originator` (defaults to `<id>-analytics`) and `compliance`
(defaults to none). A broken or missing pack keeps that rule too — it gets the
MagickVoice *look*, but not its upstream attribution. That is also why neither
appears in `brands/magickvoice/brand.config.json`: MagickVoice's values are
baked into `DEFAULT_BRAND`, so a copied pack carries nothing to forget.

Colors must be hex (`#rgb` / `#rrggbb`). Other CSS colors are passed through
as-is, but the derived tokens (focus ring, glow, `accentMuted`) need hex to
apply their alpha/tint, so a named color gives an opaque ring and a talk-time
series identical to the accent.

    {
      "name": "Acme Utils",                  // product name (tab title + Topbar)
      "originator": "acme-analytics",        // x-mgkvc-originator sent to magick-master; lowercase slug; default "<id>-analytics"
      "shortName": "AU",                      // compact label
      "company": "Acme",                      // parent company, used in copy
      "wordmark": { "lead": "Acme", "accent": "Utils" },  // two-tone logo text
      "byline": "by {company}",               // sub-wordmark line; null hides it
      "tagline": "Download, merge, and analyze your {company} campaigns.",
      "loginTagline": "…longer login-panel blurb…",
      "loginHeadline": { "lead": "Turn finished campaigns into ", "accent": "decisions." },
      "compliance": "ISO 27001 certified",    // login-footer claims after "© <year> <company>"; default none
      "promotions": false,                    // gate first-party promos (sales CTA); default false
      "sales": { "label": "Talk to sales", "href": "https://acme.com/sales" },
      "colors": {
        "accent": "#1d4ed8",                  // primary brand color
        "accentStrong": "#1e40af",            // darker accent (hover/active/links)
        "accentSoft": "#eff6ff",              // subtle accent background
        "accentMuted": "#bfdbfe",             // light accent tint for a secondary series; derived from accent if omitted
        "gradient": ["#1d4ed8", "#3b82f6", "#60a5fa"],  // wordmark/button gradient (3)
        "panel":    ["#0b1220", "#1e293b", "#1e40af"],  // login left-panel gradient (3)
        "highlight":["#bfdbfe", "#93c5fd"]              // login headline highlight (2)
      },
      "style": {                              // optional non-color levers (same set as the customer UI)
        "gradientAngle": 135,                 //   accent gradient angle, deg (default 135)
        "radius": "soft",                     //   "sharp" | "default" | "soft" | <px 0–64>  (default "default")
        "elevation": "flat",                  //   "flat" | "soft" | "glow"  (default "glow")
        "flatButtons": true                   //   solid-accent gradient CTAs (default false)
      }
    }

`style` is fail-closed like everything else — an absent or malformed lever
falls back to the default look:

- `radius` — corner radius across the app. A preset (`sharp` = 2px, `default` =
  8px, `soft` = 14px) or a base radius in px. It is the `rounded-lg` size; the
  rest of Tailwind's scale (`rounded-sm` … `rounded-4xl`) is scaled by the same
  factor, because the utilities read `--radius-*` variables that `lib/brand.ts`
  overrides. Unaffected: `rounded-full`, bare `rounded` (Tailwind compiles it to
  a fixed `.25rem`), arbitrary `rounded-[Npx]`, the `.skeleton` radius in
  `globals.css`, and Recharts bar `radius` props.
- `elevation` — the accent-tinted glow on gradient CTAs (`--shadow-accent`):
  `glow` (the halo), `soft` (a neutral shadow), or `flat` (none).
- `flatButtons` — render gradient CTAs such as "Ask AI" (`--cta-bg`) as a solid
  accent fill. Primary buttons are already solid `--accent`.

The UI is light-only, and both `accent` (primary buttons, toggles, checkboxes)
and every `gradient` stop (avatar and workspace initials, white-icon tiles, the
"Ask AI" button) are **backgrounds for white text** — each should clear 4.5:1
against white. A brand color too light for that (e.g. a bright gold) belongs in
`highlight`, which only sits on the dark login panel, with darker shades as
`accent`/`gradient`.

A long wordmark widens the expanded sidebar (`--sidebar-width`, 248px minimum,
320px cap — see `brandSidebarWidth`) rather than running past its padding.

**Scope note:** the brand colors drive every accent surface — buttons, links,
focus rings, active nav, badges, the `var(--brand-grad)` wordmark/avatar
gradient, charts, and the login panel — because the UI reads CSS custom
properties (`--accent`, `--accent-strong`, `--accent-soft`, `--accent-ring`,
`--accent-muted`, `--brand-grad`, `--cta-bg`, `--shadow-accent`, `--radius-*`,
`--login-*`) that `lib/brand.ts` sets at runtime on `<html>`.
The neutral/background palette stays fixed in `app/globals.css`, and so do
categorical colors that carry meaning rather than brand (the AI/IVR/channel type
colors and status colors in `lib/data.ts`, chart series such as "AI" spend).
`promotions` is opt-in (default `false`) so a whitelabel never inherits
MagickVoice-only promo UI such as the login "Talk to sales" CTA — only the
default `magickvoice` brand sets it `true`.

## Add a new whitelabel

1. `cp -r brands/magickvoice brands/acme`
2. Edit `brands/acme/brand.config.json` (name, company, colors, copy). Set
   `"promotions": false` and `"sales": null` unless the brand really has
   MagickVoice's promos — the copy inherits `true` from the magickvoice pack.
   Add `originator` if upstream should see something other than `acme-analytics`
   (each pack's must be unique; a test enforces it), and `compliance` only for
   claims that brand actually holds.
3. Replace `brands/acme/logo.png` with the brand's logo (also the favicon).
4. Set `BRAND=acme` in the deployment env and restart.
5. Point the brand's domain at that deployment (infra side, handled separately).

No code changes are needed to add a brand. Under the shipped Docker setup,
committed brands are baked into the image and `docker compose` also bind-mounts
the host `brands/` dir read-only — so steps 1–4 work with a plain restart, no
`--build`. See `deployment-guide.md` → "Whitelabeling (brand packs)".
