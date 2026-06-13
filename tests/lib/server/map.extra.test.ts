import { describe, it, expect } from "vitest";
import { dayAgo, humanBatchId, batchDocToBatch, bulkJobToBatchDoc } from "@/lib/server/map";
import type { BatchDoc } from "@/lib/server/types";
import { makeCtx, makeRawBulkJob } from "./_factories";

describe("dayAgo", () => {
  it("returns 0 for now", () => {
    expect(dayAgo(new Date().toISOString())).toBe(0);
  });

  it("floors fractional days", () => {
    const iso = new Date(Date.now() - 86_400_000 * 2.9).toISOString();
    expect(dayAgo(iso)).toBe(2);
  });

  it("computes whole days ago", () => {
    const iso = new Date(Date.now() - 86_400_000 * 5).toISOString();
    expect(dayAgo(iso)).toBe(5);
  });

  it("clamps future dates to 0", () => {
    const iso = new Date(Date.now() + 86_400_000 * 3).toISOString();
    expect(dayAgo(iso)).toBe(0);
  });
});

describe("humanBatchId", () => {
  it("prefixes per selType", () => {
    expect(humanBatchId("ai", "abcd1234")).toBe("AI-1234");
    expect(humanBatchId("ivr", "abcd1234")).toBe("IVR-1234");
    expect(humanBatchId("whatsapp", "abcd1234")).toBe("WA-1234");
    expect(humanBatchId("telegram", "abcd1234")).toBe("TG-1234");
    expect(humanBatchId("email", "abcd1234")).toBe("EM-1234");
  });

  it("uses 'B' prefix for unknown selType", () => {
    expect(humanBatchId("nope", "abcd1234")).toBe("B-1234");
  });

  it("takes last 4 alphanumerics, uppercased, stripping non-alphanumerics", () => {
    expect(humanBatchId("ai", "job_xy-9z")).toBe("AI-XY9Z");
    expect(humanBatchId("ai", "ab")).toBe("AI-AB"); // fewer than 4
  });

  it("falls back to 0000 when no alphanumerics", () => {
    expect(humanBatchId("ai", "----")).toBe("AI-0000");
    expect(humanBatchId("ai", "")).toBe("AI-0000");
  });
});

describe("batchDocToBatch", () => {
  it("maps fields with id=batchId and computes dayAgo", () => {
    const doc: BatchDoc = {
      tenantId: "t", accountId: "a", batchId: "AI-0001", sourceId: "src",
      name: "Camp", channel: "voice", callType: "ai", provider: "twilio",
      date: new Date(Date.now() - 86_400_000 * 3).toISOString(),
      selType: "ai", total: 100,
      breakdown: [{ key: "completed", value: 80 }],
      successRate: 0.8, spendInr: 50, telephonyInr: 30, aiInr: 20,
      avgDuration: 120, avgTalkTime: 90, fingerprint: "fp",
      ingestStatus: "ready", updatedAt: "x",
    };
    const b = batchDocToBatch(doc);
    expect(b.id).toBe("AI-0001");
    expect(b.batchId).toBe("AI-0001");
    expect(b.name).toBe("Camp");
    expect(b.channel).toBe("voice");
    expect(b.callType).toBe("ai");
    expect(b.provider).toBe("twilio");
    expect(b.dayAgo).toBe(3);
    expect(b.total).toBe(100);
    expect(b.breakdown).toEqual([{ key: "completed", value: 80 }]);
    expect(b.successRate).toBe(0.8);
    expect(b.spendInr).toBe(50);
    expect(b.telephonyInr).toBe(30);
    expect(b.aiInr).toBe(20);
    expect(b.avgDuration).toBe(120);
    expect(b.avgTalkTime).toBe(90);
    // bookkeeping fields are not copied onto the Batch shape
    expect((b as unknown as Record<string, unknown>).sourceId).toBeUndefined();
    expect((b as unknown as Record<string, unknown>).fingerprint).toBeUndefined();
  });
});

