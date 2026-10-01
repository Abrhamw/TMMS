import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import type { SqlDriver } from '../db/driver';
import { enqueue, listOutbox } from '../db/outbox';
import { listMessages, upsertMessages } from '../db/queries';
import { migrate } from '../db/schema';
import { flush } from '../sync/engine';
import type { ApiClient } from '../api/client';
import type { MailMessage } from '../api/mailTypes';

describe('mailbox cache', () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createNodeDriver();
    await migrate(driver);
  });

  it('caches folder rows and reads them back', async () => {
    const message: MailMessage = { id: 5, subject: 'Hello', actor: 'Ayalew' };
    await upsertMessages(driver, 'mailinbox', [message]);

    const rows = await listMessages<MailMessage>(driver, 'mailinbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe('Hello');
    expect(await listMessages(driver, 'mailsent')).toHaveLength(0);
  });

  it('sends a queued message once with its client_ref', async () => {
    await enqueue(driver, {
      type: 'mail',
      entity: 'mail:compose',
      payload: { to: [10], subject: 'Site report', body: 'All good', status: 'SENT' },
    });
    const post = vi.fn(async () => ({ id: 77 }));
    const client: ApiClient = {
      baseUrl: 'https://tmms.example.com',
      get: async () => ({}),
      put: async () => ({}),
      patch: async () => ({}),
      del: async () => ({}),
      post,
    };

    const first = await flush({ driver, client });
    expect(first.sent).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('/mailbox/messages');
    expect(post.mock.calls[0]?.[1]).toMatchObject({ subject: 'Site report', client_ref: expect.any(String) });

    const second = await flush({ driver, client });
    expect(second.sent).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await listOutbox(driver, ['pending'])).toHaveLength(0);
  });
});
