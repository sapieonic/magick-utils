// Centralized, typed access to server environment configuration.
// Nothing here throws at import time — callers check the `*Configured` flags so
// the app keeps running (on mock data) when the backend isn't wired yet.
// (Server-only by convention — only imported from route handlers / server modules.)

export const env = {
  magickMasterBaseUrl: process.env.MAGICK_MASTER_BASE_URL ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "mu_session",

  mongoUri: process.env.MONGODB_URI ?? "",
  mongoDb: process.env.MONGODB_DB ?? "magickutils",

  // Shared secret guarding the cron cleanup endpoint (POST /api/cron/cleanup),
  // which the daily GitHub Actions workflow calls with a Bearer token.
  cronSecret: process.env.CRON_SECRET ?? "",

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "openai-compatible") as "openai-compatible" | "anthropic",
    model: process.env.LLM_MODEL ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
  },
} as const;

/** magick-master + Mongo present → the data plane (auth, campaigns, ingest, export) can run. */
export function isBackendConfigured(): boolean {
  return Boolean(env.magickMasterBaseUrl && env.mongoUri && env.sessionSecret);
}

/** Auth alone needs magick-master + a session secret (Mongo not required to log in). */
export function isAuthConfigured(): boolean {
  return Boolean(env.magickMasterBaseUrl && env.sessionSecret);
}

export function isMongoConfigured(): boolean {
  return Boolean(env.mongoUri);
}

/** A cron secret is set → the scheduled cleanup endpoint will accept requests. */
export function isCronConfigured(): boolean {
  return Boolean(env.cronSecret);
}

/** LLM key present → AI insights + chat can call a real model. */
export function isLlmConfigured(): boolean {
  return Boolean(env.llm.apiKey && env.llm.model);
}
