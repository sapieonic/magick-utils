import { describe, it, expect } from "vitest";
import { bulkJobToBatchDoc } from "@/lib/server/map";
import type { RawBulkJob } from "@/lib/server/magick-client";
import type { BatchDoc, TenantContext } from "@/lib/server/types";

const ctx: TenantContext = { tenantId: "t1", accountId: "a1", idToken: "tok" };

const seg = (doc: BatchDoc, key: string) =>
  doc.breakdown.find((s) => s.key === key)?.value ?? 0;

describe("bulkJobToBatchDoc", () => {
  it("derives a breakdown from status_summary (the real upstream field)", () => {
    // Regression for ClickUp 86d3b6qga: the old code read completed_contacts /
    // failed_contacts (which magick-master never sends) → everything pending.
    const job: RawBulkJob = {
      id: "job-1",
      name: "Reminders",
      dispatch_type: "ai_voice_call",
      status: "dispatched",
      total_contacts: 404,
      status_summary: { completed: 300, failed: 40, no_answer: 30, busy: 20, in_progress: 14 },
    };
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(seg(doc, "completed")).toBe(300);
    expect(seg(doc, "failed")).toBe(40);
    expect(seg(doc, "noanswer")).toBe(30);
    expect(seg(doc, "busy")).toBe(20);
    expect(seg(doc, "inprogress")).toBe(14);
    expect(seg(doc, "pending")).toBe(0);
    expect(doc.successRate).toBeCloseTo(300 / 404, 9);
  });

  it("keeps switched_off / voicemail / in_progress as distinct statuses", () => {
    // The granular-status fix: these must NOT collapse into failed / pending.
    const job: RawBulkJob = {
      id: "mbnpl",
      name: "MBNPL_3895_B2_10-06",
      dispatch_type: "ai_voice_call",
      status: "completed",
      total_contacts: 3895,
      status_summary: {
        busy: 1384, completed: 943, switched_off: 794, voicemail: 666,
        failed: 99, no_answer: 8, in_progress: 1,
      },
    };
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(seg(doc, "switchedoff")).toBe(794);
    expect(seg(doc, "failed")).toBe(99);
    expect(seg(doc, "voicemail")).toBe(666);
    expect(seg(doc, "inprogress")).toBe(1);
    expect(seg(doc, "pending")).toBe(0);
    expect(doc.breakdown.reduce((a, b) => a + b.value, 0)).toBe(3895);
  });

  it("does NOT synthesize pending for the total/summary gap (true to backend data)", () => {
    // 60 of the 100 contacts have no call record in core. The old code invented
    // them as "pending"; we now show only what the backend actually reported.
    const job: RawBulkJob = {
      id: "job-2",
      dispatch_type: "ai_voice_call",
      status: "processing",
      total_contacts: 100,
      status_summary: { completed: 30, busy: 10 },
    };
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(seg(doc, "completed")).toBe(30);
    expect(seg(doc, "busy")).toBe(10);
    expect(seg(doc, "pending")).toBe(0);
    expect(doc.breakdown.reduce((a, b) => a + b.value, 0)).toBe(40); // sums to reported, not total
    expect(doc.successRate).toBeCloseTo(30 / 100, 9); // successRate still over total_contacts
  });

  it("collapses only genuinely pre-answer statuses into pending", () => {
    const job: RawBulkJob = {
      id: "job-3",
      dispatch_type: "ai_voice_call",
      status: "processing",
      total_contacts: 10,
      status_summary: { queued: 4, ringing: 3, completed: 3 },
    };
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(seg(doc, "pending")).toBe(7);
    expect(seg(doc, "completed")).toBe(3);
  });

  it("falls back to call_status_counts when status_summary is absent", () => {
    const job: RawBulkJob = {
      id: "job-4",
      dispatch_type: "static_call",
      status: "completed",
      total_contacts: 50,
      status_summary: null,
      call_status_counts: [
        { batch_id: "b1", completed: 20, failed: 5 } as unknown as Record<string, number>,
        { batch_id: "b2", completed: 20, failed: 5 } as unknown as Record<string, number>,
      ],
    };
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(seg(doc, "completed")).toBe(40);
    expect(seg(doc, "failed")).toBe(10);
  });

  it("shows an empty breakdown when the backend reports no counts (no fabricated pending)", () => {
    const job: RawBulkJob = {
      id: "job-5", dispatch_type: "ai_voice_call", status: "queued", total_contacts: 10,
    };
    const doc = bulkJobToBatchDoc(job, ctx);
    expect(doc.breakdown).toEqual([]);
    expect(doc.successRate).toBe(0);
  });

  describe("messaging (no per-message status pre-ingestion)", () => {
    it("completed job → dispatched messages shown as sent", () => {
      const job: RawBulkJob = {
        id: "m1", dispatch_type: "whatsapp_message", status: "completed", total_contacts: 200,
      };
      const doc = bulkJobToBatchDoc(job, ctx);
      expect(doc.selType).toBe("message");
      expect(seg(doc, "sent")).toBe(200);
    });

    it("failed job → failed", () => {
      const job: RawBulkJob = {
        id: "m2", dispatch_type: "telegram_message", status: "failed", total_contacts: 15,
      };
      expect(seg(bulkJobToBatchDoc(job, ctx), "failed")).toBe(15);
    });

    it("queued job → pending", () => {
      const job: RawBulkJob = {
        id: "m3", dispatch_type: "email_message", status: "queued", total_contacts: 8,
      };
      expect(seg(bulkJobToBatchDoc(job, ctx), "pending")).toBe(8);
    });
  });

  it("preserves the ingestion worker's exact breakdown once ingestStatus=ready", () => {
    const existing: BatchDoc = {
      tenantId: "t1", accountId: "a1", batchId: "m4", sourceId: "m4",
      name: "Done", channel: "whatsapp", callType: null, selType: "message",
      provider: "whatsapp", date: "2026-06-10T00:00:00.000Z", total: 200,
      breakdown: [{ key: "read", value: 120 }, { key: "delivered", value: 60 }, { key: "failed", value: 20 }],
      successRate: 120 / 200, spendInr: 0, telephonyInr: 0, aiInr: 0,
      avgDuration: null, avgTalkTime: null, fingerprint: "x",
      ingestStatus: "ready", updatedAt: "2026-06-10T00:00:00.000Z",
    };
    const job: RawBulkJob = {
      id: "m4", dispatch_type: "whatsapp_message", status: "completed", total_contacts: 200,
    };
    const doc = bulkJobToBatchDoc(job, ctx, existing);
    expect(seg(doc, "read")).toBe(120);
    expect(seg(doc, "delivered")).toBe(60);
    expect(seg(doc, "sent")).toBe(0); // not clobbered by the pre-ingestion estimate
  });
});
