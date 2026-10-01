import type { ApiClient } from '../api/client';
import type { ChecklistResponse } from '../api/checklistTypes';
import type { SqlDriver } from '../db/driver';
import {
  setSyncMeta,
  upsertChecklist,
  upsertTaskDetail,
  upsertTasks,
  type ServerTask,
} from '../db/queries';

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

export async function pullChecklist(
  driver: SqlDriver,
  client: ApiClient,
  taskId: number,
): Promise<ChecklistResponse> {
  const data = await client.get<ChecklistResponse>(`/tasks/${taskId}/checklist`);
  for (const template of data.templates ?? []) {
    await upsertChecklist(driver, taskId, template.id, template);
  }
  return data;
}
