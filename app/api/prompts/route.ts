import { NextRequest, NextResponse } from "next/server";
import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import {
  createPromptTemplate,
  isDuplicateKeyError,
  listPromptTemplates,
} from "@/lib/server/repositories";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";
import type { PromptTemplate } from "@/lib/server/types";

export const GET = withLogging("prompts.list", async () => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  const templates = await listPromptTemplates(ctx.tenantId, ctx.accountId);
  return NextResponse.json({ templates });
});

export const POST = withLogging("prompts.create", async (req: NextRequest) => {
  if (!isBackendConfigured()) {
    return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  }
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { slug, version, name, content, isActive } = body as Record<string, unknown>;

  if (typeof slug !== "string" || !slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: "version must be a positive integer" }, { status: 400 });
  }
  if (typeof name !== "string" || !name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (typeof content !== "string" || !content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const doc: PromptTemplate = {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    slug,
    version,
    name,
    content,
    isActive: isActive === true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await createPromptTemplate(doc);
    log().info({ slug, version }, "prompt template created");
    return NextResponse.json({ template: doc }, { status: 201 });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      log().warn({ slug, version }, "prompt template already exists");
      return NextResponse.json(
        {
          error: "conflict",
          detail: `A prompt template with slug "${slug}" and version ${version} already exists.`,
        },
        { status: 409 }
      );
    }
    log().error({ err }, "prompt template creation failed");
    return NextResponse.json({ error: "create_failed", detail: String(err) }, { status: 500 });
  }
});
