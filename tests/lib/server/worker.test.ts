import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  keepPublishedRevisionIfOwned: vi.fn(),
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
const client = vi.hoisted(() => ({
  listCalls: vi.fn(),
  listIvrCalls: vi.fn(),
  listStaticCalls: vi.fn(),
  listMessages: vi.fn(),
  getBulkJob: vi.fn(),
}));
const logFns = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/server/repositories", () => repositories);
vi.mock("@/lib/server/magick-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/magick-client")>();
  return { ...actual, MagickClient: vi.fn(() => client) };
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

import { logger } from "@/lib/server/logger";
import { MagickApiError } from "@/lib/server/magick-client";
import { processJob, runClaimedJob, SWEEP_DELAY_MARGIN_MS } from "@/lib/server/worker";
import { bulkJobRecordsStamp } from "@/lib/server/records-stamp";
import { recordsContentFingerprint } from "@/lib/server/record-fingerprint";

// What the call surfaces are paged under today (see listOrderToken).
const CALL_ORDER = "created_at:asc";
// Mirrors the repositories mock above; the real constant is covered by its own test.
const SUPERSEDED_REVISION_GRACE_MS = 30 * 60 * 1000;
import type { Job } from "@/lib/server/types";

const job = (patch: Partial<Job> = {}): Job => ({
  jobId: "j1",
  type: "merge",
  tenantId: "t1",
  accountId: "a1",
  idToken: "token",
  batchIds: ["b1", "b2"],
  status: "running",
  total: 250,
  done: 0,
  cursor: 0,
  batchIndex: 0,
  leaseId: "lease-1",
  leaseUntil: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

const batch = (batchId: string) => ({
  batchId,
  sourceId: `source-${batchId}`,
  selType: "ai",
  total: 1,
  fingerprint: "fp",
});

beforeEach(() => {
  vi.clearAllMocks();
  repositories.checkpointJob.mockResolvedValue(job());
  repositories.beginBatchIngestion.mockResolvedValue(true);
  repositories.countRecords.mockResolvedValue(0);
  repositories.updateClaimedJob.mockResolvedValue(job());
  repositories.deleteBatchRevisionRecords.mockResolvedValue(undefined);
  repositories.deleteUnpublishedBatchRevision.mockResolvedValue(undefined);
  repositories.getBatch.mockImplementation((_t, _a, id) => Promise.resolve(batch(id)));
  repositories.failBatchIfOwned.mockResolvedValue(undefined);
  repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "1", status: "done" }]);
  repositories.publishBatchIfOwned.mockResolvedValue(true);
  repositories.keepPublishedRevisionIfOwned.mockResolvedValue(true);
  repositories.releaseIngestionLocks.mockResolvedValue(undefined);
  repositories.renewIngestionLocks.mockResolvedValue(undefined);
  repositories.retireBatchRevision.mockResolvedValue(undefined);
  repositories.deleteSupersededRecordRevisions.mockResolvedValue(0);
  repositories.deleteOrphanedRecordRevisions.mockResolvedValue(0);
  client.getBulkJob.mockResolvedValue({
    id: "source-b1",
    dispatch_type: "ai_voice_call",
    updated_at: "2026-09-01T09:00:00Z",
  });
  repositories.replaceBatchRecords.mockResolvedValue(undefined);
});

