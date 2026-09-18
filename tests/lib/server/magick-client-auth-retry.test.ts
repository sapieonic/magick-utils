// The one-hour cliff: a Firebase ID token expires while a long ingestion is
// still paging, magick-master starts answering 401, and every call after that
// fails. These pin the client's re-mint-and-retry-once behaviour, including the
// two ways it must NOT behave — retrying forever on a credential upstream keeps
// refusing, and flattening a mint failure into the original 401.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  env: { magickMasterBaseUrl: "https://mm.test", firebaseApiKey: "web-api-key" },
  isAuthConfigured: () => true,
  isTokenRefreshConfigured: () => true,
}));
vi.mock("@/lib/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  log: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const token = vi.hoisted(() => ({ mintIdToken: vi.fn() }));
vi.mock("@/lib/server/firebase-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/firebase-token")>();
  return { ...actual, mintIdToken: token.mintIdToken };
});

import {
  TokenRefreshPermanentError,
  TokenRefreshTransientError,
  type MintedToken,
} from "@/lib/server/firebase-token";
import { MagickApiError, MagickClient } from "@/lib/server/magick-client";
import type { TenantContext } from "@/lib/server/types";

const ctx = (patch: Partial<TenantContext> = {}): TenantContext => ({
  tenantId: "t1",
  accountId: "a1",
  idToken: "expired-token",
  refreshToken: "refresh-1",
  ...patch,
});

const minted = (patch: Partial<MintedToken> = {}): MintedToken => ({
  idToken: "fresh-token",
  refreshToken: "refresh-2",
  expiresAt: Date.now() + 3_600_000,
  ...patch,
});

/** Answer each call with the next entry, and record the Bearer it was sent. */
function stubResponses(responses: Array<{ status: number; body: string; contentType?: string }>) {
  const bearers: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      bearers.push(headers.Authorization);
      const next = responses[Math.min(i++, responses.length - 1)];
      return new Response(next.body, {
        status: next.status,
        headers: { "Content-Type": next.contentType ?? "application/json" },
      });
    }),
  );
  return bearers;
}

