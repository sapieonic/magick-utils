// Client-side data access seam. Screens call these; when the backend is
// configured they hit the BFF route handlers, otherwise they fall back to the
// seeded mock data in lib/data.ts so the UI keeps working without credentials.

import { CAMPAIGNS } from "@/lib/data";
import type { Batch } from "@/lib/types";
import type { AggregatesDoc, DashboardVolume, Insight, JobStatus, JobType } from "@/lib/server/types";

export interface JobDto {
  jobId: string;
  type: JobType;
  status: JobStatus;
  total: number;
  done: number;
  retryAt: string | null;
  retryCount: number;
  error: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

let _status: { backend: boolean; llm: boolean } | null = null;
let _statusAt = 0;
const STATUS_TTL_MS = 30_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function responseError(res: Response, fallback: string): Promise<ApiRequestError> {
  let body: { error?: string; message?: string } = {};
  try {
    const readable = typeof res.clone === "function" ? res.clone() : res;
    body = await readable.json();
  } catch {
    // A non-JSON upstream error still gets the safe caller-supplied fallback.
  }
  return new ApiRequestError(body.message ?? fallback, res.status, body.error);
}

/** When a live BFF data call comes back 401, the magick-master session has
 *  expired (or was never authenticated) — the server has already cleared the
 *  cookie, so send the user back to login. Centralized so every screen reacts
 *  the same way; guarded against redirect loops if we're already on /login.
 *  Returns true when a redirect was triggered. */
function handleSessionExpiry(res: Response): boolean {
  if (res.status !== 401 || typeof window === "undefined") return false;
  if (!window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
  return true;
}

export async function backendStatus(): Promise<{ backend: boolean; llm: boolean }> {
  if (_status && Date.now() - _statusAt < STATUS_TTL_MS) return _status;
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw await responseError(res, "Unable to check backend availability.");
    const j = await res.json();
    _status = { backend: !!j.backend, llm: !!j.llm };
    _statusAt = Date.now();
    return _status;
  } catch (error) {
    // A network fault is not proof that this is a demo environment. Do not
    // cache or replace production data with convincing seeded rows.
    throw error instanceof ApiRequestError
      ? error
      : new ApiRequestError("Backend availability could not be verified.", 503, "health_unavailable");
  }
}

/** List campaigns/batches. Falls back to mock data when the backend is off. */
export async function listCampaigns(): Promise<{ batches: Batch[]; source: "live" | "mock" }> {
  const { backend } = await backendStatus();
  if (!backend) return { batches: CAMPAIGNS, source: "mock" };
  const res = await fetch("/api/campaigns", { cache: "no-store" });
  if (handleSessionExpiry(res)) throw new Error("session_expired");
  if (!res.ok) throw await responseError(res, "Unable to load campaigns.");
  const j = await res.json();
  return { batches: j.batches as Batch[], source: "live" };
}

export interface IngestJobResult {
  jobId: string | null;
  total: number;
  done?: number;
  /** True when every requested batch already has normalized records, so no job
   *  was enqueued. Also used after a page reload so Analyze/Combine skip a
   *  redundant pull. */
  ready?: boolean;
  /** True when the caller was attached to an already-running job. */
  existing?: boolean;
}

export async function createIngestJob(
  batchIds: string[],
  type: "ingest" | "merge" = "ingest",
  options?: { refresh?: boolean },
): Promise<IngestJobResult | null> {
  const { backend } = await backendStatus();
  if (!backend) return null;
  const res = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      batchIds,
      type,
      ...(options?.refresh ? { refresh: true } : {}),
    }),
  });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) throw await responseError(res, "Unable to schedule ingestion.");
  return res.json();
}

export async function getJob(jobId: string): Promise<JobDto | null> {
  const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) throw await responseError(res, "Unable to refresh job progress.");
  return res.json();
}

export function isJobNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.code === "not_found");
}

/** Progress bar percent. In-flight jobs cap at 99 so "100" only means done. */
export function jobProgressPercent(done: number, total: number, status?: JobStatus): number {
  if (status === "done") return 100;
  if (!(total > 0)) return 0;
  return Math.min(99, Math.round((done / total) * 100));
}

export async function getAnalytics(batchIds: string[], refresh = false): Promise<AggregatesDoc | null> {
  const { backend } = await backendStatus();
  if (!backend) return null;
  const res = await fetch("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, refresh }),
  });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) throw await responseError(res, "Unable to load analytics.");
  const j = await res.json();
  return j.aggregates as AggregatesDoc;
}

export async function getDashboardVolume(range: string): Promise<DashboardVolume | null> {
  const { backend } = await backendStatus();
  if (!backend) return null;
  const res = await fetch("/api/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ range }),
  });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) throw new Error(`dashboard ${res.status}`);
  const json = await res.json();
  return json.volume as DashboardVolume;
}

export async function generateInsights(batchIds: string[], refresh = false): Promise<Insight | null> {
  const { llm } = await backendStatus();
  if (!llm) throw new ApiRequestError("AI insights are not configured for this environment.", 503, "llm_not_configured");
  const res = await fetch("/api/insights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, refresh }),
  });
  if (handleSessionExpiry(res)) throw new ApiRequestError("Your session expired.", 401, "session_expired");
  if (!res.ok) throw await responseError(res, "AI insight generation failed.");
  const j = await res.json();
  return j.insight as Insight;
}

