import { NextResponse } from "next/server";
import { isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getInsight, getRecords, setAggregates, setInsight } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";
import { aggregatesKey, batchSetKey } from "@/lib/server/fingerprint";
import { getLLM, INSIGHT_SCHEMA, type ChatMessage } from "@/lib/server/llm";
import type { AggregatesDoc, Insight } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contextString(agg: AggregatesDoc): string {
  return JSON.stringify(
    {
      totalRecords: agg.totalRecords,
      successRate: Number((agg.successRate * 100).toFixed(1)),
      statusMix: agg.statusMix,
      spendInr: Math.round(agg.spendInr),
      telephonyInr: Math.round(agg.telephonyInr),
      aiInr: Math.round(agg.aiInr),
      sentiment: agg.sentiment,
      topTopics: agg.topics?.slice(0, 8),
      funnel: agg.funnel,
    },
    null,
    2,
  );
}

export const POST = withLogging("insights", async (req: Request) => {
  if (!isBackendConfigured()) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  if (!isLlmConfigured()) return NextResponse.json({ error: "llm_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: string[]; model?: string; refresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const batchIds = (body.batchIds ?? []).filter(Boolean);
  if (batchIds.length === 0) return NextResponse.json({ error: "no_batches" }, { status: 400 });
  const model = body.model ?? "default";
  const aggKey = aggregatesKey(batchIds);
  // Insight cache is keyed on the bare batch-set fingerprint so aggregate-shape
  // version bumps don't needlessly invalidate (and re-bill) generated insights.
  const insightKey = `${batchSetKey(batchIds)}:${model}`;

  if (!body.refresh) {
    const cached = await getInsight(ctx.tenantId, ctx.accountId, insightKey);
    if (cached) {
      log().info({ batchCount: batchIds.length, model, cached: true }, "insight served from cache");
      return NextResponse.json({ insight: cached, cached: true });
    }
  }

  // ensure aggregates
  let agg = await getAggregates(ctx.tenantId, ctx.accountId, aggKey);
  if (!agg) {
    const records = await getRecords(ctx.tenantId, ctx.accountId, batchIds);
    if (records.length === 0) {
      log().warn({ batchCount: batchIds.length }, "insight requested for un-ingested batches");
      return NextResponse.json({ error: "not_ingested", message: "Run ingestion first." }, { status: 409 });
    }
    agg = computeAggregates(records, batchIds, ctx, aggKey);
    await setAggregates(agg);
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a campaign analytics expert for an outbound voice & messaging platform. " +
        "Given aggregate metrics for a set of campaign batches, produce a JSON insight with three " +
        "fields: a plain-English `narrative`, a list of notable `anomalies` (each with supporting " +
        "numbers and a severity), and actionable `recommendations`.\n" +
        "Requirements for `narrative`: 3–6 sentences of finished, business-ready prose that reference " +
        "the actual figures. It must be the final analysis ONLY — do not include your own reasoning, " +
        "planning, working notes, self-corrections, delimiters, or any meta-commentary about the task, " +
        "the JSON, the schema, or 'the output'. Write as if for a stakeholder who will never see your " +
        "thought process.\n" +
        "Keep every field strictly grounded in the data provided — do not invent costs, sentiment, " +
        "outcomes, or metrics that are not present (e.g. if spend or sentiment is zero/empty, say so " +
        "rather than fabricating).",
    },
    { role: "user", content: `Campaign aggregates (JSON):\n${contextString(agg)}\n\nProduce the insight.` },
  ];

  try {
    const startedAt = Date.now();
    log().info({ batchCount: batchIds.length, model, refresh: Boolean(body.refresh) }, "generating insight via LLM");
    const payload = await getLLM().structured(messages, INSIGHT_SCHEMA, { model: undefined });
    log().info(
      {
        durationMs: Date.now() - startedAt,
        anomalies: payload.anomalies.length,
        recommendations: payload.recommendations.length,
      },
      "insight generated",
    );
    const insight: Insight = {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      key: insightKey,
      fingerprint: aggKey,
      model,
      narrative: payload.narrative,
      anomalies: payload.anomalies,
      recommendations: payload.recommendations,
      createdAt: new Date().toISOString(),
    };
    await setInsight(insight);
    return NextResponse.json({ insight, cached: false });
  } catch (err) {
    log().error({ err, batchCount: batchIds.length, model }, "insight generation failed");
    return NextResponse.json({ error: "llm_failed", detail: String(err) }, { status: 502 });
  }
});
