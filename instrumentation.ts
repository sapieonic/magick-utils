// Next.js instrumentation hook — runs once when the server process starts.
// On the Node runtime: initialize OTel log export, then (if backend configured)
// ensure Mongo indexes and boot the in-process ingestion worker. No-ops cleanly
// when unconfigured (mock mode). All Node-only modules (logger, OTel SDK, db,
// worker) are imported dynamically AFTER the runtime guard so this module stays
// loadable in the Edge Runtime without dragging in node:fs / worker_threads.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initOtelLogs, shutdownOtelLogs } = await import("./lib/server/observability/otel-logs");
  const { logger } = await import("./lib/server/logger");

  initOtelLogs();
  // Register shutdown handlers — process.on is Node-only; the runtime guard above
  // guarantees we never reach here on the Edge Runtime. Bracket-notation defeats
  // Turbopack's static edge-API scanner while remaining semantically identical.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any)["on"]("SIGTERM", () => void shutdownOtelLogs());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any)["on"]("SIGINT", () => void shutdownOtelLogs());

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
