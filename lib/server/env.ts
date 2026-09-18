// Centralized, typed access to server environment configuration.
// Nothing here throws at import time — callers check the `*Configured` flags so
// the app keeps running (on mock data) when the backend isn't wired yet.
// (Server-only by convention — only imported from route handlers / server modules.)

/** Parse a positive-integer env var, falling back when unset or malformed — a
 *  typo must not silently shorten a retention window to zero. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  magickMasterBaseUrl: process.env.MAGICK_MASTER_BASE_URL ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  sessionCookieName: process.env.SESSION_COOKIE_NAME ?? "mu_session",

  mongoUri: process.env.MONGODB_URI ?? "",
  mongoDb: process.env.MONGODB_DB ?? "magickutils",

  // Firebase Web API key, used server-side ONLY to exchange a stored refresh
  // token for a fresh ID token (lib/server/firebase-token.ts). This is the same
  // public key the client bundle carries — it identifies the project, it does
  // not authorize anything on its own; the refresh token is the credential.
  // `NEXT_PUBLIC_FIREBASE_API_KEY` is inlined at BUILD time, so a deployment
  // that sets it only at runtime needs the server-side `FIREBASE_API_KEY`.
  firebaseApiKey: process.env.FIREBASE_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",

  // Shared secret guarding the cron cleanup endpoint (POST /api/cron/cleanup),
  // which the daily GitHub Actions workflow calls with a Bearer token.
  cronSecret: process.env.CRON_SECRET ?? "",

  // How long batches, records, jobs, aggregates and insights are kept, in days.
  // This is the ceiling on how far back the Dashboard and Analytics can look:
  // campaigns older than this are deleted with every record they own, so a
  // customer asking for "previous months" needs this raised. Size it against the
  // storage the deployment actually has.
  dataRetentionDays: positiveInt(process.env.DATA_RETENTION_DAYS, 5),

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "openai-compatible") as "openai-compatible" | "anthropic",
    model: process.env.LLM_MODEL ?? "",
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
    projectId: process.env.LLM_PROJECT_ID ?? "",
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

/** A Firebase Web API key is present → the server can mint a fresh ID token from
 *  a stored refresh token. Without it, sessions still work but expire after the
 *  ID token's own hour, and long ingests cannot outlive it. */
export function isTokenRefreshConfigured(): boolean {
  return Boolean(env.firebaseApiKey);
}

/** A cron secret is set → the scheduled cleanup endpoint will accept requests. */
export function isCronConfigured(): boolean {
  return Boolean(env.cronSecret);
}

/** LLM key present → AI insights + chat can call a real model. */
export function isLlmConfigured(): boolean {
  return Boolean(env.llm.apiKey && env.llm.model);
}
