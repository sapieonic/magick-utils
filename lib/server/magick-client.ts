// Typed HTTP client for the magick-master backend (customer-facing platform layer
// that proxies to magic-voice-core). Two flavors of request:
//   - auth calls: just an Authorization: Bearer <id_token> header
//   - data calls: Bearer + X-Tenant-Id + X-Account-Id
//
// Pure server module — no React. Uses the global fetch. Raw upstream payloads are
// described with lightweight `Raw*` interfaces; we stay defensive because upstream
// fields may be absent. Non-2xx responses throw a typed MagickApiError.

import { env, isAuthConfigured, isTokenRefreshConfigured } from "@/lib/server/env";
import { mintIdToken, type MintedToken } from "@/lib/server/firebase-token";
import type { TenantContext } from "@/lib/server/types";
import { log } from "@/lib/server/logger";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown on any non-2xx response from magick-master. Carries the HTTP status
 *  and the raw response body (text) for diagnostics. */
export class MagickApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;
  readonly retryAfterMs: number | null;

  constructor(status: number, body: string, url: string, retryAfter: string | null = null) {
    super(`magick-master ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = "MagickApiError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

// ---------------------------------------------------------------------------
// Raw upstream payload shapes (lightweight; everything optional/defensive)
// ---------------------------------------------------------------------------

export interface RawSentiment {
  label?: string | null;
  score?: number | null;
}

export interface RawConversationQuality {
  [key: string]: unknown;
}

export interface RawCallAnalysisCommon {
  overall_sentiment?: RawSentiment | null;
  key_topics?: string[] | null;
  conversation_quality?: RawConversationQuality | null;
  summary?: string | null;
}

export interface RawCallAnalysis {
  common?: RawCallAnalysisCommon | null;
  custom?: Record<string, unknown> | null;
}

export interface RawConversationTurn {
  role?: string | null;
  content?: string | null;
  timestamp?: string | null;
}

export interface RawCallTimestamps {
  queued_at?: string | null;
  initiated_at?: string | null;
  answered_at?: string | null;
  ended_at?: string | null;
}

export interface RawCall {
  call_id?: string | null;
  batch_id?: string | null;
  status?: string | null;
  outcome?: string | null;
  recipient_phone?: string | null;
  recipient_name?: string | null;
  recipient_language?: string | null;
  duration_seconds?: number | null;
  talk_time_seconds?: number | null;
  conversation_summary?: string | null;
  recording_url?: string | null;
  ai_pipeline?: string | null;
  telephony_provider?: string | null;
  telephony_cost_inr?: number | null;
  ai_cost_inr?: number | null;
  total_cost_inr?: number | null;
  direction?: string | null;
  timestamps?: RawCallTimestamps | null;
  conversation_log?: RawConversationTurn[] | null;
  analysis_status?: string | null;
  call_analysis?: RawCallAnalysis | null;
  created_at?: string | null;
  // IVR / static-call extras we tolerate but don't strictly type
  dtmf_input?: string | null;
  ivr_path?: string | null;
  completed_node?: string | null;
  [key: string]: unknown;
}

export interface RawMessage {
  id?: string | null;
  batch_id?: string | null;
  to_phone?: string | null;
  to_email?: string | null;
  from_phone?: string | null;
  template_name?: string | null;
  status?: string | null;
  wamid?: string | null;
  message_id?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  failed_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  reply_text?: string | null;
  provider?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface RawBulkJob {
  id?: string | null;
  name?: string | null;
  dispatch_type?: string | null;
  status?: string | null;
  total_contacts?: number | null;
  /** Per-call status counts (status → count) for the job's batches, enriched live
   *  from core by magick-master. Present only for call dispatch types
   *  (ai_voice_call / ivr_call / static_call); null for messaging and when core
   *  is unreachable. This — NOT completed_contacts/failed_contacts (which the
   *  upstream never sends) — is the authoritative source of per-status counts. */
  status_summary?: Record<string, number> | null;
  /** Per-batch status counts cached on the job from batch-completion webhooks.
   *  Fallback when status_summary is absent. Each entry may carry a `batch_id`
   *  key alongside the status counts. Call dispatch types only. */
  call_status_counts?: Array<Record<string, number>> | null;
  progress_pct?: number | null;
  provider?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface RawTenant {
  id: string;
  name?: string | null;
  slug?: string | null;
  [key: string]: unknown;
}

export interface RawAccount {
  id: string;
  tenant_id?: string | null;
  name?: string | null;
  slug?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface AccountsListResponse {
  accounts?: RawAccount[] | null;
  [key: string]: unknown;
}

export interface RawUser {
  [key: string]: unknown;
}

export interface AuthSessionResponse {
  user?: RawUser | null;
  tenants?: RawTenant[] | null;
  memberships?: unknown[] | null;
  default_account?: unknown;
  [key: string]: unknown;
}

export interface AuthMeResponse {
  user?: RawUser | null;
  tenants?: RawTenant[] | null;
  memberships?: unknown[] | null;
  [key: string]: unknown;
}

export interface CallsListResponse {
  calls: RawCall[];
  total: number;
  limit: number;
  offset: number;
}

export interface MessagesListResponse {
  messages: RawMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface BulkJobsListResponse {
  jobs: RawBulkJob[];
  total: number;
  limit: number;
  offset: number;
}

export interface StatsResponse {
  calls?: Record<string, unknown> | null;
  ivr?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Per-batch status counts from core's status-summary endpoint. Shape is
 *  best-effort since the proxy route may differ — callers tolerate null. */
export interface StatusSummaryResponse {
  [batchId: string]: Record<string, number>;
}

/** The two post-call-analysis rollups we read out of magick-master's merged
 *  bulk-dispatch analytics (`POST /bulk-dispatch-jobs/analytics`, which fans out
 *  to core's `/calls/batch-analytics`).
 *
 *  This endpoint exists because the per-record read path cannot carry them:
 *  core's calls LIST projects a column subset that deliberately excludes the
 *  heavy `call_analysis` JSONB, and its formatter sends `call_analysis: null`
 *  rather than omitting the key — so every listed call looks like a call with no
 *  analysis. Core aggregates these in SQL straight off the blob instead.
 *
 *  The response carries far more (totals, duration, cost, outcome and error
 *  distributions); we type only what we consume and stay defensive about the
 *  rest, like every other Raw* shape here. */
export interface RawBatchAnalytics {
  /** Per-sentiment call counts. Labels are whatever the analysis model wrote —
   *  normally positive/neutral/negative, but not guaranteed to be either that
   *  set or that casing. */
  sentiment_distribution?: { label?: string | null; count?: number | null }[] | null;
  /** Most frequent detected intents, already ordered by count desc and capped
   *  upstream (core takes the top 10). */
  key_topics?: { topic?: string | null; count?: number | null }[] | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request params
// ---------------------------------------------------------------------------

export interface ListCallsParams {
  limit?: number;
  offset?: number;
  status?: string;
  batchId?: string;
  jobId?: string;
}

export interface ListMessagesParams {
  connectionId?: string;
  batchId?: string;
  status?: string;
  provider?: string;
  limit?: number;
  offset?: number;
}

export interface ListBulkJobsParams {
  limit?: number;
  offset?: number;
  status?: string;
  dispatchType?: string;
}

export interface ExportCallsParams {
  jobId?: string;
  batchId?: string;
  fields?: string[];
}

export interface StatsParams {
  startDate?: string;
  endDate?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

/** Ceiling on the best-effort call-analytics rollup (see `batchAnalytics`).
 *  Generous enough for a 50-batch selection on a warm upstream, short enough
 *  that a stuck one does not hold the analytics response open. */
const BATCH_ANALYTICS_TIMEOUT_MS = 15_000;

/** Every `iterate*` generator below stops on ONE condition: a short page. That
 *  is the only signal the upstream gives that is always true when exhausted and
 *  never true before.
 *
 *  They used to also stop once `offset` reached the page's reported `total`.
 *  That break could only ever end paging earlier than the short-page stop, so
 *  it won nothing when `total` was right and silently truncated the result when
 *  it was low — and magick-master's totals are counted separately from the rows
 *  it serves, so a stale-low `total` is routine. A `total: 100` on an account
 *  with thousands of bulk jobs reproduced exactly the "only 100 campaigns"
 *  report this listing is meant to have fixed, with the caller's scan cap never
 *  reached. The cost of trusting the short page instead is one extra request per
 *  iteration when the last page happens to be exactly full. */

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function baseUrl(): string {
  if (!isAuthConfigured()) {
    throw new Error(
      "magick-master is not configured: set MAGICK_MASTER_BASE_URL and SESSION_SECRET",
    );
  }
  return env.magickMasterBaseUrl.replace(/\/+$/, "");
}

function buildUrl(path: string, query?: Record<string, string | number | undefined | null>): string {
  const url = new URL(`${baseUrl()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** The path (no query, no host) for a magick-master URL, for compact log lines.
 *  Query params here are non-sensitive (limit/offset/status/batch ids/dates) but
 *  we drop them to keep log cardinality low; secrets live only in headers. */
function logPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** fetch() wrapper that times every magick-master call and logs the outcome —
 *  one INFO line per successful request, WARN on non-2xx, ERROR on network
 *  failure. Inherits the active request/job correlation fields via `log()`, so
 *  upstream calls are traceable back to the API request (or worker job) that
 *  triggered them. The caller still inspects `res.ok` and throws MagickApiError. */
async function loggedFetch(url: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? "GET";
  const path = logPath(url);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, init);
    const durationMs = Date.now() - startedAt;
    const fields = { upstream: "magick-master", method, path, status: res.status, durationMs };
    if (res.ok) log().info(fields, "magick-master request ok");
    else log().warn(fields, "magick-master request non-2xx");
    return res;
  } catch (err) {
    log().error(
      { upstream: "magick-master", method, path, durationMs: Date.now() - startedAt, err },
      "magick-master request errored",
    );
    throw err;
  }
}

async function raw(url: string, headers: Record<string, string>): Promise<Response> {
  const res = await loggedFetch(url, {
    headers: { ...headers, "x-mgkvc-originator": "magick-analytics" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MagickApiError(res.status, body, url, res.headers.get("retry-after"));
  }
  return res;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await raw(url, headers);
  return (await res.json()) as T;
}

/** As `getJson`, for the tenant-scoped endpoints that take their arguments in a
 *  JSON body rather than the query string.
 *
 *  `timeoutMs` is opt-in and deliberately not the default for this file. Most
 *  calls here are load-bearing — ingestion cannot substitute a result for a page
 *  of calls it failed to fetch — so aborting them would turn a slow upstream into
 *  a wrong dataset. It is right only for a caller that has a correct answer to
 *  fall back on. */
async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await loggedFetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "x-mgkvc-originator": "magick-analytics" },
    body: JSON.stringify(body),
    cache: "no-store",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new MagickApiError(res.status, responseBody, url, res.headers.get("retry-after"));
  }
  return (await res.json()) as T;
}

