// Content fingerprint of a batch's normalized records — the value stored as
// `BatchDoc.fingerprint` when a revision is published, and what the worker
// compares a fresh pull against to decide that a short re-pull is the same
// dataset and need not be written again (see `unchanged` in `ingestBatch`).
//
// The rule that keeps that skip safe: the fingerprint covers EVERY field a
// reader can surface — CSV export columns, aggregates, analytics, chat and
// insight context — so a pull that differs in anything a customer could see
// can never be mistaken for the published one. It is therefore built from the
// whole record minus an explicit list of storage metadata, never from a list
// of fields somebody remembered to include: that list is how `recordingUrl`,
// `transcript`, `outcome` and a dozen others once fell out, so a recording
// arriving after a campaign finished was kept stale and stamped current.
//
// Import-free apart from node:crypto and types, so tests exercise the real
// thing while the worker's normalize module is mocked.

import { createHash } from "node:crypto";
import type { NormalizedRecord } from "./types";

/** Every `NormalizedRecord` field, classified. `satisfies` makes this
 *  exhaustive in both directions: a field added to the type fails `tsc` until
 *  somebody decides here whether a reader can see it, and a field removed from
 *  the type fails too. Only `metadata` is excluded from the fingerprint; the
 *  fingerprint itself walks the record's ACTUAL keys, so a key this table has
 *  never heard of (an untyped upstream addition) is included, not dropped —
 *  the direction that republishes rather than the one that hides a change.
 *
 *  `metadata` means "describes where/when this copy is stored, not what the
 *  record says": it differs between two copies of identical data. */
export const NORMALIZED_RECORD_FIELD_ROLES = {
  tenantId: "content",
  accountId: "content",
  batchId: "content",
  // The staging/publication revision this copy belongs to — new every pull.
  revision: "metadata",
  // When this copy was staged — new every pull.
  revisionCreatedAt: "metadata",
  // Set on a superseded copy only.
  retiredAt: "metadata",
  // The batch fingerprint at PULL time, stamped onto each record. Including it
  // would make every pull after a publish differ from the one before it (the
  // records of revision N carry fingerprint N-1), so no tie could ever match.
  fingerprint: "metadata",
  recordId: "content",
  selType: "content",
  channel: "content",
  recipientPhone: "content",
  recipientEmail: "content",
  status: "content",
  outcome: "content",
  activityTimestamp: "content",
  activityDate: "content",
  timestamp: "content",
  provider: "content",
  totalCostInr: "content",
  telephonyCostInr: "content",
  aiCostInr: "content",
  durationSeconds: "content",
  talkTimeSeconds: "content",
  recordingUrl: "content",
  conversationSummary: "content",
  sentiment: "content",
  keyTopics: "content",
  transcript: "content",
  dtmfInput: "content",
  ivrPath: "content",
  completedNode: "content",
  messageId: "content",
  deliveredAt: "content",
  readAt: "content",
  replyText: "content",
  templateName: "content",
  bounceReason: "content",
  // The upstream payload, in full. Only `raw.status` is read today, but a
  // reader added tomorrow could read anything in it, and nothing here would
  // notice — so it is covered whole. The cost of that choice: if upstream ever
  // put a per-REQUEST value in a list row (a signed URL, a "now"), every tie
  // would publish again, as before the skip existed — wasted storage, never a
  // stale dataset. Exclude such a key here, by name, if that ever happens.
  raw: "content",
} as const satisfies Record<keyof NormalizedRecord, "content" | "metadata">;

/** Keys never fingerprinted: the metadata above, plus Mongo's `_id`, which
 *  every record read back from the collection carries and which is unique per
 *  stored copy. */
export const RECORD_FINGERPRINT_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  "_id",
  ...Object.entries(NORMALIZED_RECORD_FIELD_ROLES)
    .filter(([, role]) => role === "metadata")
    .map(([key]) => key),
]);

/** Deterministic serialization for fingerprinting.
 *
 *  - Object keys are sorted at every level, so upstream key order is irrelevant.
 *  - `null` and `undefined` are the same value, and an object entry holding
 *    either is dropped — the driver stores `undefined` as BSON null and a field
 *    may be absent on one copy and null on another, none of which a reader can
 *    tell apart (every export renders all three as an empty cell).
 *  - A Date serializes as its instant; an invalid one as null. Plain
 *    `JSON.stringify` would render every Date as `{}`, so all dates would
 *    collide.
 *  - Array order is preserved (`keyTopics` order is visible), with holes and
 *    undefined elements as null.
 *  - Anything else with a `toJSON` (an ObjectId inside `raw`) uses it; a bigint
 *    is tagged so it cannot collide with the number of the same digits. */
export function canonicalRecordJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(`${value.toString()}n`);
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "null" : JSON.stringify(`$date:${value.toISOString()}`);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => canonicalRecordJson(item)).join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return canonicalRecordJson(toJSON.call(value));
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalRecordJson(v)}`).join(",")}}`;
}

/** One record's fingerprinted content: every key except the excluded ones. */
export function recordContentJson(record: NormalizedRecord): string {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RECORD_FINGERPRINT_EXCLUDED_KEYS.has(key)) content[key] = value;
  }
  return canonicalRecordJson(content);
}

/** Fingerprint of a whole record set, independent of record order.
 *
 *  Hashed incrementally with a length prefix per record, so an 8k-record
 *  campaign with transcripts is never joined into one giant string, and no
 *  record's content can be confused with the boundary between two. Records are
 *  ordered by `recordId` with a plain code-unit comparison — not
 *  `localeCompare`, whose order depends on the host's ICU data. Same output
 *  shape as `fingerprint()` (16 hex chars). */
export function recordsContentFingerprint(records: readonly NormalizedRecord[]): string {
  const sorted = [...records].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
  const hash = createHash("sha1");
  hash.update(`records:v2:${sorted.length}\n`);
  for (const record of sorted) {
    const json = recordContentJson(record);
    hash.update(`${Buffer.byteLength(json)}:${json}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}
