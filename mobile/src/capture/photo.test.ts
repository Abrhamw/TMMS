import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeDriver } from '../test/nodeDriver';
import type { SqlDriver } from '../db/driver';
import { listOutbox } from '../db/outbox';
import { migrate } from '../db/schema';
import { mimeForName, extensionForUri, queueAttachment } from './photo';

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
    expect(mimeForName('scan.webp')).toBe('image/webp');
    expect(mimeForName('scan.pdf')).toBe('application/pdf');
  });

  it('derives a container extension from the source uri', () => {
    expect(extensionForUri('file:///tmp/IMG_0001.PNG')).toBe('png');
    expect(extensionForUri('file:///tmp/photo.jpeg?width=100')).toBe('jpeg');
    expect(extensionForUri('file:///tmp/no-extension')).toBe('jpg');
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

  it('preserves the source extension and reports an accurate mime', async () => {
    const localId = await queueAttachment(driver, { taskId: 7, sourceUri: 'file:///tmp/IMG_0001.PNG' });
    const attachment = await driver.first<{ file_uri: string }>('SELECT * FROM attachment WHERE local_id = ?', [localId]);
    expect(attachment?.file_uri).toMatch(/\.png$/);
    const items = await listOutbox(driver, ['pending']);
    const payload = JSON.parse(items[0]!.payload) as Record<string, unknown>;
    expect(payload.mime).toBe('image/png');
    expect(String(payload.file_name)).toMatch(/\.png$/);
  });

  it('keys each attachment to its own outbox entity', async () => {
    await queueAttachment(driver, { taskId: 7, sourceUri: 'file:///tmp/a.jpg' });
    await queueAttachment(driver, { taskId: 7, sourceUri: 'file:///tmp/b.jpg' });
    const items = await listOutbox(driver, ['pending']);
    expect(new Set(items.map((i) => i.entity)).size).toBe(2);
  });
});
