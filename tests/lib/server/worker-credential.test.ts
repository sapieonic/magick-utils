// What happens to an ingestion whose Firebase ID token dies mid-run.
//
// The failure these pin down: a token expires an hour after login, magick-master
// starts answering 401, and the worker used to treat that like corrupt data —
// job set to `error`, batch failed, and the staged revision DELETED, so nothing
// resumed even after the user signed back in. A credential problem must put the
// job back; only a credential that can never work again may fail it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  beginBatchIngestion: vi.fn(),
  checkpointJob: vi.fn(),
  claimNextJob: vi.fn(),
  countRecords: vi.fn(),
  deleteBatchRevisionRecords: vi.fn(),
  deleteUnpublishedBatchRevision: vi.fn(),
  failBatchIfOwned: vi.fn(),
  getBatch: vi.fn(),
  getRecordsForRevision: vi.fn(),
  publishBatchIfOwned: vi.fn(),
  releaseIngestionLocks: vi.fn(),
  renewIngestionLocks: vi.fn(),
  retireBatchRevision: vi.fn(),
  deleteSupersededRecordRevisions: vi.fn(),
  deleteOrphanedRecordRevisions: vi.fn(),
  SUPERSEDED_REVISION_GRACE_MS: 30 * 60 * 1000,
  replaceBatchRecords: vi.fn(),
  updateClaimedJob: vi.fn(),
}));
const client = vi.hoisted(() => ({ listCalls: vi.fn(), listMessages: vi.fn(), getBulkJob: vi.fn() }));
const constructed = vi.hoisted(() => ({ calls: [] as Array<{ ctx: unknown; options: unknown }> }));
const token = vi.hoisted(() => ({ mintIdToken: vi.fn() }));
const logFns = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/server/repositories", () => repositories);
vi.mock("@/lib/server/env", () => ({
  env: { magickMasterBaseUrl: "https://mm.test", firebaseApiKey: "web-api-key" },
  isAuthConfigured: () => true,
  isTokenRefreshConfigured: () => true,
}));
vi.mock("@/lib/server/magick-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/magick-client")>();
  return {
    ...actual,
    MagickClient: vi.fn((ctx: unknown, options: unknown) => {
      constructed.calls.push({ ctx, options });
      return client;
    }),
  };
});
vi.mock("@/lib/server/firebase-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/firebase-token")>();
  return { ...actual, mintIdToken: token.mintIdToken };
});
vi.mock("@/lib/server/normalize", () => ({
  normalizeCall: (raw: { id: string }) => ({ recordId: raw.id, status: "done" }),
  normalizeMessage: (raw: { id: string }) => ({ recordId: raw.id, status: "done" }),
  buildBatchDoc: (_records: unknown[], _ctx: unknown, batch: unknown) => batch,
}));
vi.mock("@/lib/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  log: () => logFns,
}));
vi.mock("@/lib/server/observability/request-context", () => ({ runWithRequestContext: vi.fn() }));

import {
  TokenRefreshPermanentError,
  TokenRefreshTransientError,
  type MintedToken,
} from "@/lib/server/firebase-token";
import { MagickApiError } from "@/lib/server/magick-client";
import type { Job } from "@/lib/server/types";
import { processJob, runClaimedJob } from "@/lib/server/worker";

/** `idToken` is not a readable JWT, so `idTokenNeedsRefresh` reports it as
 *  expiring — which is what a job resumed hours after it was enqueued looks
 *  like, and what makes the pre-flight mint fire. */
const job = (patch: Partial<Job> = {}): Job => ({
  jobId: "j1",
  type: "ingest",
  tenantId: "t1",
  accountId: "a1",
  idToken: "stale-token",
  batchIds: ["b1"],
  status: "running",
  total: 1,
  done: 0,
  cursor: 0,
  batchIndex: 0,
  leaseId: "lease-1",
  leaseUntil: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const minted = (patch: Partial<MintedToken> = {}): MintedToken => ({
  idToken: "fresh-token",
  refreshToken: "refresh-2",
  expiresAt: Date.now() + 3_600_000,
  ...patch,
});

const batch = (batchId: string) => ({
  batchId,
  sourceId: `source-${batchId}`,
  selType: "ai",
  total: 1,
  fingerprint: "fp",
});

/** The single `updateClaimedJob` patch matching a predicate. */
function patchWhere(predicate: (patch: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  const call = repositories.updateClaimedJob.mock.calls.find(([, , patch]) => predicate(patch));
  return call?.[2];
}

beforeEach(() => {
  vi.clearAllMocks();
  constructed.calls.length = 0;
  repositories.checkpointJob.mockResolvedValue(job());
  repositories.beginBatchIngestion.mockResolvedValue(true);
  repositories.countRecords.mockResolvedValue(0);
  repositories.updateClaimedJob.mockResolvedValue(job());
  repositories.deleteBatchRevisionRecords.mockResolvedValue(undefined);
  repositories.deleteUnpublishedBatchRevision.mockResolvedValue(undefined);
  repositories.getBatch.mockImplementation((_t: string, _a: string, id: string) => Promise.resolve(batch(id)));
  repositories.failBatchIfOwned.mockResolvedValue(undefined);
  repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "1", status: "done" }]);
  repositories.publishBatchIfOwned.mockResolvedValue(true);
  repositories.releaseIngestionLocks.mockResolvedValue(undefined);
  repositories.renewIngestionLocks.mockResolvedValue(undefined);
  repositories.retireBatchRevision.mockResolvedValue(undefined);
  repositories.deleteSupersededRecordRevisions.mockResolvedValue(0);
  repositories.deleteOrphanedRecordRevisions.mockResolvedValue(0);
  repositories.replaceBatchRecords.mockResolvedValue(undefined);
  client.getBulkJob.mockResolvedValue({ id: "source-b1", updated_at: "2026-09-01T09:00:00Z" });
  client.listCalls.mockResolvedValue({ calls: [{ id: "1" }], total: 1 });
  token.mintIdToken.mockResolvedValue(minted());
});

