import { NextResponse } from "next/server";
import { env, isBackendConfigured, isLlmConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { getAggregates, getBatch, getInsight, getRecords, setAggregates, setInsight } from "@/lib/server/repositories";
import { computeAggregates } from "@/lib/server/aggregate";
import { diffAggregates } from "@/lib/diff";
import { aggregatesKey, compareKey } from "@/lib/server/fingerprint";
import { getLLM, INSIGHT_SCHEMA, type ChatMessage } from "@/lib/server/llm";
import type { AggregatesDiff, AggregatesDoc, Insight, TenantContext } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ensure aggregates exist for a batch set, computing-on-miss from ingested
 *  records (parity with /api/analytics). Returns null when nothing is ingested
 *  so the caller can surface a 409. */
async function ensureAggregates(ctx: TenantContext, batchIds: string[]): Promise<AggregatesDoc | null> {
  const key = aggregatesKey(batchIds);
  const cached = await getAggregates(ctx.tenantId, ctx.accountId, key);
  if (cached) return cached;
  const records = await getRecords(ctx.tenantId, ctx.accountId, batchIds);
  if (records.length === 0) return null;
  const agg = computeAggregates(records, batchIds, ctx, key);
  await setAggregates(agg);
  return agg;
}

/** Compacted diff for the prompt — rounds money/percentages and keeps only the
 *  most-moved topic/status/sentiment shifts so the model gets signal, not noise. */
function diffContext(diff: AggregatesDiff): string {
  const pp = (x: number) => Number(x.toFixed(1));
  const shareList = (xs: { key: string; deltaShare: number }[]) =>
    xs.slice(0, 6).map((s) => ({ key: s.key, deltaSharePct: Number((s.deltaShare * 100).toFixed(1)) }));
  return JSON.stringify(
    {
      currentRecords: diff.current.totalRecords,
      baselineRecords: diff.baseline.totalRecords,
      successRate: { currentPct: pp(diff.successRate.current * 100), baselinePct: pp(diff.successRate.baseline * 100), deltaPp: pp(diff.successRate.deltaPp) },
      spendInr: { current: Math.round(diff.spendInr.current), baseline: Math.round(diff.spendInr.baseline), deltaPct: diff.spendInr.relative == null ? null : Math.round(diff.spendInr.relative * 100) },
      telephonyInr: { deltaPct: diff.telephonyInr.relative == null ? null : Math.round(diff.telephonyInr.relative * 100) },
      aiInr: { deltaPct: diff.aiInr.relative == null ? null : Math.round(diff.aiInr.relative * 100) },
      telephonyShareShiftPp: pp(diff.costSplit.deltaShare * 100),
      volumeDelta: diff.volume.delta,
      topicShifts: shareList(diff.topicShifts),
      statusMixShifts: shareList(diff.statusMixShift),
      sentimentShifts: shareList(diff.sentimentShift),
      funnelShifts: diff.funnelShifts?.map((f) => ({ stage: f.stage, retentionShiftPp: pp(f.deltaShareOfSent * 100) })),
    },
    null,
    2,
  );
}

export const POST = withLogging("insights-compare", async (req: Request) => {
  if (!isBackendConfigured()) return NextResponse.json({ error: "backend_not_configured" }, { status: 503 });
  if (!isLlmConfigured()) return NextResponse.json({ error: "llm_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });

  let body: { batchIds?: string[]; baselineBatchIds?: string[]; refresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const batchIds = (body.batchIds ?? []).filter(Boolean);
  const baselineBatchIds = (body.baselineBatchIds ?? []).filter(Boolean);
  if (batchIds.length === 0) return NextResponse.json({ error: "no_batches" }, { status: 400 });
  if (baselineBatchIds.length === 0) return NextResponse.json({ error: "no_baseline" }, { status: 400 });
  const model = env.llm.model;

  // Server-side selType guard — never trust the client. Recompute from the
  // cached BatchDocs; any cross-type set across the two sides is rejected.
  const allIds = [...new Set([...batchIds, ...baselineBatchIds])];
  const batchDocs = await Promise.all(allIds.map((id) => getBatch(ctx.tenantId, ctx.accountId, id)));
  const selTypes = new Set(batchDocs.filter(Boolean).map((b) => b!.selType));
  if (selTypes.size > 1) {
    return NextResponse.json({ error: "seltype_mismatch", message: "Compare batches of the same type." }, { status: 400 });
  }

  const cacheKey = compareKey(batchIds, baselineBatchIds, model);
  if (!body.refresh) {
    const cached = await getInsight(ctx.tenantId, ctx.accountId, cacheKey);
    if (cached) {
      log().info({ batchCount: batchIds.length, baselineCount: baselineBatchIds.length, model, cached: true }, "comparison served from cache");
      return NextResponse.json({ insight: cached, cached: true });
    }
  }

  const [current, baseline] = await Promise.all([ensureAggregates(ctx, batchIds), ensureAggregates(ctx, baselineBatchIds)]);
  if (!current || !baseline) {
    log().warn({ hasCurrent: Boolean(current), hasBaseline: Boolean(baseline) }, "comparison requested for un-ingested batches");
    return NextResponse.json({ error: "not_ingested", message: "Run ingestion on both selections first." }, { status: 409 });
  }

  const diff = diffAggregates(current, baseline);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a campaign analytics expert for an outbound voice & messaging platform. " +
        "You are given a DETERMINISTIC diff between a CURRENT campaign selection and a BASELINE " +
        "(all deltas are current − baseline, already computed — never recompute or contradict them). " +
        "Produce a JSON insight with three fields:\n" +
        "- `narrative`: 3–6 sentences of finished, business-ready prose explaining WHAT CHANGED and the " +
        "likely WHY, citing the actual deltas (e.g. 'answer rate rose 4.3 points'). Treat a falling cost " +
        "as an improvement and a falling answer/read rate as a regression.\n" +
        "- `anomalies`: notable REGRESSIONS (metrics that worsened), each with the signed delta and a severity.\n" +
        "- `recommendations`: 'do more of what worked' — actions that double down on the metrics that improved.\n" +
        "Rules: stay strictly grounded in the diff; if every delta is ~0 say there was no material change " +
        "rather than inventing one; when a relative % is null (baseline was zero) do not over-read it. " +
        "The narrative must be the final analysis ONLY — no reasoning, planning, meta-commentary, or notes about the JSON.",
    },
    { role: "user", content: `Comparison diff (JSON, deltas are current − baseline):\n${diffContext(diff)}\n\nProduce the comparison insight.` },
  ];

  try {
    const startedAt = Date.now();
    log().info({ batchCount: batchIds.length, baselineCount: baselineBatchIds.length, model, refresh: Boolean(body.refresh) }, "generating comparison via LLM");
    const payload = await getLLM().structured(messages, INSIGHT_SCHEMA, { model: undefined });
    log().info({ durationMs: Date.now() - startedAt, anomalies: payload.anomalies.length, recommendations: payload.recommendations.length }, "comparison generated");
    const insight: Insight = {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      key: cacheKey,
      fingerprint: cacheKey,
      model,
      narrative: payload.narrative,
      anomalies: payload.anomalies,
      recommendations: payload.recommendations,
      createdAt: new Date().toISOString(),
    };
    await setInsight(insight);
    return NextResponse.json({ insight, cached: false });
  } catch (err) {
    log().error({ err, batchCount: batchIds.length, baselineCount: baselineBatchIds.length, model }, "comparison generation failed");
    return NextResponse.json({ error: "llm_failed", detail: String(err) }, { status: 502 });
  }
});
