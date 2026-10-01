import type { ApiClient } from '../api/client';
import type { SqlDriver } from '../db/driver';
import type { OutboxItem } from '../db/outbox';

export interface AttachmentPayload {
  task_id: number;
  local_id?: string;
  file_uri: string;
  file_name: string;
  mime?: string;
  kind?: string;
  checklist_item_id?: number | null;
  lat?: number | null;
  lng?: number | null;
  accuracy_m?: number | null;
  captured_at?: string;
  note?: string | null;
}

interface UploadedAttachment {
  id: number;
}

export async function sendAttachment(
  driver: SqlDriver,
  client: ApiClient,
  item: OutboxItem,
): Promise<void> {
  const payload = JSON.parse(item.payload) as AttachmentPayload;
  const { File } = await import('expo-file-system');
  const file = new File(payload.file_uri);
  const data = await file.base64();
  const uploaded = await client.post<UploadedAttachment>(`/tasks/${payload.task_id}/attachments`, {
    data,
    file_name: payload.file_name,
    mime: payload.mime ?? 'image/jpeg',
    kind: payload.kind ?? 'PHOTO',
    checklist_item_id: payload.checklist_item_id ?? null,
    lat: payload.lat ?? null,
    lng: payload.lng ?? null,
    accuracy_m: payload.accuracy_m ?? null,
    captured_at: payload.captured_at,
    note: payload.note ?? null,
    client_ref: item.client_ref,
  });
  if (payload.local_id) {
    await driver.run(
      "UPDATE attachment SET remote_id = ?, status = 'uploaded' WHERE local_id = ?",
      [uploaded.id, payload.local_id],
    );
  }
}