describe("processJob resume", () => {
  it("resumes at the durable offset and derives progress without double counting", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "101" }], total: 101 });
    repositories.getRecordsForRevision
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
      )
      .mockResolvedValueOnce(
        Array.from({ length: 101 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
      );
    await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 101 , cursorOrder: CALL_ORDER }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
    expect(repositories.deleteBatchRevisionRecords).not.toHaveBeenCalled();
    expect(repositories.replaceBatchRecords).toHaveBeenCalledTimes(1);
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(2, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(3, "j1", "lease-1", { done: 101, cursor: 0, batchIndex: 1 });
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done", done: 101 }),
      { clearCredential: true },
    );
  });

  it("keeps the raw pagination cursor separate from unique-record progress", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 3 });
    client.listCalls.mockResolvedValueOnce({
      calls: [{ id: "dup" }, { id: "dup" }, { id: "unique" }],
      total: 3,
    });
    repositories.getRecordsForRevision.mockResolvedValue([
      { recordId: "dup", status: "done" },
      { recordId: "unique", status: "done" },
    ]);

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({
      done: 2,
      cursor: 3,
      batchIndex: 0,
    }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(2, "j1", "lease-1", expect.objectContaining({
      done: 2,
      cursor: 3,
      batchIndex: 0,
    }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(3, "j1", "lease-1", {
      done: 2,
      cursor: 0,
      batchIndex: 1,
    });
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done", done: 2 }),
      { clearCredential: true },
    );
  });

  it("resumes duplicate-heavy pagination from the raw offset with unique progress", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "unique" }], total: 3 });
    repositories.getRecordsForRevision
      .mockResolvedValueOnce([{ recordId: "dup", status: "done" }])
      .mockResolvedValueOnce([
        { recordId: "dup", status: "done" },
        { recordId: "unique", status: "done" },
      ]);

    await processJob(job({ done: 1, cursor: 2, batchIndex: 0, batchIds: ["b1"], total: 3 , cursorOrder: CALL_ORDER }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 2 });
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({
      done: 2,
      cursor: 3,
    }));
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done", done: 2 }),
      { clearCredential: true },
    );
  });

  it("starts the next batch from zero after a durable batch transition", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.countRecords.mockResolvedValueOnce(100);
    await processJob(job({ done: 100, cursor: 0, batchIndex: 1 }));
    expect(repositories.countRecords).toHaveBeenCalledWith("t1", "a1", ["b1"]);
    expect(repositories.getBatch).toHaveBeenCalledTimes(1);
    expect(repositories.getBatch).toHaveBeenCalledWith("t1", "a1", "b2");
    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b2", limit: 100, offset: 0 });
    expect(repositories.deleteBatchRevisionRecords).toHaveBeenCalledWith("t1", "a1", "b2", "j1");
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ done: 101 }),
      { clearCredential: true },
    );
  });

  // A raw OFFSET is only meaningful under the ordering that produced it.
  // A job checkpointed by a build that sent no sort parameter (newest-first by
  // default) must not keep paging the same revision oldest-first: on a core
  // without the `id` tiebreak the two lose DIFFERENT tied rows, so the resumed
  // revision would skip some and repeat others.
  describe("list ordering across a resume", () => {
    const staged = Array.from({ length: 100 }, (_, index) => ({ recordId: `old-${index}`, status: "done" }));

    it("restarts a legacy checkpoint (no recorded ordering) from offset 0 under the current ordering", async () => {
      repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 2 });
      const sourceJob = {
        id: "source-b1", dispatch_type: "ai_voice_call", status: "completed",
        records_updated_at: "2026-09-30T10:00:00.000000Z",
      };
      client.getBulkJob.mockResolvedValue(sourceJob);
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }], total: 2 });
      repositories.getRecordsForRevision.mockResolvedValueOnce([
        { recordId: "1", status: "done" }, { recordId: "2", status: "done" },
      ]);

      await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 2 }));

      // Progress and the cursor are reset through the lease-guarded update —
      // `checkpointJob` would refuse to move `done` backwards.
      expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", {
        done: 0, cursor: 0, cursorOrder: CALL_ORDER,
      });
      // The pages fetched under the old ordering are discarded, not reused.
      expect(repositories.deleteBatchRevisionRecords).toHaveBeenCalledWith("t1", "a1", "b1", "j1");
      expect(client.listCalls).toHaveBeenCalledTimes(1);
      expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
      expect(repositories.getRecordsForRevision).toHaveBeenCalledTimes(1);
      // Every page checkpoint names the ordering it was fetched under.
      expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({
        done: 2, cursor: 2, cursorOrder: CALL_ORDER,
      }));
      // A restarted pull read the records stamp before its first page, so it
      // may claim it — unlike a genuine resume.
      expect(bulkJobRecordsStamp(sourceJob)).not.toBeNull();
      expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
        expect.objectContaining({ total: 2, ingestedRecordsStamp: bulkJobRecordsStamp(sourceJob) }),
        "j1",
        "lease-1",
      );
    });

    it("restarts a checkpoint recorded under a different ordering", async () => {
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
      await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 1, cursorOrder: "created_at:desc" }));
      expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
      expect(repositories.deleteBatchRevisionRecords).toHaveBeenCalledWith("t1", "a1", "b1", "j1");
    });

    it("resumes a checkpoint recorded under the same ordering", async () => {
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "new" }], total: 101 });
      repositories.getRecordsForRevision
        .mockResolvedValueOnce(staged)
        .mockResolvedValueOnce([...staged, { recordId: "new", status: "done" }]);
      await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 101, cursorOrder: CALL_ORDER }));
      expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
      expect(repositories.deleteBatchRevisionRecords).not.toHaveBeenCalled();
    });

    // Messaging sends no sort parameter, so a legacy checkpoint was paged under
    // exactly the ordering it would continue with.
    it("resumes a legacy messaging checkpoint, whose ordering has not changed", async () => {
      repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "message", channel: "whatsapp", total: 101 });
      client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "whatsapp_message" });
      client.listMessages.mockResolvedValueOnce({ messages: [{ id: "new" }], total: 101 });
      repositories.getRecordsForRevision
        .mockResolvedValueOnce(staged)
        .mockResolvedValueOnce([...staged, { recordId: "new", status: "done" }]);
      await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 101 }));
      expect(client.listMessages).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
      expect(repositories.deleteBatchRevisionRecords).not.toHaveBeenCalled();
      expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({
        cursorOrder: "default",
      }));
    });

    // Killed between publishing and the batch transition: the staged revision
    // IS what readers see, and it was completed under one ordering. Restarting
    // would delete its rows from under them.
    it("never restarts a revision that is already published", async () => {
      repositories.getBatch.mockResolvedValue({
        ...batch("b1"), total: 100, ingestStatus: "ready", publishedRevision: "j1",
      });
      client.listCalls.mockResolvedValueOnce({ calls: [], total: 100 });
      repositories.getRecordsForRevision.mockResolvedValue(staged);
      await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 100 }));
      expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
      expect(repositories.deleteBatchRevisionRecords).not.toHaveBeenCalled();
      expect(repositories.updateClaimedJob).not.toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({ cursor: 0 }));
      repositories.getRecordsForRevision.mockReset();
    });
  });

  it("stops if ownership is lost while checkpointing", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.checkpointJob.mockResolvedValueOnce(null);
    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost while checkpointing");
    expect(repositories.updateClaimedJob).toHaveBeenCalledTimes(1);
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      { leaseUntil: expect.any(String) },
    );
  });

  // Upstream totals are progress hints, not pagination boundaries: a dispatched
  // contact with no call row yet makes them run ahead of the rows they count.
  // A short pull still publishes, with the paginated count as the total.
  it("treats paginated rows as authoritative when an upstream total is stale-high", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 100 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }], total: 100 });
    repositories.getRecordsForRevision.mockResolvedValue([
      { recordId: "1", status: "done" },
      { recordId: "2", status: "done" },
    ]);

    await expect(processJob(job({ batchIds: ["b1"], total: 100 }))).resolves.toBeUndefined();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2 }),
      "j1",
      "lease-1",
    );
  });

  // The IVR/static-call failure: upstream reports thousands of dispatched
  // contacts and returns no rows at all. Publishing that put a green "Up to
  // date" over an empty Analytics screen, so it is now a job failure — which
  // leaves the batch "error" and the reason on the job.
  it("fails the batch when upstream returns no records for a job it reports as dispatched", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue({
      id: "source-b1",
      dispatch_type: "ivr_call",
      status: "completed",
      updated_at: "2026-09-18T10:00:00Z",
    });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 3475 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).rejects.toThrow(
      /no records returned for b1.*3475 dispatched contacts/,
    );
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(client.listIvrCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  // A batch poisoned by an empty publish before this guard existed has `total`
  // already collapsed to 0, and upstream may report 0 on the calls listing too
  // — `sourceTotal` is the only figure left that proves records are missing, so
  // the guard has to read it or those batches stay silently empty forever.
  it("catches a batch whose total already collapsed to zero, via sourceTotal", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 0, sourceTotal: 3475 });
    client.getBulkJob.mockResolvedValue({
      id: "source-b1",
      dispatch_type: "ivr_call",
      status: "completed",
      updated_at: "2026-09-18T10:00:00Z",
    });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 0 }))).rejects.toThrow(
      /3475 dispatched contacts/,
    );
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  // A campaign the customer has only just launched has dispatched contacts and
  // no calls yet. That is not the read-path gap above, and reporting "Sync
  // failed" on it would be a fresh bug of its own.
  //
  // This is also where #23's zero-row guarantee now lives. That PR replaced
  // `total: records.length || batch.total` with `total: records.length`, and
  // zero rows is the ONLY input on which those differ — so asserting `total: 0`
  // here is what stops the upstream figure creeping back as a fallback. It used
  // to be pinned by the stale-high test below, which can no longer use zero rows
  // now that they are a failure for a job that finished dialling.
  it("publishes an empty batch while upstream is still dialling", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue({
      id: "source-b1",
      dispatch_type: "ivr_call",
      status: "processing",
      updated_at: "2026-09-18T10:00:00Z",
    });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).resolves.toBeUndefined();
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0 }),
      "j1",
      "lease-1",
    );
  });

  // The guard is armed only by a status that PROVES dialling finished. These
  // three are the ways that proof can be missing, and each one used to fire it:
  // an unrecognised status, a job cancelled before it dialled (which genuinely
  // has no calls and would have been stuck in an unclearable "error"), and a
  // detail fetch that failed. All must publish rather than fail.
  it.each([
    ["an unrecognised status", { id: "source-b1", dispatch_type: "ivr_call", status: "scheduled", updated_at: "2026-09-18T10:00:00Z" }],
    ["a cancelled job", { id: "source-b1", dispatch_type: "ivr_call", status: "cancelled", updated_at: "2026-09-18T10:00:00Z" }],
    ["a job that failed before dialling", { id: "source-b1", dispatch_type: "ivr_call", status: "failed", updated_at: "2026-09-18T10:00:00Z" }],
  ])("does not fail an empty batch on %s", async (_label, bulkJob) => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue(bulkJob);
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).resolves.toBeUndefined();
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalled();
  });

  it("does not fail an empty batch when the job detail could not be fetched", async () => {
    // selType cannot tell ivr_call from static_call, so the listing's stored
    // dispatchType is what chooses the surface when the detail fetch fails.
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"),
      selType: "ivr",
      dispatchType: "ivr_call",
      total: 3475,
    });
    client.getBulkJob.mockRejectedValue(new Error("upstream 500"));
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).resolves.toBeUndefined();
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalled();
  });

  it("refuses to list an IVR batch when dispatch_type cannot be determined", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockRejectedValue(new Error("upstream 500"));

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).rejects.toThrow(
      /cannot choose a magick-master list surface/,
    );
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(client.listIvrCalls).not.toHaveBeenCalled();
    expect(client.listStaticCalls).not.toHaveBeenCalled();
  });

  it("refuses an unrecognized dispatch_type instead of inferring /proxy/calls from selType", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ai", dispatchType: "ai_voice_call" });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "webrtc_call" });

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(/unsupported dispatch_type "webrtc_call"/);
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(client.listIvrCalls).not.toHaveBeenCalled();
    expect(client.listStaticCalls).not.toHaveBeenCalled();
  });

  // Status comparison is case- and whitespace-insensitive; without the
  // normalization a padded value reads as unrecognised and silently disarms.
  it("normalizes the job status before classifying it", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue({
      id: "source-b1",
      dispatch_type: "ivr_call",
      status: " Completed ",
      updated_at: "2026-09-18T10:00:00Z",
    });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 3475 }))).rejects.toThrow(/3475 dispatched contacts/);
    expect(client.listCalls).not.toHaveBeenCalled();
  });

  // The messaging branch pages a different endpoint; the guard has to cover it
  // too, or a WhatsApp campaign can blank the same way.
  it("fails an empty messaging batch that upstream reports as dispatched", async () => {
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), selType: "message", channel: "whatsapp", total: 900,
    });
    client.getBulkJob.mockResolvedValue({
      id: "source-b1",
      dispatch_type: "whatsapp_message",
      status: "completed",
      updated_at: "2026-09-18T10:00:00Z",
    });
    client.listMessages.mockResolvedValueOnce({ messages: [], total: 900 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 900 }))).rejects.toThrow(
      /no records returned for b1.*900 dispatched contacts.*message batch/,
    );
    expect(client.listMessages).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listCalls).not.toHaveBeenCalled();
  });

  // The other direction: a campaign that genuinely dispatched nothing must
  // still publish, or an empty batch becomes a permanent error nobody can clear.
  it("publishes an empty batch when upstream reports nothing dispatched either", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 0, sourceTotal: 0 });
    client.listCalls.mockResolvedValueOnce({ calls: [], total: 0 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await expect(processJob(job({ batchIds: ["b1"], total: 0 }))).resolves.toBeUndefined();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 0 }),
      "j1",
      "lease-1",
    );
  });

  // `total` is the exact ingested count once committed; the dispatched figure
  // has to ride through publication on its own field or the next listing loses
  // it again on the commit after that.
  it("carries the dispatched count through publication", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 10, sourceTotal: 10 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 10 });

    await processJob(job({ batchIds: ["b1"], total: 10 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1, sourceTotal: 10 }),
      "j1",
      "lease-1",
    );
  });

  // Every ingestion stages a full new copy of a batch's records. Leaving the
  // superseded copies for a daily cron meant each "Refresh data" click added a
  // duplicate dataset that lingered for days, until storage ran out.
  it("reclaims revisions superseded by earlier runs once the new one is published", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(repositories.retireBatchRevision).toHaveBeenCalledBefore(
      repositories.deleteSupersededRecordRevisions,
    );
    expect(repositories.deleteSupersededRecordRevisions).toHaveBeenCalledWith("t1", "a1", "b1", "j1");
  });

  it("clears crash orphans before staging, sparing the published and staging revisions", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), publishedRevision: "rev-live" });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(repositories.deleteOrphanedRecordRevisions).toHaveBeenCalledWith(
      "t1", "a1", "b1", ["rev-live", "j1"],
    );
    // Must run before any row of the new revision is written, so a resumed job
    // never has its own staged work swept.
    expect(repositories.deleteOrphanedRecordRevisions).toHaveBeenCalledBefore(
      repositories.replaceBatchRecords,
    );
  });

  // The sweep above spares anything inside the reader grace window, so it can
  // never reclaim the revision this very job just retired. Without a second,
  // deferred pass that duplicate survives until the daily cron — which is the
  // storage growth the whole change exists to stop.
  it("comes back for the revision it just superseded, once the grace has passed", async () => {
    vi.useFakeTimers();
    try {
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
      await processJob(job({ batchIds: ["b1"], total: 1 }));
      expect(repositories.deleteSupersededRecordRevisions).toHaveBeenCalledTimes(1);

      // At fire time the batch's CURRENT published revision is what must be
      // spared — another refresh may have published a newer one since.
      repositories.getBatch.mockResolvedValue({ ...batch("b1"), publishedRevision: "j2" });
      await vi.advanceTimersByTimeAsync(SUPERSEDED_REVISION_GRACE_MS + SWEEP_DELAY_MARGIN_MS);

      expect(repositories.deleteSupersededRecordRevisions).toHaveBeenCalledTimes(2);
      expect(repositories.deleteSupersededRecordRevisions).toHaveBeenLastCalledWith("t1", "a1", "b1", "j2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail the job when the deferred sweep throws", async () => {
    vi.useFakeTimers();
    try {
      client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
      await processJob(job({ batchIds: ["b1"], total: 1 }));
      repositories.deleteSupersededRecordRevisions.mockRejectedValue(new Error("mongo down"));
      await vi.advanceTimersByTimeAsync(SUPERSEDED_REVISION_GRACE_MS + SWEEP_DELAY_MARGIN_MS);
      // Swallowed and logged, never an unhandled rejection that takes the
      // long-running worker process down hours after the job finished.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: "b1" }),
        expect.stringContaining("deferred revision sweep failed"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // The stamp a refresh compares against must predate the pull: anything
  // upstream writes while we page has to leave it behind, so the next refresh
  // re-pulls rather than concluding nothing changed.
  it("stamps the records stamp read before paging began", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), sourceFingerprint: "src-fp" });
    const observed = {
      id: "source-b1", status: "completed",
      records_updated_at: "2026-09-01T10:00:00.000001Z", status_summary: { completed: 1 },
    };
    client.getBulkJob.mockResolvedValue(observed);
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.getBulkJob).toHaveBeenCalledWith("source-b1");
    // Observed BEFORE the first page: a write landing during or after the pull
    // must move the stamp, never be absorbed into it.
    expect(client.getBulkJob.mock.invocationCallOrder[0]!)
      .toBeLessThan(client.listCalls.mock.invocationCallOrder[0]!);
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestedSourceFingerprint: "src-fp",
        ingestedRecordsStamp: bulkJobRecordsStamp(observed),
      }),
      "j1",
      "lease-1",
    );
    expect(bulkJobRecordsStamp(observed)).toEqual(expect.any(String));
  });

  it("stamps null when master reports records_updated_at unknown", async () => {
    client.getBulkJob.mockResolvedValue({ id: "source-b1", status: "completed", records_updated_at: null, status_summary: {} });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedRecordsStamp: null }),
      "j1",
      "lease-1",
    );
  });

  it("does not stamp a resumed pull, whose stamp would postdate its own pause", async () => {
    // A stampable job: the null below must come from the resume rule, not from
    // master having nothing to report.
    client.getBulkJob.mockResolvedValue({
      id: "source-b1", status: "completed", records_updated_at: "2026-09-01T10:00:00.000001Z", status_summary: {},
    });
    repositories.getRecordsForRevision
      .mockResolvedValueOnce([{ recordId: "1", status: "done" }])
      .mockResolvedValue([{ recordId: "1", status: "done" }, { recordId: "2", status: "done" }]);
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "2" }], total: 2 });

    await processJob(job({ batchIds: ["b1"], total: 2, done: 1, cursor: 1, batchIndex: 0 , cursorOrder: CALL_ORDER }));

    // A rate-limited job can pause for longer than the changes it would be
    // claiming to have captured. dispatch_type is still fetched so a resumed
    // IVR ingest can pick a surface; the *stamp* stays null.
    expect(client.getBulkJob).toHaveBeenCalledWith("source-b1");
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedRecordsStamp: null }),
      "j1",
      "lease-1",
    );
  });

  it("publishes without a stamp when the source job cannot be read", async () => {
    client.getBulkJob.mockRejectedValue(new Error("upstream down"));
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    // No stamp means no skip: the next refresh re-pulls rather than guessing.
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedRecordsStamp: null }),
      "j1",
      "lease-1",
    );
  });

  it("still completes when the superseded-revision sweep fails", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.deleteSupersededRecordRevisions.mockRejectedValue(new Error("mongo down"));

    await expect(processJob(job({ batchIds: ["b1"], total: 1 }))).resolves.toBeUndefined();
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "done" }),
      { clearCredential: true },
    );
  });

  it("stamps the source fingerprint the published revision was built from", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), sourceFingerprint: "src-fp" });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    // Without this stamp a refresh cannot tell an unchanged source from a moved
    // one, and re-pulls an identical dataset on every click.
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedSourceFingerprint: "src-fp" }),
      "j1",
      "lease-1",
    );
  });

  it("continues past a stale-low upstream total while full pages are returned", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }));
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 1 });
    client.listCalls
      .mockResolvedValueOnce({ calls: firstPage, total: 1 })
      .mockResolvedValueOnce({ calls: [{ id: "101" }], total: 1 });
    repositories.getRecordsForRevision.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({ recordId: String(index + 1), status: "done" })),
    );

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listCalls).toHaveBeenNthCalledWith(2, {
      jobId: "source-b1",
      limit: 100,
      offset: 100,
    });
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 101 }),
      "j1",
      "lease-1",
    );
  });

  it("deduplicates repeated upstream ids and publishes the unique records", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 2 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "dup" }, { id: "dup" }], total: 2 });
    repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "dup", status: "done" }]);

    await expect(processJob(job({ batchIds: ["b1"], total: 2 }))).resolves.toBeUndefined();
    expect(repositories.replaceBatchRecords).toHaveBeenCalledWith(
      "t1",
      "a1",
      "b1",
      [expect.objectContaining({ recordId: "dup" })],
    );
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1 }),
      "j1",
      "lease-1",
    );
  });

  it("rejects upstream rows that have no stable record id", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "" }], total: 1 });

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "1 of 1 records at offset 0 have no record id",
    );
    expect(repositories.replaceBatchRecords).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  it("retains partial-write detection after deduplicating source ids", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }], total: 2 });
    repositories.getRecordsForRevision.mockResolvedValue([{ recordId: "1", status: "done" }]);

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "stored 1 of 2 unique records fetched",
    );
  });

  it("does not publish after another worker replaces the batch lease owner", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.publishBatchIfOwned.mockResolvedValueOnce(false);

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "lease lost during batch publication",
    );
  });

  it("stops before fetching when a newer worker owns the batch", async () => {
    repositories.beginBatchIngestion.mockResolvedValueOnce(false);
    repositories.getBatch
      .mockResolvedValueOnce(batch("b1"))
      .mockResolvedValueOnce({
        ...batch("b1"),
        ingestJobId: "newer-job",
        ingestLeaseId: "newer-lease",
        ingestLeaseUntil: "2099-01-01T00:00:00.000Z",
      });

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "newer worker owns batch ingestion",
    );
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(repositories.getBatch).toHaveBeenCalledTimes(2);
    expect(logFns.warn).toHaveBeenCalledWith(
      {
        batchId: "b1",
        ingestJobId: "newer-job",
        ingestLeaseId: "newer-lease",
        ingestLeaseUntil: "2099-01-01T00:00:00.000Z",
      },
      "[worker] batch ingestion ownership lost",
    );
  });

  it("logs the snapshot ownership when a re-read after denial fails", async () => {
    repositories.beginBatchIngestion.mockResolvedValueOnce(false);
    repositories.getBatch
      .mockResolvedValueOnce({
        ...batch("b1"),
        ingestJobId: "old-job",
        ingestLeaseId: "old-lease",
        ingestLeaseUntil: "2026-08-12T12:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("mongo down"));

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(
      "newer worker owns batch ingestion",
    );
    expect(logFns.warn).toHaveBeenCalledWith(
      {
        batchId: "b1",
        ingestJobId: "old-job",
        ingestLeaseId: "old-lease",
        ingestLeaseUntil: "2026-08-12T12:00:00.000Z",
      },
      "[worker] batch ingestion ownership lost",
    );
  });
});