describe("processJob credential handling", () => {
  it("mints before the first upstream call when the stored token is spent", async () => {
    await processJob(job({ refreshToken: "refresh-1" }));

    // A job that sat out a rate-limit pause, or that a restart re-claimed hours
    // later, still carries the token the enqueuing request stamped on it.
    expect(token.mintIdToken).toHaveBeenCalledWith("refresh-1");
    expect(constructed.calls[0].ctx).toMatchObject({ idToken: "fresh-token", refreshToken: "refresh-2" });
  });

  it("persists the minted pair onto the job document", async () => {
    await processJob(job({ refreshToken: "refresh-1" }));

    // Google may rotate the refresh token. A rotated value left unwritten means
    // the next claim resumes with one that is already refused.
    expect(patchWhere((p) => "idToken" in p)).toEqual({ idToken: "fresh-token", refreshToken: "refresh-2" });
  });

  it("skips the pre-flight mint when the job has no refresh token", async () => {
    await processJob(job());

    expect(token.mintIdToken).not.toHaveBeenCalled();
    expect(constructed.calls[0].ctx).toMatchObject({ idToken: "stale-token" });
  });

  it("stores the credential the client re-mints mid-run", async () => {
    await processJob(job({ refreshToken: "refresh-1" }));
    repositories.updateClaimedJob.mockClear();

    // This is the callback the client invokes after its own 401 retry.
    const { onCredentialRefresh } = constructed.calls[0].options as {
      onCredentialRefresh: (c: MintedToken) => Promise<void>;
    };
    await onCredentialRefresh(minted({ idToken: "fresher", refreshToken: "refresh-3" }));

    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", {
      idToken: "fresher",
      refreshToken: "refresh-3",
    });
  });

  it("keeps running when the credential write loses the lease race", async () => {
    repositories.updateClaimedJob.mockResolvedValueOnce(null);
    await expect(processJob(job({ refreshToken: "refresh-1" }))).resolves.toBeUndefined();
    expect(logFns.warn).toHaveBeenCalledWith(
      "[worker] could not store the re-minted credential; lease may have moved on",
    );
  });
});

