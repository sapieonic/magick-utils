import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";

export async function GET() {
  if (!isAuthConfigured()) {
    return NextResponse.json({ authenticated: false, configured: false }, { status: 401 });
  }
  const session = await getSession();
  if (!session.idToken) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    user: session.user ?? null,
    tenants: session.tenants ?? [],
    context: session.tenantId && session.accountId ? { tenantId: session.tenantId, accountId: session.accountId } : null,
  });
}
