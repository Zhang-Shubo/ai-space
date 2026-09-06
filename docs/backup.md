# Backup design

The backup module is the third part of the storage service (see [storage.md](storage.md)): after "where does an app keep its data" comes "what happens when the machine is gone". This document is the reference for what `src/space/storage/backup/` does and why.

Status: implemented. Snapshots, retention, the weekly verification, `restore`, the API and the panel's Backups list are in place. The PostgreSQL path (`pg_dump` / `pg_restore --list`) is coded but not exercised until a workspace uses postgres; client-side encryption is not done.

## What it replaces

The pattern this module replaces is a shell script on a cron timer: find every `*.db` under the workspace, snapshot each with `sqlite3 .backup` into a staging directory, `rclone sync` the directory to one of seven weekday slots in a bucket, append a line to a log file. It worked, and it had four gaps that shape the design:

1. **Overwriting slots**: a snapshot lived for exactly seven days. A corruption noticed on day eight was permanent.
2. **Nothing but databases**: JSON state files, chat sessions and uploaded images next to the databases were not copied.
3. **Nobody looked**: a snapshot that failed to open would have been found on the day it was needed.
4. **Invisible**: the last run's result lived in a log file on the machine, not in the panel with the other tasks.

## Goals and non-goals

Goals:

- Every app with data under `<workspace>/data/<app>/` is backed up without declaring anything. Opting out is a manifest line; opting in is not required.
- One snapshot is one object: an app's databases, its state files and a manifest of what is inside, in one archive that can be restored on a machine that has never seen the workspace.
- Retention keeps history, not slots. Recent days, recent weeks, recent months.
- Snapshots are verified on a schedule, and restore is a command that is exercised before it is needed.
- Backups are scheduler tasks, so they show in the panel, back off, and alert like every other task.
- No new binaries beyond what a server has: `tar`, `zstd`; the S3 client is Bun's.

Non-goals:

- Continuous replication or point-in-time recovery. The unit is a snapshot on a schedule.
- Copying S3 blob stores. They are already off the machine; a bucket-to-bucket copy is a bucket feature, not this module's.
- Backing up the workspace `.env`. Secrets come from the password manager.
- Encrypting snapshots at rest. The bucket's own encryption applies; client-side encryption can be added later as a step in the pipeline.

## Overview

```
scheduler task (command)
   │  bun <space>/src/index.ts backup <app>
   ▼
snapshot ──► stage ──► archive ──► upload ──► record ──► prune
   │            │          │          │          │          │
   │            │          │          │          │          └─ delete snapshots beyond the keep counts (only ones with a sidecar)
   │            │          │          │          └─ backups table in space.db + <key>.json sidecar next to the object
   │            │          │          └─ Bun S3Client (multipart) or a directory, per SPACE_BACKUP_URL
   │            │          └─ tar | zstd of the staging dir; sha256 of the result
   │            └─ <workspace>/backups/<app>/<stamp>/  (same disk: a full disk fails before any upload)
   └─ VACUUM INTO for each SQLite file; copy of every other file in the data dir
```

Four subcommands and two scheduled tasks:

