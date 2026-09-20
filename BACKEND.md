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
`MONGODB_URI`, the `LLM_*` set, the `NEXT_PUBLIC_FIREBASE_*` web config, and `FIREBASE_API_KEY`
(the same key, readable server-side at runtime — see *Token refresh* below; without it sessions
still work but die after an hour). On boot, `instrumentation.ts` ensures Mongo indexes and starts
the worker when the backend is configured.

## Server modules (`lib/server/`)
- `env.ts` — typed config + the `*Configured` flags.
- `types.ts` — contracts: `TenantContext`, `BatchDoc`, `NormalizedRecord`, `Job`, `AggregatesDoc`, `Insight`.
- `session.ts` — iron-session cookie; `getTenantContext()` (null when not logged in / unconfigured, and
  the one place a stored ID token is refreshed before use — see *Token refresh*).
- `firebase-token.ts` — exchanges a Firebase refresh token for a fresh ID token via Google's
  secure-token endpoint; classifies a failure as permanent (re-login) or transient (retry).
- `magick-client.ts` — typed magick-master client (`authSession`/`authMe`, `MagickClient` — which also
  re-mints and retries once on a 401, see *Token refresh* — with
  `listCalls`/`listIvrCalls`/`listStaticCalls`/`listMessages`, `listBulkJobs`, `statusSummary`,
  `batchAnalytics`, `exportCallsCsv`). `JOB_LIST_SURFACE` is the per-`dispatch_type` table the worker
  uses to pick a path and a row key (see *Job-scoped list surfaces*).
- `normalize.ts` — core call/message → `NormalizedRecord`; `buildBatchDoc`; dispatch-type mapping.
- `map.ts` — `BatchDoc` ↔ frontend `Batch`; bulk-job → `BatchDoc`. **Batch is keyed by the upstream source id.**
- `db.ts` / `repositories.ts` — cached Mongo client, collections, indexes, tenant-scoped repo functions.
- `aggregate.ts` — compute analytics aggregates from records.
- `call-analysis.ts` — fills the Conversation tab's Sentiment and Key topics from core's rollup,
  because the records cannot carry them (see *Sentiment and key topics* below).
- `fingerprint.ts` — stable hashes for cache keys / change detection.
- `llm/` — `getLLM()` factory + `OpenAICompatibleProvider` (DeepSeek/Kimi/OpenRouter/vLLM/Ollama) and
  `AnthropicProvider`; `complete`/`stream`/`structured` (Zod-validated, retry-on-parse-fail). `INSIGHT_SCHEMA`.
- `worker.ts` — tails the `jobs` collection; ingest/merge jobs paginate magick-master, normalize, persist
  records, rebuild the `BatchDoc`. Resumable progress via `Job.done`/`cursor`.

### Token refresh

A Firebase ID token lives **one hour**; the session cookie lives eight. That gap was a live bug, not a
theoretical one: for seven of every eight hours the cookie carried a credential magick-master had
already stopped accepting, so `/campaigns` 401'd and bounced the user to `/login` mid-session, and any
ingest still running an hour after login died and **discarded its staged revision**.

The credential is now refreshed instead of being allowed to expire under a longer-lived cookie. Four
places cooperate, and they are deliberately independent so that losing one degrades rather than breaks:

1. **The browser** (`components/SessionRefresher.tsx`, mounted in `app/(app)/layout.tsx`) keeps a
   Firebase `onIdTokenChanged` subscription alive and re-posts each new token to `POST /api/auth/refresh`.
   This matters more than it looks: `lib/firebase.ts` used to be imported *only* by `app/login/page.tsx`,
   so outside `/login` no `Auth` object existed and the SDK's own refresh scheduler never ran at all.
   A `visibilitychange` check covers the sleeping-laptop case, where no timer fires for hours.
