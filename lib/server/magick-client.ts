// Typed HTTP client for the magick-master backend (customer-facing platform layer
// that proxies to magic-voice-core). Two flavors of request:
//   - auth calls: just an Authorization: Bearer <id_token> header
//   - data calls: Bearer + X-Tenant-Id + X-Account-Id
//
// Pure server module — no React. Uses the global fetch. Raw upstream payloads are
// described with lightweight `Raw*` interfaces; we stay defensive because upstream
// fields may be absent. Non-2xx responses throw a typed MagickApiError.

import { env, isAuthConfigured } from "@/lib/server/env";
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

  constructor(status: number, body: string, url: string) {
    super(`magick-master ${status} for ${url}: ${body.slice(0, 500)}`);
    this.name = "MagickApiError";
    this.status = status;
    this.body = body;
    this.url = url;
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
    throw new MagickApiError(res.status, body, url);
  }
  return res;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await raw(url, headers);
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
    throw new MagickApiError(res.status, body, url);
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

export class MagickClient {
  private readonly ctx: TenantContext;

  constructor(ctx: TenantContext) {
    this.ctx = ctx;
  }

  static fromContext(ctx: TenantContext): MagickClient {
    return new MagickClient(ctx);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.ctx.idToken}`,
      "X-Tenant-Id": this.ctx.tenantId,
      "X-Account-Id": this.ctx.accountId,
      Accept: "application/json",
    };
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
    return getJson<CallsListResponse>(url, this.headers());
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
      const total = page.total ?? 0;
      if (total > 0 && offset >= total) break;
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
    return getJson<MessagesListResponse>(url, this.headers());
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
      const total = page.total ?? 0;
      if (total > 0 && offset >= total) break;
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
    return getJson<BulkJobsListResponse>(url, this.headers());
  }

  async getBulkJob(id: string): Promise<RawBulkJob> {
    const url = buildUrl(`/bulk-dispatch-jobs/${encodeURIComponent(id)}`);
    return getJson<RawBulkJob>(url, this.headers());
  }

  // ---- Status summary (tolerate 404 → null) ----

  /** Per-batch status counts. The proxy route may not exist (404) — returns null
   *  in that case rather than throwing. */
  async statusSummary(batchIds: string[]): Promise<StatusSummaryResponse | null> {
    if (batchIds.length === 0) return {};
    const url = buildUrl("/proxy/calls/status-summary", { batch_ids: batchIds.join(",") });
    try {
      return await getJson<StatusSummaryResponse>(url, this.headers());
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
    return getJson<StatsResponse>(url, this.headers());
  }

  // ---- CSV export (returns the raw Response for streaming/piping) ----

  /** Returns the raw fetch Response (text/csv) so callers can pipe the body
   *  stream directly to the client. Throws MagickApiError on non-2xx. */
  async exportCallsCsv(params: ExportCallsParams): Promise<Response> {
    const url = buildUrl("/proxy/calls/export", {
      job_id: params.jobId,
      batch_id: params.batchId,
      fields: params.fields && params.fields.length > 0 ? params.fields.join(",") : undefined,
    });
    return raw(url, { ...this.headers(), Accept: "text/csv" });
  }
}
