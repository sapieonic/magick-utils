import { describe, expect, it } from "vitest";
import {
  NORMALIZED_RECORD_FIELD_ROLES,
  RECORD_FINGERPRINT_EXCLUDED_KEYS,
  canonicalRecordJson,
  recordsContentFingerprint,
} from "@/lib/server/record-fingerprint";
import type { NormalizedRecord } from "@/lib/server/types";

// A record with EVERY field populated, so a mutation of any one is a real
// change rather than null → value on a field the fixture never set.
const full = (): NormalizedRecord => ({
  tenantId: "t1",
  accountId: "a1",
  batchId: "b1",
  revision: "rev-1",
  revisionCreatedAt: new Date("2026-10-01T00:00:00Z"),
  retiredAt: new Date("2026-10-01T01:00:00Z"),
  fingerprint: "fp-at-pull-time",
  recordId: "r1",
  selType: "ai",
  channel: "voice",
  recipientPhone: "+911",
  recipientEmail: "a@example.com",
  status: "completed",
  outcome: "promise_to_pay",
  activityTimestamp: "2026-10-01T00:00:00.000Z",
  activityDate: new Date("2026-10-01T00:00:00Z"),
  timestamp: "2026-10-01T00:05:00Z",
  provider: "plivo",
  totalCostInr: 1.5,
  telephonyCostInr: 1,
  aiCostInr: 0.5,
  durationSeconds: 60,
  talkTimeSeconds: 55,
  recordingUrl: "/api/v1/calls/r1/recording",
  conversationSummary: "Agreed to pay",
  sentiment: "positive",
  keyTopics: ["payment", "date"],
  transcript: "agent: hi\nuser: hello",
  dtmfInput: "1",
  ivrPath: "root>1",
  completedNode: "end",
  messageId: "m1",
  deliveredAt: "2026-10-01T00:01:00Z",
  readAt: "2026-10-01T00:02:00Z",
  replyText: "ok",
  templateName: "promo",
  bounceReason: "none",
  raw: { status: "completed", nested: { a: 1 } },
});

/** A value of the same kind that differs from `value`. */
function mutate(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime() + 1000);
  if (Array.isArray(value)) return [...value, "extra"];
  if (typeof value === "number") return value + 1;
  if (typeof value === "string") return `${value}-changed`;
  if (value && typeof value === "object") return { ...(value as object), changed: true };
  return "set";
}

const fp = (...records: NormalizedRecord[]) => recordsContentFingerprint(records);

const roles = Object.entries(NORMALIZED_RECORD_FIELD_ROLES) as Array<[keyof NormalizedRecord, string]>;
const contentKeys = roles.filter(([, role]) => role === "content").map(([key]) => key);
const metadataKeys = roles.filter(([, role]) => role === "metadata").map(([key]) => key);

describe("recordsContentFingerprint", () => {
  it("fixture populates every field the record type has", () => {
    // If a new field is added to NormalizedRecord (and classified, which tsc
    // forces), the fixture must set it too or its mutation case below would be
    // a null → value change that proves nothing about a value → value one.
    for (const [key] of roles) expect(full()[key], key).not.toBeUndefined();
  });

  // Enumerated from the classification table, which `satisfies` keeps
  // exhaustive over NormalizedRecord — so a field added to the type is covered
  // here automatically, without anyone remembering to add a case.
  it.each(contentKeys)("changes when %s changes", (key) => {
    const changed = { ...full(), [key]: mutate(full()[key]) } as NormalizedRecord;
    expect(fp(changed)).not.toBe(fp(full()));
  });

  it.each(contentKeys)("changes when %s goes from a value to absent", (key) => {
    const record = full();
    delete (record as unknown as Record<string, unknown>)[key];
    expect(fp(record)).not.toBe(fp(full()));
  });

  it("covers exactly the classified metadata, plus Mongo's _id, and nothing else", () => {
    expect([...RECORD_FINGERPRINT_EXCLUDED_KEYS].sort()).toEqual(["_id", ...metadataKeys].sort());
    expect([...metadataKeys].sort()).toEqual(["fingerprint", "retiredAt", "revision", "revisionCreatedAt"]);
  });

  it.each([...metadataKeys, "_id"])("ignores %s, which differs between copies of identical data", (key) => {
    const record = full() as unknown as Record<string, unknown>;
    const changed = { ...record, [key]: mutate(record[key] ?? "x") };
    expect(fp(changed as unknown as NormalizedRecord)).toBe(fp(full()));
  });

  it("includes a key the classification has never heard of", () => {
    const extra = { ...full(), newUpstreamField: "x" } as unknown as NormalizedRecord;
    expect(fp(extra)).not.toBe(fp(full()));
  });

  it("sees a change deep inside raw", () => {
    const changed = { ...full(), raw: { status: "completed", nested: { a: 2 } } };
    expect(fp(changed)).not.toBe(fp(full()));
  });

  it("treats absent, undefined and null as one value, as a Mongo round trip does", () => {
    const withNull = { ...full(), outcome: null, raw: { status: "completed", nested: { a: 1 }, extra: null } };
    const withUndefined = { ...full(), outcome: undefined, raw: { status: "completed", nested: { a: 1 }, extra: undefined } };
    const absent = full();
    delete absent.outcome;
    expect(fp(withNull)).toBe(fp(withUndefined));
    expect(fp(withNull)).toBe(fp(absent));
  });

  it("is independent of key order and record order", () => {
    const a = full();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as NormalizedRecord;
    const b = { ...full(), recordId: "r2" };
    expect(fp(a, b)).toBe(fp(b, reordered));
  });

  it("distinguishes dates rather than collapsing them all to {}", () => {
    expect(canonicalRecordJson(new Date("2026-01-01T00:00:00Z"))).not.toBe(
      canonicalRecordJson(new Date("2026-01-02T00:00:00Z")),
    );
    expect(canonicalRecordJson(new Date("nope"))).toBe("null");
  });

  it("preserves array order, which a reader sees", () => {
    expect(fp({ ...full(), keyTopics: ["a", "b"] })).not.toBe(fp({ ...full(), keyTopics: ["b", "a"] }));
  });

  it("counts records, so a dropped record changes it", () => {
    expect(fp(full(), { ...full(), recordId: "r2" })).not.toBe(fp(full()));
  });
});
