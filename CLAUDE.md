@AGENTS.md

# MagickUtils

Utility tool for MagickVoice customers to **download, merge, and analyze** their voice-call and
messaging campaign data. See `PROPOSAL.md` for the full architecture and rationale.

## Stack
- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** · **Tailwind v4**
- **Recharts** (charts), **lucide-react** (icons, via the `Icon` wrapper), fonts via `next/font`
  (Plus Jakarta Sans + JetBrains Mono).
- Target deploy: a **single long-running Node host** (Render/Railway/Fly) — NOT Vercel serverless —
  so long-running jobs (ingestion, CSV merge, AI analysis) can run in-process. State in **MongoDB
  Atlas**. LLM is **provider-agnostic** (OpenAI-compatible: DeepSeek/Kimi/OpenRouter, or Anthropic).

## Commands
- `npm run dev` — dev server (Turbopack). `npm run build` / `npm start` — prod build + serve.
- `npm run lint` — ESLint. `npx tsc --noEmit` — typecheck. Both must pass before a change is done.
- `npm test` — Vitest (run once). `npm run test:watch`, `npm run test:coverage`.
- Single file: `npx vitest run tests/lib/server/aggregate.test.ts`. By name: `npx vitest run -t "merge"`.
- Tests default to the **node** environment (`vitest.config.ts`); DOM/component tests opt in per-file with
  a `// @vitest-environment jsdom` comment at the top. `tests/` mirrors the source tree.

## Layout
- `app/login`, `app/workspace` — auth + tenant/account context selection.
- `app/(app)/{dashboard,campaigns,combine,analytics}` — the four main screens, behind a workspace
  guard in `app/(app)/layout.tsx` (Sidebar + Topbar shell).
- `components/ui/` — shared design-system primitives (Card, Button, Badge, Modal, Tabs, charts, etc.).
  `Icon` takes a lucide PascalCase name string: `<Icon name="Download" />`. `cx` is the classname joiner.
- `components/shell/` — Sidebar, Topbar. `components/screens/<screen>/` — per-screen pieces.
- `lib/data.ts` — **the data seam**: domain metadata, formatters, and (currently) seeded mock data.
  Swap these for real API responses when wiring the backend. `lib/types.ts` — domain types.
- `lib/store.tsx` — `AppProvider` / `useApp()`: workspace, currency, dateRange, and the batch-id
  selection passed into Combine/Analytics (sessionStorage-persisted).

## Domain model (important)
A **batch** = one bulk job's result. `selType(batch)` ∈ `ai | ivr | message` governs the hard rule:
you may only multi-select / combine / analyze-together batches of the **same selType**. `typeKey` keeps
messaging channels distinct for badges (`ai | ivr | whatsapp | telegram | email`).

`BatchDoc.ingestStatus` is `none | ingesting | ready | stale | error`. **`stale` is readable** — its
published revision is complete and is what every reader sees, it just has upstream changes waiting.
Use `isBatchReadable()` from `lib/server/types.ts` rather than comparing to `"ready"`; treating stale as
un-ingested is what produced intermittent 409s. See BACKEND.md → *Batch freshness*.

Each ingestion writes a complete new copy of a batch's records under a fresh revision, so anything that
re-ingests unnecessarily costs a full duplicate dataset. Never make a refresh unconditional; see
`bulkJobIsUnchangedSince` and `docs/runbooks/storage-recovery.md`. The one refresh that is never skipped
is a batch already flagged `stale` — the two freshness signals can disagree, and deferring to the
timestamp there latches the batch stale with no click able to clear it.

Anything that both counts and then reads the same records (the CSV export) must resolve the published
revisions once with `resolvePublishedRecordsFilter` and pass that to both; resolving twice lets a
refresh publish in between and the two disagree.

`DATA_RETENTION_DAYS` (default 5) is the ceiling on how far back Dashboard and Analytics can see —
older batches are deleted with every record they own.

## Status
- ✅ Full UI ported from the design handoff. `npm run dev`, `npm run build`, `npx tsc --noEmit` pass.
- ✅ Backend V1 built (see `BACKEND.md`): magick-master client, iron-session auth, MongoDB layer,
  in-process ingestion worker (`instrumentation.ts` → `lib/server/worker.ts`), pluggable LLM, and all
  BFF routes under `app/api/*` (auth, campaigns, ingest, jobs, export [streamed CSV], analytics,
  insights, chat [SSE]). `lib/api.ts` is the client seam with **mock fallback** — unset env ⇒ the UI
  runs on `lib/data.ts`; set env ⇒ live data.
- ✅ All four screens wired through `lib/api.ts`: Campaigns (list), Dashboard (stats/status-mix/recent +
  batch-derived volume series), Combine (real `merge` job poll + streamed CSV download), and Analytics
  (real ingest job poll → `getAnalytics` aggregates feed Overview/Cost/Conversation tabs; `generateInsights`
  for AI Insights; `streamChat` SSE for the chat box). Every path degrades to mock/canned when the
  backend/LLM is off, so the UI still runs with no env.
- ✅ Firebase login wired (`lib/firebase.ts`: Google + email sign-in → ID token exchanged by the BFF).
  No-ops cleanly when `NEXT_PUBLIC_FIREBASE_*` is unset (mock mode / token-paste testing).
- ⏳ Deferred (noted in `BACKEND.md`): token refresh for long jobs, prettier batch ids, GridFS export retention.

## Conventions
- Demo mode (backend off) has to answer the same controls as live mode. Seeded data has no records for
  a date filter to narrow, so anything range-dependent must be scaled by hand — a widget sitting still
  while the rest of the screen moves reads as a broken filter, not as demo data. **Scale from the figure
  the widget sits beside, not from the width of the window**: a breakdown scaled by `rangeDays()` grew
  past its own seed and drew a donut claiming more calls than the card above it. `rangeDays()`
  (`lib/date-range.ts`) is for synthetic series that have no total to anchor to; anything that
  decomposes a number scales from that number (see `mockDashboardQuality`).
- The Topbar date range is a **Dashboard and Campaigns** control. Combine and Analytics are scoped to an
  explicit batch selection, not a period, so they deliberately ignore it — don't "fix" that by wiring the
  range in, and don't add a range-dependent widget to either screen.
- Never render one control per item for an unbounded collection. The campaigns pager windows through
  `pageSlots()` (`lib/pagination.ts`); a row of several hundred page buttons overflows its card with no
  way to reach what it hides.
- Client components that use hooks/state/recharts/handlers start with `"use client";`.
- Money always goes through `fmtMoney`/`fmtMoneyFull(inr, currency)` with `currency` from `useApp()`.
- Navigation: `useRouter()` from `next/navigation`; set `analyzeTargets`/`combineTargets` via `useApp()`
  before pushing to `/analytics` or `/combine`.
- This Next.js version has breaking changes vs training data — consult `node_modules/next/dist/docs/`.
