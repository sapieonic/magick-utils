import { isBackendConfigured } from "@/lib/server/env";
import { getTenantContext } from "@/lib/server/session";
import { countRecords, getBatch, streamRecords } from "@/lib/server/repositories";
import type { NormalizedRecord } from "@/lib/server/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvEscape(v: string): string {
  if (v == null) return "";
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
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

async function handle(batchIds: string[], columns: string[], ctx: { tenantId: string; accountId: string }) {
  if (batchIds.length === 0) return Response.json({ error: "no_batches" }, { status: 400 });

  const count = await countRecords(ctx.tenantId, ctx.accountId, batchIds);
  if (count === 0) {
    return Response.json({ error: "not_ingested", message: "Run ingestion for these batches first." }, { status: 409 });
  }

  const nameById = new Map<string, string>();
  for (const id of batchIds) {
    const b = await getBatch(ctx.tenantId, ctx.accountId, id).catch(() => null);
    if (b) nameById.set(id, b.name);
  }
  const cols = columns.length > 0 ? columns : DEFAULT_COLS;
  const cursor = await streamRecords(ctx.tenantId, ctx.accountId, batchIds);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(cols.map(csvEscape).join(",") + "\n"));
      try {
        for await (const rec of cursor) {
          const row = cols.map((c) => csvEscape(colValue(rec, c, nameById))).join(",");
          controller.enqueue(enc.encode(row + "\n"));
        }
      } catch (err) {
        controller.error(err);
        return;
      } finally {
        await cursor.close().catch(() => {});
      }
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

export async function POST(req: Request) {
  if (!isBackendConfigured()) return Response.json({ error: "backend_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: "not_authenticated" }, { status: 401 });
  let body: { batchIds?: string[]; columns?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  return handle((body.batchIds ?? []).filter(Boolean), body.columns ?? [], ctx);
}

export async function GET(req: Request) {
  if (!isBackendConfigured()) return Response.json({ error: "backend_not_configured" }, { status: 503 });
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: "not_authenticated" }, { status: 401 });
  const url = new URL(req.url);
  const batchIds = (url.searchParams.get("batchIds") ?? "").split(",").filter(Boolean);
  const columns = (url.searchParams.get("columns") ?? "").split(",").filter(Boolean);
  return handle(batchIds, columns, ctx);
}
