import { NextResponse } from "next/server";
import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { withLogging } from "@/lib/server/http-log";

export const dynamic = "force-dynamic";

export const GET = withLogging("health", async () => {
  return NextResponse.json({
    ok: true,
    backend: isBackendConfigured(),
    llm: isLlmConfigured(),
  });
});
