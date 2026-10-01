import type { SqlDriver } from './driver';

export interface ServerTask {
  id: number;
  task_number?: string | null;
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  task_type?: string | null;
  region_id?: number | null;
  crew_id?: number | null;
  line_id?: number | null;
  tower_id?: number | null;
  asset_id?: number | null;
  substation_id?: number | null;
  due_date?: string | null;
  updated_at?: string | null;
  progress_pct?: number | null;
  crew?: { name?: string | null } | null;
  line?: { name?: string | null } | null;
}

export interface CachedTask {
  server_id: number;
  task_number: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  task_type: string | null;
  region_id: number | null;
  crew_id: number | null;
  line_id: number | null;
  tower_id: number | null;
  asset_id: number | null;
  due_date: string | null;
  updated_at: string | null;
  progress_pct: number;
  crew_name: string | null;
  line_name: string | null;
  cached_at: string;
}

export interface TaskFilter {
  status?: string;
  search?: string;
  crewId?: number;
  regionId?: number;
}

const TASK_SELECT = `
  SELECT server_id, task_number, title, status, priority, task_type, region_id,
         crew_id, line_id, tower_id, asset_id, due_date, updated_at, progress_pct,
         crew_name, line_name, cached_at
  FROM task`;

export async function upsertTasks(driver: SqlDriver, tasks: ServerTask[]): Promise<number> {
  const now = new Date().toISOString();
  await driver.transaction(async () => {
    for (const task of tasks) {
      await driver.run(
        `INSERT INTO task (
           server_id, task_number, title, status, priority, task_type, region_id,
           crew_id, line_id, tower_id, asset_id, substation_id, due_date, updated_at,
           progress_pct, crew_name, line_name, payload, cached_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           task_number = excluded.task_number,
           title = excluded.title,
           status = excluded.status,
           priority = excluded.priority,
           task_type = excluded.task_type,
           region_id = excluded.region_id,
           crew_id = excluded.crew_id,
           line_id = excluded.line_id,
           tower_id = excluded.tower_id,
           asset_id = excluded.asset_id,
           substation_id = excluded.substation_id,
           due_date = excluded.due_date,
           updated_at = excluded.updated_at,
           progress_pct = excluded.progress_pct,
           crew_name = excluded.crew_name,
           line_name = excluded.line_name,
           payload = excluded.payload,
           cached_at = excluded.cached_at
         WHERE task.dirty = 0`,
        [
          task.id,
          task.task_number ?? null,
          task.title ?? null,
          task.status ?? null,
          task.priority ?? null,
          task.task_type ?? null,
          task.region_id ?? null,
          task.crew_id ?? null,
          task.line_id ?? null,
          task.tower_id ?? null,
          task.asset_id ?? null,
          task.substation_id ?? null,
          task.due_date ?? null,
          task.updated_at ?? null,
          task.progress_pct ?? 0,
          task.crew?.name ?? null,
          task.line?.name ?? null,
          JSON.stringify(task),
          now,
        ],
      );
    }
  });
  return tasks.length;
}