describe("runClaimedJob credential failures", () => {
  /** Every deferral shares this shape: alive, unlocked, due at `retryAt`. */
  function expectDeferred(retryAt: string) {
    expect(patchWhere((p) => p.status === "rate_limited")).toEqual(
      expect.objectContaining({ status: "rate_limited", retryAt, leaseUntil: null, leaseId: null, error: null }),
    );
    // The point of deferring rather than failing: the staged revision survives,
    // so the resumed job continues from its checkpoint instead of re-paging
    // everything it had already written.
    expect(repositories.deleteUnpublishedBatchRevision).not.toHaveBeenCalled();
    expect(repositories.failBatchIfOwned).not.toHaveBeenCalled();
  }

  it("defers a 401 instead of destroying the staged revision", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(401, "token expired", "url"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));

    await runClaimedJob(job({ refreshToken: "refresh-1" }));

    expectDeferred("2026-08-12T12:01:00.000Z");
    vi.useRealTimers();
  });

  it("defers a transient refresh failure", async () => {
    // Google briefly unreachable says nothing about the credential — and nothing
    // about the records already staged.
    token.mintIdToken.mockRejectedValueOnce(new TokenRefreshTransientError("secure-token responded 503"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));

    await runClaimedJob(job({ refreshToken: "refresh-1" }));

    expectDeferred("2026-08-12T12:01:00.000Z");
    expect(client.listCalls).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("counts the deferral so it cannot repeat forever", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(401, "token expired", "url"));
    await runClaimedJob(job({ refreshToken: "refresh-1", authRetryCount: 4 }));

    expect(patchWhere((p) => p.status === "rate_limited")).toMatchObject({ authRetryCount: 5 });
  });

  it("counts credential deferrals separately from rate-limit ones", async () => {
    // A large ingest legitimately hits rate limits many times. Sharing one
    // counter would spend its entire credential grace on throttling it had
    // already survived — and a long ingest is exactly the job most likely to
    // outlive its token, so the penalty landed where it hurt most.
    client.listCalls.mockRejectedValueOnce(new MagickApiError(401, "token expired", "url"));

    await runClaimedJob(job({ refreshToken: "refresh-1", retryCount: 19 }));

    const deferral = patchWhere((p) => p.status === "rate_limited");
    expect(deferral).toMatchObject({ authRetryCount: 1 });
    expect(deferral).not.toHaveProperty("retryCount");
  });

  it("does not advance the credential counter on a rate limit", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "slow down", "url"));

    await runClaimedJob(job({ refreshToken: "refresh-1", retryCount: 2 }));

    const deferral = patchWhere((p) => p.status === "rate_limited");
    expect(deferral).toMatchObject({ retryCount: 3 });
    expect(deferral).not.toHaveProperty("authRetryCount");
  });

  it("fails the job when the refresh token is permanently dead", async () => {
    token.mintIdToken.mockRejectedValueOnce(new TokenRefreshPermanentError("TOKEN_EXPIRED"));

    await runClaimedJob(job({ refreshToken: "revoked" }));

    const failure = patchWhere((p) => p.status === "error");
    // No amount of waiting fixes a revoked refresh token, and "MagickApiError
    // 401" is not something the customer can act on.
    expect(failure?.error).toBe(
      "Your sign-in expired and could not be renewed. Sign in again, then retry. (TOKEN_EXPIRED)",
    );
    expect(repositories.failBatchIfOwned).toHaveBeenCalledWith("t1", "a1", "b1", "j1", "lease-1");
  });

  it("stops deferring once the grace window is used up", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(401, "token expired", "url"));

    // Twenty minutes of 401s with nobody signing back in: leaving the job
    // deferred forever shows a progress bar that never finishes and never errors.
    await runClaimedJob(job({ refreshToken: "refresh-1", authRetryCount: 20 }));

    expect(patchWhere((p) => p.status === "rate_limited")).toBeUndefined();
    expect(patchWhere((p) => p.status === "error")?.error).toBe(
      "Your sign-in expired and could not be renewed. Sign in again, then retry.",
    );
  });

  it("marks a credential deferral as such, not as throttling", async () => {
    // Both pauses share the `rate_limited` status, and the Combine screen used
    // to read that as "rate limit reached, it will retry, just wait" — sending a
    // signed-out user away from the one action that rescues their merge.
    client.listCalls.mockRejectedValueOnce(new MagickApiError(401, "token expired", "url"));

    await runClaimedJob(job({ refreshToken: "refresh-1" }));

    expect(patchWhere((p) => p.status === "rate_limited")).toMatchObject({ deferReason: "credential" });
  });

  it("marks a transient mint failure as a credential deferral too", async () => {
    token.mintIdToken.mockRejectedValueOnce(new TokenRefreshTransientError("secure-token responded 503"));

    await runClaimedJob(job({ refreshToken: "refresh-1" }));

    expect(patchWhere((p) => p.status === "rate_limited")).toMatchObject({ deferReason: "credential" });
  });

  it("leaves the credential on a job it expects to resume", async () => {
    // The deferral is the one transition that must NOT clear it: the job comes
    // back and keeps paging, and a reattach after signing in re-stamps it.
    client.listCalls.mockRejectedValueOnce(new MagickApiError(401, "token expired", "url"));

    await runClaimedJob(job({ refreshToken: "refresh-1" }));

    const deferral = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "rate_limited",
    );
    expect(deferral?.[3]).toBeUndefined();
  });

  it("clears the credential when a dead refresh token ends the job", async () => {
    token.mintIdToken.mockRejectedValueOnce(new TokenRefreshPermanentError("TOKEN_EXPIRED"));

    await runClaimedJob(job({ refreshToken: "revoked" }));

    const failure = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "error",
    );
    expect(failure?.[3]).toEqual({ clearCredential: true });
  });

  it("still fails outright on a data error", async () => {
    client.listCalls.mockRejectedValueOnce(new Error("upstream failed"));

    await runClaimedJob(job({ refreshToken: "refresh-1" }));

    expect(patchWhere((p) => p.status === "error")?.error).toBe("Error: upstream failed");
    expect(repositories.deleteUnpublishedBatchRevision).toHaveBeenCalled();
  });
});
