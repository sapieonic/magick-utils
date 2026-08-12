import { fingerprint } from "./fingerprint";
import { getBatch } from "./repositories";
import type { TenantContext } from "./types";

/** Fingerprint the actual batch revisions behind a selection. Cache keys that
 * only include batch ids remain stale after those batches are re-ingested. */
export async function datasetFingerprint(ctx: TenantContext, batchIds: string[]): Promise<string> {
  const unique = [...new Set(batchIds)].sort();
  const docs = await Promise.all(unique.map((id) => getBatch(ctx.tenantId, ctx.accountId, id)));
  if (docs.some((doc) => doc == null)) throw new Error("selection contains a missing batch");
  return fingerprint(unique.map((id, i) => `${id}:${docs[i]!.fingerprint}`));
}
