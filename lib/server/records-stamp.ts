// The records stamp a refresh compares to decide it can skip a re-pull.
//
// Its own module, importing nothing but the fingerprint helpers and a type, so
// the worker (whose suite mocks `./normalize` with a narrow factory) and the
// skip check in `map.ts` read one definition without either dragging in the
// other's dependencies.

import type { RawBulkJob } from "./magick-client";
import { fingerprint, stableJson } from "./fingerprint";

/**
 * What a skip decision compares: master's `records_updated_at` — the latest
 * core ROW write across the job's batches — bound to the job's `status_summary`.
 *
 * `records_updated_at` is the signal that sees per-call changes: a recording
 * URL, a transcript, an outcome, post-call AI analysis, a delivery receipt all
 * write core's row, and none of them writes master's job row. (The job row has
 * no `updated_at` at all; the field this used to compare never existed, so the
 * skip never fired.) It cannot see a row being DELETED — a max does not move
 * when a smaller value leaves — so the stamp is bound to `status_summary`,
 * whose counts a deletion does move. Both come from the one core read master
 * makes for the detail, so they describe the same moment.
 *
 * `null` whenever master reports `records_updated_at` as unknown (`null` or
 * absent: an older master or core, a failed read, a batch with no settled
 * stamp, or an older core that does not compute it on that surface). Null never
 * matches anything, including another null.
 *
 * The literal version tag keeps a future change in what this covers from ever
 * matching a stamp written under the old meaning.
 */
export function bulkJobRecordsStamp(job: RawBulkJob | null | undefined): string | null {
  const recordsUpdatedAt = job?.records_updated_at;
  if (typeof recordsUpdatedAt !== "string" || recordsUpdatedAt.length === 0) return null;
  return fingerprint(["records-v1", recordsUpdatedAt, stableJson(job?.status_summary ?? null)]);
}
