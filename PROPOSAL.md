# magick-utils — Proposal

A standalone utility tool for MagickVoice customers to **download**, **merge**, and **analyze** the
data from voice-call campaigns and messaging campaigns they've run on the platform — with charts and
AI-generated insights.

It reuses the platform's existing **auth and tenant + account principles**: customers log in with their
MagickVoice (Firebase) account, then operate within a chosen tenant/account context.

---

## 1. How it fits with the existing systems

```
                         ┌──────────────────────────────┐
  Customer  ──login──▶   │  magick-utils (this app)      │
                         │  Next.js + in-process worker  │
                         │  ── talks only to ──▶ magick-master ──▶ magic-voice-core
                         └──────────────┬───────────────┘
                                        │
                                  MongoDB Atlas
                            (durable state + job queue)
```

- **`magic-voice-core`** — the orchestrator that owns the raw data (calls, batches, messages,
  recordings, per-call analysis). Authenticates via `X-API-Key` + `x-mgkvc-tenant` + `x-mgkvc-account`.
  We do **not** talk to it directly.
- **`magick-master`** — the customer-facing platform layer. **Firebase Auth** login, multi-tenancy via
  `X-Tenant-Id` + `X-Account-Id`, RBAC, credits, and `/proxy/*` passthrough to core. **This is our only
  upstream.** It already enforces tenant isolation and membership validation, so we inherit all of it
  instead of re-implementing it.

### Decisions locked in
| Area            | Decision |
|-----------------|----------|
| Upstream API    | **magick-master** (Firebase login + tenant/account context + `/proxy/*`) |
| Hosting         | **Single long-running Node host** (Render / Railway / Fly) — Next.js + in-process background worker. **Not** Vercel serverless. |
| State           | **MongoDB Atlas** — durable; survives sessions and restarts. The `jobs` collection doubles as the work queue. |
| Long jobs       | Run **in-process** on the same host (no function time limits). |
| AI provider     | **Pluggable** — Anthropic *or* OpenAI-compatible (DeepSeek, Kimi/Moonshot, OpenRouter, self-hosted vLLM/Ollama). No hard Claude dependency. |
| Analytics depth | Deterministic stats + charts **and** AI insights / Q&A. |

> **Why not Vercel?** The AI analysis and large CSV merges are long, bursty jobs. Serverless function
> platforms (Vercel, and Supabase Edge Functions) cap single-invocation duration. A single long-running
> Node host removes that ceiling entirely and lets background work run in-process — simplest ops, one
> service. The app is still a Next.js app; it's just deployed on a Node host rather than Vercel.

---

## 2. Auth & landing flow (the tenant/account principle)

1. **Login page** — Firebase client SDK (Google / email) → obtain `id_token` → POST to our
   `/api/auth/session`, which calls magick-master `/auth/session` + `/auth/me`, then sets an **encrypted
   httpOnly session cookie**. The Firebase token never lives in browser-accessible storage.
2. **Context page** — the user types **Tenant ID** and **Account ID**. We validate them against the
   memberships returned by `/auth/me` (typo / unauthorized tenant rejected up front), store them in the
   session, and land them on the dashboard. (Membership list can pre-fill the fields; the manual-entry
   box stays.)
3. Every server route auto-injects `Authorization: Bearer <firebase_token>`, `X-Tenant-Id`,
   `X-Account-Id`. All MongoDB queries are scoped by `tenantId + accountId` — cached data is **never**
   served across tenants.

---

## 3. Features

### 3.1 Downloads / Export center
- Browse past **bulk call campaigns** (batches / `bulk-dispatch-jobs`) and **message batches**
  (WhatsApp / Telegram / Email) in a filterable table: date range, status, provider, pipeline tier.
- Per-campaign **CSV download** with a **column picker** (core's export already supports a `fields`
  list).
- CSVs are **streamed on demand** from MongoDB straight to the HTTP response — no file storage to
  manage or expire. (GridFS is a drop-in later if you want to retain generated exports.)

### 3.2 Combined CSV builder
- Multi-select several campaigns/batches **across calls *and* messages**, choose a unified column set,
  and the app assembles one merged CSV — streamed from a MongoDB cursor. On a long-running host there's
  no duration cap, so very large merges are fine.

### 3.3 Analytics & charts (calls + messages)
Deterministic, pure aggregation functions (unit-testable), rendered with **Recharts**:
- Status / outcome distributions, answer & success rates.
- Duration & talk-time histograms.
- Cost breakdown (telephony vs AI).
- Sentiment from `call_analysis.overall_sentiment`; key-topic rollups.
- Message delivery / read / bounce funnels.
- Time-series trends across a campaign or a selection.

### 3.4 AI insights & Q&A (provider-agnostic)
Runs server-side off **aggregated stats + a bounded transcript sample** (keeps tokens controlled so
smaller open models stay viable):
- **Campaign narrative** — plain-English "what happened and why".
- **Theme / topic rollup** — recurring objections/requests across transcripts.
- **Anomaly detection** — failure spikes, cost outliers, low-answer segments, with supporting numbers.
- **Recommendations** — best call windows, underperforming segments, prompt/script suggestions.
- **Cross-campaign comparison.**
- **Natural-language Q&A** over a campaign's cached aggregates + sampled transcripts.

Outputs are stored in MongoDB keyed by `{ fingerprint, model }` so re-opening is instant, and switching
models re-runs cleanly.

---

## 4. Data & job layer (MongoDB Atlas)

Connection uses the cached-client pattern (reused pool across requests). Collections:

