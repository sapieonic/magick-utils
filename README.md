# MagickUtils

A utility tool for **MagickVoice** customers to **download, merge, and analyze** their voice-call and
messaging campaign data. It provides a workspace UI over their campaign batches plus a backend-for-frontend
(BFF) for ingestion, CSV export, analytics aggregation, and LLM-powered insights / chat.

See [`PROPOSAL.md`](./PROPOSAL.md) for the full architecture and rationale, and [`BACKEND.md`](./BACKEND.md)
for the backend design.

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** · **Tailwind v4**
- **Recharts** (charts) · **lucide-react** (icons) · `next/font` (Plus Jakarta Sans + JetBrains Mono)
- **MongoDB Atlas** for durable state · **iron-session** auth · **Firebase** login
- Provider-agnostic LLM (OpenAI-compatible: DeepSeek / Kimi / OpenRouter, or Anthropic)
- Target deploy: a **single long-running Node host** (Render / Railway / Fly) — *not* Vercel serverless —
  so long-running jobs (ingestion, CSV merge, AI analysis) can run in-process.

## Getting Started

The app runs with **zero configuration** on seeded mock data — every screen is fully functional without a
backend. To run against live data, configure the environment (see below).

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start the dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |

## Architecture

### Frontend

- `app/login`, `app/workspace` — auth + tenant/account context selection.
- `app/(app)/{dashboard,campaigns,combine,analytics}` — the four main screens, behind a workspace guard
  in `app/(app)/layout.tsx` (Sidebar + Topbar shell).
- `components/ui/` — shared design-system primitives (Card, Button, Badge, Modal, Tabs, charts…).
- `components/shell/` — Sidebar, Topbar. `components/screens/<screen>/` — per-screen pieces.
- `lib/data.ts` — the data seam: domain metadata, formatters, and seeded mock data.
- `lib/store.tsx` — `AppProvider` / `useApp()`: workspace, currency, date range, and batch-id selection.
- `lib/api.ts` — the client seam with **mock fallback**: unset env ⇒ UI runs on `lib/data.ts`; set env ⇒ live data.

### Backend (BFF)

A BFF over **magick-master**, with state in MongoDB, an in-process ingestion worker
(`instrumentation.ts` → `lib/server/worker.ts`), a pluggable LLM layer (`lib/server/llm/`), and routes under
`app/api/*` (auth, campaigns, ingest, jobs, export [streamed CSV], analytics, insights, chat [SSE]).

Everything is gated on env config and degrades gracefully — `GET /api/health` reports `{ ok, backend, llm }`.
See [`BACKEND.md`](./BACKEND.md) for module-by-module and route-by-route detail.

### Domain model

A **batch** = one bulk job's result. `selType(batch)` ∈ `ai | ivr | message` governs the hard rule:
you may only multi-select / combine / analyze-together batches of the **same selType**.

## Configuration

Copy `.env.example` → `.env.local` and fill in:

- `MAGICK_MASTER_BASE_URL`, `SESSION_SECRET` (≥32 chars) — auth
- `MONGODB_URI` — durable state
- `LLM_API_KEY`, `LLM_MODEL`, (optional) `LLM_BASE_URL` — insights / chat
- `NEXT_PUBLIC_FIREBASE_*` — web login config
- `CRON_SECRET` — shared secret guarding the scheduled cleanup endpoint (see below)

On boot, `instrumentation.ts` ensures Mongo indexes and starts the worker when the backend is configured.
See [`BACKEND.md`](./BACKEND.md) for a full local-testing walkthrough against the live (read-only) services.

### Scheduled cleanup

To keep MongoDB small enough for the Atlas free tier, a daily GitHub Actions cron
([`.github/workflows/cleanup.yml`](./.github/workflows/cleanup.yml)) calls `POST /api/cron/cleanup`, which
prunes regenerable/derived data: cached **aggregates** > 7 days, terminal (done/error) **jobs** > 1 day, and
cached **insights** > 30 days. The endpoint is guarded by a Bearer `CRON_SECRET` and no-ops (503) until both
`MONGODB_URI` and `CRON_SECRET` are set. To activate the schedule, set the app's `CRON_SECRET` env var and add
two **repository secrets** (Settings → Secrets and variables → Actions):

- `CLEANUP_URL` — the deployed endpoint URL, e.g. `https://<your-host>/api/cron/cleanup`
- `CRON_SECRET` — the same value as the app's env var

See [`BACKEND.md`](./BACKEND.md#scheduled-cleanup) for the retention rationale.

## Status

- ✅ Full UI ported from the design handoff.
- ✅ Backend V1 built (auth, ingestion worker, MongoDB layer, pluggable LLM, all BFF routes).
- ⏳ Wiring the remaining screens (dashboard, combine, analytics insights + chat) through `lib/api.ts`
  (Campaigns is wired as the reference), real Firebase login, and `.env.example` credentials.
