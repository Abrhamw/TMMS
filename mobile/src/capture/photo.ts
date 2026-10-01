import { Directory, File, Paths } from 'expo-file-system';
import type { SqlDriver } from '../db/driver';
import { enqueue } from '../db/outbox';

export interface StoredPhoto {
  localId: string;
  uri: string;
  name: string;
}

export interface QueueAttachmentInput {
  taskId: number;
  sourceUri: string;
  findingId?: number | null;
  checklistItemId?: number | null;
  kind?: 'PHOTO' | 'DOC' | 'OTHER';
  note?: string | null;
  gps?: { lat: number; lng: number; accuracy_m: number | null } | null;
}

function newLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function attachmentsDir(): Directory {
  return new Directory(Paths.document, 'attachments');
}

export function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'image/jpeg';
}

export async function storePhoto(sourceUri: string): Promise<StoredPhoto> {
  const dir = attachmentsDir();
  dir.create({ intermediates: true, idempotent: true });
  const localId = newLocalId();
  const name = `${localId}.jpg`;
  const destination = new File(dir, name);
  await new File(sourceUri).copy(destination);
  return { localId, uri: destination.uri, name };
}

export async function queueAttachment(
  driver: SqlDriver,
  input: QueueAttachmentInput,
): Promise<string> {
  const stored = await storePhoto(input.sourceUri);
  const capturedAt = new Date().toISOString();
  await driver.run(
    `INSERT INTO attachment (local_id, task_id, finding_id, file_uri, remote_id, status, created_at)
     VALUES (?, ?, ?, ?, NULL, 'pending', ?)`,
    [stored.localId, input.taskId, input.findingId ?? null, stored.uri, capturedAt],
  );
  await enqueue(driver, {
    type: 'attachment',
    entity: `task:${input.taskId}`,
    payload: {
      task_id: input.taskId,
      local_id: stored.localId,
      file_uri: stored.uri,
      file_name: stored.name,
      mime: mimeForName(stored.name),
      kind: input.kind ?? 'PHOTO',
      checklist_item_id: input.checklistItemId ?? null,
      lat: input.gps?.lat ?? null,
      lng: input.gps?.lng ?? null,
      accuracy_m: input.gps?.accuracy_m ?? null,
      captured_at: capturedAt,
      note: input.note ?? null,
    },
  });
  return stored.localId;
}