2. **Every route handler**, via `getTenantContext()`. It re-mints a near-expired token from the stored
   refresh token before handing it to any caller. This is why campaigns, ingest, export and analytics
   all inherit the fix with no per-route logic — and why reaching into `session.idToken` directly is a
   bug that reintroduces the one-hour cliff. The **one** legitimate exception is `/api/accounts`, which
   runs before a workspace is chosen and so has no tenant/account for `getTenantContext()` to return;
   it uses `getFreshIdToken()` instead. That route was the last screen still on the cliff — a user who
   idled an hour, came back to a working dashboard and clicked "Switch workspace" was bounced by the
   account cascade alone.
3. **`MagickClient` itself**, which on a magick-master 401 mints a replacement and retries the call
   **once**. This catches the case the freshness check cannot: revoking a user kills the refresh token
   while the ID token still has minutes left on it, so nothing looks stale until upstream refuses it.
   Routes pass `onCredentialRefresh: persistRefreshedCredential` so a rotated refresh token reaches the
   cookie instead of living only in that request's memory.
4. **The ingestion worker**, which carries the refresh token on the job so a long run can re-mint
   mid-flight rather than dying at the hour mark. It mints *pre-flight* too: a job resumed after a
   deferral or a host restart is holding the token from whichever request enqueued it.

`firebase-token.ts` splits failures the same way `call-analysis.ts` splits settled from momentary, and
for the same reason: a **transient** failure (5xx, network, timeout) must keep the session and retry —
Google being briefly unreachable must not sign everyone out — while a **permanent** one (`TOKEN_EXPIRED`,
`USER_DISABLED`, `USER_NOT_FOUND`, `INVALID_REFRESH_TOKEN`, `MISSING_REFRESH_TOKEN`) clears the session,
because retrying a revoked credential forever is worse than asking for a login. A permanent refusal that
surfaces inside a route is mapped to `401 session_expired` rather than a generic 502 — the client only
reacts to a 401, so anything else leaves the user staring at an error with a dead cookie nobody clears. An *unrecognised* 400 is treated as
transient on purpose: guessing "permanent" wrongly signs a working user out.

Notes for anyone changing this:
- **The refresh token is a long-lived credential at rest.** Unlike the ID token it does not expire, so
  a job must not keep one a moment longer than it needs it. `updateClaimedJob(..., { clearCredential })`
  `$unset`s both tokens in the *same atomic write* that ends a job, so a thirty-second merge does not
  leave a standing credential behind; the retention sweep (`deleteJobsOlderThan`, bounded by
  `DATA_RETENTION_DAYS`) is the **backstop** for jobs that never reach a terminal state, not the primary
  eraser. Treat it as a backstop with real gaps: it runs only from the external cron
  (`POST /api/cron/cleanup`, which 503s unless `CRON_SECRET` is set), and there is no TTL index on
  `jobs` to catch what the cron misses — `createdAt` is an ISO *string*, and Mongo TTL indexes act only
  on BSON `Date`.
- **`REDACT_PATHS` (`logger.ts`) keeps it out of log storage**, and is load-bearing for the same reason.
  Mind the caveat the file itself states: pino wildcards are single-segment, so `*.refreshToken` does
  **not** cover a nested `context.job.refreshToken`. Nothing logs a whole `Job` or `TenantContext`
  today; if you add such a call site, the redaction will not save you.
- **Cookie budget.** iron-session *throws* above 4096 bytes. The session already holds an ID token
  (~1KB), the refresh token, and a `tenants[]` array with nested accounts. `getTenantContext()` and
  `/api/auth/refresh` therefore tolerate a failed save rather than letting one oversized cookie 500
  every screen; login cannot tolerate it and reports `session_too_large` rather than blaming
  magick-master for a cookie this app could not write.
- **`ttl`, not `cookieOptions.maxAge`.** Setting `maxAge` yourself takes an iron-session branch that
  leaves `ttl` at its 14-day default and derives neither value from the other — which left the seal
  replayable for ~13 days after the browser dropped the cookie. Passing `ttl` alone derives
  `maxAge = ttl - 60`.
- **A paused job carries `deferReason`.** `rate_limited` is reused as the "alive, paused, resume at
  `retryAt`" status for both throttling and an expired credential, because the scheduler treats them
  identically — but the customer must not. Combine reads `deferReason` to choose between "the upstream
  is throttling us, just wait" and "your sign-in expired; sign in again and reopen this screen". Only
  the second is actionable, and telling a signed-out user to wait sends them away from the one thing
  that rescues the merge.

