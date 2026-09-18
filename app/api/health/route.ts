import { NextResponse } from "next/server";
import { isBackendConfigured, isLlmConfigured, isTokenRefreshConfigured } from "@/lib/server/env";
import { withLogging } from "@/lib/server/http-log";

export const dynamic = "force-dynamic";

export const GET = withLogging(
  "health",
  async () => {
    return NextResponse.json({
      ok: true,
      backend: isBackendConfigured(),
      llm: isLlmConfigured(),
      // Whether the server can renew a Firebase ID token. Reported because the
      // symptom of it being off — users bounced to /login about an hour after
      // signing in — is indistinguishable from the bug this replaced, and
      // operators diagnose config through this endpoint. Without it, nobody can
      // tell "the fix is broken" from "the key was never set".
      tokenRefresh: isTokenRefreshConfigured(),
    });
  },
  { logRequests: false },
);