describe("processJob dispatch-type routing", () => {
  it("reads IVR jobs from /proxy/ivr-calls as sessions, with job_id", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr" });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "ivr_call" });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [{ id: "sess-1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listIvrCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(client.listStaticCalls).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1, dispatchType: "ivr_call" }),
      "j1",
      "lease-1",
    );
  });

  it("reads static-call jobs from /proxy/static-calls as calls, with job_id", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr" });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "static_call" });
    client.listStaticCalls.mockResolvedValueOnce({ calls: [{ id: "st-1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listStaticCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(client.listIvrCalls).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchType: "static_call" }),
      "j1",
      "lease-1",
    );
  });

  it("reads messaging jobs with job_id, not the job id stuffed into batch_id", async () => {
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"),
      selType: "message",
      channel: "whatsapp",
    });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "whatsapp_message" });
    client.listMessages.mockResolvedValueOnce({ messages: [{ id: "m1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listMessages).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listCalls).not.toHaveBeenCalled();
  });

  it("reads telegram jobs through listMessages with job_id", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "message", channel: "telegram" });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "telegram_message" });
    client.listMessages.mockResolvedValueOnce({ messages: [{ id: "m1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listMessages).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listCalls).not.toHaveBeenCalled();
  });

  it("reads email jobs through listMessages with job_id", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "message", channel: "email" });
    client.getBulkJob.mockResolvedValue({ id: "source-b1", dispatch_type: "email_message" });
    client.listMessages.mockResolvedValueOnce({ messages: [{ id: "m1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listMessages).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listCalls).not.toHaveBeenCalled();
  });

  it("refuses to list without sourceId rather than sending MagickUtils batchId as core batch_id", async () => {
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"),
      sourceId: "",
      dispatchType: "ai_voice_call",
    });

    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow(/no sourceId/);
    expect(client.listCalls).not.toHaveBeenCalled();
    expect(client.listMessages).not.toHaveBeenCalled();
    expect(client.listIvrCalls).not.toHaveBeenCalled();
    expect(client.listStaticCalls).not.toHaveBeenCalled();
    expect(client.getBulkJob).not.toHaveBeenCalled();
  });

  it("keeps AI jobs on /proxy/calls with job_id", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "c1" }], total: 1 });

    await processJob(job({ batchIds: ["b1"], total: 1 }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 0 });
    expect(client.listIvrCalls).not.toHaveBeenCalled();
    expect(client.listStaticCalls).not.toHaveBeenCalled();
  });
});