/** Comparative insight (feature 4a): the AI narrative explaining what changed
 *  between the current selection and a baseline. Returns null when the LLM is
 *  off — the caller still renders the deterministic delta grid (computed client
 *  side via getAnalytics + diffAggregates), so only the prose degrades. */
export async function compareInsights(
  batchIds: string[],
  baselineBatchIds: string[],
  refresh = false,
): Promise<Insight | null> {
  const { llm } = await backendStatus();
  if (!llm) throw new ApiRequestError("AI insights are not configured for this environment.", 503, "llm_not_configured");
  const res = await fetch("/api/insights/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, baselineBatchIds, refresh }),
  });
  if (handleSessionExpiry(res)) throw new ApiRequestError("Your session expired.", 401, "session_expired");
  if (!res.ok) throw await responseError(res, "AI comparison generation failed.");
  const j = await res.json();
  return j.insight as Insight;
}

/** Stream a chat answer token-by-token. Returns false if the backend/LLM is off
 *  (caller should fall back to its simulated response). */
export async function streamChat(
  batchIds: string[],
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  onDelta: (text: string) => void,
): Promise<boolean> {
  const { llm } = await backendStatus();
  if (!llm) throw new ApiRequestError("The campaign assistant is not configured.", 503, "llm_not_configured");
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, message, history }),
  });
  if (handleSessionExpiry(res)) throw new ApiRequestError("Your session expired.", 401, "session_expired");
  if (!res.ok) throw await responseError(res, "The campaign assistant is unavailable.");
  if (!res.body) throw new ApiRequestError("The campaign assistant returned no response.", 502, "empty_stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let doneSeen = false;
  const processEvent = (evt: string) => {
    const lines = evt.split("\n");
    if (lines.some((line) => line.trim() === "event: error")) {
      throw new ApiRequestError("The campaign assistant stream failed.", 502, "stream_failed");
    }
    if (lines.some((line) => line.trim() === "event: done")) doneSeen = true;
    const line = lines.find((candidate) => candidate.startsWith("data: "));
    if (!line) return;
    try {
      const payload = JSON.parse(line.slice(6));
      if (payload.delta) onDelta(payload.delta as string);
    } catch {
      // Terminal frames carry an empty object; malformed data is ignored here,
      // but the required done frame below still prevents a false success.
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) processEvent(evt);
    }
    buf += decoder.decode();
    for (const evt of buf.split("\n\n").filter((event) => event.trim())) processEvent(evt);
    if (!doneSeen) {
      throw new ApiRequestError("The campaign assistant response ended early.", 502, "incomplete_stream");
    }
  } catch (error) {
    await reader.cancel?.().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return true;
}

// ---- auth ----

export interface SessionAccountInfo {
  id: string;
  name?: string;
  slug?: string;
}

export interface SessionTenantInfo {
  id: string;
  name?: string;
  slug?: string;
  accounts?: SessionAccountInfo[];
}

/** Exchange a Firebase ID token for a BFF session. Returns the tenants the user
 *  belongs to (for the workspace picker), or throws with a readable message. */
export async function postSession(idToken: string): Promise<{ tenants: SessionTenantInfo[] }> {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ? `${j.error}` : `session ${res.status}`);
  }
  const j = await res.json();
  return { tenants: (j.tenants ?? []) as SessionTenantInfo[] };
}

/** List the accounts available within a tenant, for the cascading workspace
 *  picker. Returns [] when the backend is off or the request fails, so the UI
 *  cleanly falls back to manual account entry. */
export async function listAccounts(tenantId: string): Promise<SessionAccountInfo[]> {
  try {
    const res = await fetch(`/api/accounts?tenantId=${encodeURIComponent(tenantId)}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.accounts ?? []) as SessionAccountInfo[];
  } catch {
    return [];
  }
}

/** Select the active tenant/account workspace on the session. */
export async function postContext(tenantId: string, accountId: string): Promise<void> {
  const res = await fetch("/api/auth/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, accountId }),
  });
  // A 401 here means the session is gone/expired (not_authenticated) — bounce to
  // login instead of surfacing a confusing "check the IDs" error on the picker.
  if (handleSessionExpiry(res)) return;
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ? `${j.error}` : `context ${res.status}`);
  }
}

export interface SessionUserInfo {
  id?: string;
  email?: string;
  name?: string;
}

export async function fetchMe(): Promise<{ authenticated: boolean; user?: SessionUserInfo | null; tenants: SessionTenantInfo[]; context: { tenantId: string; accountId: string } | null } | null> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

/** Trigger a CSV download via the export route (live only). */
export function downloadCsvUrl(batchIds: string[], columns: string[]): string {
  const q = new URLSearchParams({ batchIds: batchIds.join(","), columns: columns.join(",") });
  return `/api/export?${q.toString()}`;
}

/** Fetch a prepared CSV without navigating away on an API error. */
export async function downloadCsv(batchIds: string[], columns: string[]): Promise<void> {
  const url = downloadCsvUrl(batchIds, columns);
  const preflightUrl = `${url}&preflight=1`;
  const res = await fetch(preflightUrl, { cache: "no-store" });
  if (handleSessionExpiry(res)) throw new ApiRequestError("Your session expired.", 401, "session_expired");
  if (!res.ok) throw await responseError(res, "CSV download failed.");
  // Native navigation streams the response directly into the browser download
  // manager; never buffer a potentially multi-gigabyte CSV in tab memory.
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.click();
}
