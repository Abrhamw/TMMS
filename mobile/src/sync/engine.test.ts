import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import type { SqlDriver } from '../db/driver';
import { enqueue, listOutbox, type OutboxItem } from '../db/outbox';
import { migrate } from '../db/schema';
import { createNodeDriver } from '../test/nodeDriver';
import { flush, type FlushEvent } from './engine';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeClient(post: (path: string, body: unknown) => Promise<unknown>): {
  client: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: ApiClient = {
    baseUrl: 'https://tmms.example.com',
    get: async () => ({}),
    put: async () => ({}),
    patch: async () => ({}),
    del: async () => ({}),
    post: async (path, body) => {
      calls.push({ method: 'post', path, body });
      return post(path, body);
    },
  };
  return { client, calls };
}

describe('sync engine', () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createNodeDriver();
    await migrate(driver);
  });

  it('sends pending items in order and clears the outbox', async () => {
    await enqueue(driver, { type: 'comment', entity: 'task:1', payload: { entity_type: 'TASK', entity_id: 1, body: 'hi' } });
    await enqueue(driver, { type: 'finding', entity: 'task:1', payload: { task_id: 1, title: 'Cracked' } });
    const { client, calls } = fakeClient(async () => ({ id: 9 }));

    const result = await flush({ driver, client });

    expect(result).toEqual({ sent: 2, failed: 0, remaining: 0, aborted: false });
    expect(calls.map((c) => c.path)).toEqual(['/comments', '/tasks/1/findings']);
    expect(calls[1]?.body).toMatchObject({ title: 'Cracked', client_ref: expect.any(String) });
    expect(await listOutbox(driver, ['pending', 'inflight'])).toHaveLength(0);
  });

  it('marks a definitive 4xx failure and keeps flushing', async () => {
    await enqueue(driver, { type: 'finding', entity: 'task:1', payload: { task_id: 1, title: 'Bad' } });
    await enqueue(driver, { type: 'comment', entity: 'task:1', payload: { entity_type: 'TASK', entity_id: 1, body: 'ok' } });
    const events: FlushEvent[] = [];
    const { client } = fakeClient(async (path) => {
      if (path === '/tasks/1/findings') throw new ApiError('Finding title is required', 400);
      return { id: 1 };
    });

    const result = await flush({ driver, client, onEvent: (e) => events.push(e) });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(events.some((e) => e.kind === 'failed')).toBe(true);
    const failed = await listOutbox(driver, ['failed']);
    expect(failed[0]?.last_error).toContain('title is required');
  });

  it('requeues on a network error and stops sending the same entity', async () => {
    await enqueue(driver, { type: 'comment', entity: 'task:1', payload: { entity_type: 'TASK', entity_id: 1, body: 'a' } });
    await enqueue(driver, { type: 'comment', entity: 'task:1', payload: { entity_type: 'TASK', entity_id: 1, body: 'b' } });
    await enqueue(driver, { type: 'comment', entity: 'task:2', payload: { entity_type: 'TASK', entity_id: 2, body: 'c' } });
    let calls = 0;
    const { client } = fakeClient(async (path) => {
      calls += 1;
      if (calls === 1) throw new Error('Network request failed');
      return { id: 1 };
    });

    const result = await flush({ driver, client });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(2);
    expect(calls).toBe(2);
  });

  it('aborts the run when the session is rejected', async () => {
    await enqueue(driver, { type: 'comment', entity: 'task:1', payload: { entity_type: 'TASK', entity_id: 1, body: 'a' } });
    await enqueue(driver, { type: 'comment', entity: 'task:2', payload: { entity_type: 'TASK', entity_id: 2, body: 'b' } });
    const events: FlushEvent[] = [];
    const { client, calls } = fakeClient(async () => {
      throw new ApiError('Session expired', 401);
    });

    const result = await flush({ driver, client, onEvent: (e) => events.push(e) });

    expect(result.aborted).toBe(true);
    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: 'aborted' });
  });

  it('delegates attachment uploads to the injected sender', async () => {
    await enqueue(driver, {
      type: 'attachment',
      entity: 'task:1',
      payload: { task_id: 1, local_id: 'loc-1', file_uri: 'file:///p.jpg', file_name: 'p.jpg' },
    });
    const seen: OutboxItem[] = [];
    const { client } = fakeClient(async () => ({}));

    const result = await flush({
      driver,
      client,
      sendAttachmentImpl: async (_driver, _client, item) => {
        seen.push(item);
      },
    });

    expect(result.sent).toBe(1);
    expect(seen[0]?.client_ref).toBeTruthy();
  });
});
