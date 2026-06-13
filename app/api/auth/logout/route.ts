import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";

export const POST = withLogging("auth/logout", async () => {
  if (!isAuthConfigured()) return NextResponse.json({ ok: true });
  const session = await getSession();
  const userId = session.user?.id;
  session.destroy();
  log().info({ userId }, "session destroyed (logout)");
  return NextResponse.json({ ok: true });
});
