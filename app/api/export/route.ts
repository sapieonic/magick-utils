import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { countRecords, getBatch, streamRecords } from "@/lib/server/repositories";
import type { NormalizedRecord } from "@/lib/server/types";
import { withLogging } from "@/lib/server/http-log";
import { log } from "@/lib/server/logger";
import { setRequestContext } from "@/lib/server/observability/request-context";
import { parseBatchIds, selectionErrorResponse, validateSelection } from "@/lib/server/selection";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvEscape(v: string): string {
  if (v == null) return "";
  const dangerous = /^[\t\r\n]/.test(v) || /^[\u0000-\u0020]*[=+\-@]/.test(v);
  const safe = dangerous ? `'${v}` : v;
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function colValue(r: NormalizedRecord, col: string, nameById: Map<string, string>): string {
  const s = (x: unknown): string => (x == null ? "" : String(x));
  switch (col) {
    case "record_id": return s(r.recordId);
    case "call_id": return s(r.recordId);
    case "message_id": return s(r.messageId ?? r.recordId);
    case "campaign_name": return s(nameById.get(r.batchId) ?? r.batchId);
    case "channel": return s(r.channel);
    case "recipient_phone": return s(r.recipientPhone ?? r.recipientEmail);
    case "status": return s(r.status);
    case "outcome": return s(r.outcome);
    case "timestamp": return s(r.timestamp);
    case "provider": return s(r.provider);
    case "total_cost_inr": return s(r.totalCostInr);
    case "telephony_cost_inr": return s(r.telephonyCostInr);
    case "ai_cost_inr": return s(r.aiCostInr);
    case "duration_seconds": return s(r.durationSeconds);
    case "talk_time_seconds": return s(r.talkTimeSeconds);
    case "recording_url": return s(r.recordingUrl);
    case "transcript": return s(r.transcript);
    case "conversation_summary": return s(r.conversationSummary);
    case "sentiment": return s(r.sentiment);
    case "key_topics": return s(r.keyTopics?.join("; "));
    case "dtmf_input": return s(r.dtmfInput);
    case "ivr_path": return s(r.ivrPath);
    case "completed_node": return s(r.completedNode);
    case "delivered_at": return s(r.deliveredAt);
    case "read_at": return s(r.readAt);
    case "reply_text": return s(r.replyText);
    case "template_name": return s(r.templateName);
    case "bounce_reason": return s(r.bounceReason);
    default: return "";
  }
}

const DEFAULT_COLS = ["record_id", "campaign_name", "channel", "recipient_phone", "status", "outcome", "timestamp", "total_cost_inr"];
const VALID_COLS = new Set([
  "record_id", "call_id", "message_id", "campaign_name", "channel", "recipient_phone", "status", "outcome",
  "timestamp", "provider", "total_cost_inr", "telephony_cost_inr", "ai_cost_inr", "duration_seconds",
  "talk_time_seconds", "recording_url", "transcript", "conversation_summary", "sentiment", "key_topics",
  "dtmf_input", "ivr_path", "completed_node", "delivered_at", "read_at", "reply_text", "template_name", "bounce_reason",
]);

async function handle(rawBatchIds: unknown, rawColumns: unknown, ctx: { tenantId: string; accountId: string; idToken: string }) {
  let batchIds: string[];
  try {
    batchIds = parseBatchIds(rawBatchIds);
    await validateSelection(ctx, batchIds, { requireReady: true, verifyCounts: true });
  } catch (error) {
    const response = selectionErrorResponse(error);
    if (response) return response;
    throw error;
  }
  if (!Array.isArray(rawColumns) || rawColumns.some((column) => typeof column !== "string") || rawColumns.length > 40) {
    return Response.json({ error: "invalid_columns" }, { status: 400 });
  }
  const columns = [...new Set(rawColumns as string[])];
  if (columns.some((column) => !VALID_COLS.has(column))) return Response.json({ error: "invalid_columns" }, { status: 400 });
  const count = await countRecords(ctx.tenantId, ctx.accountId, batchIds);

  const nameById = new Map<string, string>();
  for (const id of batchIds) {
    const b = await getBatch(ctx.tenantId, ctx.accountId, id).catch(() => null);
    if (b) nameById.set(id, b.name);
  }
  const cols = columns.length > 0 ? columns : DEFAULT_COLS;
  const cursor = await streamRecords(ctx.tenantId, ctx.accountId, batchIds);

  const exportLog = log().child({ batchCount: batchIds.length, recordCount: count, columns: cols.length });
  exportLog.info("CSV export started");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const startedAt = Date.now();
      let rows = 0;
      controller.enqueue(enc.encode(cols.map(csvEscape).join(",") + "\n"));
      try {
        for await (const rec of cursor) {
          rows++;
          const row = cols.map((c) => csvEscape(colValue(rec, c, nameById))).join(",");
          controller.enqueue(enc.encode(row + "\n"));
        }
      } catch (err) {
        exportLog.error({ err, rows }, "CSV export stream failed");
        controller.error(err);
        return;
      } finally {
        await cursor.close().catch(() => {});
      }
      exportLog.info({ rows, durationMs: Date.now() - startedAt }, "CSV export completed");
      controller.close();
    },
  });

  const filename = batchIds.length === 1 ? `${batchIds[0]}.csv` : `combined-${batchIds.length}-batches.csv`;
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function preflight(rawBatchIds: unknown, rawColumns: unknown, ctx: { tenantId: string; accountId: string; idToken: string }) {
  try {
    const batchIds = parseBatchIds(rawBatchIds);
    await validateSelection(ctx, batchIds, { requireReady: true, verifyCounts: true });
    if (!Array.isArray(rawColumns) || rawColumns.some((column) => typeof column !== "string") || rawColumns.length > 40) {
      return Response.json({ error: "invalid_columns" }, { status: 400 });
    }
    const columns = [...new Set(rawColumns as string[])];
    if (columns.some((column) => !VALID_COLS.has(column))) {
      return Response.json({ error: "invalid_columns" }, { status: 400 });
    }
    return Response.json({ ready: true });
  } catch (error) {
    const response = selectionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export const POST = withLogging("export", async (req: Request) => {
  if (!isBackendConfigured()) return Response.json({ error: "backend_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });
  let body: { batchIds?: unknown; columns?: unknown };
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    const response = jsonBodyErrorResponse(error);
    if (response) return response;
    throw error;
  }
  return handle(body?.batchIds, body?.columns ?? [], ctx);
});

export const GET = withLogging("export", async (req: Request) => {
  if (!isBackendConfigured()) return Response.json({ error: "backend_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: "not_authenticated" }, { status: 401 });
  setRequestContext({ tenantId: ctx.tenantId, accountId: ctx.accountId });
  const url = new URL(req.url);
  const batchIds = (url.searchParams.get("batchIds") ?? "").split(",").filter(Boolean);
  const columns = (url.searchParams.get("columns") ?? "").split(",").filter(Boolean);
  if (url.searchParams.get("preflight") === "1") return preflight(batchIds, columns, ctx);
  return handle(batchIds, columns, ctx);
});
