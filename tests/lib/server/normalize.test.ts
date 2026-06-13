import { describe, it, expect } from "vitest";
import {
  normalizeStatus,
  dispatchTypeToType,
  normalizeCall,
  normalizeMessage,
  buildBatchDoc,
  batchDocOptsFromJob,
} from "@/lib/server/normalize";
import type { BuildBatchDocOpts } from "@/lib/server/normalize";
import { makeCtx, makeRawCall, makeRawMessage, makeRawBulkJob, makeRecord } from "./_factories";

describe("normalizeStatus", () => {
  // Every key in CALL_STATUS_MAP
  const callCases: Array<[string, string]> = [
    ["completed", "completed"],
    ["failed", "failed"],
    ["escalate_human", "failed"],
    ["switched_off", "switchedoff"],
    ["no_answer", "noanswer"],
    ["busy", "busy"],
    ["voicemail", "voicemail"],
    ["in_progress", "inprogress"],
    ["queued", "pending"],
    ["initiating", "pending"],
    ["ringing", "pending"],
  ];
  it.each(callCases)("maps call status %s -> %s", (input: string, expected: string) => {
    expect(normalizeStatus(input, "call")).toBe(expected);
  });

  // Every key in MESSAGE_STATUS_MAP
  const messageCases: Array<[string, string]> = [
    ["read", "read"],
    ["opened", "read"],
    ["delivered", "delivered"],
    ["clicked", "delivered"],
    ["bounced", "bounced"],
    ["undelivered", "bounced"],
    ["complained", "bounced"],
    ["failed", "failed"],
    ["queued", "sent"],
    ["sending", "sent"],
    ["sent", "sent"],
  ];
  it.each(messageCases)("maps message status %s -> %s", (input: string, expected: string) => {
    expect(normalizeStatus(input, "message")).toBe(expected);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeStatus("  COMPLETED  ", "call")).toBe("completed");
    expect(normalizeStatus("No_Answer", "call")).toBe("noanswer");
    expect(normalizeStatus("  Read ", "message")).toBe("read");
  });

  it("passes unknown status through unchanged (raw, not lowercased)", () => {
    expect(normalizeStatus("WeirdStatus", "call")).toBe("WeirdStatus");
    expect(normalizeStatus("WeirdStatus", "message")).toBe("WeirdStatus");
  });

  it("returns the raw value for empty input", () => {
    // "" lowercased/trimmed not in map -> falls back to the original raw ""
    expect(normalizeStatus("", "call")).toBe("");
  });

  it("handles undefined input (coerced to '')", () => {
    // raw ?? "" => "" for the lookup key, but `?? raw` returns the original
    // raw value, which is undefined here.
    expect(normalizeStatus(undefined as unknown as string, "call")).toBeUndefined();
  });

  it("distinguishes by kind (queued differs)", () => {
    expect(normalizeStatus("queued", "call")).toBe("pending");
    expect(normalizeStatus("queued", "message")).toBe("sent");
  });
});

describe("dispatchTypeToType", () => {
  it("maps ai_voice_call", () => {
    expect(dispatchTypeToType("ai_voice_call")).toEqual({ channel: "voice", callType: "ai", selType: "ai" });
  });
  it("maps ivr_call", () => {
    expect(dispatchTypeToType("ivr_call")).toEqual({ channel: "voice", callType: "ivr", selType: "ivr" });
  });
  it("maps static_call", () => {
    expect(dispatchTypeToType("static_call")).toEqual({ channel: "voice", callType: "ivr", selType: "ivr" });
  });
  it("maps whatsapp_message", () => {
    expect(dispatchTypeToType("whatsapp_message")).toEqual({ channel: "whatsapp", callType: null, selType: "message" });
  });
  it("maps telegram_message", () => {
    expect(dispatchTypeToType("telegram_message")).toEqual({ channel: "telegram", callType: null, selType: "message" });
  });
  it("maps email_message", () => {
    expect(dispatchTypeToType("email_message")).toEqual({ channel: "email", callType: null, selType: "message" });
  });
  it("is case-insensitive and trims", () => {
    expect(dispatchTypeToType("  AI_VOICE_CALL ")).toEqual({ channel: "voice", callType: "ai", selType: "ai" });
  });
  const dflt = { channel: "voice", callType: "ai", selType: "ai" };
  it("defaults on unknown", () => {
    expect(dispatchTypeToType("something_else")).toEqual(dflt);
  });
  it("defaults on null", () => {
    expect(dispatchTypeToType(null)).toEqual(dflt);
  });
  it("defaults on undefined", () => {
    expect(dispatchTypeToType(undefined)).toEqual(dflt);
  });
});

