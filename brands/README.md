# Brand packs (whitelabeling)

Each subfolder is one whitelabel brand. The active brand is chosen at **runtime**
by the `BRAND` env var (default: `magickvoice`) — MagickUtils runs on a single
long-running Node host, so one build serves any brand. Set `BRAND` per
deployment and point that brand's domain at it; **no rebuild per brand.**

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

    {
      "name": "Acme Utils",                  // product name (tab title + Topbar)
      "shortName": "AU",                      // compact label
      "company": "Acme",                      // parent company, used in copy
      "wordmark": { "lead": "Acme", "accent": "Utils" },  // two-tone logo text
      "byline": "by {company}",               // sub-wordmark line; null hides it
      "tagline": "Download, merge, and analyze your {company} campaigns.",
      "loginTagline": "…longer login-panel blurb…",
      "loginHeadline": { "lead": "Turn finished campaigns into ", "accent": "decisions." },
      "promotions": false,                    // gate first-party promos (sales CTA); default false
      "sales": { "label": "Talk to sales", "href": "https://acme.com/sales" },
      "colors": {
        "accent": "#1d4ed8",                  // primary brand color
        "accentStrong": "#1e40af",            // darker accent (hover/active/links)
        "accentSoft": "#eff6ff",              // subtle accent background
        "gradient": ["#1d4ed8", "#3b82f6", "#60a5fa"],  // wordmark/button gradient (3)
        "panel":    ["#0b1220", "#1e293b", "#1e40af"],  // login left-panel gradient (3)
        "highlight":["#bfdbfe", "#93c5fd"]              // login headline highlight (2)
      },
      "style": { "gradientAngle": 135 }       // accent gradient angle, deg
    }

**Scope note:** the brand colors drive every accent surface — buttons, links,
focus rings, active nav, badges, the `var(--brand-grad)` wordmark/avatar
gradient, charts, and the login panel — because the UI reads CSS custom
properties (`--accent`, `--accent-strong`, `--accent-soft`, `--accent-ring`,
`--brand-grad`, `--login-*`) that `lib/brand.ts` sets at runtime on `<html>`.
The neutral/background palette stays fixed in `app/globals.css`.
`promotions` is opt-in (default `false`) so a whitelabel never inherits
MagickVoice-only promo UI such as the login "Talk to sales" CTA — only the
default `magickvoice` brand sets it `true`.

## Add a new whitelabel

1. `cp -r brands/magickvoice brands/acme`
2. Edit `brands/acme/brand.config.json` (name, company, colors, copy).
3. Replace `brands/acme/logo.png` with the brand's logo (also the favicon).
4. Deploy with `BRAND=acme` set in the environment.
5. Point the brand's domain at that deployment (infra side, handled separately).

No code changes are needed to add a brand.
