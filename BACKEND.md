# Backend (V1)

A backend-for-frontend (BFF) over **magick-master**, with durable state in **MongoDB**, an in-process
**ingestion worker**, and a **provider-agnostic LLM** layer. Designed for a single long-running Node host
(Render/Railway/Fly), not serverless. See `PROPOSAL.md` for rationale.

## Graceful degradation
Everything is gated on env config. With nothing set, the app runs on seeded **mock data** and the UI is
fully functional. `GET /api/health` → `{ ok, backend, llm }` reports what's live. The client seam
`lib/api.ts` falls back to `lib/data.ts` whenever `backend`/`llm` is false.

Flags (`lib/server/env.ts`): `isAuthConfigured` (magick-master + SESSION_SECRET), `isBackendConfigured`
(+ MONGODB_URI), `isLlmConfigured` (LLM_API_KEY + LLM_MODEL).

## Configure
Copy `.env.example` → `.env.local` and fill in `MAGICK_MASTER_BASE_URL`, `SESSION_SECRET`,
`MONGODB_URI`, the `LLM_*` set, and the `NEXT_PUBLIC_FIREBASE_*` web config. On boot,
`instrumentation.ts` ensures Mongo indexes and starts the worker when the backend is configured.

## Server modules (`lib/server/`)
- `env.ts` — typed config + the `*Configured` flags.
- `types.ts` — contracts: `TenantContext`, `BatchDoc`, `NormalizedRecord`, `Job`, `AggregatesDoc`, `Insight`.
- `session.ts` — iron-session cookie; `getTenantContext()` (null when not logged in / unconfigured).
- `magick-client.ts` — typed magick-master client (`authSession`/`authMe`, `MagickClient` with
  `listCalls`/`iterateCalls`, messages, `listBulkJobs`, `statusSummary`, `exportCallsCsv`).
- `normalize.ts` — core call/message → `NormalizedRecord`; `buildBatchDoc`; dispatch-type mapping.
- `map.ts` — `BatchDoc` ↔ frontend `Batch`; bulk-job → `BatchDoc`. **Batch is keyed by the upstream source id.**
- `db.ts` / `repositories.ts` — cached Mongo client, collections, indexes, tenant-scoped repo functions.
- `aggregate.ts` — compute analytics aggregates from records.
- `fingerprint.ts` — stable hashes for cache keys / change detection.
- `llm/` — `getLLM()` factory + `OpenAICompatibleProvider` (DeepSeek/Kimi/OpenRouter/vLLM/Ollama) and
  `AnthropicProvider`; `complete`/`stream`/`structured` (Zod-validated, retry-on-parse-fail). `INSIGHT_SCHEMA`.
- `worker.ts` — tails the `jobs` collection; ingest/merge jobs paginate magick-master, normalize, persist
  records, rebuild the `BatchDoc`. Resumable progress via `Job.done`/`cursor`.

## API routes (`app/api/`)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/health` | GET | config status |
| `/api/auth/session` | POST `{idToken}` | exchange Firebase token → store session, return tenants |
| `/api/auth/context` | POST `{tenantId,accountId}` | select workspace (validated vs memberships) |
| `/api/auth/me` | GET | current session/user/context |
| `/api/auth/logout` | POST | destroy session |
| `/api/campaigns` | GET | list batches (bulk-dispatch jobs → BatchDocs) |
| `/api/ingest` | POST `{batchIds,type?}` | enqueue ingest/merge job → `{jobId,total}` |
| `/api/jobs/[id]` | GET | job status/progress (idToken stripped) |
| `/api/export` | GET/POST `{batchIds,columns}` | streamed CSV from Mongo records (409 if not ingested) |
| `/api/analytics` | POST `{batchIds,refresh?}` | compute/cache aggregates (409 if not ingested) |
| `/api/insights` | POST `{batchIds,refresh?}` | LLM insight, cached by fingerprint + configured `LLM_MODEL` |
| `/api/chat` | POST `{batchIds,message,history?}` | SSE-streamed grounded Q&A |
| `/api/cron/cleanup` | POST | prune stale data (Bearer `CRON_SECRET`); returns `{deleted}` counts |

Typical flow: log in → pick workspace → `GET /api/campaigns` → `POST /api/ingest` for a selection →
poll `GET /api/jobs/:id` → then `analytics` / `insights` / `export` work against the ingested records.