export async function listTasks(driver: SqlDriver, filter: TaskFilter = {}): Promise<CachedTask[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (typeof filter.crewId === 'number') {
    clauses.push('crew_id = ?');
    params.push(filter.crewId);
  }
  if (typeof filter.regionId === 'number') {
    clauses.push('region_id = ?');
    params.push(filter.regionId);
  }
  if (filter.search) {
    clauses.push('(title LIKE ? OR task_number LIKE ?)');
    const like = `%${filter.search}%`;
    params.push(like, like);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return driver.all<CachedTask>(
    `${TASK_SELECT}${where} ORDER BY (due_date IS NULL), due_date, server_id DESC`,
    params,
  );
}

export async function getTask(driver: SqlDriver, id: number): Promise<CachedTask | null> {
  return driver.first<CachedTask>(`${TASK_SELECT} WHERE server_id = ?`, [id]);
}

export async function upsertTaskDetail(
  driver: SqlDriver,
  id: number,
  detail: unknown,
): Promise<void> {
  await driver.run(
    `INSERT INTO task_detail (task_id, payload, cached_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at`,
    [id, JSON.stringify(detail), new Date().toISOString()],
  );
}

export async function getTaskDetail<T = unknown>(driver: SqlDriver, id: number): Promise<T | null> {
  const row = await driver.first<{ payload: string }>(
    'SELECT payload FROM task_detail WHERE task_id = ?',
    [id],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export async function setSyncMeta(driver: SqlDriver, key: string, value: string): Promise<void> {
  await driver.run(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function getSyncMeta(driver: SqlDriver, key: string): Promise<string | null> {
  const row = await driver.first<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function countTasks(driver: SqlDriver): Promise<number> {
  const row = await driver.first<{ c: number }>('SELECT COUNT(*) c FROM task');
  return Number(row?.c ?? 0);
}

export async function upsertChecklist(
  driver: SqlDriver,
  taskId: number,
  templateId: number,
  payload: unknown,
): Promise<void> {
  await driver.run(
    `INSERT INTO checklist (task_id, template_id, payload, cached_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, template_id) DO UPDATE SET payload = excluded.payload, cached_at = excluded.cached_at`,
    [taskId, templateId, JSON.stringify(payload), new Date().toISOString()],
  );
}

export async function getChecklist<T = unknown>(
  driver: SqlDriver,
  taskId: number,
): Promise<Array<{ template_id: number; payload: T }>> {
  const rows = await driver.all<{ template_id: number; payload: string }>(
    'SELECT template_id, payload FROM checklist WHERE task_id = ? ORDER BY template_id',
    [taskId],
  );
  const out: Array<{ template_id: number; payload: T }> = [];
  for (const row of rows) {
    try {
      out.push({ template_id: row.template_id, payload: JSON.parse(row.payload) as T });
    } catch {
      /* skip a corrupt cache row */
    }
  }
  return out;
}

export interface ServerLine {
  id: number;
  name?: string | null;
  line_id?: string | null;
  voltage_kv?: number | null;
  color?: string | null;
  route?: Array<[number, number]> | null;
  region_id?: number | null;
}

export async function upsertLines(driver: SqlDriver, lines: ServerLine[]): Promise<number> {
  const cachedAt = new Date().toISOString();
  for (const line of lines) {
    await driver.run(
      `INSERT INTO line (server_id, line_code, name, route_json, payload, cached_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         line_code = excluded.line_code,
         name = excluded.name,
         route_json = excluded.route_json,
         payload = excluded.payload,
         cached_at = excluded.cached_at`,
      [
        line.id,
        line.line_id ?? null,
        line.name ?? null,
        JSON.stringify(line.route ?? null),
        JSON.stringify(line),
        cachedAt,
      ],
    );
  }
  return lines.length;
}

export async function listLines(driver: SqlDriver): Promise<ServerLine[]> {
  const rows = await driver.all<{ payload: string }>('SELECT payload FROM line ORDER BY server_id');
  const out: ServerLine[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as ServerLine);
    } catch {
      /* skip a corrupt cache row */
    }
  }
  return out;
}

export async function upsertMessages(
  driver: SqlDriver,
  folder: string,
  messages: Array<{ id: number }>,
): Promise<number> {
  const cachedAt = new Date().toISOString();
  for (const message of messages) {
    await driver.run(
      `INSERT INTO message (server_id, folder, payload, cached_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         folder = CASE
           WHEN excluded.folder = 'detail' AND message.folder IS NOT NULL AND message.folder <> 'detail'
             THEN message.folder
           ELSE excluded.folder
         END,
         payload = excluded.payload,
         cached_at = excluded.cached_at`,
      [message.id, folder, JSON.stringify(message), cachedAt],
    );
  }
  return messages.length;
}

export async function listMessages<T = unknown>(driver: SqlDriver, folder: string): Promise<T[]> {
  const rows = await driver.all<{ payload: string }>(
    'SELECT payload FROM message WHERE folder = ? ORDER BY server_id DESC',
    [folder],
  );
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload) as T);
    } catch {
      /* skip a corrupt cache row */
    }
  }
  return out;
}

export async function getMessage<T = unknown>(driver: SqlDriver, id: number): Promise<T | null> {
  const row = await driver.first<{ payload: string }>(
    'SELECT payload FROM message WHERE server_id = ?',
    [id],
  );
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}
