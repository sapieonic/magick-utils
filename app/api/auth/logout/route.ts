import { NextResponse } from "next/server";
import { isAuthConfigured } from "@/lib/server/env";
import { getSession } from "@/lib/server/session";

export async function POST() {
  if (!isAuthConfigured()) return NextResponse.json({ ok: true });
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}
