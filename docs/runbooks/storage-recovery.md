# Runbook — recovering a full MongoDB cluster

For the deploy that fixed unbounded record-revision growth. Follow this on the
day it ships, in order. Steps 1–3 are the ones that actually reclaim space.

## What was wrong

Every ingestion stages a complete new copy of a batch's records under a fresh
revision and publishes it atomically. The superseded copy was only *marked*
retired and left for a daily cron that swept on the five-day retention window.
"Refresh data" re-ingested unconditionally, so each click added a full duplicate
dataset that survived for days. Enough clicks exhausted the cluster's storage and
blocked writes for **every tenant on it**, not just the account doing the
clicking.

Four things changed: a refresh now re-pulls only what upstream actually touched;
the worker reclaims superseded copies itself (see
`SUPERSEDED_REVISION_GRACE_MS`); the cron sweeps them on that short window rather
than the retention window; and the cron additionally sweeps the copies a crash
left behind with no retirement marker, which previously nothing could reach.

## 1. Deploy, then check the cron is wired up

The code change alone reclaims nothing already on disk. The cleanup endpoint is
what does, and it no-ops with a 503 unless both are set:

- `CRON_SECRET` — app env var on the deployment, matching
- `CRON_SECRET` — GitHub **environment secret** for `production` / `dedicated`
- `CLEANUP_URL` — GitHub **environment variable**, the deployed endpoint URL

If these were never configured, no cleanup has ever run and that is the first
thing to fix. `.github/workflows/cleanup.yml` fails loudly when either is
missing, so check its recent runs.

## 2. Run the cleanup now — don't wait for 03:00 UTC

Actions → *Daily data cleanup* → **Run workflow**. This is the step that deletes
the accumulated duplicates. Or directly:

```bash
curl -fsS -X POST "$CLEANUP_URL" -H "Authorization: Bearer $CRON_SECRET"
```

It returns the counts it removed:

```json
{"ok":true,"deleted":{"aggregates":N,"jobs":N,"insights":N,"batches":N,"records":N,"recordRevisions":N,"orphanedRevisions":N}}
```

`recordRevisions` and `orphanedRevisions` are the numbers that matter here — both
count duplicate rows. `recordRevisions` are copies a clean publish retired;
`orphanedRevisions` are copies a crash left with no marker at all, which nothing
used to reclaim until the whole batch aged out. Expect both to be large on the
first run after this deploy and near zero afterwards.

If the call itself fails because the cluster is refusing writes, a delete is
normally still permitted where an insert is not; if it is genuinely rejected,
raise the tier temporarily rather than trying to work around it.

## 3. Confirm space was actually reclaimed

`dataSize` should drop immediately. **`storageSize` may not** — WiredTiger does
not return freed extents to the filesystem without a compaction, which is not
available on shared tiers. That is expected and not a failure: the freed space is
reused by subsequent writes even while `storageSize` stays flat. Judge recovery
by `dataSize` and by writes succeeding again, not by the disk figure.

## 4. Expect one re-ingest per batch, once

A refresh is skipped only when the batch carries `ingestedSourceUpdatedAt`, which
is stamped at ingestion time. Batches ingested before this deploy have no stamp,
so the first "Refresh data" on each will do a full re-pull. This cannot be
backfilled honestly — the value has to be the source's state *at the time of the
last pull*, and that was never recorded — so the one-time cost is deliberate.

It is bounded: the worker reclaims the superseded copy after the grace window, so
peak usage is roughly 2× that batch for the length of the window, not permanently.
If the cluster is very tight, run step 2 first so the re-ingest has headroom.

One batch always re-pulls regardless of its stamp: a batch the campaigns listing
has flagged `stale`. That flag is evidence the source moved, so the timestamp
check is skipped entirely — without that escape hatch the two freshness signals
can disagree and latch a batch stale with no click able to clear it. If you see a
batch refuse to leave `stale`, that rule is the thing to check first.

## 5. Watch the logs

Two lines confirm the fix is working in production:

- `refresh skipped — upstream job untouched since last ingestion` — a refresh
  that correctly did nothing. Should become common.
- `superseded revision rows reclaimed` / `… reclaimed after grace`, with a
  `reclaimed` row count — the worker cleaning up after itself.

Absence of the first under repeated refreshes means the skip is not engaging;
check that `ingestedSourceUpdatedAt` is being stamped (`[worker] source stamp
unavailable` warns when the upstream read failed).

## 6. Only then, consider more history

`DATA_RETENTION_DAYS` (default 5) is the ceiling on how far back Dashboard and
Analytics can see — campaigns older than it are deleted with every record they
own. Raising it is what serves a customer asking for "previous months", and it
costs storage roughly in proportion.

Do it after steps 1–3, with a measured `dataSize` in hand. Raising retention on a
cluster that has not been cleaned first is how this incident happens again.
