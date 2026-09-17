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
| `npm test` | Vitest, run once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with coverage |

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

Everything is gated on env config and degrades gracefully — `GET /api/health` reports `{ ok, backend, llm, tokenRefresh }`.
See [`BACKEND.md`](./BACKEND.md) for module-by-module and route-by-route detail.

### Domain model

A **batch** = one bulk job's result. `selType(batch)` ∈ `ai | ivr | message` governs the hard rule:
you may only multi-select / combine / analyze-together batches of the **same selType**.

## Configuration

Copy `.env.example` → `.env.local` and fill in:

- `MAGICK_MASTER_BASE_URL`, `SESSION_SECRET` (≥32 chars) — auth
- `MONGODB_URI` — durable state
- `LLM_API_KEY`, `LLM_MODEL`, (optional) `LLM_BASE_URL`, `LLM_PROJECT_ID` — insights / chat
- `NEXT_PUBLIC_FIREBASE_*` — web login config (**build-time**: inlined into the client bundle)
- `FIREBASE_API_KEY` — the same Firebase Web API key, read by the server at runtime to re-mint expiring
  ID tokens. Falls back to `NEXT_PUBLIC_FIREBASE_API_KEY` when that value is in the server's environment
  too, which is the usual case — see `.env.example`
- `CRON_SECRET` — shared secret guarding the scheduled cleanup endpoint (see below)
- `DATA_RETENTION_DAYS` — how long campaign data is kept (default `5`). **This is the limit on how far
  back the Dashboard and Analytics can look**, so raise it if customers need previous months — see
  [Scheduled cleanup](#scheduled-cleanup) for the storage trade-off.

On boot, `instrumentation.ts` ensures Mongo indexes and starts the worker when the backend is configured.
See [`BACKEND.md`](./BACKEND.md) for a full local-testing walkthrough against the live (read-only) services.

### Scheduled cleanup

To keep MongoDB small enough for the Atlas free tier, a daily GitHub Actions cron
([`.github/workflows/cleanup.yml`](./.github/workflows/cleanup.yml)) calls `POST /api/cron/cleanup`, which
enforces a retention window — `DATA_RETENTION_DAYS`, default five — for batches and their normalized
records, jobs, cached aggregates and cached insights, and reclaims any superseded record revisions the
ingestion worker did not — both the ones a clean publish retired and the ones a crash left with no
retirement marker at all (those are unreachable duplicates, so they are not on the retention clock).
The endpoint is guarded by a Bearer
`CRON_SECRET` and no-ops (503) until both `MONGODB_URI` and `CRON_SECRET` are set. The workflow runs for the `production` and `dedicated` GitHub
Environments. Configure the following under each environment's secrets and variables:

- `CLEANUP_URL` — an environment variable containing the deployed endpoint URL, e.g.
  `https://<your-host>/api/cron/cleanup`
- `CRON_SECRET` — an environment secret with the same value as that deployment's app env var

See [`BACKEND.md`](./BACKEND.md#scheduled-cleanup) for the retention rationale, and
[`docs/runbooks/storage-recovery.md`](./docs/runbooks/storage-recovery.md) for what to do when a
cluster has already filled up.

## Status

- ✅ Full UI ported from the design handoff.
- ✅ Backend V1 built (auth, ingestion worker, MongoDB layer, pluggable LLM, all BFF routes).
- ✅ All four screens wired through `lib/api.ts` (Campaigns, Dashboard, Combine, Analytics), real
  Firebase login, and `.env.example` credentials. Unset env still falls back to the seeded demo data.
- ✅ Token refresh. A Firebase ID token lives **one hour** under an eight-hour session cookie; it is now
  re-minted from a stored refresh token in three independent places — the browser, `getTenantContext()`
  on every route, and the ingestion worker mid-job — so nobody is bounced to `/login` mid-session and a
  long ingest no longer dies at the hour mark. Needs a Firebase Web API key the *server* can read
  (`FIREBASE_API_KEY`, falling back to `NEXT_PUBLIC_FIREBASE_API_KEY`); with neither, sessions still
  work but expire with the ID token. See [`BACKEND.md`](./BACKEND.md#token-refresh).
- ⏳ A **service credential** for background jobs, which would decouple ingestion from any user's session
  entirely — it needs a magick-master-side change, so it is tracked separately (see
  [`BACKEND.md`](./BACKEND.md) → *Known V1 tradeoffs*). Prettier batch ids and GridFS export retention
  are likewise deferred.
