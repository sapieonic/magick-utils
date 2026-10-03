// What a prepared CSV export actually holds, read back once preparation has
// finished. Shared by Combine and the per-campaign download so the two state
// the same figure and the same shortfall from the same rule. Client-safe.

import { listCampaignsByIds } from "@/lib/api";
import { selectionShortfall } from "@/lib/shortfall";
import type { Batch } from "@/lib/types";

export type ExportFacts = {
  /** Rows the CSV holds: the sum of each batch's published record count. */
  rows: number;
  /** Records the served revisions lack against upstream's own count. */
  missing: number;
  /** Batches whose latest pull was short, so the file carries some of their
   *  records forward from an earlier load. */
  kept: number;
};

/** The exact row count of a prepared export, and how it falls short of
 *  upstream, or null when it cannot be stated.
 *
 *  Once a batch is readable its `total` IS its published record count (the
 *  ingest route re-pulls any batch whose stored count disagrees), and the CSV
 *  streams exactly those records. The figure a screen had BEFORE preparation —
 *  a listing's `total` — is not: for a batch never ingested it is the
 *  dispatched contact count. A merge job's own `result.rowCount` is not usable
 *  either: it counts only the batches that job re-pulled, so a selection that
 *  was partly ingested already would be under-reported. Every batch must come
 *  back readable, or the figure would quietly describe a subset.
 *
 *  Null in demo mode (seeded batches carry no record count to read back) and
 *  when any batch is missing or unreadable; callers keep their estimate then.
 *
 *  Read after the merge finished, so each batch's `shortfall` reflects the pull
 *  that merge just made, or the recent one it chose not to repeat. */
export async function resolveExportFacts(batchIds: string[]): Promise<ExportFacts | null> {
  const { batches, source } = await listCampaignsByIds(batchIds);
  if (source !== "live") return null;
  const selected: Batch[] = [];
  for (const id of batchIds) {
    const found = batches.find((batch) => batch.id === id);
    if (!found || (found.ingestStatus !== "ready" && found.ingestStatus !== "stale")) return null;
    selected.push(found);
  }
  const { missing, kept } = selectionShortfall(selected);
  return { rows: selected.reduce((sum, batch) => sum + batch.total, 0), missing, kept };
}