function authHeaders(idToken: string): Record<string, string> {
  return { Authorization: `Bearer ${idToken}`, Accept: "application/json" };
}

// ---------------------------------------------------------------------------
// Auth calls (no tenant headers)
// ---------------------------------------------------------------------------

/** Exchange a Firebase id_token for a session: user + tenants + memberships. */
export async function authSession(idToken: string): Promise<AuthSessionResponse> {
  const url = buildUrl("/auth/session");
  const res = await loggedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-mgkvc-originator": "magick-analytics",
    },
    body: JSON.stringify({ id_token: idToken }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MagickApiError(res.status, body, url, res.headers.get("retry-after"));
  }
  return (await res.json()) as AuthSessionResponse;
}

/** Fetch the current user + tenants/memberships for a Bearer id_token. */
export async function authMe(idToken: string): Promise<AuthMeResponse> {
  return getJson<AuthMeResponse>(buildUrl("/auth/me"), authHeaders(idToken));
}

/** List the accounts within a tenant. Auth-style call: Bearer + X-Tenant-Id only
 *  (no account context exists yet) — used by the workspace picker to cascade the
 *  account list once a tenant is chosen. magick-master validates the user's
 *  membership in the tenant and scopes the result to it. */
export async function listTenantAccounts(
  idToken: string,
  tenantId: string,
): Promise<AccountsListResponse> {
  return getJson<AccountsListResponse>(buildUrl("/accounts"), {
    ...authHeaders(idToken),
    "X-Tenant-Id": tenantId,
  });
}

