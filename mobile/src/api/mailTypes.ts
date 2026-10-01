export interface MailRecipient {
  person_id: number;
  name: string;
  role?: string | null;
  title?: string | null;
  username?: string | null;
}

export interface MailMessage {
  id: number;
  key?: string;
  subject?: string | null;
  body?: string | null;
  actor?: string | null;
  actor_key?: string | null;
  sender_person_id?: number | null;
  recipient?: string | null;
  at?: string | null;
  created_at?: string | null;
  sent_at?: string | null;
  unread?: boolean;
  status?: string | null;
  category?: string | null;
  priority?: string | null;
  outgoing?: boolean;
  action_required?: boolean;
  parent_id?: number | null;
  forward_of_id?: number | null;
  thread_id?: number | null;
  attachments?: unknown[];
  tags?: string[];
}

export interface MailFolderPage {
  folder: string;
  rows: MailMessage[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export const MAIL_FOLDERS = [
  { key: 'mailinbox', label: 'Inbox' },
  { key: 'mailsent', label: 'Sent' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'archive', label: 'Archive' },
] as const;
