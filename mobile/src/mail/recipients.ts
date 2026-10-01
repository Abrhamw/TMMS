import type { ApiClient } from '../api/client';
import type { MailRecipient } from '../api/mailTypes';
import type { SqlDriver } from '../db/driver';
import { getSyncMeta, setSyncMeta } from '../db/queries';

export const RECIPIENTS_KEY = 'mail_recipients';

export async function pullRecipients(
  driver: SqlDriver,
  client: ApiClient,
): Promise<MailRecipient[]> {
  const list = await client.get<MailRecipient[]>('/mailbox/recipients');
  await setSyncMeta(driver, RECIPIENTS_KEY, JSON.stringify(list));
  return list;
}

export async function cachedRecipients(driver: SqlDriver): Promise<MailRecipient[]> {
  const raw = await getSyncMeta(driver, RECIPIENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MailRecipient[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
