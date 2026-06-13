// Local fixture factories for the lib/server unit tests.
import type {
  RawBulkJob,
  RawCall,
  RawMessage,
} from "@/lib/server/magick-client";
import type { NormalizedRecord, TenantContext } from "@/lib/server/types";

export function makeCtx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: "tenant-1",
    accountId: "account-1",
    idToken: "tok-abc",
    ...overrides,
  };
}

export function makeRawCall(overrides: Partial<RawCall> = {}): RawCall {
  return {
    call_id: "call-1",
    status: "completed",
    ...overrides,
  };
}

export function makeRawMessage(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    id: "msg-1",
    status: "delivered",
    ...overrides,
  };
}

export function makeRawBulkJob(overrides: Partial<RawBulkJob> = {}): RawBulkJob {
  return {
    id: "job-1",
    name: "Job One",
    dispatch_type: "ai_voice_call",
    status: "dispatched",
    total_contacts: 10,
    ...overrides,
  };
}

/** Minimal valid NormalizedRecord; override per test. */
export function makeRecord(
  overrides: Partial<NormalizedRecord> = {},
): NormalizedRecord {
  return {
    tenantId: "tenant-1",
    accountId: "account-1",
    batchId: "AI-0001",
    fingerprint: "fp",
    recordId: "rec-1",
    selType: "ai",
    channel: "voice",
    status: "completed",
    ...overrides,
  };
}
