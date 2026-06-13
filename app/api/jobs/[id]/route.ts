import { NextResponse } from "next/server";
import { getTenantContext } from "@/lib/server/session";
import { getJob } from "@/lib/server/repositories";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const { id } = await params;
  const job = await getJob(id);
  if (!job || job.tenantId !== ctx.tenantId || job.accountId !== ctx.accountId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // never leak the stored idToken
  const { idToken: _omit, ...safe } = job;
  void _omit;
  return NextResponse.json(safe);
}
