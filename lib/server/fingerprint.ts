import { createHash } from "node:crypto";

/** Stable short hash of arbitrary parts — used to detect when a running batch's
 *  data has changed (cache invalidation) and to key aggregates/insights. */
export function fingerprint(parts: (string | number | null | undefined)[]): string {
  const h = createHash("sha1");
  h.update(parts.map((p) => String(p ?? "")).join("|"));
  return h.digest("hex").slice(0, 16);
}

/** JSON with object keys sorted at every level, so a value whose serialization
 *  order varies upstream (a Go map, a re-ordered DB group-by) still hashes to
 *  one fingerprint. Key order changing alone used to read as "the data moved". */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** Fingerprint for a set of batch ids (order-independent). */
export function batchSetKey(batchIds: string[]): string {
  return fingerprint([...batchIds].sort());
}

/** Version tag for the aggregates cache shape / status vocabulary. Bump this when
 *  the way aggregates are computed changes (e.g. status bucketing) so stale cached
 *  AggregatesDocs are bypassed automatically rather than served until manual refresh. */
const AGGREGATES_VERSION = "v7"; // v7: sentiment/topics from core's call-analysis rollup

/** Cache key for precomputed aggregates.
 *
 *  The insight caches deliberately do NOT reuse this key — but they must still
 *  react to a bump, because their prose is generated from the aggregate and
 *  would otherwise contradict the chart beside it. `/api/insights` detects that
 *  by storing this key as the Insight's `fingerprint` and rejecting a cache hit
 *  that does not match; `compareKey` folds the version in directly, because a
 *  comparison's `fingerprint` is its own key and cannot carry the signal. */
export function aggregatesKey(batchIds: string[], datasetFingerprint?: string): string {
  return `${batchSetKey(batchIds)}:${datasetFingerprint ?? "legacy"}:${AGGREGATES_VERSION}`;
}

/** Cache key for a comparative insight (feature 4a). **Directional** — current
 *  vs baseline — so swapping the two sets yields a distinct entry whose deltas
 *  flip sign, rather than colliding with the forward comparison. */
export function compareKey(
  currentBatchIds: string[],
  baselineBatchIds: string[],
  model: string,
  currentDataset = "legacy",
  baselineDataset = "legacy",
): string {
  // AGGREGATES_VERSION is part of the key: a comparison's topicShifts and
  // sentimentShift are derived from the two aggregate series, so a bump that
  // changes how those are computed invalidates every stored narrative too.
  // Without this, the v7 chart shows real topics while this route serves prose
  // generated when both series were always empty.
  return `compare:${batchSetKey(currentBatchIds)}:${currentDataset}:${batchSetKey(baselineBatchIds)}:${baselineDataset}:${model}:${AGGREGATES_VERSION}`;
}
