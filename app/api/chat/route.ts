import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getRecords } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";
import { aggregatesKey } from "@/lib/server/fingerprint";
import { getLLM, type ChatMessage } from "@/lib/server/llm";
import type { AggregatesDoc } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function summary(agg: AggregatesDoc): string {
  return JSON.stringify({
    totalRecords: agg.totalRecords,
    successRatePct: Number((agg.successRate * 100).toFixed(1)),
    statusMix: agg.statusMix,
    spendInr: Math.round(agg.spendInr),
    sentiment: agg.sentiment,
    topTopics: agg.topics?.slice(0, 8),
    funnel: agg.funnel,
  });
}

/** Streamed (SSE) natural-language Q&A grounded in a campaign's aggregates. */
export const POST = withLogging("chat", async (req: Request) => {
  if (!isBackendConfigured()) return Response.json({ error: "backend_not_configured" }, { status: 503 });
  if (!isLlmConfigured()) return Response.json({ error: "llm_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: string[]; message?: string; history?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const batchIds = (body.batchIds ?? []).filter(Boolean);
  const message = (body.message ?? "").trim();
  if (!message) return Response.json({ error: "empty_message" }, { status: 400 });
  // Bind a logger now so the streamed callbacks below (which run after the
  // handler returns) keep this request's correlation fields.
  const chatLog = log().child({ batchCount: batchIds.length, msgLen: message.length });

  // best-effort context (don't hard-fail if not ingested — answer generally)
  const NO_CONTEXT = "(no aggregates available — answer from general knowledge and say so)";
  let ctxStr = NO_CONTEXT;
  if (batchIds.length > 0) {
    const key = aggregatesKey(batchIds);
    let agg = await getAggregates(ctx.tenantId, ctx.accountId, key);
    if (!agg) {
      const records = await getRecords(ctx.tenantId, ctx.accountId, batchIds);
      if (records.length > 0) agg = computeAggregates(records, batchIds, ctx, key);
    }
    if (agg) ctxStr = summary(agg);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You answer questions about a specific set of campaign batches, grounded in the aggregate " +
        "metrics provided. Reference concrete numbers. If the data doesn't contain the answer, say so. " +
        `Campaign aggregates (JSON): ${ctxStr}`,
    },
    ...(body.history ?? []),
    { role: "user", content: message },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      chatLog.info({ hasContext: ctxStr !== NO_CONTEXT }, "chat stream started");
      let chunks = 0;
      try {
        for await (const delta of getLLM().stream(messages)) {
          chunks++;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
        }
        controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
        chatLog.info({ chunks, durationMs: Date.now() - startedAt }, "chat stream completed");
      } catch (err) {
        chatLog.error({ err, chunks, durationMs: Date.now() - startedAt }, "chat stream failed");
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});
