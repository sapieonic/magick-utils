import { createHash } from "node:crypto";

/** Stable short hash of arbitrary parts — used to detect when a running batch's
 *  data has changed (cache invalidation) and to key aggregates/insights. */
export function fingerprint(parts: (string | number | null | undefined)[]): string {
  const h = createHash("sha1");
  h.update(parts.map((p) => String(p ?? "")).join("|"));
  return h.digest("hex").slice(0, 16);
}

/** Fingerprint for a set of batch ids (order-independent). */
export function batchSetKey(batchIds: string[]): string {
  return fingerprint([...batchIds].sort());
}

/** Version tag for the aggregates cache shape / status vocabulary. Bump this when
 *  the way aggregates are computed changes (e.g. status bucketing) so stale cached
 *  AggregatesDocs are bypassed automatically rather than served until manual refresh. */
const AGGREGATES_VERSION = "v2";

/** Cache key for precomputed aggregates. Separate from batchSetKey so the insight
 *  cache (keyed on the bare batchSetKey) is unaffected by aggregate-shape bumps. */
export function aggregatesKey(batchIds: string[]): string {
  return `${batchSetKey(batchIds)}:${AGGREGATES_VERSION}`;
}
