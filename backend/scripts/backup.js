#!/usr/bin/env node
'use strict';

// Consistent, verified SQLite backups.
//
//   node scripts/backup.js [--out DIR] [--keep N] [--prune] [--test-restore]
//
// A hot copy is taken with `VACUUM INTO`, which produces a transactionally
// consistent, compacted snapshot without stopping the server, then the snapshot
// is re-opened and checked (`PRAGMA integrity_check` + `PRAGMA foreign_key_check`)
// so a corrupt or truncated backup is never recorded as good.
//
// `--test-restore` proves the newest backup is actually restorable by opening it
// as a database and counting core tables. It never touches the live database.
//
// Target RPO is one backup interval; target RTO is the time to copy the newest
// verified snapshot back over the live file and restart (see docs/BACKUP_RECOVERY.md).

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = process.env.TMMS_DB || path.join(__dirname, '..', 'tmms.db');

function parseArgs(argv) {
  const out = { out: path.join(__dirname, '..', 'backups'), keep: 14, prune: false, testRestore: false, db: DEFAULT_DB };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--keep') out.keep = Number(argv[++i]) || 14;
    else if (a === '--prune') out.prune = true;
    else if (a === '--db') out.db = path.resolve(argv[++i]);
    else if (a === '--test-restore') out.testRestore = true;
  }
  return out;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function verify(dbPath) {
  const copy = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check;').get();
    const integrityValue = integrity ? Object.values(integrity)[0] : 'unknown';
    const fk = copy.prepare('PRAGMA foreign_key_check;').all();
    const tables = copy
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get().c;
    return { ok: integrityValue === 'ok' && fk.length === 0, integrity: integrityValue, foreignKeyViolations: fk.length, tables };
  } finally {
    copy.close();
  }
}

function newestBackup(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /^tmms-.*\.db$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].f) : null;
}

function prune(dir, keep) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^tmms-.*\.db$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = files.slice(keep).map((x) => path.join(dir, x.f));
  for (const file of stale) fs.unlinkSync(file);
  return stale.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.db)) {
    console.error(`[backup] database not found: ${args.db}`);
    process.exit(1);
  }
  fs.mkdirSync(args.out, { recursive: true });

  if (args.testRestore) {
    const target = newestBackup(args.out);
    if (!target) {
      console.error(`[backup] no backup found in ${args.out}`);
      process.exit(1);
    }
    const result = verify(target);
    console.log(`[backup] restore test ${path.basename(target)}: ${result.ok ? 'OK' : 'FAILED'} (integrity=${result.integrity}, fk=${result.foreignKeyViolations}, tables=${result.tables})`);
    process.exit(result.ok ? 0 : 2);
  }

  const target = path.join(args.out, `tmms-${stamp()}.db`);
  const source = new DatabaseSync(args.db);
  try {
    source.exec(`VACUUM INTO ${quoteLiteral(target)};`);
  } finally {
    source.close();
  }

  const result = verify(target);
  if (!result.ok) {
    console.error(`[backup] verification FAILED for ${target} (integrity=${result.integrity}, fk=${result.foreignKeyViolations})`);
    process.exit(2);
  }
  const pruned = args.prune ? prune(args.out, args.keep) : 0;
  const bytes = fs.statSync(target).size;
  console.log(`[backup] wrote ${target} (${bytes} bytes, ${result.tables} tables, integrity=${result.integrity})${pruned ? `, pruned ${pruned} old` : ''}`);
}

main();