describe("bulkJobToBatchDoc (field mapping + edge cases)", () => {
  const ctx = makeCtx();

  it("calls: does NOT synthesize pending from the total/summary gap (true to backend data)", () => {
    const job = makeRawBulkJob({
      dispatch_type: "ai_voice_call",
      total_contacts: 10,
      status_summary: { completed: 6, failed: 2 }, // 2 contacts never became calls — not invented as pending
    });
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(doc.breakdown).toEqual([
      { key: "completed", value: 6 },
      { key: "failed", value: 2 },
    ]);
    expect(doc.successRate).toBe(0.6); // still completed / total_contacts
  });

  it("calls: pending never negative when counts exceed total", () => {
    const job = makeRawBulkJob({
      dispatch_type: "ai_voice_call",
      total_contacts: 5,
      status_summary: { completed: 6, failed: 4 }, // counted 10 > total 5
    });
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(doc.breakdown.find((s) => s.key === "pending")).toBeUndefined();
  });

  it("calls: unknown statuses are dropped and never resurface as pending", () => {
    const job = makeRawBulkJob({
      dispatch_type: "ai_voice_call",
      total_contacts: 5,
      status_summary: { completed: 2, mystery: 2 }, // mystery dropped; gap not invented as pending
    });
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(doc.breakdown).toEqual([{ key: "completed", value: 2 }]);
  });

  it("calls: empty breakdown when total 0 and no counts", () => {
    const job = makeRawBulkJob({ dispatch_type: "ai_voice_call", total_contacts: 0, status_summary: null, call_status_counts: null });
    expect(bulkJobToBatchDoc(job, ctx).breakdown).toEqual([]);
  });

  it("calls: coerces stringy counts and merges duplicate keys from call_status_counts", () => {
    const job = makeRawBulkJob({
      dispatch_type: "ai_voice_call",
      total_contacts: 10,
      status_summary: null,
      call_status_counts: [
        { batch_id: "b1", completed: 3 } as never,
        { completed: "2" as never },
      ],
    });
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(doc.breakdown.find((s) => s.key === "completed")?.value).toBe(5);
  });

  it("calls: breakdown drops zero-value buckets", () => {
    const job = makeRawBulkJob({ dispatch_type: "ai_voice_call", total_contacts: 3, status_summary: { completed: 3, failed: 0 } });
    expect(bulkJobToBatchDoc(job, ctx).breakdown).toEqual([{ key: "completed", value: 3 }]);
  });

  it("messaging: successKey is read, so pre-ingestion successRate is always 0", () => {
    const job = makeRawBulkJob({ dispatch_type: "whatsapp_message", total_contacts: 100, status: "completed" });
    expect(bulkJobToBatchDoc(job, ctx).successRate).toBe(0);
  });

  it("messaging: empty breakdown when total 0", () => {
    const job = makeRawBulkJob({ dispatch_type: "whatsapp_message", total_contacts: 0, status: "dispatched" });
    expect(bulkJobToBatchDoc(job, ctx).breakdown).toEqual([]);
  });

  it("batchId = sourceId when no existing", () => {
    expect(bulkJobToBatchDoc(makeRawBulkJob({ id: "job-77" }), ctx).batchId).toBe("job-77");
  });

  it("batchId = existing.batchId when existing provided", () => {
    const existing = { batchId: "AI-PRETTY", ingestStatus: "none" } as BatchDoc;
    expect(bulkJobToBatchDoc(makeRawBulkJob({ id: "job-77" }), ctx, existing).batchId).toBe("AI-PRETTY");
  });

  it("preserves existing spend figures even pre-ingestion (breakdown still recomputed)", () => {
    const existing = { batchId: "AI-X", ingestStatus: "none", spendInr: 50, telephonyInr: 30, aiInr: 20, avgDuration: 10, avgTalkTime: 5 } as BatchDoc;
    const job = makeRawBulkJob({ dispatch_type: "ai_voice_call", total_contacts: 10, status_summary: { completed: 5 } });
    const doc = bulkJobToBatchDoc(job, ctx, existing);
    expect(doc.spendInr).toBe(50);
    expect(doc.telephonyInr).toBe(30);
    expect(doc.aiInr).toBe(20);
    expect(doc.avgDuration).toBe(10);
    expect(doc.avgTalkTime).toBe(5);
    expect(doc.breakdown).toEqual([{ key: "completed", value: 5 }]); // gap no longer synthesized as pending
  });

  it("spend defaults to 0 / null when no existing", () => {
    const doc = bulkJobToBatchDoc(makeRawBulkJob({ dispatch_type: "ai_voice_call", total_contacts: 1, status_summary: { completed: 1 } }), ctx);
    expect(doc.spendInr).toBe(0);
    expect(doc.telephonyInr).toBe(0);
    expect(doc.aiInr).toBe(0);
    expect(doc.avgDuration).toBeNull();
    expect(doc.avgTalkTime).toBeNull();
  });

  it("maps name fallback to batchId, provider fallback to channel, sourceId from id", () => {
    const job = makeRawBulkJob({ id: "job-5", name: null, provider: null, dispatch_type: "telegram_message", total_contacts: 2, status: "dispatched" });
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(doc.channel).toBe("telegram");
    expect(doc.callType).toBeNull();
    expect(doc.selType).toBe("message");
    expect(doc.name).toBe("job-5");
    expect(doc.provider).toBe("telegram");
    expect(doc.sourceId).toBe("job-5");
    expect(doc.ingestStatus).toBe("none");
  });

  it("fingerprint is a 16-hex string", () => {
    expect(bulkJobToBatchDoc(makeRawBulkJob(), ctx).fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});
