import { beforeEach, describe, expect, it } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import type { SqlDriver } from '../db/driver';
import { listOutbox } from '../db/outbox';
import { migrate } from '../db/schema';
import { MAX_POINTS_PER_BATCH, queueTrace, type TracePoint } from './trace';

function makePoints(count: number): TracePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: 9 + i / 100000,
    lng: 38 + i / 100000,
    accuracy_m: 5,
    recorded_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
}

describe('trace queueing', () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createNodeDriver();
    await migrate(driver);
  });

  it('queues every point with its own client_ref', async () => {
    const count = await queueTrace(driver, { taskId: 4, points: makePoints(3) });

    expect(count).toBe(3);
    const items = await listOutbox(driver, ['pending']);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('trace');
    const payload = JSON.parse(items[0]!.payload) as { points: Array<Record<string, unknown>> };
    expect(payload.points).toHaveLength(3);
    const refs = new Set(payload.points.map((point) => point.client_ref));
    expect(refs.size).toBe(3);
  });

  it('splits large traces into bounded batches', async () => {
    await queueTrace(driver, { taskId: 4, points: makePoints(MAX_POINTS_PER_BATCH + 5) });

    const items = await listOutbox(driver, ['pending']);
    expect(items).toHaveLength(2);
    const first = JSON.parse(items[0]!.payload) as { points: unknown[] };
    const second = JSON.parse(items[1]!.payload) as { points: unknown[] };
    expect(first.points).toHaveLength(MAX_POINTS_PER_BATCH);
    expect(second.points).toHaveLength(5);
  });
});
