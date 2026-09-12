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

### Batch freshness (`BatchDoc.ingestStatus`)
`none` → `ingesting` → `ready`, with `error` on failure. A published revision is also readable as
**`stale`**: upstream's job summary has moved since the revision was ingested, but that revision is
complete and is still what every reader sees. Stale batches therefore serve analytics, exports and the
dashboard normally, and keep their ingested figures — including the record total. Resetting them to
`none` instead made the record count flip between page loads, 409'd the next analytics call, and drove a
full duplicate re-ingest on every campaigns listing.

Freshness is decided by comparing `sourceFingerprint` (the current upstream summary, via
`bulkJobSourceFingerprint`) with `ingestedSourceFingerprint` (what the published revision was built
from). The fingerprint deliberately excludes the job's `updated_at`, which upstream bumps without any
record changing. The comparison is against what was *ingested*, not against the previous listing, so a
source that moves and moves back resolves to "ready" rather than latching stale.

**Deciding whether to re-pull is a different question and uses a different signal.** That fingerprint is
one-directional: a change proves the source moved, but no change proves nothing, because
`status_summary` and `call_status_counts` are call-dispatch-only and no summary field moves for message
receipts, replies, or post-call AI enrichment. So `POST /api/ingest` with `refresh: true` skips a batch
only when `bulkJobIsUnchangedSince` holds — the job has reached a terminal status AND its `updated_at`
matches `ingestedSourceUpdatedAt`, stamped from the same endpoint before the last pull began. Anything
unproven is re-pulled: redundant work is self-cleaning, silently serving stale data is not.

Because the two signals are different, they can disagree, and one direction deadlocks: the listing marks
a batch `stale` while `updated_at` stands still, so the skip fires, nothing is pulled, and the batch
stays latched `stale` with no click able to clear it. A batch already flagged `stale` is therefore never
skipped — that flag is positive evidence the source moved, so there is nothing left to decide.

For the same reason the worker stamps `ingestedSourceFingerprint` from the *listing's* view of the job
(`batch.sourceFingerprint`) rather than from the detail payload it fetches for `ingestedSourceUpdatedAt`.
A fingerprint is only comparable with another of the same shape, and `/bulk-dispatch-jobs` and
`/bulk-dispatch-jobs/{id}` need not agree on their summary fields; stamping a detail-derived value would
mark every batch `stale` on the very next listing, forever. Being one listing behind is the safe
direction: a change that lands mid-ingestion shows up as `stale` next listing, and that refresh is no
longer skippable.

## API routes (`app/api/`)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/health` | GET | config status |
| `/api/auth/session` | POST `{idToken}` | exchange Firebase token → store session, return tenants |
| `/api/auth/context` | POST `{tenantId,accountId}` | select workspace (validated vs memberships) |
| `/api/auth/me` | GET | current session/user/context |
| `/api/auth/logout` | POST | destroy session |
| `/api/campaigns` | GET `?range=`\|`?ids=` | list batches (bulk-dispatch jobs → BatchDocs) |
| `/api/ingest` | POST `{batchIds,type?}` | enqueue ingest/merge job → `{jobId,total}` |
| `/api/jobs/[id]` | GET | job status/progress (idToken stripped) |
| `/api/export` | GET/POST `{batchIds,columns}` | streamed CSV from Mongo records (409 if not ingested) |
| `/api/analytics` | POST `{batchIds,refresh?}` | compute/cache aggregates (409 if not ingested) |
| `/api/insights` | POST `{batchIds,refresh?}` | LLM insight, cached by fingerprint + configured `LLM_MODEL` |
| `/api/chat` | POST `{batchIds,message,history?}` | SSE-streamed grounded Q&A |
| `/api/cron/cleanup` | POST | prune stale data (Bearer `CRON_SECRET`); returns `{deleted}` counts |

`/api/campaigns` has two modes. `?range=` (or no param, meaning All time) lists the account by paging
upstream bulk-dispatch jobs, capped at `MAX_BULK_JOBS_SCANNED` and reporting `truncated` when it stops
early — that flag must be surfaced, or a capped listing reads to the customer as deleted data. `?ids=`
resolves a known selection directly instead, with no scan and no truncation; Analytics uses it, since
listing thousands of jobs to name a handful of selected ones was both slow and, once truncated, made
live campaigns look deleted. An id the upstream no longer has is simply absent from the response.

Typical flow: log in → pick workspace → `GET /api/campaigns` → `POST /api/ingest` for a selection →
poll `GET /api/jobs/:id` → then `analytics` / `insights` / `export` work against the ingested records.

## Scheduled cleanup
`POST /api/cron/cleanup` enforces a retention window across persisted application data so the MongoDB
Atlas free tier stays small. The window is `DATA_RETENTION_DAYS` (default 5) and covers cached
**aggregates**, all **jobs**, cached **insights**, and every source **batch** older than the window
together with all normalized **records** owned by that batch. The batch's immutable upstream creation
date is the retention clock, so listing campaigns again cannot extend the lifetime of old data.

**This window is also the product limit on history.** Campaigns older than it are gone, so the Dashboard
and Analytics cannot show "previous months" until it is raised. Raising it costs storage roughly in
proportion, so size it against the cluster the deployment actually has.

Retired **record revisions** are not on that clock. Each ingestion stages a complete new copy of a
batch's records under a fresh revision and publishes it atomically; the superseded copy is unreachable
from that moment on. Reclaiming it waits out `SUPERSEDED_REVISION_GRACE_MS` — the window in which a
reader may already have resolved the old pointer, sized to outlast a slowly-drained CSV export, not
just a query. So the worker does two passes: on publish it reclaims copies left by *earlier* ingestions
of the same batch (already past the window), and it schedules a second pass for the copy it just
superseded. This endpoint is the backstop for anything a restart cut short.

A restart can also leave rows that never receive the marker at all — a revision
orphaned when the process died between publishing and retiring, or a staging revision abandoned
mid-ingestion. Those are invisible to the marker-based sweep, so the worker clears them per batch
before it stages (`deleteOrphanedRecordRevisions`), sparing the published revision and its own
staging one. The cron runs the same reclamation across every batch
(`deleteOrphanedRecordRevisionsEverywhere`, reported as `orphanedRevisions`), so a batch that is never
ingested again does not hold its orphan until the batch itself ages out. That pass chunks its query by
batch and spares each batch's `publishedRevision` and in-flight `ingestJobId`; the bound matters, since
the unbounded exclusion list it replaced could exceed MongoDB's 16 MB command limit and fail the whole
cleanup.

Reclamation keys on the `retiredAt` marker alone. Only `retireBatchRevision` sets it, and it refuses to
mark a batch's current `publishedRevision`; revision ids are job ids and are never reused, so a marked
row can never become readable again. Holding these duplicates for days instead is what previously let
repeated "Refresh data" clicks exhaust the cluster's storage for every tenant.

The endpoint runs without a user session, guarded by a shared Bearer secret (`CRON_SECRET`). It's driven
by a daily GitHub Actions cron (`.github/workflows/cleanup.yml`) for the `production` and `dedicated`
GitHub Environments. Each environment needs a `CLEANUP_URL` environment variable (the deployed endpoint
URL) and a `CRON_SECRET` environment secret (matching that deployment's app env). Returns 503 until both
`MONGODB_URI` and `CRON_SECRET` are configured.

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
6. Dashboard, Combine and Analytics are live too — all four screens read through `lib/api.ts`.
   You can also exercise the pipeline directly with the session cookie, e.g.:
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