describe("runClaimedJob empty-pull failure", () => {
  // The commit's user-facing promise: the batch stops reading "Up to date" and
  // the reason reaches the job, where the screen prints it. `processJob` alone
  // cannot show this — the transition happens in runClaimedJob's catch.
  it("fails the job terminally and releases the batch so the screen can say so", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3475 });
    client.getBulkJob.mockResolvedValue({
      id: "source-b1",
      dispatch_type: "ivr_call",
      status: "completed",
      updated_at: "2026-09-18T10:00:00Z",
    });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 3475 });
    repositories.getRecordsForRevision.mockResolvedValue([]);

    await runClaimedJob(job({ batchIds: ["b1"], total: 3475 }));

    // Terminal, not deferred — a deferral would retry this forever.
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({
        status: "error",
        error: expect.stringMatching(/3475 dispatched contacts/),
        leaseUntil: null,
        leaseId: null,
      }),
      { clearCredential: true },
    );
    expect(repositories.failBatchIfOwned).toHaveBeenCalledWith("t1", "a1", "b1", "j1", "lease-1");
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
  });

  // One blacked-out batch must not take an already-published sibling with it.
  // `failBatchIfOwned`/`deleteUnpublishedBatchRevision` are scoped to this job's
  // ownership markers, which a publish clears — this pins that they no-op on b1.
  it("leaves an already-published batch intact when a later batch blacks out", async () => {
    repositories.getBatch.mockImplementation((_t: string, _a: string, id: string) =>
      Promise.resolve(
        id === "b2"
          ? { ...batch("b2"), selType: "ivr", total: 3475 }
          : { ...batch("b1"), total: 1 },
      ),
    );
    client.getBulkJob.mockImplementation(async (id: string) => {
      if (id === "source-b2") {
        return { id, dispatch_type: "ivr_call", status: "completed", updated_at: "2026-09-18T10:00:00Z" };
      }
      return { id, dispatch_type: "ai_voice_call", status: "completed", updated_at: "2026-09-18T10:00:00Z" };
    });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [], total: 3475 });
    repositories.getRecordsForRevision
      .mockResolvedValueOnce([{ recordId: "1", status: "done" }])
      .mockResolvedValue([]);

    await runClaimedJob(job({ batchIds: ["b1", "b2"], total: 3476 }));

    // b1 published before b2 threw, and stays published.
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledTimes(1);
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "b1" }),
      "j1",
      "lease-1",
    );
  });
});

