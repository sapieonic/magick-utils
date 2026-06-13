// Request-logging wrapper for App Router route handlers. Wrap each exported
// handler with `withLogging("route/template", handler)` so every inbound API
// request is logged on the way in and out — method, path, status, duration —
// inside a fresh correlation context. Downstream code (magick-master client,
// repositories, LLM calls) that uses the logger's `log()` helper then inherits
// the same `reqId`, making a single request trivial to trace in Grafana.
//
// Node-only. Keeps the generic handler signature so it composes with both plain
// `(req)` handlers and dynamic `(req, { params })` handlers.

import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import { runWithRequestContext } from "./observability/request-context";

type RouteHandler<A extends unknown[]> = (
  req: Request,
  ...rest: A
) => Promise<Response> | Response;

export function withLogging<A extends unknown[]>(
  route: string,
  handler: RouteHandler<A>,
): RouteHandler<A> {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const reqId = randomUUID();
    const method = req.method;
    let path = req.url;
    let search = "";
    try {
      const u = new URL(req.url);
      path = u.pathname;
      search = u.search;
    } catch {
      // non-absolute URL — keep req.url as-is
    }

    return runWithRequestContext({ reqId, route, method }, async () => {
      const reqLog = logger.child({ reqId, route, method, path });
      const startedAt = Date.now();
      reqLog.info(search ? { search } : {}, "→ request received");
      try {
        const res = await handler(req, ...rest);
        const durationMs = Date.now() - startedAt;
        reqLog.info({ status: res.status, durationMs }, "← request completed");
        return res;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        // Log then rethrow so Next.js still produces its 500 — we only observe.
        reqLog.error({ err, durationMs }, "✗ request threw");
        throw err;
      }
    });
  };
}