### Sentiment and key topics

**These two series do not come from the ingested records, and cannot.** Everything else on the
Analytics → Conversation tab is derived from `NormalizedRecord`s pulled from magick-master's
`/proxy/calls` → core's calls LIST. That list projects a column subset which deliberately excludes the
heavy `call_analysis` JSONB, and core's formatter emits `call_analysis: null` rather than omitting the
key — so from here every call in the fleet is indistinguishable from a call whose analysis never ran.
`normalizeCall` writes `sentiment: null` / `keyTopics: null` on every record and both cards render
their empty state, while duration and talk-time (ordinary list columns) render fine. The analysis
itself completes normally upstream; this is purely a read-path projection gap.

`call-analysis.ts` therefore asks the one endpoint that can see the blob:
`POST /bulk-dispatch-jobs/analytics` on magick-master, which fans out to core's
`/calls/batch-analytics` and aggregates both series in SQL straight off `call_analysis`. Core computes
over the union of the selection's batches in one query, so the result is exact rather than N per-batch
top-10s merged approximately here. Notes:

- **AI selections only.** IVR and messaging runs have no conversation to analyse, and magick-master
  rejects a non-`ai_voice_call` job id with a 400 rather than an empty rollup.
- **Selection-scoped rollups, not per-record fields.** They cannot reach the CSV export or anything
  else reading a `NormalizedRecord`. Closing that needs core to project the two values as scalars onto
  the calls list — which it already does for the WebRTC dialer list (`analysis_sentiment_label` in
  `WEBRTC_LIST_COLUMNS`), just not for AI calls. The enrichment only ever fills an **empty** series, so
  when that lands the per-record numbers win and this becomes a no-op.
- **Best-effort. Cacheability tracks "would asking again help?", not "did the call succeed?".**
  Those come apart both ways. A momentary failure (5xx, timeout, 401, 429) is `cacheable: false`:
  the cache key is a fingerprint of the batch set and its dataset, neither of which moves because a
  downstream call failed, so a cached blank would outlive the outage and only Refresh could clear it.
  A *settled* refusal (400 for a dispatch type with no analysis, 404 for a job upstream no longer
  has) is `cacheable: true`: it says the same thing on every retry, and marking it uncacheable would
  stop the whole aggregates doc — every other series on the screen — from ever being cached for that
  selection, forcing a full recompute from Mongo on every request.
- **Either way the doc is marked `analysisUnavailable: true`**, so the Conversation tab says "couldn't
  load" instead of asserting the records carry no AI analysis. The two look identical on screen; only
  one of them is a fact about the customer's data.
- **Bump `AGGREGATES_VERSION` (`lib/server/fingerprint.ts`) whenever this changes.** `/api/analytics`
  serves a cache hit *before* enrichment runs, so without a bump every selection analysed before the
  deploy keeps serving its old empty doc until someone clicks Refresh or retention prunes it. The two
  **insight** caches must react to that bump too, or their prose contradicts the chart beside it:
  `/api/insights` stores the aggregates key as the Insight's `fingerprint` and rejects a hit that no
  longer matches, and `compareKey` folds the version in directly (a comparison's `fingerprint` is its
  own key, so it cannot carry the signal). Neither route persists a narrative built while the rollup
  was unreadable.
- **A settled refusal is an allow-list (`400`, `404`, `422`), not a 4xx range.** `408` is a 4xx about
  *this moment* and must stay momentary. `404` qualifies only because `fetchRollup` runs first: master
  404s the whole request when any one `job_id` is unknown and names them in `missing_job_ids`, so those
  are dropped and the rest re-asked once — one deleted campaign no longer blanks the tab for the other
  49 in a selection. A 404 that reaches the classifier therefore means the endpoint is absent or *no*
  selected job still exists.
