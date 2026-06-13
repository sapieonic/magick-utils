// Per-request / per-job correlation context, carried implicitly through the
// async call tree via AsyncLocalStorage. Set once at the edge of a unit of work
// (an API request in `withLogging`, a worker job in the ingestion loop) and read
// anywhere downstream — notably the logger's `log()` helper and the magick-master
// client — so every log line for that request/job shares the same `reqId`/`jobId`
// and tenant context without threading a logger through every function.
//
// Node-only (async_hooks). Server modules only; never import into client/edge.

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Correlation id for an inbound API request. */
  reqId?: string;
  /** Correlation id for a background worker job (mutually exclusive with reqId). */
  jobId?: string;
  /** Route template (e.g. "jobs/[id]") or worker label (e.g. "worker:ingest"). */
  route?: string;
  /** HTTP method, for inbound requests. */
  method?: string;
  tenantId?: string;
  accountId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the active context for the duration of its async tree. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active context, or undefined when running outside any unit of work. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Attach fields to the active context once they become known (e.g. tenant/account
 *  resolved after session lookup). No-op when there is no active context. */
export function setRequestContext(patch: Partial<RequestContext>): void {
  const cur = storage.getStore();
  if (cur) Object.assign(cur, patch);
}

/** The active context with undefined fields stripped — ready to spread into log
 *  bindings. Returns an empty object outside any unit of work. */
export function contextBindings(): Record<string, string> {
  const cur = storage.getStore();
  if (!cur) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cur)) {
    if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  }
  return out;
}
