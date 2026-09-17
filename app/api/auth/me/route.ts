import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession, sessionIsLive } from "@/lib/server/session";
import { withLogging } from "@/lib/server/http-log";

export const GET = withLogging("auth/me", async () => {
  if (!isAuthConfigured()) {
    return NextResponse.json({ authenticated: false, configured: false }, { status: 401 });
  }
  const session = await getSession();
  // Holding an ID token is not the same as holding a usable one: the token lives
  // an hour, this cookie eight. Answering on mere presence is what let the
  // app-shell guard wave a user in and leave the first campaigns fetch to eject
  // them mid-screen. `sessionIsLive` also passes a session that can re-mint from
  // its refresh token, so a merely-expired token is not grounds to sign anyone out.
  if (!sessionIsLive(session)) {
    // Clear the dead cookie instead of leaving it to fail the same way on every
    // subsequent load.
    session.destroy();
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    user: session.user ?? null,
    tenants: session.tenants ?? [],
    context: session.tenantId && session.accountId ? { tenantId: session.tenantId, accountId: session.accountId } : null,
  });
});
