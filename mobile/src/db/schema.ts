import type { SqlDriver } from './driver';

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  server_id INTEGER PRIMARY KEY,
  task_number TEXT,
  title TEXT,
  status TEXT,
  priority TEXT,
  task_type TEXT,
  region_id INTEGER,
  crew_id INTEGER,
  line_id INTEGER,
  tower_id INTEGER,
  asset_id INTEGER,
  substation_id INTEGER,
  due_date TEXT,
  updated_at TEXT,
  progress_pct REAL DEFAULT 0,
  crew_name TEXT,
  line_name TEXT,
  payload TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_detail (
  task_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finding (
  server_id INTEGER PRIMARY KEY,
  task_id INTEGER,
  payload TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist (
  task_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  cached_at TEXT NOT NULL,
  PRIMARY KEY (task_id, template_id)
);

CREATE TABLE IF NOT EXISTS message (
  server_id INTEGER PRIMARY KEY,
  folder TEXT,
  payload TEXT NOT NULL,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line (
  server_id INTEGER PRIMARY KEY,
  line_code TEXT,
  name TEXT,
  route_json TEXT,
  payload TEXT,
  cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachment (
  local_id TEXT PRIMARY KEY,
  task_id INTEGER,
  finding_id INTEGER,
  file_uri TEXT NOT NULL,
  remote_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ref TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  entity TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);
`;

export async function migrate(driver: SqlDriver): Promise<void> {
  await driver.exec(SCHEMA_SQL);
  await driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