describe("normalizeCall", () => {
  const ctx = makeCtx();
  const opts = { selType: "ai" as const, batchId: "AI-0001", fingerprint: "fp1" };

  it("is defensive with a near-empty raw object", () => {
    const rec = normalizeCall({} as never, ctx, opts);
    expect(rec.recordId).toBe("");
    expect(rec.status).toBe(""); // normalizeStatus("","call") => ""
    expect(rec.channel).toBe("voice");
    expect(rec.selType).toBe("ai");
    expect(rec.timestamp).toBeNull();
    expect(rec.sentiment).toBeNull();
    expect(rec.keyTopics).toBeNull();
    expect(rec.transcript).toBeNull();
    expect(rec.recipientPhone).toBeNull();
    expect(rec.tenantId).toBe("tenant-1");
    expect(rec.accountId).toBe("account-1");
    expect(rec.batchId).toBe("AI-0001");
    expect(rec.fingerprint).toBe("fp1");
  });

  it("assembles transcript as 'role: content' lines, skipping empty content", () => {
    const raw = makeRawCall({
      conversation_log: [
        { role: "agent", content: "Hello" },
        { role: "user", content: "" }, // skipped
        { role: "user", content: "Hi there" },
        { role: "", content: "no role" }, // emitted without prefix
      ],
    });
    const rec = normalizeCall(raw, ctx, opts);
    expect(rec.transcript).toBe("agent: Hello\nuser: Hi there\nno role");
  });

  it("transcript null when log empty", () => {
    expect(normalizeCall(makeRawCall({ conversation_log: [] }), ctx, opts).transcript).toBeNull();
  });

  it("transcript null when log missing", () => {
    expect(normalizeCall(makeRawCall({ conversation_log: null }), ctx, opts).transcript).toBeNull();
  });

  it("transcript null when all entries have empty content", () => {
    const raw = makeRawCall({ conversation_log: [{ role: "a", content: "" }, { role: "b", content: null }] });
    expect(normalizeCall(raw, ctx, opts).transcript).toBeNull();
  });

  it("reads sentiment from call_analysis.common.overall_sentiment.label", () => {
    const raw = makeRawCall({
      call_analysis: { common: { overall_sentiment: { label: "positive" } } },
    });
    expect(normalizeCall(raw, ctx, opts).sentiment).toBe("positive");
  });

  it("sentiment null when analysis missing", () => {
    expect(normalizeCall(makeRawCall(), ctx, opts).sentiment).toBeNull();
  });

  it("keyTopics passes through array", () => {
    const raw = makeRawCall({ call_analysis: { common: { key_topics: ["a", "b"] } } });
    expect(normalizeCall(raw, ctx, opts).keyTopics).toEqual(["a", "b"]);
  });

  it("keyTopics null when not an array", () => {
    const raw = makeRawCall({ call_analysis: { common: { key_topics: "nope" as never } } });
    expect(normalizeCall(raw, ctx, opts).keyTopics).toBeNull();
  });

  it("timestamp prefers ended_at over created_at", () => {
    const raw = makeRawCall({ timestamps: { ended_at: "2026-01-02T00:00:00Z" }, created_at: "2026-01-01T00:00:00Z" });
    expect(normalizeCall(raw, ctx, opts).timestamp).toBe("2026-01-02T00:00:00Z");
  });

  it("timestamp falls back to created_at when no ended_at", () => {
    const raw = makeRawCall({ timestamps: { ended_at: null }, created_at: "2026-01-01T00:00:00Z" });
    expect(normalizeCall(raw, ctx, opts).timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("passes ivr fields through", () => {
    const raw = makeRawCall({ dtmf_input: "1#", ivr_path: "menu>sub", completed_node: "end" });
    const rec = normalizeCall(raw, ctx, opts);
    expect(rec.dtmfInput).toBe("1#");
    expect(rec.ivrPath).toBe("menu>sub");
    expect(rec.completedNode).toBe("end");
  });

  it("conversationSummary falls back to common.summary", () => {
    const raw = makeRawCall({ conversation_summary: null, call_analysis: { common: { summary: "the gist" } } });
    expect(normalizeCall(raw, ctx, opts).conversationSummary).toBe("the gist");
  });

  it("maps cost/duration/provider fields", () => {
    const raw = makeRawCall({
      total_cost_inr: 5, telephony_cost_inr: 3, ai_cost_inr: 2,
      duration_seconds: 90, talk_time_seconds: 60, telephony_provider: "twilio",
      recipient_phone: "+91999", outcome: "answered", recording_url: "http://rec",
    });
    const rec = normalizeCall(raw, ctx, opts);
    expect(rec.totalCostInr).toBe(5);
    expect(rec.telephonyCostInr).toBe(3);
    expect(rec.aiCostInr).toBe(2);
    expect(rec.durationSeconds).toBe(90);
    expect(rec.talkTimeSeconds).toBe(60);
    expect(rec.provider).toBe("twilio");
    expect(rec.recipientPhone).toBe("+91999");
    expect(rec.outcome).toBe("answered");
    expect(rec.recordingUrl).toBe("http://rec");
    expect(rec.recipientEmail).toBeNull();
  });
});

describe("normalizeMessage", () => {
  const ctx = makeCtx();
  const opts = { channel: "whatsapp" as const, batchId: "WA-0001", fingerprint: "fp2" };

  it("messageId fallback chain message_id -> wamid -> id", () => {
    expect(normalizeMessage(makeRawMessage({ message_id: "m", wamid: "w", id: "i" }), ctx, opts).messageId).toBe("m");
    expect(normalizeMessage(makeRawMessage({ message_id: null, wamid: "w", id: "i" }), ctx, opts).messageId).toBe("w");
    expect(normalizeMessage(makeRawMessage({ message_id: null, wamid: null, id: "i" }), ctx, opts).messageId).toBe("i");
    expect(normalizeMessage(makeRawMessage({ message_id: null, wamid: null, id: null }), ctx, opts).messageId).toBeNull();
  });

  it("recordId stringifies the resolved messageId", () => {
    expect(normalizeMessage(makeRawMessage({ message_id: 12345 as never }), ctx, opts).recordId).toBe("12345");
  });

  it("recordId is '' when no id present", () => {
    expect(normalizeMessage(makeRawMessage({ message_id: null, wamid: null, id: null }), ctx, opts).recordId).toBe("");
  });

  it("timestamp fallback chain read_at -> delivered_at -> sent_at -> failed_at -> created_at", () => {
    const full = makeRawMessage({ read_at: "r", delivered_at: "d", sent_at: "s", failed_at: "f", created_at: "c" });
    expect(normalizeMessage(full, ctx, opts).timestamp).toBe("r");
    expect(normalizeMessage(makeRawMessage({ read_at: null, delivered_at: "d", sent_at: "s", failed_at: "f", created_at: "c" }), ctx, opts).timestamp).toBe("d");
    expect(normalizeMessage(makeRawMessage({ read_at: null, delivered_at: null, sent_at: "s", failed_at: "f", created_at: "c" }), ctx, opts).timestamp).toBe("s");
    expect(normalizeMessage(makeRawMessage({ read_at: null, delivered_at: null, sent_at: null, failed_at: "f", created_at: "c" }), ctx, opts).timestamp).toBe("f");
    expect(normalizeMessage(makeRawMessage({ read_at: null, delivered_at: null, sent_at: null, failed_at: null, created_at: "c" }), ctx, opts).timestamp).toBe("c");
    expect(normalizeMessage(makeRawMessage({ read_at: null, delivered_at: null, sent_at: null, failed_at: null, created_at: null }), ctx, opts).timestamp).toBeNull();
  });

  it("bounceReason prefers error_message over error_code", () => {
    expect(normalizeMessage(makeRawMessage({ error_message: "boom", error_code: "E1" }), ctx, opts).bounceReason).toBe("boom");
    expect(normalizeMessage(makeRawMessage({ error_message: null, error_code: "E1" }), ctx, opts).bounceReason).toBe("E1");
    expect(normalizeMessage(makeRawMessage({ error_message: null, error_code: null }), ctx, opts).bounceReason).toBeNull();
  });

  it("provider falls back to channel", () => {
    expect(normalizeMessage(makeRawMessage({ provider: "meta" }), ctx, opts).provider).toBe("meta");
    expect(normalizeMessage(makeRawMessage({ provider: null }), ctx, opts).provider).toBe("whatsapp");
  });

  it("sets selType message and maps recipient fields + status", () => {
    const rec = normalizeMessage(
      makeRawMessage({ to_phone: "+91", to_email: "a@b.c", status: "opened", template_name: "tpl", delivered_at: "d", read_at: "r" }),
      ctx, opts,
    );
    expect(rec.selType).toBe("message");
    expect(rec.channel).toBe("whatsapp");
    expect(rec.recipientPhone).toBe("+91");
    expect(rec.recipientEmail).toBe("a@b.c");
    expect(rec.status).toBe("read"); // opened -> read
    expect(rec.templateName).toBe("tpl");
    expect(rec.deliveredAt).toBe("d");
    expect(rec.readAt).toBe("r");
    expect(rec.totalCostInr).toBeNull();
    expect(rec.outcome).toBeNull();
  });
});

describe("buildBatchDoc", () => {
  const ctx = makeCtx();
  const baseOpts = (over: Partial<BuildBatchDocOpts> = {}): BuildBatchDocOpts => ({
    batchId: "AI-0001",
    sourceId: "src-1",
    name: "Batch",
    channel: "voice",
    callType: "ai",
    selType: "ai",
    provider: "twilio",
    date: "2026-01-01T00:00:00Z",
    fingerprint: "fp",
    ...over,
  });

  it("defaults total to records.length", () => {
    const recs = [makeRecord(), makeRecord(), makeRecord()];
    expect(buildBatchDoc(recs, ctx, baseOpts()).total).toBe(3);
  });

  it("honors total override", () => {
    expect(buildBatchDoc([makeRecord()], ctx, baseOpts({ total: 50 })).total).toBe(50);
  });

  it("breakdown uses fixed order and only known keys", () => {
    const recs = [
      makeRecord({ status: "failed" }),
      makeRecord({ status: "completed" }),
      makeRecord({ status: "pending" }),
      makeRecord({ status: "completed" }),
      makeRecord({ status: "totallyUnknown" }), // dropped
    ];
    const doc = buildBatchDoc(recs, ctx, baseOpts());
    expect(doc.breakdown).toEqual([
      { key: "completed", value: 2 },
      { key: "failed", value: 1 },
      { key: "pending", value: 1 },
    ]);
  });

  it("successRate divides completed count by total (calls)", () => {
    const recs = [makeRecord({ status: "completed" }), makeRecord({ status: "completed" }), makeRecord({ status: "failed" })];
    expect(buildBatchDoc(recs, ctx, baseOpts({ total: 4 })).successRate).toBe(0.5);
  });

  it("successRate uses 'read' for message sets", () => {
    const recs = [
      makeRecord({ selType: "message", status: "read" }),
      makeRecord({ selType: "message", status: "delivered" }),
    ];
    expect(buildBatchDoc(recs, ctx, baseOpts({ selType: "message", channel: "whatsapp", callType: null })).successRate).toBe(0.5);
  });

  it("successRate 0 when total is 0", () => {
    expect(buildBatchDoc([], ctx, baseOpts()).successRate).toBe(0);
  });

  it("sums spend/telephony/ai", () => {
    const recs = [
      makeRecord({ totalCostInr: 10, telephonyCostInr: 6, aiCostInr: 4 }),
      makeRecord({ totalCostInr: 5, telephonyCostInr: 3, aiCostInr: 2 }),
      makeRecord({ totalCostInr: null, telephonyCostInr: null, aiCostInr: null }),
    ];
    const doc = buildBatchDoc(recs, ctx, baseOpts());
    expect(doc.spendInr).toBe(15);
    expect(doc.telephonyInr).toBe(9);
    expect(doc.aiInr).toBe(6);
  });

  it("avgDuration/avgTalkTime are numeric averages for calls", () => {
    const recs = [
      makeRecord({ durationSeconds: 100, talkTimeSeconds: 50 }),
      makeRecord({ durationSeconds: 200, talkTimeSeconds: 70 }),
      makeRecord({ durationSeconds: null, talkTimeSeconds: null }),
    ];
    const doc = buildBatchDoc(recs, ctx, baseOpts());
    expect(doc.avgDuration).toBe(150);
    expect(doc.avgTalkTime).toBe(60);
  });

  it("avgDuration/avgTalkTime null when no numeric durations", () => {
    const doc = buildBatchDoc([makeRecord({ durationSeconds: null })], ctx, baseOpts());
    expect(doc.avgDuration).toBeNull();
    expect(doc.avgTalkTime).toBeNull();
  });

  it("avgDuration/avgTalkTime always null for message sets", () => {
    const recs = [makeRecord({ selType: "message", durationSeconds: 100, talkTimeSeconds: 50 })];
    const doc = buildBatchDoc(recs, ctx, baseOpts({ selType: "message" }));
    expect(doc.avgDuration).toBeNull();
    expect(doc.avgTalkTime).toBeNull();
  });

  it("ingestStatus defaults to ready, honors override", () => {
    expect(buildBatchDoc([], ctx, baseOpts()).ingestStatus).toBe("ready");
    expect(buildBatchDoc([], ctx, baseOpts({ ingestStatus: "ingesting" })).ingestStatus).toBe("ingesting");
  });

  it("copies context + opts fields and sets updatedAt", () => {
    const doc = buildBatchDoc([], ctx, baseOpts());
    expect(doc.tenantId).toBe("tenant-1");
    expect(doc.accountId).toBe("account-1");
    expect(doc.batchId).toBe("AI-0001");
    expect(doc.sourceId).toBe("src-1");
    expect(doc.provider).toBe("twilio");
    expect(typeof doc.updatedAt).toBe("string");
  });
});

describe("batchDocOptsFromJob", () => {
  it("pulls channel/callType/selType from dispatch_type", () => {
    const opts = batchDocOptsFromJob(makeRawBulkJob({ dispatch_type: "ivr_call" }), { batchId: "IVR-1", fingerprint: "fp" });
    expect(opts.channel).toBe("voice");
    expect(opts.callType).toBe("ivr");
    expect(opts.selType).toBe("ivr");
  });

  it("name falls back to id, sourceId from id, provider falls back to channel", () => {
    const opts = batchDocOptsFromJob(makeRawBulkJob({ name: null, provider: null, dispatch_type: "whatsapp_message", id: "job-9" }), { batchId: "WA-1", fingerprint: "fp" });
    expect(opts.name).toBe("job-9");
    expect(opts.sourceId).toBe("job-9");
    expect(opts.provider).toBe("whatsapp"); // channel fallback
  });

  it("date falls back to now when created_at missing", () => {
    const opts = batchDocOptsFromJob(makeRawBulkJob({ created_at: null }), { batchId: "AI-1", fingerprint: "fp" });
    expect(typeof opts.date).toBe("string");
    expect(opts.date.length).toBeGreaterThan(0);
  });

  it("total from total_contacts, undefined when absent", () => {
    expect(batchDocOptsFromJob(makeRawBulkJob({ total_contacts: 42 }), { batchId: "AI-1", fingerprint: "fp" }).total).toBe(42);
    expect(batchDocOptsFromJob(makeRawBulkJob({ total_contacts: null }), { batchId: "AI-1", fingerprint: "fp" }).total).toBeUndefined();
  });

  it("passes batchId/fingerprint through", () => {
    const opts = batchDocOptsFromJob(makeRawBulkJob(), { batchId: "AI-XYZ", fingerprint: "abc123" });
    expect(opts.batchId).toBe("AI-XYZ");
    expect(opts.fingerprint).toBe("abc123");
  });
});
