// Next.js instrumentation hook — runs once when the server process starts.
// On the Node runtime, if the backend is configured, ensure Mongo indexes and
// boot the in-process ingestion worker. No-ops cleanly when unconfigured (mock mode).

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isBackendConfigured } = await import("./lib/server/env");
  if (!isBackendConfigured()) {
    console.log("[instrumentation] backend not configured — running on mock data");
    return;
  }
  try {
    const { ensureIndexes } = await import("./lib/server/db");
    const { startWorker } = await import("./lib/server/worker");
    await ensureIndexes();
    startWorker();
    console.log("[instrumentation] Mongo indexes ensured; ingestion worker started");
  } catch (err) {
    console.error("[instrumentation] startup failed", err);
  }
}
