import type { SqlDriver } from '../db/driver';
import { enqueue, newClientRef } from '../db/outbox';

export interface TracePoint {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  recorded_at: string;
}

export interface QueueTraceInput {
  taskId: number;
  crewId?: number | null;
  points: TracePoint[];
}

export const MAX_POINTS_PER_BATCH = 100;

export async function queueTrace(driver: SqlDriver, input: QueueTraceInput): Promise<number> {
  let queued = 0;
  for (let i = 0; i < input.points.length; i += MAX_POINTS_PER_BATCH) {
    const batch = input.points.slice(i, i + MAX_POINTS_PER_BATCH);
    await enqueue(driver, {
      type: 'trace',
      entity: `trace:${input.taskId}`,
      payload: {
        task_id: input.taskId,
        crew_id: input.crewId ?? null,
        // Each point carries its own client_ref so a retried batch can never
        // record the same ground position twice.
        points: batch.map((point) => ({ ...point, client_ref: newClientRef() })),
      },
    });
    queued += batch.length;
  }
  return queued;
}
