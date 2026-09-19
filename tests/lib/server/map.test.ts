import { describe, it, expect } from "vitest";
import { bulkJobIsUnchangedSince, bulkJobSourceFingerprint, bulkJobToBatchDoc } from "@/lib/server/map";
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
      avgDuration: null, avgTalkTime: null, fingerprint: "x", sourceFingerprint: "source-fp",
      ingestStatus: "ready", updatedAt: "2026-06-10T00:00:00.000Z",
    };
    const job: RawBulkJob = {
      id: "m4", dispatch_type: "whatsapp_message", status: "completed", total_contacts: 200,
    };
    const initial = bulkJobToBatchDoc(job, ctx);
    const doc = bulkJobToBatchDoc(job, ctx, { ...existing, sourceFingerprint: initial.sourceFingerprint });
    expect(seg(doc, "read")).toBe(120);
    expect(seg(doc, "delivered")).toBe(60);
    expect(seg(doc, "sent")).toBe(0); // not clobbered by the pre-ingestion estimate
  });

  it("preserves the committed unique total when the upstream raw total includes duplicates", () => {
    const job: RawBulkJob = {
      id: "deduped", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 369,
      updated_at: "2026-08-12T10:00:00Z",
    };
    const source = bulkJobToBatchDoc(job, ctx);
    const committed: BatchDoc = {
      ...source,
      total: 359,
      ingestStatus: "ready", ingestedSourceFingerprint: source.sourceFingerprint,
      publishedRevision: "revision-1",
      fingerprint: "dataset-fp",
    };

    const refreshed = bulkJobToBatchDoc(job, ctx, committed);

    expect(refreshed.total).toBe(359);
    // The ingested count wins for `total`, but the dispatched figure is
    // upstream's own and is never replaced by it.
    expect(refreshed.sourceTotal).toBe(369);
    expect(refreshed.ingestStatus).toBe("ready");
    expect(refreshed.publishedRevision).toBe("revision-1");
  });

  // A zero-record commit used to pull `total` down to 0 and take the dispatched
  // count with it, leaving nothing to prove records were missing — and silencing
  // the worker guard that reads it on the next refresh.
  it("keeps the dispatched count after a commit that ingested nothing", () => {
    const job: RawBulkJob = {
      id: "empty-ingest", dispatch_type: "static_call", status: "completed", total_contacts: 3475,
      updated_at: "2026-09-18T10:00:00Z",
    };
    const source = bulkJobToBatchDoc(job, ctx);
    const committed: BatchDoc = {
      ...source,
      total: 0,
      ingestStatus: "ready", ingestedSourceFingerprint: source.sourceFingerprint,
      publishedRevision: "revision-1",
      fingerprint: "dataset-fp",
    };

    const refreshed = bulkJobToBatchDoc(job, ctx, committed);

    expect(refreshed.total).toBe(0);
    expect(refreshed.sourceTotal).toBe(3475);
  });

  it("marks a committed dataset stale when the upstream revision changes", () => {
    const first = bulkJobToBatchDoc({
      id: "job-stale", dispatch_type: "ai_voice_call", status: "processing",
      total_contacts: 10, updated_at: "2026-08-12T10:00:00Z",
    }, ctx);
    const committed: BatchDoc = { ...first, ingestStatus: "ready", fingerprint: "dataset-fp" };
    const refreshed = bulkJobToBatchDoc({
      id: "job-stale", dispatch_type: "ai_voice_call", status: "completed",
      total_contacts: 12, updated_at: "2026-08-12T11:00:00Z",
    }, ctx, committed);
    // "stale", never "none": the published revision is still what every reader
    // sees, so analytics must keep serving it instead of 409-ing and re-pulling.
    expect(refreshed.ingestStatus).toBe("stale");
    expect(refreshed.fingerprint).toBe("dataset-fp");
    expect(refreshed.sourceFingerprint).not.toBe(committed.sourceFingerprint);
    // The ingested record count must not flip back to the raw contact count —
    // that is what made the header total jump between page loads.
    expect(refreshed.total).toBe(committed.total);
  });

  it("ignores updated_at churn, which upstream bumps without changing records", () => {
    const base: RawBulkJob = {
      id: "job-churn", dispatch_type: "ai_voice_call", status: "processing",
      total_contacts: 10, status_summary: { completed: 4 }, updated_at: "2026-08-12T10:00:00Z",
    };
    const first = bulkJobToBatchDoc(base, ctx);
    const committed: BatchDoc = {
      ...first, ingestStatus: "ready", total: 9, fingerprint: "dataset-fp",
      ingestedSourceFingerprint: first.sourceFingerprint,
    };
    const refreshed = bulkJobToBatchDoc({ ...base, updated_at: "2026-08-12T11:30:00Z" }, ctx, committed);
    expect(refreshed.sourceFingerprint).toBe(committed.sourceFingerprint);
    expect(refreshed.ingestStatus).toBe("ready");
    expect(refreshed.total).toBe(9);
  });

  // A batch ingested before markers existed cannot be proven in step with its
  // source, so it reads as stale until the next ingestion stamps one.
  it("treats an ingested batch with no marker as stale", () => {
    const job: RawBulkJob = {
      id: "job-legacy", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 10,
    };
    const legacy: BatchDoc = { ...bulkJobToBatchDoc(job, ctx), ingestStatus: "ready", total: 9 };
    expect(bulkJobToBatchDoc(job, ctx, legacy).ingestStatus).toBe("stale");
  });

  // Comparing each listing against the previous one let a transient upstream
  // blip latch a batch to "stale" with no way back, since only a publish clears
  // it. The comparison must be against what the published revision was built
  // from, so a recovered source resolves the batch to "ready" again.
  it("returns to ready when a transient upstream blip reverses", () => {
    const job: RawBulkJob = {
      id: "job-blip", dispatch_type: "ai_voice_call", status: "completed",
      total_contacts: 10, status_summary: { completed: 10 },
    };
    const ingested = bulkJobToBatchDoc(job, ctx);
    const committed: BatchDoc = {
      ...ingested, ingestStatus: "ready", total: 10,
      ingestedSourceFingerprint: ingested.sourceFingerprint,
    };
    // Core briefly unreachable: status_summary comes back null.
    const blipped = bulkJobToBatchDoc({ ...job, status_summary: null }, ctx, committed);
    expect(blipped.ingestStatus).toBe("stale");
    // Core recovers and reports exactly what it did before.
    expect(bulkJobToBatchDoc(job, ctx, blipped).ingestStatus).toBe("ready");
  });

  it("keeps a stale batch's ingested figures across further listings", () => {
    const first = bulkJobToBatchDoc({
      id: "job-stale-2", dispatch_type: "ai_voice_call", status: "processing", total_contacts: 10,
    }, ctx);
    const stale: BatchDoc = {
      ...first, ingestStatus: "stale", total: 9, spendInr: 42, fingerprint: "dataset-fp",
    };
    const refreshed = bulkJobToBatchDoc({
      id: "job-stale-2", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 11,
    }, ctx, stale);
    expect(refreshed.ingestStatus).toBe("stale");
    expect(refreshed.total).toBe(9);
    expect(refreshed.spendInr).toBe(42);
  });

  it("does not copy worker ownership fields from an existing batch", () => {
    const job: RawBulkJob = {
      id: "job-lock", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 1,
    };
    const existing: BatchDoc = {
      tenantId: "t1", accountId: "a1", batchId: "job-lock", sourceId: "job-lock",
      name: "Locked", channel: "voice", callType: "ai", selType: "ai",
      provider: "voice", date: "2026-08-12T00:00:00.000Z", total: 1,
      breakdown: [], successRate: 0, spendInr: 0, telephonyInr: 0, aiInr: 0,
      avgDuration: null, avgTalkTime: null, fingerprint: "fp",
      ingestStatus: "ingesting", ingestJobId: "old-job", ingestLeaseId: "old-lease",
      ingestLeaseUntil: "2099-01-01T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
    };
    const doc = bulkJobToBatchDoc(job, ctx, existing);
    expect(doc.ingestJobId).toBeUndefined();
    expect(doc.ingestLeaseId).toBeUndefined();
    expect(doc.ingestLeaseUntil).toBeUndefined();
  });

});