| Piece | Kind | Purpose |
| --- | --- | --- |
| `backup <app>` | CLI | Snapshot, archive, upload, record, prune one app (`space` for ai-space's own `space.db`). |
| `backup`, one task per app | scheduler `command` task, source `manifest`, name `backup` | Runs the CLI on the app's schedule. Contributed by the backup module when the manifest syncs; the app does not declare it. |
| `backup-verify` | CLI and a weekly task owned by `space` | Downloads the newest snapshot of every app, opens it, records the result. Fails when any app has no successful snapshot in the last two days. |
| `backups [<app>]` | CLI | Lists snapshots from the target's sidecars; works without `space.db`. |
| `restore <app>` | CLI | Fetches a snapshot and unpacks it into a directory or in place. |

`space` is a reserved app name: it holds ai-space's own tasks and its own snapshot. A manifest may not use it, and may not declare a task named `backup` unless it sets `backup: false`.

## What goes into a snapshot

For app `<app>` with data dir `D = <workspace>/data/<app>/`, the archive holds:

| Archive path | Source | Method |
| --- | --- | --- |
| `databases/<rel>.db` | Every `*.db` in `D`, at any depth, whether or not it is in the storage inventory. | `VACUUM INTO` through `bun:sqlite`. Consistent under WAL, no writer lock, output already compacted; rows that are still in the WAL are in the copy. `-wal`, `-shm` and `-journal` files are never copied. A `.db` that turns out not to be SQLite is copied as a plain file and noted. |
| `databases/<name>.pgdump` | Inventory rows with backend `postgres`. | `pg_dump -Fc`. The run fails with a clear message when `pg_dump` is missing. |
| `files/<rel>` | Everything else in `D`, recursively. | Plain copy. Built-in excludes: `blobs/`, `notify/` (image cache the notify service rebuilds), `.snapshot/` (what a restore leaves behind), `space.env` (regenerated on sync; holds the app token and S3 credentials), `*.db-wal`, `*.db-shm`, `*.db-journal`, `*.log`, `*.lock`, `.DS_Store`, plus the manifest's `backup.exclude`. |
| `blobs/<rel>` | `D/blobs/`, the filesystem blob store. | Only when `backup.include` lists `blobs`. Default off: it can be large, and apps that need it opt in. An S3 blob store is never copied; its URL is recorded in the manifest so a restore knows where the objects live. |
| `space.yaml` | The app manifest at snapshot time. | Copy. |
| `manifest.json` | Generated. | Every entry above with kind, size and sha256; the excludes in force; notes on what was skipped; the blob URL. |

The source database is opened read-write but never written: a read-only handle cannot create the `-shm` file a WAL database needs, so it fails on a database whose owner closed cleanly.

`space` (ai-space itself) is snapshotted the same way with `D = <workspace>/data/`, top level only: `space.db` and nothing else, since every app directory is its own snapshot. The running ai-space writes `space.db` while the backup process reads it; `VACUUM INTO` takes a read transaction, which never blocks a WAL writer. The index write from the subprocess waits `busy_timeout` like every other connection.

## Archive and upload

Staging is `<workspace>/backups/<app>/<stamp>/`, on the same disk as the data on purpose: a full disk fails the snapshot before an upload starts, so no half-written object ever exists. The archive is `tar -cf - . | zstd -q -T0`, both spawned as the system binaries (GNU or BSD tar, any zstd; `setup` checks for them). The sha256 is computed by streaming the finished file. Staging and the archive are removed after the run, success or failure; a lock file keeps two runs of one app apart, and a lock left by a dead process is ignored.

Upload goes to `SPACE_BACKUP_URL`:

| Value | Behaviour |
| --- | --- |
| `s3://<bucket>/<prefix>/` | Bun's `S3Client` with the workspace `SPACE_S3_*` credentials; large files stream as multipart. Default when S3 is configured and `SPACE_S3_BUCKET` is set: `s3://<SPACE_S3_BUCKET>/backups/`. |
| `file:///abs/dir/` | A directory on this machine or a mounted volume. Useful for a first run and for tests. Boot logs a warning that a same-machine copy is not a backup. |
| unset | Boot logs it; the tasks are registered anyway and every run fails with `SPACE_BACKUP_URL is not set`, so the gap is visible in the panel rather than silent. |

Object keys:

```
<prefix>/<app>/<yyyy-mm-ddThh-mm-ssZ>.tar.zst
<prefix>/<app>/<yyyy-mm-ddThh-mm-ssZ>.json        the snapshot manifest again, as a sidecar
```

The sidecar makes the target self-describing: `backups`, `backup-verify` and `restore` read sidecars, so they work on a fresh machine before `space.db` has been restored. Only keys in exactly this shape are ever listed, verified, pruned or restored; anything else under the prefix is left alone, which is what makes it safe to point `SPACE_BACKUP_URL` at a prefix that already holds other files. The `backups` table in `space.db` indexes the same information for the API and the panel, and verification indexes a sidecar it did not write.

## Schedule and retention

A `backup` task is registered for every app when its manifest syncs, and for `space` at boot. Defaults, all overridable in `space.yaml`:

```yaml
backup:                       # optional; every key optional
  schedule: "0 3 * * *"       # cron; default: SPACE_BACKUP_SCHEDULE with a per-app minute
  timezone: UTC
  keep: { daily: 7, weekly: 4, monthly: 6 }
  include: [databases, files] # add "blobs" for a filesystem blob store
  exclude: ["cache/", "*.tmp"] # gitignore-style, relative to the data dir
# backup: false               # opt out; nothing of this app is copied
```

The default schedule spreads apps over the hour: `SPACE_BACKUP_SCHEDULE` gives the hour (`0 3 * * *`), and each app gets a minute derived from a hash of its name. A default whose minute field is not a plain number (`*/30 3 * * *`) is used as written. The panel shows the exact time on the task.

Retention is counted, not dated, so a machine that was off for a week does not throw away everything on its first run back. After every successful upload, prune keeps, for that app:

- the newest `daily` snapshots,
- the first snapshot of each of the newest `weekly` ISO weeks,
- the first snapshot of each of the newest `monthly` months,

and deletes the rest, archive and sidecar together. One snapshot can satisfy more than one slot. A snapshot that failed verification never fills a slot and is dropped, unless it is the only one left.

The task is a `command` target, so the scheduler's timeout (`SPACE_BACKUP_TIMEOUT_MIN`, default 30), backoff and concurrency limit apply. A backup that overruns is killed; the next run removes what it left in staging. `SPACE_NOTIFY_TASKS` alerts after three failures in a row, as for every task.

## Verification

`backup-verify` runs weekly (`SPACE_BACKUP_VERIFY_SCHEDULE`, default `0 5 * * 1`), owned by `space`. For `space` and every app with a data directory whose manifest does not opt out, it:

1. Reads the newest sidecar. Fails the app when there is none, or when the snapshot is older than `SPACE_BACKUP_MAX_AGE_HOURS` (default 48).
2. Downloads the archive and checks its sha256 against the sidecar.
3. Unpacks it and compares the listing with the manifest inside: nothing missing, nothing extra.
4. Opens each SQLite copy and runs `PRAGMA integrity_check`; runs `pg_restore --list` on each postgres dump; re-hashes every other file.
5. Records the result in the `backups` table and rewrites the sidecar with a `verify` field.

One failing app fails the task, with every app's result in the run output. Verification reads the target's sidecars, so a snapshot written by another machine is indexed and checked too.

## Restore

```
bun src/index.ts backups [<app>]                                 list snapshots (from the target)
bun src/index.ts restore <app> [--at <time>] --to <dir>          unpack only
bun src/index.ts restore <app> [--at <time>] --in-place [--stopped]
```

`--at` takes the stamp form (`2026-09-05T03-00-00Z`) or ISO time; the default is the newest snapshot. Every restore checks the archive's sha256 against the sidecar first.

`--to` unpacks into a directory in the data-dir layout (`databases/` and `files/` at the top, `blobs/` under `blobs/`, the snapshot's own `space.yaml` and `manifest.json` under `.snapshot/`) and stops. It is the path for inspecting old data, for moving an app to another machine, and for the round-trip check after a first backup.

`--in-place` replaces `<workspace>/data/<app>/`:

1. Stops the app through `SPACE_SERVICE_STOP` when that is configured; otherwise the operator stops it and passes `--stopped`.
2. Moves the current directory to `<workspace>/data/<app>.pre-restore-<stamp>/`, which ai-space never deletes.
3. Unpacks, and keeps the current `space.env` (it is regenerated on the next sync anyway).
4. Prints the start step. Starting is the operator's, because ai-space does not own the unit.

A postgres dump is unpacked, not loaded; the command prints the `pg_restore` line to run. `space` refuses `--in-place`: its snapshot holds only `space.db`, which is copied by hand while ai-space is stopped.

There is no restore route in the API. Replacing live data stays a terminal action with the machine's own credentials.

## API and panel

```
GET  /api/backups                every app with a backup task: last snapshot, last ok, last verified, stale, next run
GET  /api/apps/:app/backups      one app's snapshots from the index, newest first
POST /api/apps/:app/backups      run the app's backup task now (bearer token)
```

The panel's settings drawer lists every app under Backups with the age of its last successful snapshot, red when older than `SPACE_BACKUP_MAX_AGE_HOURS`; the tooltip carries the last error, the verification result and the next run. The tasks drawer shows the `backup` tasks themselves.

## Configuration

```
SPACE_BACKUP_URL              s3://<bucket>/<prefix>/ or file:///dir/; default s3://<SPACE_S3_BUCKET>/backups/ when S3 is configured
SPACE_BACKUP_SCHEDULE         hour of the per-app backup tasks;   default "0 3 * * *"
SPACE_BACKUP_VERIFY_SCHEDULE  the weekly verify task;              default "0 5 * * 1"
SPACE_BACKUP_MAX_AGE_HOURS    verify fails an app older than this; default 48
SPACE_BACKUP_TIMEOUT_MIN      task timeout;                        default 30
```

`SPACE_S3_*` supply the credentials for an `s3://` target. All of it lives in the workspace `.env`; nothing in a manifest names a bucket or a key.

## Module layout

```
src/space/storage/backup/
├── types.ts      BackupSpec, Keep, SnapshotManifest, SnapshotEntry, BackupRecord; key and stamp helpers
├── spec.ts       parse `backup:` (absent, bool or mapping), defaults, per-app minute, scheduleFor
├── snapshot.ts   stage one app: VACUUM INTO, pg_dump, file copy with the exclude matcher, manifest.json
├── archive.ts    tar | zstd via Bun.$, extract, list, hashFile
├── target.ts     BackupTarget interface; FileTarget and S3Target (Bun S3Client)
├── catalog.ts    listSnapshots / readSidecar: what the target holds
├── store.ts      the backups table in space.db; summary for the API; index a foreign sidecar
├── retention.ts  pure: selectRetained(candidates, keep)
├── run.ts        runBackup: stage → archive → upload → record → prune; the lock; pruneApp
├── verify.ts     verifyApp / verifyAll, integrityCheck
├── restore.ts    restoreSnapshot, materialize (archive layout → data dir)
├── tasks.ts      backupTask(app, spec) and spaceManifest(): the scheduler tasks
├── api.ts        the three routes
├── cli.ts        the four subcommands
└── index.ts      barrel
```

How it hooks into what exists:

- `index.ts` `provision()` runs for every manifest before the scheduler syncs it and returns the contributed `backup` task; `Scheduler.syncManifest(manifest, extra)` treats it as a manifest task, so it is keyed `app + "backup"`, orphaned when the app goes, and overridable from the panel like any other.
- At boot the scheduler syncs a synthetic manifest for `space` with its `backup` and `backup-verify` tasks, as a built-in app: a workspace sync (`POST /api/apps/sync`) forgets apps whose directory lost its manifest, and must not forget this one.
- Every task's command is the absolute bun binary and entry file (`process.execPath`, `import.meta.path`), run in the ai-space checkout with `SPACE_HOME` pinned, so the subprocess finds the same workspace the scheduler uses.
- `setup` checks for `tar` and `zstd` and mentions the default target in its S3 section.

Tests: `spec`, `retention` and `tasks` are unit-tested; `backup.test.ts` runs the whole pipeline on a temporary workspace with a live WAL database against a `FileTarget`, including verification of a tampered archive, prune after a failed verification, `--to` on a fresh workspace, and `--in-place`.

## Failure modes considered

| Situation | Behaviour |
| --- | --- |
| Disk full | `VACUUM INTO` or the copy fails inside staging; nothing uploaded, live data untouched, task fails. |
| Upload interrupted | No sidecar, so nothing lists it; the error row and the task failure are visible. A stray archive without a sidecar is never touched. |
| Two backups of one app at once | The scheduler never runs one task concurrently with itself; the CLI takes a lock file and exits with a message. A lock from a dead process is ignored. |
| `space.db` locked by the running ai-space | The read side never blocks under WAL; the index write waits `busy_timeout`, then the run fails, but the object and sidecar are already in the target and verification indexes them later. |
| App writes to a `.db` that is not in WAL mode | `VACUUM INTO` waits for the writer's transaction to end, up to `busy_timeout`; a long transaction fails the snapshot, which the task reports. |
| Target unreachable | Upload fails fast; staging cleaned; task fails and backs off. `backup-verify` catches the growing age. |
| Corrupt snapshot | Found by the weekly verify; marked; the next prune drops it when a good one exists. |
| Machine lost | `backups` and `restore --to` need only the bucket credentials and a checkout of ai-space. |
| An operator points `SPACE_BACKUP_URL` at a prefix with other files | Only keys of the form `<app>/<stamp>.tar.zst` with a sidecar are ever listed or deleted. |

## Migrating from the shell script

1. Leave the old objects where they are. The new module writes under its own prefix and never lists or deletes outside it. The old weekday slots stay as a fallback until the first verification passes, then can be deleted by hand.
2. Stop the old timer before the first scheduled run, so the two do not snapshot the same files at the same minute.
3. Databases that are not in `<workspace>/data/<app>/` are not seen by the new module. Move them under an app, or accept that they are not backed up.
4. Run `backup <app>` once for every app by hand, then `backup-verify`, then `restore --to` one of them into a temporary directory and open the copy.