describe("processJob incomplete upstream pull", () => {
  // The Samarthya defect, in miniature: core pages calls over a non-unique
  // `created_at`, and tied rows are lost deterministically. The pull returns as
  // many raw rows as `total` (3), but one id twice and another never.
  const completed = { id: "source-b1", dispatch_type: "ai_voice_call", status: "completed", records_updated_at: "2026-09-30T10:00:00.000000Z" };
  const records = (...ids: string[]) => ids.map((recordId) => ({ recordId, status: "done" }));
  const shortPage = { calls: [{ id: "1" }, { id: "1" }, { id: "2" }], total: 3 };

  beforeEach(() => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), name: "Promo", total: 3 });
    client.getBulkJob.mockResolvedValue(completed);
  });
  // `clearAllMocks` keeps implementations, and these tests set persistent ones.
  afterEach(() => {
    client.listCalls.mockReset();
    client.listIvrCalls.mockReset();
    repositories.getRecordsForRevision.mockReset();
  });

  it("publishes a first-ever short pull flagged incomplete, after exactly one pass", async () => {
    // Never ingested: nothing readable to fall back on.
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), name: "Promo", total: 3, ingestStatus: "none" });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    // One pass: against an unfixed upstream the loss is deterministic, so a
    // re-pull is pure load.
    expect(client.listCalls).toHaveBeenCalledTimes(1);
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 2,
        ingestedListedTotal: 3,
        ingestStatus: "stale",
        shortPull: expect.objectContaining({ listed: 3, received: 2, keptPrevious: false }),
      }),
      "j1",
      "lease-1",
    );
    expect(repositories.keepPublishedRevisionIfOwned).not.toHaveBeenCalled();
    // The warning is durable in the same write that moves the job past b1.
    expect(repositories.checkpointJob).toHaveBeenCalledWith("j1", "lease-1", {
      done: 2, cursor: 0, batchIndex: 1, warnings: [expect.objectContaining({ batchId: "b1", kind: "incomplete_upstream" })],
    });
    // The job finishes, carrying the shortfall where the screen can read it.
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({
        status: "done",
        warnings: [
          expect.objectContaining({
            kind: "incomplete_upstream",
            batchId: "b1",
            listed: 3,
            received: 2,
            served: 2,
            keptPrevious: false,
            message: expect.stringMatching(/Upstream returned 2 of 3 records for "Promo"/),
          }),
        ],
      }),
      { clearCredential: true },
    );
    expect(logFns.warn).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "b1", listedTotal: 3, uniqueRecords: 2, missingRecords: 1, duplicateRows: 1 }),
      expect.stringMatching(/publishing it flagged incomplete/),
    );
  });

  it("keeps a fuller published revision, marks the batch stale and finishes the other batches", async () => {
    repositories.getBatch.mockImplementation((_t: string, _a: string, id: string) =>
      Promise.resolve(
        id === "b1"
          ? { ...batch("b1"), name: "Promo", total: 3, ingestStatus: "ready", publishedRevision: "old-rev" }
          : batch(id),
      ),
    );
    client.getBulkJob.mockImplementation((id: string) => Promise.resolve({ ...completed, id }));
    client.listCalls
      .mockResolvedValueOnce(shortPage) // b1: 2 unique of 3
      .mockResolvedValueOnce({ calls: [{ id: "9" }], total: 1 }); // b2: complete
    repositories.getRecordsForRevision.mockResolvedValueOnce(records("1", "2")).mockResolvedValueOnce(records("9"));

    await processJob(job({ batchIds: ["b1", "b2"], total: 4 }));

    // b1: the 3-record revision readers see stays published, flagged.
    expect(repositories.keepPublishedRevisionIfOwned).toHaveBeenCalledWith(
      "t1",
      "a1",
      "b1",
      "j1",
      "lease-1",
      expect.objectContaining({ listed: 3, received: 2, keptPrevious: true }),
      // A fuller kept revision was built from an earlier pull: no stamps from this one.
      undefined,
    );
    // The staged copy is removed: once when staging began, once after the keep
    // (through the variant that re-reads the batch before deleting).
    const b1Deletes = repositories.deleteBatchRevisionRecords.mock.calls.filter((call) => call[2] === "b1");
    expect(b1Deletes).toEqual([["t1", "a1", "b1", "j1"]]);
    expect(repositories.deleteUnpublishedBatchRevision).toHaveBeenCalledWith("t1", "a1", "b1", "j1");
    expect(repositories.retireBatchRevision).not.toHaveBeenCalledWith("t1", "a1", "b1", expect.anything());
    // b2 is published normally, with nothing flagged.
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledTimes(1);
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "b2", shortPull: null, ingestStatus: "ready" }),
      "j1",
      "lease-1",
    );
    // The job is done — not failed — and says what happened to b1.
    expect(repositories.failBatchIfOwned).not.toHaveBeenCalled();
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({
        status: "done",
        done: 4,
        warnings: [expect.objectContaining({ batchId: "b1", keptPrevious: true, served: 3 })],
      }),
      { clearCredential: true },
    );
  });

  it("does not fail the job through runClaimedJob either", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), name: "Promo", total: 3, ingestStatus: "stale" });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await runClaimedJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.updateClaimedJob).not.toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "error" }),
      expect.anything(),
    );
    expect(repositories.failBatchIfOwned).not.toHaveBeenCalled();
    expect(repositories.keepPublishedRevisionIfOwned).toHaveBeenCalled();
  });

  // On a tie whose CONTENT differs (the published fingerprint here is not this
  // pull's) the fresh pull carries newer statuses, so it is published; an
  // older, smaller revision (a snapshot taken while the job still ran) is worse.
  it.each([
    ["the same size as, but different from,", 2],
    ["smaller than", 1],
  ])("publishes the short pull over a revision %s it", async (_label, previousTotal) => {
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), name: "Promo", total: previousTotal, ingestStatus: "ready", publishedRevision: "old-rev",
    });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: previousTotal }));

    expect(repositories.keepPublishedRevisionIfOwned).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, shortPull: expect.objectContaining({ keptPrevious: false }) }),
      "j1",
      "lease-1",
    );
  });

  // Against a core without the `id` tiebreak every re-pull of a finished job is
  // the identical short set. Publishing it again wrote a complete duplicate
  // dataset per merge / download / Refresh while changing nothing a reader can
  // see. The published revision is the same data: keep it, write nothing but
  // the flag and the built-from stamps, and delete the staged copy.
  it("writes no new revision when a short re-pull is identical to the published one", async () => {
    // Pull once to learn this dataset's content fingerprint.
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));
    await processJob(job({ batchIds: ["b1"], total: 3 }));
    const publishedFp = repositories.publishBatchIfOwned.mock.calls[0][0].fingerprint as string;
    vi.clearAllMocks();

    // That revision is now what readers see, flagged short.
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), name: "Promo", total: 2, fingerprint: publishedFp, ingestStatus: "stale",
      publishedRevision: "old-rev", sourceFingerprint: "src-fp", sourceTotal: 3, ingestedListedTotal: 3,
      shortPull: { listed: 3, received: 2, keptPrevious: false, detectedAt: "2026-10-01T00:00:00Z" },
    });
    client.getBulkJob.mockResolvedValue({ ...completed, total_contacts: 3 });
    client.listCalls.mockResolvedValueOnce(shortPage);

    await processJob(job({ batchIds: ["b1"], total: 2 }));

    expect(client.listCalls).toHaveBeenCalledTimes(1);
    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
    expect(repositories.retireBatchRevision).not.toHaveBeenCalled();
    expect(repositories.keepPublishedRevisionIfOwned).toHaveBeenCalledWith(
      "t1",
      "a1",
      "b1",
      "j1",
      "lease-1",
      // Readers see exactly this pull's records, so nothing "earlier" is kept.
      expect.objectContaining({ listed: 3, received: 2, keptPrevious: false, detectedAt: expect.any(String) }),
      {
        ingestedListedTotal: 3,
        ingestedSourceFingerprint: "src-fp",
        ingestedRecordsStamp: bulkJobRecordsStamp(completed),
        sourceTotal: 3,
      },
    );
    // The fresh observation re-arms the merge cooldown.
    const recorded = repositories.keepPublishedRevisionIfOwned.mock.calls[0][5];
    expect(recorded.detectedAt).not.toBe("2026-10-01T00:00:00Z");
    // Staged copy dropped: unconditionally when staging began, then after the
    // keep through the variant that re-reads the batch first, so a revision
    // published since `batch` was read can never be deleted from its readers.
    expect(repositories.deleteBatchRevisionRecords.mock.calls).toEqual([["t1", "a1", "b1", "j1"]]);
    expect(repositories.deleteUnpublishedBatchRevision.mock.calls).toEqual([["t1", "a1", "b1", "j1"]]);
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({
        status: "done",
        done: 2,
        warnings: [expect.objectContaining({ batchId: "b1", keptPrevious: false, served: 2 })],
      }),
      { clearCredential: true },
    );
    expect(logFns.warn).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: "b1", unchanged: true }),
      expect.stringMatching(/identical to the published revision; nothing written/),
    );
  });

  // The skip is only safe if the fingerprint sees everything a reader can: a
  // recording, a transcript or an outcome that arrives after the campaign
  // finished changes no status and no cost, and a hand-picked field list that
  // omitted them kept such a batch stale and stamped it current.
  it.each([
    ["recordingUrl", "/api/v1/calls/2/recording"],
    ["transcript", "agent: hello\nuser: yes"],
    ["outcome", "promise_to_pay"],
    ["conversationSummary", "Agreed to pay"],
    ["deliveredAt", "2026-10-01T00:01:00Z"],
  ])("publishes a short tie that differs only in %s", async (field, value) => {
    const before = [
      { recordId: "1", status: "done", recordingUrl: null, transcript: null, outcome: null },
      { recordId: "2", status: "done", recordingUrl: null, transcript: null, outcome: null },
    ];
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(before);
    await processJob(job({ batchIds: ["b1"], total: 3 }));
    const publishedFp = repositories.publishBatchIfOwned.mock.calls[0][0].fingerprint as string;
    vi.clearAllMocks();

    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), name: "Promo", total: 2, fingerprint: publishedFp, ingestStatus: "stale",
      publishedRevision: "old-rev", shortPull: { listed: 3, received: 2, keptPrevious: false, detectedAt: "2026-10-01T00:00:00Z" },
    });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue([before[0], { ...before[1], [field]: value }]);
    await processJob(job({ batchIds: ["b1"], total: 2 }));

    expect(repositories.keepPublishedRevisionIfOwned).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledTimes(1);
    expect(repositories.publishBatchIfOwned.mock.calls[0][0].fingerprint).not.toBe(publishedFp);
  });

  // Two copies of identical data never agree on their storage metadata: each
  // pull stages a new revision, Mongo gives each copy its own _id, and every
  // record carries the batch fingerprint as of the pull that wrote it. None of
  // that may break the match, or the skip never fires.
  it("still writes nothing for an identical tie whose copies differ only in storage metadata", async () => {
    const content = { status: "done", recordingUrl: "/r", transcript: "t", outcome: "o" };
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue([
      { _id: "oid-a1", recordId: "1", revision: "rev-a", revisionCreatedAt: new Date(1), fingerprint: "fp", ...content },
      { _id: "oid-a2", recordId: "2", revision: "rev-a", revisionCreatedAt: new Date(1), fingerprint: "fp", ...content },
    ]);
    await processJob(job({ batchIds: ["b1"], total: 3 }));
    const publishedFp = repositories.publishBatchIfOwned.mock.calls[0][0].fingerprint as string;
    vi.clearAllMocks();

    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), name: "Promo", total: 2, fingerprint: publishedFp, ingestStatus: "stale", publishedRevision: "old-rev",
    });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue([
      // Reverse order, new ids/revision/stamp, and null where the first copy
      // had nothing — what a Mongo round trip of undefined produces.
      { _id: "oid-b2", recordId: "2", revision: "rev-b", revisionCreatedAt: new Date(2), fingerprint: publishedFp, ...content, dtmfInput: null },
      { _id: "oid-b1", recordId: "1", revision: "rev-b", revisionCreatedAt: new Date(2), fingerprint: publishedFp, ...content },
    ]);
    await processJob(job({ batchIds: ["b1"], total: 2 }));

    expect(repositories.publishBatchIfOwned).not.toHaveBeenCalled();
    expect(repositories.keepPublishedRevisionIfOwned).toHaveBeenCalledTimes(1);
  });

  // Never-ingested batches cannot be "unchanged": there is nothing readable,
  // so the first short pull is published even if a fingerprint happens to match.
  it("publishes a first short pull even when the batch's fingerprint matches", async () => {
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));
    await processJob(job({ batchIds: ["b1"], total: 3 }));
    const publishedFp = repositories.publishBatchIfOwned.mock.calls[0][0].fingerprint as string;
    vi.clearAllMocks();

    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), name: "Promo", total: 2, fingerprint: publishedFp, ingestStatus: "none",
    });
    client.listCalls.mockResolvedValueOnce(shortPage);
    await processJob(job({ batchIds: ["b1"], total: 2 }));

    expect(repositories.keepPublishedRevisionIfOwned).not.toHaveBeenCalled();
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledTimes(1);
  });

  // A stop is not instantly final: master flips the job to cancelled/failed
  // while a dispatch request to core may still be inserting rows. Inside the
  // settle window the pull is judged as for a running job — published stamped
  // short, re-pullable, told to nobody — and the next pull judges it exactly.
  it.each([
    ["cancelled", { cancelled_at: new Date(Date.now() - 60_000).toISOString() }],
    ["failed", { completed_at: new Date(Date.now() - 60_000).toISOString() }],
  ])("does not flag a short pull of a %s job inside the settle window", async (status, stamps) => {
    client.getBulkJob.mockResolvedValue({ ...completed, status, ...stamps });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ shortPull: null, ingestedListedTotal: 3, ingestStatus: "stale" }),
      "j1",
      "lease-1",
    );
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.not.objectContaining({ warnings: expect.anything() }),
      { clearCredential: true },
    );
  });

  it.each([
    ["cancelled", { cancelled_at: new Date(Date.now() - 10 * 60_000).toISOString() }],
    ["failed", { completed_at: new Date(Date.now() - 10 * 60_000).toISOString() }],
  ])("flags a short pull of a %s job once the settle window has passed", async (status, stamps) => {
    client.getBulkJob.mockResolvedValue({ ...completed, status, ...stamps });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ shortPull: expect.objectContaining({ listed: 3, received: 2 }) }),
      "j1",
      "lease-1",
    );
  });

  // `completed`/`dispatched` are untouched by the window, however recent.
  it("flags a short pull of a just-completed job without waiting", async () => {
    client.getBulkJob.mockResolvedValue({ ...completed, completed_at: new Date().toISOString() });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ shortPull: expect.objectContaining({ listed: 3, received: 2 }) }),
      "j1",
      "lease-1",
    );
  });

  // The convergence half: once upstream is fixed, the next pull is whole, and
  // it clears whatever an earlier pull recorded.
  it("clears a previous shortfall when the pull comes back complete", async () => {
    repositories.getBatch.mockResolvedValue({
      ...batch("b1"), name: "Promo", total: 2, ingestStatus: "stale", publishedRevision: "old-rev",
      ingestedListedTotal: 3, shortPull: { listed: 3, received: 2, keptPrevious: false, detectedAt: "x" },
    });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }, { id: "3" }], total: 3 });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2", "3"));

    await processJob(job({ batchIds: ["b1"], total: 2, warnings: [{ batchId: "b1" } as never] }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 3, ingestedListedTotal: 3, shortPull: null, ingestStatus: "ready" }),
      "j1",
      "lease-1",
    );
    // A warning an earlier run of this job left for b1 is withdrawn — in the
    // same write that moves the job past b1.
    expect(repositories.checkpointJob).toHaveBeenCalledWith("j1", "lease-1", {
      done: 3, cursor: 0, batchIndex: 1, warnings: [],
    });
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.not.objectContaining({ warnings: expect.anything() }),
      { clearCredential: true },
    );
  });

  // Duplicates alone are not loss: a reshuffle that happened to repeat rows
  // while still delivering every id is a complete pull.
  it("publishes a pull with duplicates whose unique records still reach the total", async () => {
    client.listCalls.mockResolvedValueOnce({
      calls: [{ id: "1" }, { id: "2" }, { id: "2" }, { id: "3" }],
      total: 3,
    });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2", "3"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 3, shortPull: null, ingestStatus: "ready" }),
      "j1",
      "lease-1",
    );
  });

  // Still dispatching: the COUNT and the pages legitimately move apart. It is
  // published unflagged (no warning, nothing told to the reader) but stamped
  // short and read stale, so the next refresh re-pulls it; its records stamp
  // moves anyway as the job progresses.
  it.each(["processing", "queued", "running"])("publishes a short pull unflagged while the job is %s", async (status) => {
    client.getBulkJob.mockResolvedValue({ ...completed, status });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, ingestedListedTotal: 3, shortPull: null, ingestStatus: "stale" }),
      "j1",
      "lease-1",
    );
    expect(repositories.keepPublishedRevisionIfOwned).not.toHaveBeenCalled();
    expect(repositories.updateClaimedJob).toHaveBeenLastCalledWith(
      "j1",
      "lease-1",
      expect.not.objectContaining({ warnings: expect.anything() }),
      { clearCredential: true },
    );
  });

  // Cancelled and failed jobs add no more rows, so their shortfall is loss and
  // is said out loud — exempting them is what left such batches silently short
  // and "stale" with nothing to explain why.
  it.each(["cancelled", "failed", "partially_failed", "dispatched"])("flags a short pull of a %s job", async (status) => {
    client.getBulkJob.mockResolvedValue({ ...completed, status });
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));

    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ shortPull: expect.objectContaining({ listed: 3, received: 2 }) }),
      "j1",
      "lease-1",
    );
  });

  it("publishes unflagged while the job detail is unreadable, since nothing proves its rows settled", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 3, dispatchType: "ai_voice_call" });
    client.getBulkJob.mockRejectedValue(new Error("upstream 500"));
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }], total: 3 });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ shortPull: null }),
      "j1",
      "lease-1",
    );
  });

  it("stamps a pull whose surface reported no total with what it returned", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }] });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, ingestedListedTotal: 2, shortPull: null, ingestStatus: "ready" }),
      "j1",
      "lease-1",
    );
  });

  // More unique rows than the COUNT means rows were added between the COUNT and
  // the pages, never that any were lost.
  it("does not flag unique records above the listed total", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }], total: 3 });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2", "3", "4"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 4, shortPull: null, ingestStatus: "ready" }),
      "j1",
      "lease-1",
    );
  });

  // The check compares against the LIST's total, never the contact count: a
  // partially-failed campaign dispatches contacts that never become rows, and
  // judging it by `total_contacts` would flag healthy campaigns forever.
  it("ignores a dispatched contact count above the rows the list counts", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 500, sourceTotal: 500 });
    client.getBulkJob.mockResolvedValue({ ...completed, status: "partially_failed", total_contacts: 500 });
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }, { id: "2" }, { id: "3" }], total: 3 });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2", "3"));

    await processJob(job({ batchIds: ["b1"], total: 500 }));
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ total: 3, ingestedListedTotal: 3, shortPull: null, ingestStatus: "ready" }),
      "j1",
      "lease-1",
    );
  });

  it("applies to the other list surfaces too", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), selType: "ivr", total: 3 });
    client.getBulkJob.mockResolvedValue({ ...completed, dispatch_type: "ivr_call" });
    client.listIvrCalls.mockResolvedValueOnce({ sessions: [{ id: "1" }, { id: "1" }, { id: "2" }], total: 3 });
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await processJob(job({ batchIds: ["b1"], total: 3 }));
    expect(client.listIvrCalls).toHaveBeenCalledTimes(1);
    expect(repositories.publishBatchIfOwned).toHaveBeenCalledWith(
      expect.objectContaining({ shortPull: expect.objectContaining({ listed: 3, received: 2 }) }),
      "j1",
      "lease-1",
    );
  });

  // The keep path used to move `batchIndex` past the batch in one write and
  // record the warning in a second, after `ingestBatch` returned. A kill
  // between the two resumed the job past the batch with no warning, and
  // Analytics — which treats every batch of the job as covered by its warnings
  // — suppressed the listing's shortfall too, so the notice vanished.
  it("still reports the shortfall when the job dies right after keeping the published revision", async () => {
    const publishedFp = recordsContentFingerprint(records("1", "2") as never);
    repositories.getBatch.mockImplementation((_t: string, _a: string, id: string) =>
      Promise.resolve(
        id === "b1"
          ? { ...batch("b1"), name: "Promo", total: 2, fingerprint: publishedFp, ingestStatus: "stale", publishedRevision: "old-rev" }
          : batch(id),
      ),
    );
    client.getBulkJob.mockImplementation((id: string) => Promise.resolve({ ...completed, id }));
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValueOnce(records("1", "2"));
    // The job document as Mongo would hold it: every durable write applied.
    let stored: Job = job({ batchIds: ["b1", "b2"], total: 3 });
    const persist = (_jobId: string, _leaseId: string, patch: Partial<Job>) => {
      stored = { ...stored, ...patch };
      return Promise.resolve(stored);
    };
    repositories.checkpointJob.mockImplementation(persist);
    // The lease is lost on the very next write after the transition past b1,
    // whatever that write is — the narrowest kill the old ordering lost to.
    let killed = false;
    repositories.updateClaimedJob.mockImplementation((jobId: string, leaseId: string, patch: Partial<Job>) => {
      if (!killed && stored.batchIndex === 1) {
        killed = true;
        return Promise.resolve(null);
      }
      return persist(jobId, leaseId, patch);
    });

    await expect(processJob(stored)).rejects.toThrow(/lease lost/);
    expect(killed).toBe(true);
    expect(repositories.keepPublishedRevisionIfOwned).toHaveBeenCalledTimes(1);
    expect(stored.batchIndex).toBe(1);
    expect(stored.warnings).toEqual([expect.objectContaining({ kind: "incomplete_upstream", batchId: "b1" })]);

    // A new claim resumes past b1 and finishes b2; b1's warning survives.
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "9" }], total: 1 });
    repositories.getRecordsForRevision.mockResolvedValueOnce(records("9"));
    await processJob({ ...stored, leaseId: "lease-1" });

    expect(client.listCalls).toHaveBeenCalledTimes(2);
    expect(stored.status).toBe("done");
    expect(stored.warnings).toEqual([
      expect.objectContaining({ kind: "incomplete_upstream", batchId: "b1", listed: 3, received: 2 }),
    ]);
  });

  it("fails on a lost lease while keeping the previous revision", async () => {
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), total: 3, ingestStatus: "ready" });
    repositories.keepPublishedRevisionIfOwned.mockResolvedValueOnce(false);
    client.listCalls.mockResolvedValueOnce(shortPage);
    repositories.getRecordsForRevision.mockResolvedValue(records("1", "2"));

    await expect(processJob(job({ batchIds: ["b1"], total: 3 }))).rejects.toThrow(/lease lost/);
    // Only the delete that began staging — the cleanup is left to whoever
    // owns the batch now (failure cleanup or the orphan sweep).
    expect(repositories.deleteBatchRevisionRecords).toHaveBeenCalledTimes(1);
  });
});

