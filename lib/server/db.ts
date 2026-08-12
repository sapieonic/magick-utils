// MongoDB data-access primitives: a cached client, typed collection accessors,
// and idempotent index creation. Server-only — never import from client code.

import { MongoClient, type Collection, type Db } from "mongodb";
import { env, isMongoConfigured } from "@/lib/server/env";
import type {
  AggregatesDoc,
  AiUsageWindow,
  BatchDoc,
  Insight,
  IngestionLock,
  Job,
  NormalizedRecord,
} from "@/lib/server/types";

// Next.js global-singleton pattern: cache the client (and its connect promise)
// on globalThis so it survives HMR in dev and is reused across invocations on a
// long-running Node host. The internal cast is the only place we touch `any`.
interface MongoGlobal {
  client: MongoClient;
  connect: Promise<MongoClient>;
}

const g = globalThis as unknown as { _muMongo?: MongoGlobal };

function getGlobal(): MongoGlobal {
  if (!isMongoConfigured()) {
    throw new Error(
      "MongoDB is not configured: set MONGODB_URI (see lib/server/env.ts / isMongoConfigured())."
    );
  }
  // Lazy-init the client once; reuse the same connect promise everywhere.
  g._muMongo ??= ((): MongoGlobal => {
    const client = new MongoClient(env.mongoUri);
    return { client, connect: client.connect() };
  })();
  return g._muMongo;
}

/** Connected `Db` handle. Lazy-connects on first use. */
export async function getDb(): Promise<Db> {
  const mongo = getGlobal();
  const client = await mongo.connect;
  return client.db(env.mongoDb);
}

export async function batches(): Promise<Collection<BatchDoc>> {
  return (await getDb()).collection<BatchDoc>("batches");
}

export async function records(): Promise<Collection<NormalizedRecord>> {
  return (await getDb()).collection<NormalizedRecord>("records");
}

export async function jobs(): Promise<Collection<Job>> {
  return (await getDb()).collection<Job>("jobs");
}

export async function ingestionLocks(): Promise<Collection<IngestionLock>> {
  return (await getDb()).collection<IngestionLock>("ingestion_locks");
}

export async function aiUsage(): Promise<Collection<AiUsageWindow>> {
  return (await getDb()).collection<AiUsageWindow>("ai_usage_windows");
}

export async function aggregates(): Promise<Collection<AggregatesDoc>> {
  return (await getDb()).collection<AggregatesDoc>("aggregates");
}

export async function insights(): Promise<Collection<Insight>> {
  return (await getDb()).collection<Insight>("insights");
}

// Index codes that mean "this index already exists / was just created by a
// racing caller" — safe to ignore so ensureIndexes stays idempotent.
const IGNORABLE_INDEX_CODES = new Set([
  85, // IndexOptionsConflict
  86, // IndexKeySpecsConflict
  11000, // DuplicateKey (concurrent createIndex race)
]);

function isIgnorableIndexError(err: unknown): boolean {
  const code = (err as { code?: number } | null)?.code;
  if (typeof code === "number" && IGNORABLE_INDEX_CODES.has(code)) return true;
  const message = (err as { message?: string } | null)?.message ?? "";
  return /already exists/i.test(message);
}

async function safeCreateIndexes(
  create: () => Promise<unknown>
): Promise<void> {
  try {
    await create();
  } catch (err) {
    if (isIgnorableIndexError(err)) return;
    throw err;
  }
}

/**
 * Create all required indexes. Idempotent and safe to call repeatedly /
 * concurrently — "index already exists" races are swallowed.
 */
export async function ensureIndexes(): Promise<void> {
  const [batchesCol, recordsCol, jobsCol, locksCol, aiUsageCol, aggregatesCol, insightsCol] =
    await Promise.all([
      batches(),
      records(),
      jobs(),
      ingestionLocks(),
      aiUsage(),
      aggregates(),
      insights(),
    ]);

  // Versioned publication supersedes the original unique key. Keeping the old
  // index would reject a staging revision that shares a recordId with the
  // currently published revision. IndexNotFound is expected on fresh installs.
  await recordsCol.dropIndex("uniq_tenant_account_batch_record").catch((error: unknown) => {
    const code = (error as { code?: number } | null)?.code;
    if (code !== 27 && !/index not found/i.test((error as Error | null)?.message ?? "")) throw error;
  });

  await Promise.all([
    safeCreateIndexes(() =>
      batchesCol.createIndex(
        { tenantId: 1, accountId: 1, batchId: 1 },
        { unique: true, name: "uniq_tenant_account_batch" }
      )
    ),
    safeCreateIndexes(() =>
      recordsCol.createIndexes([
        {
          key: { tenantId: 1, accountId: 1, batchId: 1 },
          name: "tenant_account_batch",
        },
        {
          key: { tenantId: 1, accountId: 1, batchId: 1, revision: 1, recordId: 1 },
          name: "uniq_tenant_account_batch_revision_record",
          unique: true,
        },
        {
          key: { tenantId: 1, accountId: 1, activityDate: 1 },
          name: "tenant_account_activity_time",
        },
        {
          key: { tenantId: 1, accountId: 1, batchId: 1, revision: 1, activityDate: 1 },
          name: "published_revision_activity_time",
        },
        { key: { retiredAt: 1 }, name: "retired_revision_cleanup" },
      ])
    ),
    safeCreateIndexes(() =>
      jobsCol.createIndexes([
        { key: { jobId: 1 }, name: "uniq_jobId", unique: true },
        { key: { status: 1, type: 1 }, name: "status_type" },
        { key: { status: 1, retryAt: 1, leaseUntil: 1, createdAt: 1 }, name: "status_due_lease_created" },
      ])
    ),
    safeCreateIndexes(() =>
      locksCol.createIndexes([
        {
          key: { tenantId: 1, accountId: 1, batchId: 1 },
          name: "uniq_ingestion_batch_lock",
          unique: true,
        },
        { key: { expiresAt: 1 }, name: "ingestion_lock_ttl", expireAfterSeconds: 0 },
        { key: { jobId: 1 }, name: "ingestion_lock_job" },
      ])
    ),
    safeCreateIndexes(() =>
      aiUsageCol.createIndexes([
        { key: { key: 1 }, name: "uniq_ai_usage_window", unique: true },
        { key: { expiresAt: 1 }, name: "ai_usage_window_ttl", expireAfterSeconds: 0 },
      ])
    ),
    safeCreateIndexes(() =>
      aggregatesCol.createIndex(
        { tenantId: 1, accountId: 1, key: 1 },
        { unique: true, name: "uniq_tenant_account_key" }
      )
    ),
    safeCreateIndexes(() =>
      insightsCol.createIndex(
        { tenantId: 1, accountId: 1, key: 1 },
        { unique: true, name: "uniq_tenant_account_key" }
      )
    ),
  ]);
}