// ---------------------------------------------------------------------------
// Data client (Bearer + X-Tenant-Id + X-Account-Id)
// ---------------------------------------------------------------------------

export interface MagickClientOptions {
  /** Called once per successful mid-flight re-mint, with the credential this
   *  client switched to.
   *
   *  Exists for the ingestion worker, which must write the new pair back onto
   *  its job document. Google MAY rotate the refresh token on exchange, and a
   *  rotated value dropped here leaves the stored job holding a credential that
   *  is refused the next time it is used — the failure this whole path exists to
   *  remove, reintroduced an hour later. Persisting the ID token too means a
   *  crash/lease recovery resumes with a token that still has most of its hour
   *  left instead of re-minting immediately.
   *
   *  Awaited but never allowed to fail a request: the client already holds a
   *  working token whether or not the caller managed to store it. */
  onCredentialRefresh?: (credential: MintedToken) => void | Promise<void>;
}

export class MagickClient {
  private ctx: TenantContext;
  private readonly onCredentialRefresh?: (credential: MintedToken) => void | Promise<void>;

  constructor(ctx: TenantContext, options: MagickClientOptions = {}) {
    // Copied, not aliased: a re-mint rewrites this client's own credential, and
    // mutating the caller's context object would hand a silently different token
    // to everything else that still holds a reference to it.
    this.ctx = { ...ctx };
    this.onCredentialRefresh = options.onCredentialRefresh;
  }

