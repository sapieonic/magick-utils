// Next.js instrumentation hook — runs once when the server process starts.
// On the Node runtime: initialize OTel log export, then (if backend configured)
// ensure Mongo indexes and boot the in-process ingestion worker. No-ops cleanly
// when unconfigured (mock mode).

import { initOtelLogs, shutdownOtelLogs } from "./lib/server/observability/otel-logs";
import { logger } from "./lib/server/logger";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  initOtelLogs();
  process.on("SIGTERM", () => void shutdownOtelLogs());
  process.on("SIGINT", () => void shutdownOtelLogs());

  const { isBackendConfigured } = await import("./lib/server/env");
  if (!isBackendConfigured()) {
    logger.info("backend not configured — running on mock data");
    return;
  }
  try {
    const { ensureIndexes } = await import("./lib/server/db");
    const { startWorker } = await import("./lib/server/worker");
    await ensureIndexes();
    startWorker();
    logger.info("Mongo indexes ensured; ingestion worker started");
  } catch (err) {
    logger.error({ err }, "startup failed");
  }
}
