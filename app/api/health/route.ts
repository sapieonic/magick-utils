import { NextResponse } from "next/server";
import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    backend: isBackendConfigured(),
    llm: isLlmConfigured(),
  });
}