describe("bulkJobIsUnchangedSince", () => {
  const done = (over: Partial<RawBulkJob> = {}): RawBulkJob => ({
    id: "job-1", dispatch_type: "ai_voice_call", status: "completed",
    total_contacts: 10, updated_at: "2026-09-01T10:00:00Z", ...over,
  });

  it("is true only when a finished job has not been touched since ingestion", () => {
    expect(bulkJobIsUnchangedSince(done(), "2026-09-01T10:00:00Z")).toBe(true);
  });

  it("is false once upstream writes to the job again", () => {
    expect(bulkJobIsUnchangedSince(done({ updated_at: "2026-09-01T11:00:00Z" }), "2026-09-01T10:00:00Z")).toBe(false);
  });

  // status_summary and call_status_counts are call-dispatch-only, so for a
  // messaging campaign the summary fingerprint is frozen from dispatch onward.
  // Delivery receipts, read receipts and replies move only updated_at — without
  // that check "Refresh data" would be a permanent no-op for messaging.
  it("catches messaging receipts, which move no summary field", () => {
    const base = { id: "job-wa", dispatch_type: "whatsapp", status: "completed", total_contacts: 5000 };
    const atIngest: RawBulkJob = { ...base, updated_at: "2026-09-01T10:00:00Z" };
    const later: RawBulkJob = { ...base, updated_at: "2026-09-01T12:30:00Z" };
    expect(bulkJobSourceFingerprint(atIngest)).toBe(bulkJobSourceFingerprint(later));
    expect(bulkJobIsUnchangedSince(later, atIngest.updated_at)).toBe(false);
  });

  it("never skips a job that is still running", () => {
    for (const status of ["processing", "queued", "in_progress", "", undefined]) {
      expect(bulkJobIsUnchangedSince(done({ status }), "2026-09-01T10:00:00Z")).toBe(false);
    }
  });

  it("never skips without a stamp — a legacy or never-ingested batch", () => {
    expect(bulkJobIsUnchangedSince(done(), null)).toBe(false);
    expect(bulkJobIsUnchangedSince(done(), undefined)).toBe(false);
  });

  it("never skips when upstream sends no updated_at at all", () => {
    expect(bulkJobIsUnchangedSince(done({ updated_at: null }), null)).toBe(false);
  });
});