describe("runClaimedJob 429", () => {
  it("durably schedules the Retry-After transition", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "60"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    await runClaimedJob(job({ batchIds: ["b1"], retryCount: 2 }));
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({
      status: "rate_limited",
      retryAt: "2026-08-12T12:01:00.000Z",
      retryCount: 3,
      leaseUntil: null,
      leaseId: null,
    }));
    vi.useRealTimers();
  });

  it("surfaces scheduling persistence failure", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "1"));
    repositories.updateClaimedJob.mockResolvedValueOnce(job()).mockResolvedValueOnce(null);
    await expect(runClaimedJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost before rate-limit scheduling");
  });

  it("names the deferral reason so the screen can say which kind of pause this is", async () => {
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "60"));

    await runClaimedJob(job({ batchIds: ["b1"] }));

    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({ status: "rate_limited", deferReason: "rate_limited" }),
    );
  });

  it("KEEPS the job's credential when it is only deferred", async () => {
    // A deferred job resumes and pages the rest of the campaign with this same
    // credential. Clearing it here would strand every paused job.
    client.listCalls.mockRejectedValueOnce(new MagickApiError(429, "limited", "url", "60"));

    await runClaimedJob(job({ batchIds: ["b1"], refreshToken: "refresh-1" }));

    const deferral = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "rate_limited",
    );
    expect(deferral).toBeDefined();
    expect(deferral?.[3]).toBeUndefined();
  });
});

