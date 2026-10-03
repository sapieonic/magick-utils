// What a bulk job's detail payload says about its row set: whether it finished
// dialling (arms the worker's empty-pull guard) and whether it has stopped
// adding rows (decides whether a short pull is settled loss or possibly lag).
// Shared by the worker, which judges a pull, and the ingest route, which must
// not let the merge cooldown hide a short pull whose job has since stopped.
// Type-only imports, so route tests need not mock anything to use it.

import type { RawBulkJob } from "./magick-client";

/** Bulk-job statuses that mean upstream finished putting the contact list on
 *  the wire, so records for it should exist and an empty pull is a fault.
 *
 *  Positive and narrow, deliberately. Only a job we can PROVE finished dialling
 *  arms the empty-pull guard in the worker's `ingestBatch`; anything else — still queued or
 *  processing, cancelled or failed before it dialled, an unrecognised state, or
 *  a job detail we could not fetch at all — leaves it disarmed. Both directions
 *  of error are real, but they are not equal: a missed detection leaves the
 *  blank batch this guard set out to surface, while a false positive puts
 *  "Sync failed" on a healthy campaign that is simply still running or was
 *  deliberately cancelled, and `failBatchIfOwned` writes `error` on a batch with
 *  no published revision — a red state no click can clear. The second is worse
 *  and hits far more campaigns, so "unsure" must mean "stay quiet".
 *
 *  These three are the statuses `messageBreakdown` (map.ts) treats as "it went
 *  out". `TERMINAL_JOB_STATUSES` there is a different question — "will anything
 *  more arrive" — and includes `failed`/`cancelled`, which is exactly why this
 *  cannot reuse it. */
const DIALLED_JOB_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "dispatched",
  "partially_failed",
]);

export function jobFinishedDialling(job: RawBulkJob | null): boolean {
  return DIALLED_JOB_STATUSES.has((job?.status ?? "").toLowerCase().trim());
}

/** Bulk-job statuses after which upstream inserts no more rows for the job, so
 *  the list surface's COUNT and its pages describe one fixed row set and a
 *  unique count below the COUNT is loss, not lag.
 *
 *  Wider than `DIALLED_JOB_STATUSES` on purpose, and only possible because a
 *  short pull no longer fails anything. The empty-pull guard throws, so it
 *  arms only on proof the job dialled; this one flags, keeps or publishes —
 *  readable either way — so the question it needs answered is narrower: will
 *  more rows appear? A cancelled or failed job's rows are as fixed as a
 *  completed one's, and exempting them would leave the same tie loss silent on
 *  exactly those campaigns. Still-dispatching, unrecognised or unreadable jobs
 *  stay exempt: the COUNT may genuinely be running ahead of the pages. */
const ROWS_SETTLED_JOB_STATUSES: ReadonlySet<string> = new Set([
  ...DIALLED_JOB_STATUSES,
  "failed",
  "cancelled",
  "canceled",
]);

/** Statuses master can reach while a dispatch request to core is still in
 *  flight. A Stop flips the job to `cancelled` without waiting for the batch
 *  being POSTed (master cancels whatever that request created once it
 *  returns), and a dispatch that throws mid-campaign writes `failed` the same
 *  way — so for a short while core may still be inserting rows the job's
 *  status says will never come. Judged inside that window, a healthy
 *  just-stopped campaign reads "Incomplete upstream data". */
const ROWS_SETTLE_AFTER_STOP_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled", "canceled"]);

/** How long after a stop/failure the row set is treated as still settling. A
 *  late batch is bounded by the dispatch request that carries it; five minutes
 *  covers a slow core comfortably while still flagging a genuinely short
 *  stopped campaign on the next pull after it. */
const ROWS_SETTLE_WINDOW_MS = 5 * 60_000;

/** Whether the job's row set has stopped growing — i.e. whether a short pull
 *  is `settled` loss to report, or possibly lag to record silently.
 *  `completed`, `dispatched` and `partially_failed` mean so outright.
 *  `cancelled`/`failed` mean so once the terminal timestamp master stamped
 *  (`cancelled_at`, `completed_at`) is older than the settle window; inside it
 *  the pull is judged as for a job still dispatching — recorded unsettled,
 *  re-pullable, told to nobody — and the next pull judges it exactly. A missing
 *  or unparseable timestamp keeps the old behaviour (settled): master stamps
 *  both on every such transition, and withholding the flag on an absence would
 *  leave a short pull silent with nothing to bring the judgement back. */
export function jobStoppedAddingRows(job: RawBulkJob | null, now: number = Date.now()): boolean {
  const status = (job?.status ?? "").toLowerCase().trim();
  if (!ROWS_SETTLED_JOB_STATUSES.has(status)) return false;
  if (!ROWS_SETTLE_AFTER_STOP_STATUSES.has(status)) return true;
  const stoppedAt = Date.parse(job?.cancelled_at ?? job?.completed_at ?? "");
  if (!Number.isFinite(stoppedAt)) return true;
  return now - stoppedAt >= ROWS_SETTLE_WINDOW_MS;
}
