import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  checkpointJob: vi.fn(),
  claimNextJob: vi.fn(),
  deleteBatchRecords: vi.fn(),
  getBatch: vi.fn(),
  getRecords: vi.fn(),
  replaceBatchRecords: vi.fn(),
  updateClaimedJob: vi.fn(),
  upsertBatch: vi.fn(),
}));
const client = vi.hoisted(() => ({ listCalls: vi.fn(), listMessages: vi.fn() }));

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
  logger: { info: vi.fn(), error: vi.fn() },
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/server/observability/request-context", () => ({ runWithRequestContext: vi.fn() }));

import { MagickApiError } from "@/lib/server/magick-client";
import { processJob, runClaimedJob } from "@/lib/server/worker";
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
  total: 200,
  fingerprint: "fp",
});

beforeEach(() => {
  vi.clearAllMocks();
  repositories.checkpointJob.mockResolvedValue(job());
  repositories.updateClaimedJob.mockResolvedValue(job());
  repositories.deleteBatchRecords.mockResolvedValue(undefined);
  repositories.getBatch.mockImplementation((_t, _a, id) => Promise.resolve(batch(id)));
  repositories.getRecords.mockResolvedValue([]);
  repositories.replaceBatchRecords.mockResolvedValue(undefined);
  repositories.upsertBatch.mockResolvedValue(undefined);
});

describe("processJob resume", () => {
  it("resumes at the durable offset and derives progress without double counting", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "101" }], total: 101 });
    await processJob(job({ done: 100, cursor: 100, batchIndex: 0, batchIds: ["b1"], total: 101 }));

    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b1", limit: 100, offset: 100 });
    expect(repositories.deleteBatchRecords).not.toHaveBeenCalled();
    expect(repositories.replaceBatchRecords).toHaveBeenCalledTimes(1);
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(1, "j1", "lease-1", expect.objectContaining({ done: 101, cursor: 101, batchIndex: 0 }));
    expect(repositories.checkpointJob).toHaveBeenNthCalledWith(2, "j1", "lease-1", { done: 101, cursor: 0, batchIndex: 1 });
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({ status: "done", done: 101 }));
  });

  it("starts the next batch from zero after a durable batch transition", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    await processJob(job({ done: 100, cursor: 0, batchIndex: 1 }));
    expect(repositories.getBatch).toHaveBeenCalledTimes(1);
    expect(repositories.getBatch).toHaveBeenCalledWith("t1", "a1", "b2");
    expect(client.listCalls).toHaveBeenCalledWith({ jobId: "source-b2", limit: 100, offset: 0 });
    expect(repositories.deleteBatchRecords).toHaveBeenCalledWith("t1", "a1", "b2");
    expect(repositories.updateClaimedJob).toHaveBeenCalledWith("j1", "lease-1", expect.objectContaining({ done: 101 }));
  });

  it("stops if ownership is lost while checkpointing", async () => {
    client.listCalls.mockResolvedValueOnce({ calls: [{ id: "1" }], total: 1 });
    repositories.checkpointJob.mockResolvedValueOnce(null);
    await expect(processJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost while checkpointing");
    expect(repositories.updateClaimedJob).not.toHaveBeenCalled();
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
    repositories.updateClaimedJob.mockResolvedValueOnce(null);
    await expect(runClaimedJob(job({ batchIds: ["b1"] }))).rejects.toThrow("job lease lost before rate-limit scheduling");
  });
});
