import type { ApiClient } from '../api/client';
import type { SqlDriver } from '../db/driver';
import { setSyncMeta, upsertTaskDetail, upsertTasks, type ServerTask } from '../db/queries';

export const TASKS_SYNCED_KEY = 'tasks_synced_at';

export async function pullTasks(driver: SqlDriver, client: ApiClient): Promise<number> {
  const tasks = await client.get<ServerTask[]>('/tasks');
  await upsertTasks(driver, tasks);
  await setSyncMeta(driver, TASKS_SYNCED_KEY, new Date().toISOString());
  return tasks.length;
}

export async function pullTaskDetail(
  driver: SqlDriver,
  client: ApiClient,
  id: number,
): Promise<Record<string, unknown>> {
  const detail = await client.get<Record<string, unknown>>(`/tasks/${id}`);
  await upsertTaskDetail(driver, id, detail);
  await upsertTasks(driver, [detail as unknown as ServerTask]);
  return detail;
}
