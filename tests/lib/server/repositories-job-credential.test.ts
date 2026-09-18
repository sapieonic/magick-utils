// The job document's credential fields: who may write them, and when they are
// dropped.
//
// A job carries the caller's Firebase credential so the worker can keep paging
// magick-master after the enqueuing request is gone. The ID token dies in an
// hour; the REFRESH token does not expire at all, which is what makes both of
// these load-bearing rather than housekeeping.

import { beforeEach, describe, expect, it, vi } from "vitest";

const jobsCol = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  aggregates: vi.fn(),
  aiUsage: vi.fn(),
  batches: vi.fn(),
  ingestionLocks: vi.fn(),
  insights: vi.fn(),
  jobs: vi.fn(async () => jobsCol),
  records: vi.fn(),
}));

import { refreshJobCredential, updateClaimedJob } from "@/lib/server/repositories";

/** The non-terminal statuses a live job can be in. A finished or failed job is
 *  deliberately not among them. */
const LIVE_STATUSES = ["queued", "running", "rate_limited"];

beforeEach(() => {
  vi.clearAllMocks();
  jobsCol.updateOne.mockResolvedValue({ modifiedCount: 1 });
  jobsCol.findOneAndUpdate.mockResolvedValue(null);
});

describe("refreshJobCredential", () => {
  it("re-stamps a live job with both halves of the new credential", async () => {
    // The rescue path: a user whose sign-in expired mid-ingest signs back in,
    // the screen reattaches to this same job, and that request's freshly minted
    // token lands here so the worker's next claim resumes instead of deferring.
    await expect(
      refreshJobCredential("t1", "a1", "j1", { idToken: "fresh", refreshToken: "r2" }),
    ).resolves.toBe(true);

    const [filter, update] = jobsCol.updateOne.mock.calls[0];
    expect(filter).toMatchObject({ jobId: "j1" });
    expect(update.$set).toMatchObject({ idToken: "fresh", refreshToken: "r2" });
    expect(update.$set.updatedAt).toEqual(expect.any(String));
  });

  it("scopes the write to the caller's tenant AND account", async () => {
    // Without both, a caller in one tenant could stamp a credential onto another
    // tenant's running job — and that job Bearers whatever it is given.
    await refreshJobCredential("t1", "a1", "j1", { idToken: "fresh" });

    expect(jobsCol.updateOne.mock.calls[0][0]).toMatchObject({
      jobId: "j1",
      tenantId: "t1",
      accountId: "a1",
    });
  });

  it("only ever rewrites a job that is still alive", async () => {
    await refreshJobCredential("t1", "a1", "j1", { idToken: "fresh" });

    // A done/errored job has no use for a credential, and quietly re-arming one
    // would put a live token back onto a document nothing is watching.
    expect(jobsCol.updateOne.mock.calls[0][0].status).toEqual({ $in: LIVE_STATUSES });
  });

  it("leaves a stored refresh token alone when the caller has none", async () => {
    // A token-paste test session has no refresh token. Writing `undefined` would
    // strip the worker of the one thing that lets it re-mint mid-run.
    await refreshJobCredential("t1", "a1", "j1", { idToken: "fresh" });

    const update = jobsCol.updateOne.mock.calls[0][1];
    expect(update.$set).toMatchObject({ idToken: "fresh" });
    expect(update.$set).not.toHaveProperty("refreshToken");
  });

  it("does nothing at all without an ID token", async () => {
    await expect(refreshJobCredential("t1", "a1", "j1", {})).resolves.toBe(false);
    expect(jobsCol.updateOne).not.toHaveBeenCalled();
  });

  it("reports false when the filter matched nothing", async () => {
    jobsCol.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(
      refreshJobCredential("t1", "a1", "j1", { idToken: "fresh" }),
    ).resolves.toBe(false);
  });
});

describe("updateClaimedJob credential clearing", () => {
  it("keeps the credential by default", async () => {
    await updateClaimedJob("j1", "lease-1", { done: 5 });

    const update = jobsCol.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({ done: 5 });
    // Every mid-run write goes through here; unsetting on any of them would
    // strip a job that is still paging.
    expect(update).not.toHaveProperty("$unset");
  });

  it("drops both credential fields in the same write that ends the job", async () => {
    await updateClaimedJob("j1", "lease-1", { status: "done" }, { clearCredential: true });

    const update = jobsCol.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({ status: "done" });
    // `deferReason` goes with them: it explains why a job is PAUSED, so leaving
    // it beside `status: "done"` is a field outliving its own meaning.
    // One atomic write: a finished job never sits in Mongo holding a credential,
    // least of all a refresh token that does not expire on its own.
    expect(update.$unset).toEqual({ idToken: "", refreshToken: "", deferReason: "" });
  });

  it("still only writes to the job this worker holds the lease on", async () => {
    await updateClaimedJob("j1", "lease-1", { status: "error" }, { clearCredential: true });

    expect(jobsCol.findOneAndUpdate.mock.calls[0][0]).toEqual({
      jobId: "j1",
      status: "running",
      leaseId: "lease-1",
    });
  });
});
