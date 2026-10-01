import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import type { SqlDriver } from './driver';
import {
  countTasks,
  getSyncMeta,
  getTaskDetail,
  listTasks,
  setSyncMeta,
  upsertTaskDetail,
  upsertTasks,
  type ServerTask,
} from './queries';
import { migrate } from './schema';

const taskA: ServerTask = {
  id: 1,
  task_number: 'TK-1',
  title: 'Inspect line',
  status: 'ASSIGNED',
  priority: 'HIGH',
  due_date: '2026-10-05',
  crew: { name: 'Central 1 Crew' },
  line: { name: 'Sululta<>Gefersa' },
};

const taskB: ServerTask = {
  id: 2,
  task_number: 'TK-2',
  title: 'Fix tower',
  status: 'IN_PROGRESS',
  priority: 'LOW',
  due_date: '2026-10-02',
};

describe('task queries', () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createNodeDriver();
    await migrate(driver);
  });

  it('upserts and orders tasks by due date', async () => {
    await upsertTasks(driver, [taskA, taskB]);
    const rows = await listTasks(driver);
    expect(rows.map((r) => r.server_id)).toEqual([2, 1]);
    expect(rows[0].crew_name).toBeNull();
    expect(rows[1].crew_name).toBe('Central 1 Crew');
    expect(rows[1].line_name).toBe('Sululta<>Gefersa');
  });

  it('updates an existing task in place on re-pull', async () => {
    await upsertTasks(driver, [taskA]);
    await upsertTasks(driver, [{ ...taskA, title: 'Inspect line (revised)' }]);
    const rows = await listTasks(driver);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Inspect line (revised)');
  });

  it('never overwrites a locally dirty task', async () => {
    await upsertTasks(driver, [taskA]);
    await driver.run('UPDATE task SET dirty = 1 WHERE server_id = ?', [1]);
    await upsertTasks(driver, [{ ...taskA, title: 'Server wins?' }]);
    const rows = await listTasks(driver);
    expect(rows[0].title).toBe('Inspect line');
  });

  it('filters by status, crew and free-text search', async () => {
    await upsertTasks(driver, [taskA, taskB]);
    expect((await listTasks(driver, { status: 'ASSIGNED' })).map((r) => r.server_id)).toEqual([1]);
    expect((await listTasks(driver, { search: 'TK-2' })).map((r) => r.server_id)).toEqual([2]);
    expect(await listTasks(driver, { regionId: 99 })).toHaveLength(0);
  });

  it('round-trips a task detail payload', async () => {
    await upsertTaskDetail(driver, 7, { id: 7, readiness: { ready: true } });
    const detail = await getTaskDetail<{ id: number; readiness: { ready: boolean } }>(driver, 7);
    expect(detail?.id).toBe(7);
    expect(detail?.readiness.ready).toBe(true);
  });

  it('stores and reads sync metadata', async () => {
    await setSyncMeta(driver, 'tasks_synced_at', '2026-10-01T00:00:00.000Z');
    expect(await getSyncMeta(driver, 'tasks_synced_at')).toBe('2026-10-01T00:00:00.000Z');
    await setSyncMeta(driver, 'tasks_synced_at', '2026-10-02T00:00:00.000Z');
    expect(await getSyncMeta(driver, 'tasks_synced_at')).toBe('2026-10-02T00:00:00.000Z');
  });

  it('counts cached tasks', async () => {
    await upsertTasks(driver, [taskA, taskB]);
    expect(await countTasks(driver)).toBe(2);
  });
});
