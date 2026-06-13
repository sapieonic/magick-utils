// Client-side data access seam. Screens call these; when the backend is
// configured they hit the BFF route handlers, otherwise they fall back to the
// seeded mock data in lib/data.ts so the UI keeps working without credentials.

import { CAMPAIGNS } from "@/lib/data";
import type { Batch } from "@/lib/types";
import type { AggregatesDoc, Insight, Job } from "@/lib/server/types";

let _status: { backend: boolean; llm: boolean } | null = null;

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
  if (_status) return _status;
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const j = await res.json();
    _status = { backend: !!j.backend, llm: !!j.llm };
  } catch {
    _status = { backend: false, llm: false };
  }
  return _status;
}

/** List campaigns/batches. Falls back to mock data when the backend is off. */
export async function listCampaigns(): Promise<{ batches: Batch[]; source: "live" | "mock" }> {
  const { backend } = await backendStatus();
  if (!backend) return { batches: CAMPAIGNS, source: "mock" };
  try {
    const res = await fetch("/api/campaigns", { cache: "no-store" });
    if (handleSessionExpiry(res)) return { batches: CAMPAIGNS, source: "mock" };
    if (!res.ok) throw new Error(`campaigns ${res.status}`);
    const j = await res.json();
    return { batches: j.batches as Batch[], source: "live" };
  } catch {
    return { batches: CAMPAIGNS, source: "mock" };
  }
}

export async function createIngestJob(batchIds: string[], type: "ingest" | "merge" = "ingest"): Promise<{ jobId: string; total: number } | null> {
  const { backend } = await backendStatus();
  if (!backend) return null;
  const res = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, type }),
  });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) return null;
  return res.json();
}

export async function getJob(jobId: string): Promise<Job | null> {
  const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) return null;
  return res.json();
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
  if (!res.ok) return null;
  const j = await res.json();
  return j.aggregates as AggregatesDoc;
}

export async function generateInsights(batchIds: string[], model: string, refresh = false): Promise<Insight | null> {
  const { llm } = await backendStatus();
  if (!llm) return null;
  const res = await fetch("/api/insights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, model, refresh }),
  });
  if (handleSessionExpiry(res)) return null;
  if (!res.ok) return null;
  const j = await res.json();
  return j.insight as Insight;
}

/** Stream a chat answer token-by-token. Returns false if the backend/LLM is off
 *  (caller should fall back to its simulated response). */
export async function streamChat(
  batchIds: string[],
  model: string,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  onDelta: (text: string) => void,
): Promise<boolean> {
  const { llm } = await backendStatus();
  if (!llm) return false;
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchIds, model, message, history }),
  });
  if (handleSessionExpiry(res)) return false;
  if (!res.ok || !res.body) return false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const evt of events) {
      const line = evt.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.delta) onDelta(payload.delta as string);
      } catch {
        /* ignore non-data frames (done/error) */
      }
    }
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