- **A 2xx that contradicts its declared shape is momentary, not empty.** An absent or null field is a
  legitimately empty rollup; a field present but not an array is upstream breaking contract, and the
  mappers coerce it to `[]` — which must not be cached as a real "no analysis".
- **Every batch must carry a `sourceId`.** The upstream ids are `sourceId`, not `batchId`. If any is
  blank the enrichment refuses rather than silently asking about a subset and presenting it as the
  whole selection.
- **The call is the only timed-out one in `magick-client.ts`** (15s). It is the heaviest — master fans a
  whole selection's batches into one core request, answered with eleven parallel aggregate queries —
  and the only one whose caller holds a correct answer to fall back on.
- Applied at all four aggregate-computing routes (`analytics`, `insights`, `insights/compare`, `chat`)
  so the AI prose can never contradict the chart beside it.
- Upstream caps the request at 50 job ids, which is exactly `MAX_SELECTION_BATCHES`.
- **Known gap:** `normalizeCall` reads only the modern `call_analysis.common.*` shape, while core's
  rollup SQL also COALESCEs a legacy top-level shape. Moot while the list carries no blob, but it
  means the "record values win once core projects them" plan above would be correct by accident on
  legacy-shaped rows. Fix `normalize.ts` alongside that core change, not before.

### Job-scoped list surfaces

magick-master's `/proxy/*` list routes each serve **one** `dispatch_type`, and core names the row
array differently per route. After master's "scope every job-scoped read to the campaign it names"
change, a `job_id` on the wrong surface is a **400** with `details` (it used to be a silent empty
`calls` page, which looked like "this campaign has no records"). The ingestion worker is the only
production list caller. Combine / Analytics / CSV export read Mongo.

| `dispatch_type` | path | row key |
|-----------------|------|---------|
| `ai_voice_call` | `/proxy/calls` | `calls` |
| `static_call` | `/proxy/static-calls` | `calls` |
| `ivr_call` | `/proxy/ivr-calls` | `sessions` |
| `whatsapp_message` / `telegram_message` / `email_message` | `/proxy/messaging/messages` | `messages` |

`selType` cannot choose a surface: it collapses `ivr_call` and `static_call` into `"ivr"`. The worker
therefore reads `dispatch_type` from the job payload (`getBulkJob`), then `BatchDoc.dispatchType`
(stamped by the campaigns listing), then infers from `selType`+`channel` only when that is
unambiguous. An IVR/static batch with no stored type **throws** rather than falling through to
`/proxy/calls`. Resume fetches the job for this reason even though it still withholds the
`ingestedSourceUpdatedAt` stamp until offset 0.

Always send `job_id` (`BatchDoc.sourceId`). Dropping it to dodge a type-mismatch 400 would list the
whole account, which is the bug master's guard exists to prevent. `batch_id` is only the fallback
for a broken BatchDoc that has no `sourceId`. Messaging used to stuff the bulk-job id into
`batch_id`; those are different filters (core batch UUIDs vs job ids) and matched nothing.

IVR session rows use `id` / `phone` / flat timestamps, not `call_id` / `recipient_phone` / nested
`timestamps`. `normalizeCall` accepts both; a page of real `sessions` that failed as "no record id"
would otherwise look like an empty dispatched pull.

`limit` is 1–100; the worker's `PAGE_SIZE` is already 100. CSV `Content-Disposition` is RFC 6266 —
unused here, because export is Mongo.

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
- ~~The caller's Firebase ID token is stored on ingest jobs — revisit with refresh tokens.~~ **Done**:
  jobs now carry a refresh token and re-mint mid-run (see *Token refresh*). What remains deferred is a
  **service credential** for background jobs, which would decouple ingestion from any user's session
  entirely; it needs a magick-master-side change, so it is tracked separately.
- Batch id = upstream source id (a UUID) for key consistency; `humanBatchId()` exists for a prettier
  display id later.
- `statusSummary` proxy path is best-effort (tolerates 404). Fingerprints currently recompute from
  ingested counts. CSV export requires prior ingestion (no on-the-fly proxy passthrough yet).
- The provider and model are fully backend-controlled via `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_BASE_URL`.