function fetchCallCount(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  token.mintIdToken.mockResolvedValue(minted());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MagickClient 401 re-mint", () => {
  it("mints a replacement and retries the call with it", async () => {
    const bearers = stubResponses([
      { status: 401, body: '{"detail":"token expired"}' },
      { status: 200, body: JSON.stringify({ calls: [{ call_id: "c1" }], total: 1 }) },
    ]);

    const out = await new MagickClient(ctx()).listCalls({ batchId: "b1" });

    expect(out.total).toBe(1);
    expect(token.mintIdToken).toHaveBeenCalledWith("refresh-1");
    // The retry must carry the NEW token; re-sending the refused one would make
    // the whole exercise a second 401.
    expect(bearers).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
  });

  it("hands the rotated credential back so the caller can persist it", async () => {
    stubResponses([
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ calls: [], total: 0 }) },
    ]);
    const onCredentialRefresh = vi.fn();

    const client = new MagickClient(ctx(), { onCredentialRefresh });
    await client.listCalls();

    // Google may rotate the refresh token on exchange. A caller that keeps the
    // one it sent is holding a credential that gets refused next hour.
    expect(onCredentialRefresh).toHaveBeenCalledWith(expect.objectContaining({
      idToken: "fresh-token",
      refreshToken: "refresh-2",
    }));
    expect(client.credential).toEqual({ idToken: "fresh-token", refreshToken: "refresh-2" });
  });

  it("keeps using the fresh token on later calls instead of re-minting per request", async () => {
    stubResponses([
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ calls: [], total: 0 }) },
    ]);
    const client = new MagickClient(ctx());
    await client.listCalls();
    await client.listCalls();

    expect(token.mintIdToken).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once when the fresh token is refused too", async () => {
    // A refresh token Google still honours can mint tokens magick-master keeps
    // rejecting (membership revoked, tenant disabled). Looping there hammers two
    // upstreams with a credential that will never be accepted.
    stubResponses([{ status: 401, body: "still no" }]);

    await expect(new MagickClient(ctx()).listCalls()).rejects.toMatchObject({ status: 401 });
    expect(fetchCallCount()).toBe(2);
    expect(token.mintIdToken).toHaveBeenCalledTimes(1);
  });

  it("lets the 401 stand when there is no refresh token to mint from", async () => {
    stubResponses([{ status: 401, body: "expired" }]);

    await expect(
      new MagickClient(ctx({ refreshToken: undefined })).listCalls(),
    ).rejects.toBeInstanceOf(MagickApiError);
    expect(token.mintIdToken).not.toHaveBeenCalled();
    expect(fetchCallCount()).toBe(1);
  });

  it("does not retry a non-401", async () => {
    stubResponses([{ status: 500, body: "boom" }]);

    await expect(new MagickClient(ctx()).listCalls()).rejects.toMatchObject({ status: 500 });
    expect(token.mintIdToken).not.toHaveBeenCalled();
    expect(fetchCallCount()).toBe(1);
  });

  it.each([
    ["permanent", new TokenRefreshPermanentError("TOKEN_EXPIRED"), TokenRefreshPermanentError],
    ["transient", new TokenRefreshTransientError("secure-token responded 503"), TokenRefreshTransientError],
  ])("surfaces a %s mint failure rather than the 401", async (_label, err, expected) => {
    stubResponses([{ status: 401, body: "expired" }]);
    token.mintIdToken.mockRejectedValueOnce(err);

    // The worker fails a job on the permanent one and reschedules on the
    // transient one. Collapsing either into the 401 erases that decision.
    await expect(new MagickClient(ctx()).listCalls()).rejects.toBeInstanceOf(expected);
  });

  it("completes the request even when persisting the new credential throws", async () => {
    stubResponses([
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ calls: [], total: 0 }) },
    ]);
    const onCredentialRefresh = vi.fn().mockRejectedValue(new Error("mongo down"));

    await expect(
      new MagickClient(ctx(), { onCredentialRefresh }).listCalls(),
    ).resolves.toEqual({ calls: [], total: 0 });
  });

  it("does not mutate the context object it was constructed with", async () => {
    stubResponses([
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ calls: [], total: 0 }) },
    ]);
    const shared = ctx();
    await new MagickClient(shared).listCalls();

    // The worker keeps using its own context for tenant-scoped repository calls;
    // rewriting it from inside the client would be action at a distance.
    expect(shared.idToken).toBe("expired-token");
    expect(shared.refreshToken).toBe("refresh-1");
  });

  it("covers the other data calls, not just listCalls", async () => {
    stubResponses([
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ id: "job-1", updated_at: "2026-09-01T09:00:00Z" }) },
    ]);
    await expect(new MagickClient(ctx()).getBulkJob("job-1")).resolves.toMatchObject({ id: "job-1" });
    expect(fetchCallCount()).toBe(2);
  });
});

describe("MagickClient.exportCallsCsv 401 re-mint", () => {
  it("returns an untouched stream from the retried request", async () => {
    const bearers = stubResponses([
      { status: 401, body: "expired", contentType: "text/plain" },
      { status: 200, body: "call_id,status\nc1,completed\n", contentType: "text/csv" },
    ]);

    const res = await new MagickClient(ctx()).exportCallsCsv({ jobId: "job-1" });

    expect(bearers).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
    // The refused response's body is drained into the MagickApiError, but the
    // one handed back belongs to a brand-new request and is still unread — the
    // caller pipes it straight to the browser, so a consumed body here is a
    // truncated CSV download.
    expect(res.bodyUsed).toBe(false);
    await expect(res.text()).resolves.toBe("call_id,status\nc1,completed\n");
  });
});