describe("bulkJobSourceFingerprint", () => {
  // Upstream may serialize these maps in any order (a Go map, a re-ordered
  // group-by). Order alone reading as "the data moved" is the churn this whole
  // fingerprint exists to avoid, arriving by another route.
  it("ignores key order in the upstream summaries", () => {
    const a: RawBulkJob = {
      id: "j", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 5,
      status_summary: { completed: 4, failed: 1 },
      call_status_counts: [{ batch_id: 1, completed: 4, failed: 1 } as never],
    };
    const b: RawBulkJob = {
      id: "j", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 5,
      status_summary: { failed: 1, completed: 4 },
      call_status_counts: [{ failed: 1, completed: 4, batch_id: 1 } as never],
    };
    expect(bulkJobSourceFingerprint(a)).toBe(bulkJobSourceFingerprint(b));
  });

  // call_status_counts is a SET of per-batch rows assembled from webhook
  // arrivals, so upstream can serve the same rows in a different order. Reading
  // a reshuffle as a change cost a full duplicate re-ingest.
  it("ignores row order in call_status_counts", () => {
    const base = { id: "j", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 9 };
    const a: RawBulkJob = {
      ...base,
      call_status_counts: [
        { batch_id: 1, completed: 4, failed: 1 } as never,
        { batch_id: 2, completed: 3, failed: 1 } as never,
      ],
    };
    const b: RawBulkJob = {
      ...base,
      call_status_counts: [
        { batch_id: 2, failed: 1, completed: 3 } as never,
        { failed: 1, batch_id: 1, completed: 4 } as never,
      ],
    };
    expect(bulkJobSourceFingerprint(a)).toBe(bulkJobSourceFingerprint(b));
  });

  it("still changes when a row's counts change, whatever the order", () => {
    const base = { id: "j", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 9 };
    const a: RawBulkJob = { ...base, call_status_counts: [{ batch_id: 1, completed: 4 } as never] };
    const b: RawBulkJob = { ...base, call_status_counts: [{ batch_id: 1, completed: 5 } as never] };
    expect(bulkJobSourceFingerprint(a)).not.toBe(bulkJobSourceFingerprint(b));
  });

  it("still changes when a count actually changes", () => {
    const base: RawBulkJob = { id: "j", dispatch_type: "ai_voice_call", status: "completed", total_contacts: 5 };
    expect(bulkJobSourceFingerprint({ ...base, status_summary: { completed: 4 } }))
      .not.toBe(bulkJobSourceFingerprint({ ...base, status_summary: { completed: 5 } }));
  });
});
