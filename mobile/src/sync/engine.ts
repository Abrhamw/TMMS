import { ApiError, type ApiClient } from '../api/client';
import type { SqlDriver } from '../db/driver';
import {
  listOutbox,
  markDone,
  markFailed,
  markInflight,
  pendingCount,
  requeue,
  MAX_OUTBOX_ATTEMPTS,
  type OutboxItem,
} from '../db/outbox';
import { sendAttachment } from './attachments';

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: number;
  aborted: boolean;
}

export type FlushEvent =
  | { kind: 'sent'; item: OutboxItem }
  | { kind: 'failed'; item: OutboxItem; error: string }
  | { kind: 'deferred'; item: OutboxItem; error: string }
  | { kind: 'aborted' };

export interface FlushDeps {
  driver: SqlDriver;
  client: ApiClient;
  onEvent?: (event: FlushEvent) => void;
  sendAttachmentImpl?: typeof sendAttachment;
  maxAttempts?: number;
}

const PERMANENT_STATUS = new Set([400, 403, 404, 409, 410, 413, 415, 422]);

function isPermanent(error: unknown): boolean {
  return error instanceof ApiError && PERMANENT_STATUS.has(error.status);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'send failed';
}

async function sendItem(deps: FlushDeps, item: OutboxItem): Promise<void> {
  const { client } = deps;
  const payload = JSON.parse(item.payload) as Record<string, unknown>;
  switch (item.type) {
    case 'checklist_draft': {
      const taskId = Number(payload.task_id);
      await client.post(`/tasks/${taskId}/checklist/draft`, payload);
      return;
    }
    case 'checklist_submit': {
      const taskId = Number(payload.task_id);
      await client.post(`/tasks/${taskId}/checklist`, { ...payload, client_ref: item.client_ref });
      return;
    }
    case 'finding': {
      const taskId = Number(payload.task_id);
      await client.post(`/tasks/${taskId}/findings`, { ...payload, client_ref: item.client_ref });
      return;
    }
    case 'comment':
      await client.post('/comments', { ...payload, client_ref: item.client_ref });
      return;
    case 'gps':
      await client.post('/gps-validations/bulk', {
        records: [{ ...payload, client_ref: item.client_ref }],
      });
      return;
    case 'mail':
      await client.post('/mailbox/messages', { ...payload, client_ref: item.client_ref });
      return;
    case 'trace': {
      const taskId = Number(payload.task_id);
      await client.post(`/tasks/${taskId}/trace`, {
        points: payload.points,
        crew_id: payload.crew_id ?? undefined,
      });
      return;
    }
    case 'task_state': {
      const taskId = Number(payload.task_id);
      await client.post(`/tasks/${taskId}/state`, payload);
      return;
    }
    case 'attachment':
      await (deps.sendAttachmentImpl ?? sendAttachment)(deps.driver, client, item);
      return;
    default:
      throw new ApiError(`Unknown outbox type: ${String(item.type)}`, 400);
  }
}

export async function flush(deps: FlushDeps): Promise<FlushResult> {
  const items = await listOutbox(deps.driver, ['pending', 'inflight']);
  const maxAttempts = deps.maxAttempts ?? MAX_OUTBOX_ATTEMPTS;
  const blocked = new Set<string>();
  let sent = 0;
  let failed = 0;
  let aborted = false;

  for (const item of items) {
    const key = item.entity ?? `#${item.id}`;
    if (blocked.has(key)) continue;
    await markInflight(deps.driver, item.id);
    try {
      await sendItem(deps, item);
      await markDone(deps.driver, item.id);
      sent += 1;
      deps.onEvent?.({ kind: 'sent', item });
    } catch (error) {
      const message = errorText(error);
      if (error instanceof ApiError && error.status === 401) {
        aborted = true;
        deps.onEvent?.({ kind: 'aborted' });
        break;
      }
      if (isPermanent(error) || item.attempts + 1 >= maxAttempts) {
        const reason = isPermanent(error) ? message : `Retry limit reached: ${message}`;
        await markFailed(deps.driver, item.id, reason);
        failed += 1;
        deps.onEvent?.({ kind: 'failed', item, error: reason });
      } else {
        await requeue(deps.driver, item.id, message);
        blocked.add(key);
        deps.onEvent?.({ kind: 'deferred', item, error: message });
      }
    }
  }

  const remaining = await pendingCount(deps.driver);
  return { sent, failed, remaining, aborted };
}