  static fromContext(ctx: TenantContext, options: MagickClientOptions = {}): MagickClient {
    return new MagickClient(ctx, options);
  }

  /** The credential this client is currently using — the one it was built with,
   *  or the replacement it minted mid-run. Read it rather than the context that
   *  was passed in, which is a snapshot from construction time. */
  get credential(): { idToken: string; refreshToken?: string } {
    return { idToken: this.ctx.idToken, refreshToken: this.ctx.refreshToken };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.ctx.idToken}`,
      "X-Tenant-Id": this.ctx.tenantId,
      "X-Account-Id": this.ctx.accountId,
      Accept: "application/json",
    };
  }

  /** Run an upstream call, and if it comes back 401, mint a fresh ID token and
   *  run it EXACTLY once more.
   *
   *  A Firebase ID token lives one hour. An ingestion that outlives that hour —
   *  routine for a large campaign — used to start collecting 401s partway
   *  through and take the job's whole staged revision down with it. Re-minting
   *  here fixes every caller at once, because `headers()` is the single place a
   *  token reaches a request.
   *
   *  `send` must build its headers from `this.headers()` on each invocation, or
   *  the retry re-sends the token that was just refused.
   *
   *  Once, not "until it works": a refresh token that Google still honours can
   *  perfectly well mint tokens magick-master keeps rejecting (membership
   *  revoked, tenant disabled), and looping on that hammers two upstreams with a
   *  credential that will never be accepted. One retry converts an expired token
   *  into a live one; a second would only repeat the answer.
   *
   *  A mint failure is deliberately NOT swallowed. `TokenRefreshPermanentError`
   *  and `TokenRefreshTransientError` mean opposite things to the worker (fail
   *  the job vs. put it back), and collapsing them into the original 401 erases
   *  the distinction that decides whether a staged revision survives. */
  private async withFreshToken<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof MagickApiError) || err.status !== 401) throw err;
      // Nothing to mint from — a token-paste test session, or a deployment
      // without a Firebase Web API key — so the 401 stands. Checking here rather
      // than letting the exchange fail keeps that case out of the worker's
      // credential-retry path, where it would defer a job for twenty minutes
      // over a configuration that cannot change while it waits.
      if (!this.ctx.refreshToken || !isTokenRefreshConfigured()) throw err;
      log().warn({ path: logPath(err.url) }, "magick-master rejected the id token; minting a replacement");
      const minted = await mintIdToken(this.ctx.refreshToken);
      this.ctx = { ...this.ctx, idToken: minted.idToken, refreshToken: minted.refreshToken };
      if (this.onCredentialRefresh) {
        try {
          await this.onCredentialRefresh(minted);
        } catch (persistErr) {
          log().warn({ err: persistErr }, "could not persist the re-minted credential; continuing with it in memory");
        }
      }
      return await send();
    }
  }

  // ---- Calls ----

  async listCalls(params: ListCallsParams = {}): Promise<CallsListResponse> {
    const url = buildUrl("/proxy/calls", {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      batch_id: params.batchId,
      job_id: params.jobId,
    });
    return this.withFreshToken(() => getJson<CallsListResponse>(url, this.headers()));
  }

  /** Page through all calls (page size 100) until exhausted. */
  async *iterateCalls(params: ListCallsParams = {}): AsyncGenerator<RawCall, void, unknown> {
    let offset = params.offset ?? 0;
    const limit = params.limit ?? PAGE_SIZE;
    for (;;) {
      const page = await this.listCalls({ ...params, limit, offset });
      const calls = page.calls ?? [];
      for (const call of calls) yield call;
      if (calls.length < limit) break;
      offset += limit;
    }
  }

  // ---- Messages ----

  async listMessages(params: ListMessagesParams = {}): Promise<MessagesListResponse> {
    const url = buildUrl("/proxy/messaging/messages", {
      connection_id: params.connectionId,
      batch_id: params.batchId,
      status: params.status,
      provider: params.provider,
      limit: params.limit,
      offset: params.offset,
    });
    return this.withFreshToken(() => getJson<MessagesListResponse>(url, this.headers()));
  }

  /** Page through all messages (page size 100) until exhausted. */
  async *iterateMessages(
    params: ListMessagesParams = {},
  ): AsyncGenerator<RawMessage, void, unknown> {
    let offset = params.offset ?? 0;
    const limit = params.limit ?? PAGE_SIZE;
    for (;;) {
      const page = await this.listMessages({ ...params, limit, offset });
      const messages = page.messages ?? [];
      for (const msg of messages) yield msg;
      if (messages.length < limit) break;
      offset += limit;
    }
  }

  // ---- Bulk dispatch jobs ----

  async listBulkJobs(params: ListBulkJobsParams = {}): Promise<BulkJobsListResponse> {
    const url = buildUrl("/bulk-dispatch-jobs", {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      dispatch_type: params.dispatchType,
    });
    return this.withFreshToken(() => getJson<BulkJobsListResponse>(url, this.headers()));
  }

  /** Page through all bulk-dispatch jobs (page size 100) until exhausted. The
   *  upstream endpoint has no date filter, so date-scoped callers page through
   *  here and filter on `created_at` themselves — and must bound how far they
   *  are willing to page (see app/api/campaigns/route.ts). */
  async *iterateBulkJobs(
    params: ListBulkJobsParams = {},
  ): AsyncGenerator<RawBulkJob, void, unknown> {
    let offset = params.offset ?? 0;
    // A non-positive limit would never advance the offset nor hit the short-page
    // stop, i.e. an infinite loop against the upstream — floor it at one row.
    const limit = Math.max(1, params.limit ?? PAGE_SIZE);
    for (;;) {
      const page = await this.listBulkJobs({ ...params, limit, offset });
      const jobs = page.jobs ?? [];
      for (const job of jobs) yield job;
      if (jobs.length < limit) break;
      offset += limit;
    }
  }

  async getBulkJob(id: string): Promise<RawBulkJob> {
    const url = buildUrl(`/bulk-dispatch-jobs/${encodeURIComponent(id)}`);
    return this.withFreshToken(() => getJson<RawBulkJob>(url, this.headers()));
  }

  /** Merged post-call-analysis rollups across a set of `ai_voice_call` jobs,
   *  computed by core over the union of their dispatched batches — so the caller
   *  gets one exact answer for the whole selection rather than N per-batch
   *  top-10s it would have to merge approximately.
   *
   *  Upstream caps this at 50 job ids, which is exactly `MAX_SELECTION_BATCHES`
   *  (lib/server/selection.ts) — a selection can never exceed it, and
   *  `call-analysis.test.ts` pins the two together so raising ours alone turns
   *  into a failing test rather than a 400 in front of the customer.
   *
   *  Unlike `statusSummary`, this does NOT swallow a 404. Callers need the status
   *  to tell a settled answer about the selection (400 wrong job type, 404 job
   *  upstream no longer has — both permanent, both safe to cache) from a
   *  momentary one (5xx, 401, timeout) that must not be. Collapsing either into
   *  `null` here would erase the distinction; `enrichWithCallAnalysis` owns that
   *  policy in one place.
   *
   *  Timed out rather than left to hang. This is the heaviest call in this file
   *  — master fans a whole selection's batches into one core request, and core
   *  answers it with eleven parallel aggregate queries — and it is the only one
   *  whose caller holds a correct answer to fall back on, so a bounded wait
   *  degrades to that instead of stalling the analytics request behind it. */
  async batchAnalytics(jobIds: string[]): Promise<RawBatchAnalytics | null> {
    if (jobIds.length === 0) return null;
    const url = buildUrl("/bulk-dispatch-jobs/analytics");
    return this.withFreshToken(() =>
      postJson<RawBatchAnalytics>(url, this.headers(), { job_ids: jobIds }, BATCH_ANALYTICS_TIMEOUT_MS),
    );
  }

  // ---- Status summary (tolerate 404 → null) ----

  /** Per-batch status counts. The proxy route may not exist (404) — returns null
   *  in that case rather than throwing. */
  async statusSummary(batchIds: string[]): Promise<StatusSummaryResponse | null> {
    if (batchIds.length === 0) return {};
    const url = buildUrl("/proxy/calls/status-summary", { batch_ids: batchIds.join(",") });
    try {
      return await this.withFreshToken(() => getJson<StatusSummaryResponse>(url, this.headers()));
    } catch (err) {
      if (err instanceof MagickApiError && err.status === 404) return null;
      throw err;
    }
  }

  // ---- Stats ----

  async getStats(params: StatsParams = {}): Promise<StatsResponse> {
    const url = buildUrl("/proxy/stats", {
      start_date: params.startDate,
      end_date: params.endDate,
    });
    return this.withFreshToken(() => getJson<StatsResponse>(url, this.headers()));
  }

  // ---- CSV export (returns the raw Response for streaming/piping) ----

  /** Returns the raw fetch Response (text/csv) so callers can pipe the body
   *  stream directly to the client. Throws MagickApiError on non-2xx.
   *
   *  Safe to retry despite handing back an unread stream, because the two bodies
   *  are never the same one: `raw()` drains the REJECTED response with `.text()`
   *  to build the MagickApiError before it throws, and the retry issues a fresh
   *  request whose body this client never touches. Nothing here reads the
   *  successful stream, so the caller still receives it intact — retrying after
   *  a body had been consumed is what would hand the browser a truncated CSV. */
  async exportCallsCsv(params: ExportCallsParams): Promise<Response> {
    const url = buildUrl("/proxy/calls/export", {
      job_id: params.jobId,
      batch_id: params.batchId,
      fields: params.fields && params.fields.length > 0 ? params.fields.join(",") : undefined,
    });
    return this.withFreshToken(() => raw(url, { ...this.headers(), Accept: "text/csv" }));
  }
}
