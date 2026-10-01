import { describe, expect, it } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import { SCHEMA_VERSION, migrate } from './schema';

describe('schema', () => {
  it('creates every cache and queue table', async () => {
    const driver = createNodeDriver();
    await migrate(driver);
    const rows = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = rows.map((r) => r.name);
    for (const table of [
      'task',
      'task_detail',
      'finding',
      'checklist',
      'message',
      'line',
      'attachment',
      'outbox',
      'sync_meta',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('is idempotent and records the schema version', async () => {
    const driver = createNodeDriver();
    await migrate(driver);
    await migrate(driver);
    const row = await driver.first<{ user_version: number }>('PRAGMA user_version');
    expect(Number(row?.user_version)).toBe(SCHEMA_VERSION);
  });
});
