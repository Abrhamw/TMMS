import type { SqlDriver } from './driver';

export type OutboxType =
  | 'checklist_draft'
  | 'checklist_submit'
  | 'finding'
  | 'attachment'
  | 'gps'
  | 'comment'
  | 'mail'
  | 'task_state'
  | 'trace';

export type OutboxStatus = 'pending' | 'inflight' | 'failed' | 'done';

// Transient failures are retried with backoff until this many attempts, after
// which the item is parked as 'failed' so one bad capture cannot retry forever.
export const MAX_OUTBOX_ATTEMPTS = 8;

export interface OutboxItem {
  id: number;
  client_ref: string;
  type: OutboxType;
  entity: string | null;
  payload: string;
  created_at: string;
  attempts: number;
  status: OutboxStatus;
  last_error: string | null;
}

export interface EnqueueInput {
  type: OutboxType;
  entity?: string | null;
  payload: unknown;
}

export function newClientRef(): string {
  const rand = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `${Date.now().toString(36)}-${rand}`;
}

export async function enqueue(driver: SqlDriver, input: EnqueueInput): Promise<OutboxItem> {
  const clientRef = newClientRef();
  const createdAt = new Date().toISOString();
  const result = await driver.run(
    `INSERT INTO outbox (client_ref, type, entity, payload, created_at, attempts, status)
     VALUES (?, ?, ?, ?, ?, 0, 'pending')`,
    [clientRef, input.type, input.entity ?? null, JSON.stringify(input.payload ?? {}), createdAt],
  );
  return {
    id: result.lastInsertRowId,
    client_ref: clientRef,
    type: input.type,
    entity: input.entity ?? null,
    payload: JSON.stringify(input.payload ?? {}),
    created_at: createdAt,
    attempts: 0,
    status: 'pending',
    last_error: null,
  };
}

export async function listOutbox(driver: SqlDriver, statuses: OutboxStatus[]): Promise<OutboxItem[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(', ');
  return driver.all<OutboxItem>(
    `SELECT * FROM outbox WHERE status IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    statuses,
  );
}

export async function listFailed(driver: SqlDriver): Promise<OutboxItem[]> {
  return driver.all<OutboxItem>(
    "SELECT * FROM outbox WHERE status = 'failed' ORDER BY created_at DESC, id DESC",
  );
}

export async function pendingCount(driver: SqlDriver): Promise<number> {
  const row = await driver.first<{ c: number }>(
    "SELECT COUNT(*) c FROM outbox WHERE status IN ('pending', 'inflight')",
  );
  return Number(row?.c ?? 0);
}

export async function markInflight(driver: SqlDriver, id: number): Promise<void> {
  await driver.run("UPDATE outbox SET status = 'inflight' WHERE id = ?", [id]);
}

export async function markDone(driver: SqlDriver, id: number): Promise<void> {
  await driver.run("UPDATE outbox SET status = 'done', last_error = NULL WHERE id = ?", [id]);
}

export async function requeue(driver: SqlDriver, id: number, error: string): Promise<void> {
  await driver.run(
    "UPDATE outbox SET status = 'pending', attempts = attempts + 1, last_error = ? WHERE id = ?",
    [error, id],
  );
}

export async function markFailed(driver: SqlDriver, id: number, error: string): Promise<void> {
  await driver.run(
    "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
    [error, id],
  );
}

export async function retryItem(driver: SqlDriver, id: number): Promise<void> {
  await driver.run("UPDATE outbox SET status = 'pending', last_error = NULL WHERE id = ?", [id]);
}
