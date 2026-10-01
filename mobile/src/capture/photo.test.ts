import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import type { SqlDriver } from '../db/driver';
import { listOutbox } from '../db/outbox';
import { migrate } from '../db/schema';
import { mimeForName, queueAttachment } from './photo';

vi.mock('expo-file-system', () => {
  class Directory {
    uri = 'file:///documents/attachments';
    exists = true;
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((part) => String(part)).join('/');
    }
    async copy() {}
  }
  return { Directory, File, Paths: { document: { uri: 'file:///documents' } } };
});

describe('photo capture', () => {
  let driver: SqlDriver;

  beforeEach(async () => {
    driver = createNodeDriver();
    await migrate(driver);
  });

  it('maps file extensions to mime types', () => {
    expect(mimeForName('A.JPG')).toBe('image/jpeg');
    expect(mimeForName('shot.png')).toBe('image/png');
    expect(mimeForName('scan.pdf')).toBe('application/pdf');
  });

  it('records a pending attachment and queues an upload', async () => {
    const localId = await queueAttachment(driver, {
      taskId: 1,
      sourceUri: 'file:///tmp/shot.jpg',
      gps: { lat: 9.1, lng: 38.7, accuracy_m: 6 },
    });

    const attachment = await driver.first<{
      local_id: string;
      task_id: number;
      remote_id: number | null;
      status: string;
      file_uri: string;
    }>('SELECT * FROM attachment WHERE local_id = ?', [localId]);

    expect(attachment?.status).toBe('pending');
    expect(attachment?.remote_id).toBeNull();
    expect(attachment?.task_id).toBe(1);

    const items = await listOutbox(driver, ['pending']);
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('attachment');
    const payload = JSON.parse(items[0]!.payload) as Record<string, unknown>;
    expect(payload.local_id).toBe(localId);
    expect(payload.file_uri).toBe(attachment?.file_uri);
    expect(payload.lat).toBe(9.1);
  });
});
