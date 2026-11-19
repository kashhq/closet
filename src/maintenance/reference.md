# Maintenance: timers, reconciliation and the CLIs: reference

Moved out of `AGENTS.md` (#723) so the auto-loaded doc keeps only invariants, gotchas and ownership. Not auto-loaded: read it before changing this area. Where it disagrees with the code or a spec, they win.

## Layout

```
  maintenance/         reconcile.ts (reconcileStorage: storage and the file table kept in step, with
                       the deletion guard; abandoned pending photos in a pass of their own), trash.ts
                       (the quarantine's purge and --restore-from-trash, #649), nightly.ts (a daily timer at an APP_TIMEZONE hour, started
                       by server.ts when MAINTENANCE_ENABLED), minutely.ts (a timer a second past every
                       minute, or every `everyMinutes`, never overlapping: the push reminders, the
                       week's re-plan, the order mail's poll, Muse's quiet round close),
                       scheduled.ts (what both timers share: ScheduledJob, whose stop() waits for a
                       run in flight at most STOP_WAIT_MS, and stopBeforeClose, the preClose hook
                       that stops them all before the pool ends), cli.ts (runCli: config, logger, schema check,
                       pool, exit status), reconcile.cli.ts (`npm run maintenance:reconcile`),
                       set-password.cli.ts (`npm run user:set-password -- <email>`): the locked-out recovery,
                       revoke-push.cli.ts (`npm run push:revoke-all`): every push subscription, after
                       a secret rotation, retrim-thumbs.ts + .cli.ts (`npm run maintenance:retrim-thumbs`):
                       the #373 backfill of cutouts' trimmed thumbs, sync-prune.ts (pruneSyncTombstones:
                       the changes feed's deletions past 90 days, raising sync_floor; src/web/sync/AGENTS.md),
                       weather-prune.ts (pruneWeatherCaches: forecast and normals rows no home, here or trip
                       location sits at, last attempted over 30 days ago; src/weather/AGENTS.md),
                       after-restore.ts + .cli.ts (`npm run maintenance:after-restore`, #653: the post-restore
                       command), repoint-cutout.ts + .cli.ts (`npm run maintenance:repoint-cutout`: a row
                       pointed at a cutout set in storage, through the state machine)
```

## Commands

```
npm run maintenance:reconcile [-- --dry-run] [--force]
                              # one storage reconciliation pass from dist/ (build first). In production:
                              # docker exec closet npm run maintenance:reconcile. Exits 3 when the
                              # guard refused; --force deletes anyway (dry-run first). Like set-password it
                              # never migrates: a database behind the build is refused (start the server first)
npm run maintenance:reconcile -- --repair-storage-identity --confirm [--orphan <install id>]
                              # pairs `install` with DATA_PATH's marker (#833; docs/operations.md#photo-storage-
                              # marker); 2 without --confirm, 3 no readable marker (never writes one; lists
                              # the `.closet-storage.orphan-*` markers, which --orphan puts back first, #1049)
npm run maintenance:reconcile -- --restore-from-trash <uuid>.webp | <day>/<entry>
                              # moves one quarantined set back into DATA_PATH (Gotchas: the quarantine);
                              # exits 3 refused (no match, several, or a live set of that name)
npm run user:set-password -- <email>
                              # sets a locked-out user's password (read without echo, or piped
                              # stdin), signs out their sessions, revokes their access tokens and
                              # push subscriptions. In production:
                              # docker exec -it closet npm run user:set-password -- <email>
npm run push:revoke-all       # removes every account's push subscriptions: the step after rotating
                              # ACCESS_TOKEN_SECRET (Deployment). docker exec closet npm run push:revoke-all
npm run maintenance:retrim-thumbs [-- --dry-run]
                              # gives every photo with a ready or edited cutout its thumb trimmed to the
                              # garment (#373), under a new variant key (the `rederive` event) so caches
                              # miss; the set it replaced is deleted by the swap. Idempotent (a thumb already
                              # trimmed is `current`); exits 1 when any photo failed (warn lines name them;
                              # run again), 130 when Ctrl-C or SIGTERM stopped it after the photo in flight
                              # (Gotchas). One read per 100 photos, then 4 statements per photo retrimmed.
                              # Once after the deploy: docker exec closet npm run maintenance:retrim-thumbs
npm run maintenance:after-restore
                              # after restoring the database from a dump (#653; Gotchas): bumps the sync
                              # epoch (every device re-syncs, every session signs in again, #908), revokes
                              # every agent and device token and every push subscription, releases
                              # dead cutout leases (older than DEAD_LEASE_MS, 2 min), then reconciles as a dry
                              # run and lists the garments whose original is missing (id, name, owner). Deletes
                              # and marks nothing; exits 3 when reconciliation refused. Safe to run twice.
                              # docker exec closet npm run maintenance:after-restore
npm run maintenance:repoint-cutout -- <uuid>.webp <key|unkeyed>
                              # points a photo's row at the nobg and thumb stored under <key> (the files must
                              # exist): `rederive` for a ready or edited row (status kept), `edit` for none,
                              # pending or failed; refused (exit 3) for an outfit selfie. Version and garment
                              # revision move; clears the row's missing mark. The `Keeping variant key <k>`
                              # line names <k>; `unkeyed` after a rollback past #141 (docs/operations.md)
```

## Gotchas

- **A photo set with no `file` row is quarantined, never deleted** (#649). After a restore from an older dump, the sets of garments added since have no row and are the only copy, and a trickle of them passes the guard. So the orphan pass moves each set by rename into `DATA_PATH/.trash/<today in APP_TIMEZONE>/<base name>/` (`PhotoStorage.quarantine`: atomic, bytes untouched; a name already there that day gets a `~<8 hex>` entry, never an overwrite) and reports `orphanedSetsQuarantined`. The same run deletes `.trash` day directories older than `TRASH_RETENTION_DAYS` (30) before its `now` (`purgeTrash`, `trashSetsPurged`; a failure is a warn line and the run goes on; skipped when the guard refused: the trash may then be what is needed back). Unreferenced rows' sets, pending photos and superseded variants are still deleted: a row explains them. `--restore-from-trash` restores whole or not at all: every entry holding the set's files (a quarantine that failed mid-set splits one), each file linked back (never replacing) before any leaves the trash, a failed link rolled back (`RestoreFailed`: the log says "rolled back" only when every link made was taken back, else names the ones still live); refused when a live set has the name, except a live file that is its trash file (the same inode), which an earlier run restored and could not finish: once every file is live, a trash name it cannot remove is a warn line and `leftInTrash`, never a failure, and running it again clears it (#841). It stamps the files `now`, so the next run leaves them a day, and restores bytes only: without its `file` row the set is quarantined again after that. `.trash` is a dot-directory: `list()` skips it and `/file/**` never serves it. `reconcile.spec.ts` (the quarantine) covers each rule.

- **A database restored behind its storage never costs a cutout** (#141). After a restore from a backup older than some cutout edits, those rows name older variant keys than the newest files on disk. The superseded pass therefore deletes a set with a cutout only when all its files are day-old and older than every file of the set the row points at. A set newer than the row's is kept and logged at warn (`Keeping variant key <k> of <photo>: newer than the row's variant (key <k'>): database restored behind storage?`); a row whose own set is not in storage deletes nothing of that photo (`Keeping every variant of <photo>: ... not in storage`). No operator step: the photo shows its row's (older) cutout, the newer bytes stay on disk until `maintenance:repoint-cutout -- <photo> <k>` points the row back (Commands) or the mask is edited again. The guard stays as the second line. A superseded key holding only a thumb goes once day-old whatever its age against the row's set: a thumb is derived (regenerable from its nobg), never the one copy of anything, and a thumb backfilled across a swap is exactly that, newer than the set the row points at; a lone superseded nobg is a cutout and is kept like a whole set. `reconcile.spec.ts` covers each case.

- **Every timer is stopped and drained before the pool ends** (#78). Both schedulers return a `ScheduledJob` (`src/maintenance/scheduled.ts`): `stop()` clears the timer, so no run starts after it, and waits for a run in flight, at most `STOP_WAIT_MS` (`JOBS_STOP_MS`, 2 s, `settlesWithin`; the whole shutdown must fit docker stop's 10 s: `src/shutdown-budget.ts`), after 1.5 s it aborts the run's `AbortSignal` (`run(signal)`; the reminders stop sending and give back their unsent claims) and gives it `JOBS_ABORT_GRACE_MS` (0.5 s) more, after which it logs `<job> still running after 2000 ms; stopped` and resolves; it never rejects. `serve()` collects every job it starts into one list and hands it to `stopBeforeClose`, a single `preClose` hook that stops them all together (one bound in all, not one per job) and logs `Stopped N scheduled jobs in T ms` (logger `Scheduler`); `createApp()`'s `onClose` (the cutout queue, then the pool) runs only after it. Until #78 the nightly jobs' `stop()` only cleared the timer and ran in `onClose`, so a reconciliation in flight at a 03:00 deploy lost every later query to the ended pool. An abandoned run is safe by each job's own design (claims before work, rows before bytes). `serve()` also hands the list to the `JobRoster` `createApp()` built (`roster.adopt`): each job exposes its `name` and `runStartedAt()`, and `/health/ready`'s optional `cron_jobs` check names a run in flight past `STUCK_AFTER_MS` (30 min; see Health). A new timer is pushed onto that list, never given a hook of its own, and its run is wrapped in `metrics.timeJob(<JobName>, run)` (job_duration_seconds; see Metrics). `scheduled.spec.ts` closes a real Fastify instance with runs in flight.
- **Browser-made cutouts keep their untrimmed thumbs** (#373). `maintenance:retrim-thumbs` takes only `ready` and `edited` rows: a photo whose cutout the browser made before 2026-09-26 is `none`, and `file_variant_key_check` allows a key only on a ready or edited row, so its thumb cannot move to a new key, and rewriting it in place would break the rule that a keyed or served name never changes (an immutable URL would keep the old bytes on every phone). Its thumb is trimmed once its mask is edited (an `edited` row takes a key) or, if the thumb file is missing, when it is made on request.
- **`maintenance:retrim-thumbs` stops between photos, never inside one.** It is `runCli`'s one `stoppable` command: the first SIGINT or SIGTERM aborts `stop`, the photo in flight finishes (its new set stored and swapped, or refused and deleted), and it exits 130 with `Thumb retrim stopped by a signal after N photos`; a second signal, either one, kills it, because the first takes both listeners away (`commandStop`, `cli.spec.ts`: Node kills only on a signal with no listener, so a SIGTERM after a Ctrl-C was caught until 2026-11-12). Killed between `storeCutoutFiles` and the swap, a photo would keep a set newer than its row's, which reconciliation's superseded pass keeps forever as a restore's signature (above). `retrim-thumbs.spec.ts` stops one mid-run, and proves a failed, cutout-less or refused photo is counted and logged alone.
