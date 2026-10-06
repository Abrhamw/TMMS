# Backup & Recovery

Operational backup runbook for the TMMS SQLite database.

## Objectives

| Target | Value | Basis |
|--------|-------|-------|
| RPO (max data loss) | 15 minutes | Backup runs every 15 minutes |
| RTO (time to restore) | 15 minutes | Copy snapshot + restart API |

Both targets assume the backup directory lives on a different volume/volume-snapshot than the live database.

## Mechanism

- `scripts/backup.js` takes a hot, transactionally consistent snapshot with `VACUUM INTO`, so the API does not need to stop.
- Every snapshot is immediately re-opened read-only and checked with `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. A snapshot that fails verification is never recorded as good and the process exits non-zero.
- Snapshots are written to `backend/backups/tmms-<timestamp>.db`.

## Commands

```bash
# Take a verified snapshot
cd backend && npm run db:backup

# Prove the newest snapshot is restorable (opens it, checks integrity, counts tables)
cd backend && npm run db:verify

# Custom location / retention
cd backend && node scripts/backup.js --out /srv/tmms-backups --prune --keep 96
```

## Scheduling

Run `npm run db:backup` on a 15-minute schedule (system cron or the platform scheduler). Retention pruning is opt-in (`--prune --keep N`) so a misconfigured schedule cannot silently delete history.

## Restore Procedure

1. Stop the API process to release the database file.
2. Preserve the current file before replacing it (for example `cp tmms.db tmms.db.pre-restore`), then copy the newest verified snapshot over `tmms.db`.
3. Remove stale `tmms.db-wal` and `tmms.db-shm` sidecar files so SQLite does not replay a WAL from the replaced database.
4. Restart the API and confirm `GET /readyz` reports `db: ok`.
5. Run `npm run db:verify` and spot-check the task list and reports.

## Recovery Drills

Run `npm run db:verify` at least weekly and perform a full restore into a scratch directory monthly to confirm the documented RTO. Record the drill date, duration and snapshot used.

## Failure Modes

- **Backup verification fails**: the process exits `2`. Treat the snapshot as unusable and investigate disk integrity before relying on the archive.
- **No snapshot present**: `npm run db:verify` exits `1`. This means the schedule is not running — fix scheduling before the RPO is breached.
