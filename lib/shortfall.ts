// Reader-facing wording for an incomplete upstream pull. Shared by the worker
// (which writes it into a job warning) and every screen that has to say so —
// Analytics, Combine — so the sentence a customer reads is the same everywhere.
// Client-safe: no server imports.

import type { Batch } from "@/lib/types";

export interface ShortfallFacts {
  /** Records upstream's list counted for the job. */
  listed: number;
  /** Unique records the latest pull returned. */
  received: number;
  /** An earlier, fuller revision was kept instead of publishing the pull. */
  keptPrevious: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** How long after a short pull was last observed a MERGE serves the flagged
 *  revision instead of re-pulling it.
 *
 *  Against a core that pages over a non-unique `created_at`, the loss is
 *  deterministic, so a re-pull inside this window returns the same short set
 *  and buys nothing but upstream load — a full re-page of every flagged batch
 *  on each Generate or per-campaign download, from one host against master's
 *  global per-IP limit (~83 page requests for an 8k-record selection). Fifteen
 *  minutes is long enough that clicking Generate again does not re-page, and
 *  short enough that a re-export soon after core's fix lands is still re-pulled
 *  without anyone having to know to press Refresh. An explicit Analytics
 *  Refresh ignores it: that is the customer asking for exactly this work.
 *
 *  Lives here, not in lib/server, because the download surfaces quote it
 *  (`repullHint`) and must not promise a re-pull sooner than a merge does one. */
export const SHORT_PULL_REPULL_COOLDOWN_MS = 15 * 60_000;

/** What a customer can do about an incomplete download, in words that agree
 *  with what the merge will actually do: within the cooldown another download
 *  or Generate serves the same flagged data, so "try again later" without a
 *  time sends them round a loop; Analytics' Refresh data ignores the cooldown. */
export function repullHint(action: "Download" | "Generate"): string {
  const minutes = Math.round(SHORT_PULL_REPULL_COOLDOWN_MS / 60_000);
  return `${action} again after ${minutes} minutes to re-pull, or use Refresh data in Analytics to re-pull now.`;
}

/** Says what happened, what readers now see because of it, and what closes it. */
export function shortfallMessage(name: string, shortfall: ShortfallFacts): string {
  const head = `Upstream returned ${fmt(shortfall.received)} of ${fmt(shortfall.listed)} records for "${name}"`;
  return shortfall.keptPrevious
    ? `${head}; the previously loaded data, which holds more records, was kept. Refresh later to re-pull.`
    : `${head}; only those records are included. Refresh later to re-pull the rest.`;
}

/** How a set of selected batches falls short of what upstream lists, for the
 *  surfaces (the CSV label) that state one figure for the whole selection.
 *  `missing` counts records the SERVED revisions lack against upstream's own
 *  count; `kept` counts batches whose latest pull was short and so still serve
 *  an earlier revision — those may hold every record and still be behind on
 *  status, which is why they are reported separately rather than folded in. */
export function selectionShortfall(batches: Array<Pick<Batch, "total" | "shortfall">>): {
  missing: number;
  kept: number;
  affected: number;
} {
  let missing = 0;
  let kept = 0;
  let affected = 0;
  for (const batch of batches) {
    const shortfall = batch.shortfall;
    if (!shortfall) continue;
    affected += 1;
    if (shortfall.keptPrevious) kept += 1;
    missing += Math.max(0, shortfall.listed - batch.total);
  }
  return { missing, kept, affected };
}