| Collection   | Purpose |
|--------------|---------|
| `campaigns`  | Cached campaign/batch metadata + a `fingerprint` derived from the cheap `status-summary` / `bulk-dispatch-jobs` progress call + status. Finished campaigns are immutable → cached long; running ones re-ingest when the fingerprint changes. A **Refresh** action forces re-pull. |
| `records`    | Normalized call/message records, **one document per record** (avoids the 16 MB doc limit), compound-indexed on `{ tenantId, accountId, batchId }`. Powers both analytics and CSV generation. |
| `aggregates` | Precomputed stats per campaign/selection, keyed by dataset fingerprint. |
| `insights`   | AI outputs, keyed by `{ fingerprint, model }`. |
| `jobs`       | Ingestion/analysis/merge job state with a **resumable pagination cursor**. Doubles as the work queue. |

### Ingestion job
When a campaign is selected for analysis/combine, a job paginates magick-master
(`/proxy/calls?batch_id=…&limit=100&offset=…` and the messaging equivalents) to exhaustion,
**normalizing calls + messages into one common record shape**, and writes records + aggregates to Mongo.
The cursor is persisted so a multi-thousand-record pull resumes after any restart. The UI polls the job
document for progress.

### In-process worker
A background worker boots with the server (via Next.js `instrumentation.ts`, Node runtime), tails the
`jobs` collection (change streams or interval poll), and processes ingestion / AI / merge with
concurrency control. Single host = single worker; if scaled to multiple instances later, add a
leader-lock (noted, not built now).

---

## 5. Pluggable LLM layer

A provider-agnostic `LLMProvider` interface; the backend is chosen by env config:

```
LLM_PROVIDER = anthropic | openai-compatible
LLM_MODEL    = deepseek-chat | moonshotai/kimi-k2 | claude-opus-4-8 | ...
LLM_BASE_URL = https://api.deepseek.com | https://api.moonshot.ai/v1 | https://openrouter.ai/api/v1 | ...
LLM_API_KEY  = ...
```

- **`openai-compatible` adapter** (default for open models): one implementation covers DeepSeek,
  Kimi/Moonshot, OpenRouter, and self-hosted vLLM/Ollama — all speak the OpenAI Chat Completions API.
- **`anthropic` adapter** for Claude, same interface.
- **Structured output**: native JSON mode / function-calling where supported, always with a
  "return JSON matching this schema" fallback + **Zod validation and a re-ask-on-parse-failure retry**,
  so insights stay chart-ready regardless of provider.
- **No provider-only features relied upon** (e.g. Anthropic prompt caching). A small per-model
  capability map (tool-use? JSON mode? context window) tunes prompt strategy and sample size.

---

## 6. Tech stack

- **Next.js (App Router) + TypeScript**, deployed on a long-running Node host (Render / Railway / Fly).
- **Tailwind + shadcn/ui** (UI), **Recharts** (charts).
- **firebase** (client auth), **iron-session** (encrypted cookie sessions).
- **mongodb** (official driver) + **Zod** (validation).
- **papaparse** (CSV assembly), Node streams for large exports.
- LLM: **`@anthropic-ai/sdk`** and/or **`openai`** SDK (the latter points at any OpenAI-compatible base URL).
- No relational DB; MongoDB is the only persistence and all of it is derived/cacheable — magick-master /
  core remain the source of truth.

---

## 7. Directory layout

```
magick-utils/
├── instrumentation.ts            # boots the in-process background worker
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (auth)/context/page.tsx           # tenant/account entry
│   ├── (app)/dashboard/page.tsx
│   ├── (app)/campaigns/page.tsx          # browse + download + column picker
│   ├── (app)/combine/page.tsx            # combined-CSV builder
│   ├── (app)/analytics/page.tsx          # charts + AI insights + Q&A
│   └── api/
│       ├── auth/session/route.ts
│       ├── campaigns/route.ts
│       ├── ingest/route.ts               # enqueue ingestion job
│       ├── jobs/[id]/route.ts            # poll job status
│       ├── export/route.ts               # single + combined CSV (streamed)
│       ├── analytics/route.ts
│       └── insights/route.ts
├── lib/
│   ├── magick-client.ts          # typed magick-master wrapper (auth + tenant headers)
│   ├── session.ts                # iron-session cookie helpers
│   ├── firebase.ts
│   ├── db/                       # Mongo client, collections, fingerprinting, job cursor
│   ├── worker/                   # job runner (ingest / analyze / merge)
│   ├── ingest/                   # paginate + normalize calls/messages → common shape
│   ├── analytics/                # pure aggregation functions
│   ├── ai/                       # LLMProvider interface + adapters, prompts, Zod schemas
│   └── types/                    # Call, Message, Batch, NormalizedRecord
└── components/                   # tables, charts, pickers
```

---

## 8. Environment variables

```
# Upstream
MAGICK_MASTER_BASE_URL=

# Firebase web config
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
# (+ remaining Firebase web config keys)

# Session
SESSION_SECRET=

# State
MONGODB_URI=

# LLM (pluggable)
LLM_PROVIDER=openai-compatible
LLM_MODEL=
LLM_BASE_URL=
LLM_API_KEY=
```

---

## 9. Build phases

1. Project scaffold + auth (Firebase login → session) + context page + `magick-client`.
2. MongoDB layer + campaign browser + single-campaign CSV download (with column picker).
3. Ingestion job + in-process worker + job-status polling.
4. Deterministic analytics + charts.
5. Combined-CSV builder (streamed merge).
6. Pluggable LLM layer + AI insights + NL Q&A.

### Future / out-of-scope-for-now
- Full-transcript semantic search (vector index) for richer Q&A — currently scoped to aggregates +
  sampled transcripts.
- GridFS retention of generated exports.
- Multi-instance worker with leader-lock.
