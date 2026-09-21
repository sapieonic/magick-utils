import { beforeEach, describe, expect, it, vi } from "vitest";

const collections = vi.hoisted(() => {
  const makeCol = () => ({
    dropIndex: vi.fn().mockResolvedValue(undefined),
    createIndex: vi.fn().mockResolvedValue("ok"),
    createIndexes: vi.fn().mockResolvedValue(["ok"]),
  });
  return {
    batches: makeCol(),
    records: makeCol(),
    jobs: makeCol(),
    ingestion_locks: makeCol(),
    ai_usage_windows: makeCol(),
    aggregates: makeCol(),
    insights: makeCol(),
  };
});

vi.mock("@/lib/server/env", () => ({
  env: { mongoUri: "mongodb://localhost", mongoDb: "testdb" },
  isMongoConfigured: () => true,
}));

vi.mock("mongodb", () => {
  class MongoClient {
    connect() {
      return Promise.resolve(this);
    }
    db() {
      return {
        collection: (name: keyof typeof collections) => collections[name],
      };
    }
  }
  return { MongoClient };
});

import { ensureIndexes, isIgnorableDropIndexError } from "@/lib/server/db";

function resetMongoCache() {
  delete (globalThis as { _muMongo?: unknown })._muMongo;
}

describe("isIgnorableDropIndexError", () => {
  it("accepts NamespaceNotFound from dropIndex on a missing collection", () => {
    // Message must not contain "ns not found" — otherwise the regex would hide a
    // regression that dropped code 26 from the ignorable set.
    expect(
      isIgnorableDropIndexError({
        code: 26,
        codeName: "NamespaceNotFound",
        message: "NamespaceNotFound",
      }),
    ).toBe(true);
  });

  it("accepts IndexNotFound when the collection exists without the legacy unique index", () => {
    expect(
      isIgnorableDropIndexError({
        code: 27,
        codeName: "IndexNotFound",
        message: "IndexNotFound",
      }),
    ).toBe(true);
  });

  it("accepts the Atlas-style ns-not-found message even without a numeric code", () => {
    expect(isIgnorableDropIndexError({ message: "ns not found testdb.records" })).toBe(true);
  });

  it("does not swallow unrelated failures such as authorization errors", () => {
    expect(
      isIgnorableDropIndexError({
        code: 13,
        message: "not authorized on testdb to execute command",
      }),
    ).toBe(false);
  });

  it("does not let a numeric non-26/27 code hide behind an ns-not-found message", () => {
    expect(
      isIgnorableDropIndexError({
        code: 13,
        message: "not authorized: ns not found testdb.records",
      }),
    ).toBe(false);
  });
});

describe("ensureIndexes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const col of Object.values(collections)) {
      col.dropIndex.mockReset().mockResolvedValue(undefined);
      col.createIndex.mockReset().mockResolvedValue("ok");
      col.createIndexes.mockReset().mockResolvedValue(["ok"]);
    }
    resetMongoCache();
  });

  it("drops the pre-revision unique index by name", async () => {
    await ensureIndexes();
    expect(collections.records.dropIndex).toHaveBeenCalledWith("uniq_tenant_account_batch_record");
  });

  it("continues creating indexes when the records collection does not exist yet", async () => {
    collections.records.dropIndex.mockRejectedValue({
      code: 26,
      codeName: "NamespaceNotFound",
      message: "NamespaceNotFound",
    });

    await expect(ensureIndexes()).resolves.toBeUndefined();
    expect(collections.records.createIndexes).toHaveBeenCalled();
    expect(collections.batches.createIndex).toHaveBeenCalled();
  });

  it("continues when the collection exists but the legacy index is already gone", async () => {
    collections.records.dropIndex.mockRejectedValue({
      code: 27,
      message: "IndexNotFound",
    });

    await expect(ensureIndexes()).resolves.toBeUndefined();
    expect(collections.records.createIndexes).toHaveBeenCalled();
  });

  it("still fails on unexpected dropIndex errors so boot does not paper over auth or server faults", async () => {
    collections.records.dropIndex.mockRejectedValue({
      code: 13,
      message: "not authorized on testdb to execute command",
    });

    await expect(ensureIndexes()).rejects.toMatchObject({ code: 13 });
    expect(collections.records.createIndexes).not.toHaveBeenCalled();
  });
});