describe("runClaimedJob credential lifetime", () => {
  it("drops the credential in the same write that completes the job", async () => {
    // A refresh token does not expire. A thirty-second merge would otherwise
    // leave one at rest in Mongo until the retention sweep — an external cron
    // that fails silently and is sized by DATA_RETENTION_DAYS, which an operator
    // may raise for reasons that have nothing to do with credentials.
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });

    await runClaimedJob(job({ batchIds: ["b1"], total: 1, refreshToken: "refresh-1" }));

    const completion = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "done",
    );
    expect(completion?.[3]).toEqual({ clearCredential: true });
  });

  it("drops the credential when the job fails for good, too", async () => {
    client.listCalls.mockRejectedValueOnce(new Error("upstream failed"));

    await runClaimedJob(job({ batchIds: ["b1"], refreshToken: "refresh-1" }));

    const failure = repositories.updateClaimedJob.mock.calls.find(
      ([, , patch]) => (patch as { status?: string }).status === "error",
    );
    expect(failure?.[3]).toEqual({ clearCredential: true });
  });
});

describe("runClaimedJob terminal failures", () => {
  it("marks a partially written batch as errored", async () => {
    client.listCalls.mockRejectedValueOnce(new Error("upstream failed"));
    repositories.getBatch.mockResolvedValue({ ...batch("b1"), ingestStatus: "ingesting" });
    repositories.beginBatchIngestion.mockResolvedValue(true);
    repositories.updateClaimedJob.mockResolvedValue(job());
    await runClaimedJob(job({ batchIds: ["b1"] }));
    expect(repositories.failBatchIfOwned).toHaveBeenCalledWith("t1", "a1", "b1", "j1", "lease-1");
  });

  it("fails a wrong-surface 400 terminally rather than deferring it", async () => {
    client.listCalls.mockRejectedValueOnce(
      new MagickApiError(400, "job is ivr_call", "/proxy/calls"),
    );

    await runClaimedJob(job({ batchIds: ["b1"] }));

    expect(repositories.updateClaimedJob).toHaveBeenCalledWith(
      "j1",
      "lease-1",
      expect.objectContaining({
        status: "error",
        error: expect.stringMatching(/400/),
        leaseUntil: null,
        leaseId: null,
      }),
      { clearCredential: true },
    );
    expect(repositories.failBatchIfOwned).toHaveBeenCalledWith("t1", "a1", "b1", "j1", "lease-1");
  });
});