## Scheduled cleanup
`POST /api/cron/cleanup` prunes regenerable/derived data so the MongoDB Atlas free tier stays small:
cached **aggregates** > 7 days (recomputed on next analytics request), terminal (done/error) **jobs** >
1 day (live jobs are untouched; this also clears their stored idTokens), and cached **insights** > 30 days
(regen costs an LLM call, hence the longer window). `records` and `batches` are left alone — `records` is
the largest collection but dropping it forces a re-ingest, so it needs a separate usage-based policy.

The endpoint runs without a user session, guarded by a shared Bearer secret (`CRON_SECRET`). It's driven
by a daily GitHub Actions cron (`.github/workflows/cleanup.yml`), which needs two repo secrets: `CLEANUP_URL`
(the deployed endpoint URL) and `CRON_SECRET` (matching the app's env). Returns 503 until both `MONGODB_URI`
and `CRON_SECRET` are configured.

## Client seam (`lib/api.ts`)
`listCampaigns`, `createIngestJob`, `getJob`, `getAnalytics`, `generateInsights`, `streamChat`,
`downloadCsvUrl`, `backendStatus`. Each no-ops to mock when the backend/LLM is off. **All four screens**
(Campaigns, Dashboard, Combine, Analytics) now consume this seam — each falls back to `lib/data.ts`
mock/canned output when the backend/LLM is off.

## Local testing against the live (read-only) services
1. `cp .env.example .env.local` and fill: `MAGICK_MASTER_BASE_URL`, `SESSION_SECRET` (≥32 chars),
   `MONGODB_URI`, the `LLM_*` set. Optionally `NEXT_PUBLIC_FIREBASE_*` for a real Google/email login.
2. `npm run dev`, then open `/login`. `GET /api/health` should report `{backend:true, llm:true}`.
3. **Authenticate** (to get a session cookie):
   - If `NEXT_PUBLIC_FIREBASE_*` is set → use **Continue with Google** or email/password (real Firebase).
   - Otherwise → expand **“Sign in with a Firebase ID token (testing)”**, paste a valid Firebase ID
     token (grab one from the real MagickVoice app's DevTools, or via the Firebase CLI), → **Use ID token**.
4. On `/workspace`, the dropdown is populated from your real tenants (`/auth/me`). Pick a tenant and its
   **accounts cascade in** (fetched from magick-master `GET /accounts` via `/api/accounts?tenantId=`) — a
   sole account auto-selects, several open a picker, and manual entry still works if none come back. →
   **Continue** (calls `/api/auth/context`, which magick-master membership-checks).
5. `/campaigns` now lists your real bulk-dispatch jobs (read-only).
6. The other screens (dashboard / combine / analytics) still read mock data until wired (next iterate).
   You can exercise the rest of the pipeline directly with the session cookie, e.g.:
   ```bash
   # after logging in via the browser, copy the mu_session cookie, then:
   curl -s localhost:3000/api/ingest -X POST -H 'Content-Type: application/json' \
        -H 'Cookie: mu_session=...' -d '{"batchIds":["<sourceId>"]}'
   curl -s localhost:3000/api/jobs/<jobId> -H 'Cookie: mu_session=...'
   curl -s localhost:3000/api/analytics -X POST -H 'Content-Type: application/json' \
        -H 'Cookie: mu_session=...' -d '{"batchIds":["<sourceId>"]}'
   curl -s localhost:3000/api/insights -X POST -H 'Content-Type: application/json' \
        -H 'Cookie: mu_session=...' -d '{"batchIds":["<sourceId>"]}'
   curl -s 'localhost:3000/api/export?batchIds=<sourceId>'  -H 'Cookie: mu_session=...'
   ```
   (Everything is read-only against magick-master; only our own Mongo is written.)

## Known V1 tradeoffs (iterate later)
- The caller's Firebase ID token is stored on ingest jobs so the worker can act on their behalf — fine
  for an internal tool; revisit with refresh tokens / a service credential for long-running jobs.
- Batch id = upstream source id (a UUID) for key consistency; `humanBatchId()` exists for a prettier
  display id later.
- `statusSummary` proxy path is best-effort (tolerates 404). Fingerprints currently recompute from
  ingested counts. CSV export requires prior ingestion (no on-the-fly proxy passthrough yet).
- The provider and model are fully backend-controlled via `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_BASE_URL`.
