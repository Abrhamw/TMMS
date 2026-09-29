import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDateTime, fmtDate } from '../api';
import { ErrorNote, Loading, Page, Pill, SearchField } from '../components';
import Comments from '../components/Comments';
import { t } from '../i18n';
import { can, getStoredUser } from '../auth';
import { ReportView } from './Reports';

// Folders, in the order they appear. The first five are real directed mail
// (authored messages); the remainder are the read-time task/report activity
// stream.
const FOLDERS = [
  { key: 'mailinbox', labelKey: 'mailboxInbox', mail: true },
  { key: 'outbox', labelKey: 'mailboxOutbox', mail: true },
  { key: 'mailsent', labelKey: 'mailboxSent', mail: true },
  { key: 'drafts', labelKey: 'mailboxDrafts', mail: true },
  { key: 'archive', labelKey: 'mailboxArchive', mail: true },
  { key: 'messages', labelKey: 'mailboxAll' },
  { key: 'unread', labelKey: 'mailboxUnread' },
  { key: 'reports', labelKey: 'mailboxReports' },
  { key: 'tasks', labelKey: 'mailboxTaskInbox' },
  { key: 'history', labelKey: 'mailboxHistory' },
];

const MAIL_FOLDERS = new Set(FOLDERS.filter((f) => f.mail).map((f) => f.key));

function folderRows(data, folder) {
  if (!data) return [];
  switch (folder) {
    case 'mailinbox': return data.mail_inbox || [];
    case 'outbox': return data.mail_outbox || [];
    case 'mailsent': return data.mail_sent || [];
    case 'drafts': return data.mail_drafts || [];
    case 'archive': return data.mail_archive || [];
    case 'unread': return [
      ...(data.unread_messages || []),
      ...(data.mail_inbox || []).filter((m) => m.unread),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    case 'reports': return (data.messages || []).filter((m) => m.kind === 'REPORT');
    case 'messages': return data.messages || [];
    case 'tasks': return data.inbox || [];
    case 'history': return data.history || [];
    default: return data[folder] || [];
  }
}

function folderCount(data, folder) {
  if (!data) return 0;
  if (folder === 'unread') return data.unread_count || 0;
  if (folder === 'messages') return data.message_count || 0;
  if (folder === 'reports') return data.report_count || 0;
  return folderRows(data, folder).length;
}

function isMessageFolder(folder) {
  return MAIL_FOLDERS.has(folder) || folder === 'unread' || folder === 'messages' || folder === 'reports';
}

function findMessage(data, key) {
  if (!data || !key) return null;
  const pools = [
    data.messages, data.unread_messages, data.mail_inbox, data.mail_outbox,
    data.mail_sent, data.mail_drafts, data.mail_archive,
  ];
  for (const pool of pools) {
    const hit = (pool || []).find((item) => item.key === key);
    if (hit) return hit;
  }
  return null;
}

function tagLabel(tag) {
  return String(tag || '').replace(/_/g, ' ');
}

function TagChips({ tags }) {
  const list = (tags || []).slice(0, 4);
  if (!list.length) return null;
  return <span className="mail-tags">{list.map((tag) => <span key={tag} className="mail-tag">{tagLabel(tag)}</span>)}</span>;
}

export default function Mailbox() {
  const nav = useNavigate();
  const me = getStoredUser();
  // The Reports folder is only meaningful to roles that can read reports;
  // field crews (no `report:read`) see task messages only.
  const folders = FOLDERS.filter((item) => item.key !== 'reports' || can(me, 'report:read'));
  const [data, setData] = useState(null);
  const [folder, setFolder] = useState('mailinbox');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessageKey, setSelectedMessageKey] = useState(null);
  const [thread, setThread] = useState(null);
  const [mailMessage, setMailMessage] = useState(null);
  const [reportDocument, setReportDocument] = useState(null);
  const [compose, setCompose] = useState(null);
  const [query, setQuery] = useState('');
  const [listLimit, setListLimit] = useState(60);
  const [error, setError] = useState(null);
  const [loadingThread, setLoadingThread] = useState(false);

  async function load() {
    try {
      const result = await api.get('/mailbox');
      setData(result);
      const rows = folderRows(result, folder);
      if (!selectedId && !selectedMessageKey && rows.length) {
        if (isMessageFolder(folder)) setSelectedMessageKey(rows[0].key);
        else setSelectedId(rows[0].id);
      }
    } catch (e) { setError(e.message); }
  }

  useEffect(() => { load(); }, []);

  // Keep the rendered list bounded: with hundreds of messages, painting every
  // row at once makes the pane sluggish. Reset to the first page whenever the
  // folder or search term changes.
  useEffect(() => { setListLimit(60); }, [folder, query]);

  // Live inbox: refresh on an interval and whenever the tab regains focus, so
  // counts, unread badges and new task/report messages appear without a manual
  // reload while staying gentle on the API.
  useEffect(() => {
    const id = setInterval(() => { load(); }, 30000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, selectedId, selectedMessageKey]);

  useEffect(() => {
    setError(null);
    if (selectedMessageKey) {
      const message = findMessage(data, selectedMessageKey);
      if (!message) return;
      let alive = true;
      setLoadingThread(true);
      if (message.kind === 'MAIL') {
        setThread(null);
        setReportDocument(null);
        setMailMessage(message);
        setLoadingThread(false);
        if (message.unread) {
          api.put(`/mailbox/messages/${message.id}/read`, {}).then(() => {
            if (alive) setData((current) => markMailRead(current, message.id));
          }).catch(() => {});
        }
        return () => { alive = false; };
      }
      setMailMessage(null);
      api.put(`/mailbox/message/${encodeURIComponent(selectedMessageKey)}/read`, {}).then(() => {
        if (!alive) return;
        setData((current) => current ? {
          ...current,
          unread_count: Math.max(0, current.unread_count - (message.unread ? 1 : 0)),
          unread_messages: current.unread_messages.filter((item) => item.key !== selectedMessageKey),
          messages: current.messages.map((item) => item.key === selectedMessageKey ? { ...item, unread: false } : item),
          inbox: current.inbox.map((item) => item.id === message.task_id ? { ...item, unread_count: Math.max(0, item.unread_count - (message.unread ? 1 : 0)), unread: item.unread_count > 1 } : item),
          sent: current.sent.map((item) => item.id === message.task_id ? { ...item, unread_count: Math.max(0, item.unread_count - (message.unread ? 1 : 0)), unread: item.unread_count > 1 } : item),
          history: current.history.map((item) => item.id === message.task_id ? { ...item, unread_count: Math.max(0, item.unread_count - (message.unread ? 1 : 0)), unread: item.unread_count > 1 } : item),
        } : current);
      }).catch(() => {});
      if (message.kind === 'REPORT') {
        setThread(null);
        api.get(`/reports/${message.report_id}`).then((report) => {
          if (alive) { setReportDocument(report); setError(null); }
        }).catch((e) => { if (alive) setError(e.message); })
          .finally(() => { if (alive) setLoadingThread(false); });
      } else {
        setReportDocument(null);
        api.get(`/mailbox/${message.task_id}`).then((result) => {
          if (alive) { setThread(result); setError(null); }
        }).catch((e) => { if (alive) setError(e.message); })
          .finally(() => { if (alive) setLoadingThread(false); });
      }
      return () => { alive = false; };
    }
    if (!selectedId) { setThread(null); setReportDocument(null); setMailMessage(null); return; }
    let alive = true;
    setLoadingThread(true);
    api.put(`/mailbox/${selectedId}/read`, {}).then(() => {
      setData((current) => current ? Object.fromEntries(Object.entries(current).map(([key, rows]) => [
        key,
        Array.isArray(rows) ? rows.map((item) => item.id === selectedId ? { ...item, unread: false } : item) : rows,
      ])) : current);
    }).catch(() => {});
    api.get(`/mailbox/${selectedId}`).then((result) => {
      if (alive) { setThread(result); setError(null); }
    }).catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoadingThread(false); });
    return () => { alive = false; };
  }, [selectedId, selectedMessageKey]);

  const sourceRows = folderRows(data, folder);
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? sourceRows.filter((item) => {
      const text = [
        item.task_number, item.title, item.subject, item.body, item.report_code,
        item.actor, item.recipient, item.category, item.line_name, item.crew_name, item.status,
        (item.tags || []).join(' '), item.latest?.summary,
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(needle);
    })
    : sourceRows;
  const visibleRows = rows.slice(0, listLimit);

  function selectFolder(key) {
    setFolder(key);
    setCompose(null);
    const nextRows = folderRows(data, key);
    if (isMessageFolder(key)) { setSelectedId(null); setSelectedMessageKey(nextRows?.[0]?.key || null); }
    else { setSelectedMessageKey(null); setSelectedId(nextRows?.[0]?.id || null); }
  }

  async function withReload(fn, notice) {
    try {
      await fn();
      await load();
    } catch (e) { setError(e.message); }
  }

  function startCompose(initial) {
    setCompose(initial || {});
    setSelectedId(null);
    setSelectedMessageKey(null);
    setThread(null);
    setMailMessage(null);
    setReportDocument(null);
  }

  return (
    <Page title={t('mailboxTitle')} crumbs="TMMS / Operations / Mailbox" fill>
      {error && <ErrorNote error={error} />}
      {!data ? <Loading /> : (
        <div className="mailbox-layout">
          <aside className="mailbox-list">
            <button type="button" className="btn btn-primary mailbox-compose-btn" onClick={() => startCompose()}>
              {t('mailboxCompose')}
            </button>
            <div className="mailbox-unread-total"><b>{data.unread_count || 0}</b> {t('mailboxUnreadTotal')}</div>
            <div className="mailbox-folders" role="tablist" aria-label="Mailbox folders">
              {folders.map((item) => (
                <button key={item.key} className={'mail-folder' + (folder === item.key && !compose ? ' active' : '')}
                  role="tab" aria-selected={folder === item.key && !compose}
                  onClick={() => selectFolder(item.key)}>
                  <span>{t(item.labelKey)}</span>
                  {item.key === 'mailinbox' && data.mail_unread_count > 0
                    ? <b className="mail-folder-unread">{data.mail_unread_count}</b>
                    : <b>{folderCount(data, item.key)}</b>}
                </button>
              ))}
            </div>
            <SearchField value={query} onChange={setQuery} placeholder={t('mailboxSearch')} />
            <div className="mail-thread-list">
              {visibleRows.map((item) => isMessageFolder(folder) ? (
                <button key={item.key} className={'mail-thread' + (selectedMessageKey === item.key && !compose ? ' active' : '')}
                  onClick={() => { setCompose(null); setSelectedId(null); setSelectedMessageKey(item.key); }}>
                  <div className="spread">
                    <b>{item.kind === 'MAIL' ? (item.outgoing ? `${t('mailboxTo')}: ${item.recipient}` : item.actor) : item.kind === 'REPORT' ? item.report_code : item.task_number}</b>
                    <span className="mail-kind">{item.kind === 'MAIL' ? tagLabel(item.category) : item.kind === 'REPORT' ? t('mailboxKindReport') : item.kind === 'COMMENT' ? t('mailboxKindMessage') : t('mailboxKindUpdate')}</span>
                  </div>
                  {item.unread && <span className="mail-unread">{t('mailboxUnreadOne')}</span>}
                  <div className="mail-thread-title">{item.subject}</div>
                  <div className="muted mail-thread-meta">{item.kind === 'MAIL' ? `${item.actor} · ${fmtDate(item.at)}` : `${item.actor} · ${fmtDate(item.at)}`}</div>
                  <TagChips tags={item.tags} />
                  <div className="mail-thread-last"><span>{item.body}</span></div>
                </button>
              ) : (
                <button key={item.id} className={'mail-thread' + (selectedId === item.id && !compose ? ' active' : '')}
                  onClick={() => { setCompose(null); setSelectedMessageKey(null); setSelectedId(item.id); }}>
                  <div className="spread"><b>{item.task_number}</b><Pill value={item.status} /></div>
                  {item.unread_count > 0 && <span className="mail-unread">{item.unread_count} {t('mailboxUnreadMany')}</span>}
                  <div className="mail-thread-title">{item.title}</div>
                  <div className="muted mail-thread-meta">{item.line_name || item.crew_name || 'Task'} · {fmtDate(item.due_date)}</div>
                  <TagChips tags={item.tags} />
                  <div className="mail-thread-last"><b>{item.latest?.actor || 'System'}</b><span>{item.latest?.summary}</span></div>
                </button>
              ))}
              {!rows.length && <div className="empty mailbox-empty">{t('mailboxEmptyFolder')}</div>}
              {rows.length > visibleRows.length && (
                <button type="button" className="btn btn-sm mail-more" onClick={() => setListLimit((n) => n + 60)}>
                  {t('mailboxShowMore')} ({rows.length - visibleRows.length} {t('mailboxRemaining')})
                </button>
              )}
            </div>
          </aside>
          <section className="mailbox-reader">
            {compose ? (
              <MailCompose
                initial={compose}
                me={me}
                onCancel={() => setCompose(null)}
                onSaved={async () => { setCompose(null); await load(); }}
              />
            ) : loadingThread ? <Loading /> : mailMessage ? (
              <MailReader
                message={mailMessage}
                me={me}
                onReply={() => startCompose({
                  recipient_person_id: mailMessage.outgoing ? mailMessage.recipient_person_id : mailMessage.sender_person_id,
                  recipient_name: mailMessage.outgoing ? mailMessage.recipient : mailMessage.actor,
                  subject: /^re:/i.test(mailMessage.subject) ? mailMessage.subject : `Re: ${mailMessage.subject}`,
                  category: mailMessage.category,
                  thread_id: mailMessage.id,
                })}
                onEdit={() => startCompose({
                  editId: mailMessage.id,
                  recipient_person_id: mailMessage.recipient_person_id,
                  recipient_name: mailMessage.recipient,
                  subject: mailMessage.subject,
                  body: mailMessage.body,
                  category: mailMessage.category,
                  priority: mailMessage.priority,
                })}
                onSend={() => withReload(() => api.post(`/mailbox/messages/${mailMessage.id}/send`, {}))}
                onArchive={() => withReload(() => api.put(`/mailbox/messages/${mailMessage.id}/archive`, {}))}
                onUnarchive={() => withReload(() => api.put(`/mailbox/messages/${mailMessage.id}/unarchive`, {}))}
                onOpenLink={() => { if (mailMessage.link) nav(mailMessage.link); }}
              />
            ) : reportDocument ? (
              <ReportReader report={reportDocument} onOpen={() => nav(`/reports?report=${reportDocument.id}`)} />
            ) : thread ? (
              <>
                <header className="mail-reader-head">
                  <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <div><div className="mono muted">{thread.task.task_number}</div><h2>{thread.task.title}</h2></div>
                    <div className="mail-reader-actions">
                      <button type="button" className="btn btn-sm" onClick={() => nav(thread.task.link || `/tasks/${thread.task.id}`)}>{t('mailboxOpenTask')}</button>
                      <Pill value={thread.task.status} />
                    </div>
                  </div>
                  <div className="mail-task-meta">
                    <span>{thread.task.line_name || 'No line linked'}</span>
                    <span>{thread.task.crew_name || 'Unassigned'}</span>
                    <span>Due {fmtDateTime(thread.task.due_date)}</span>
                    <TagChips tags={thread.task.tags} />
                  </div>
                </header>
                <div className="mail-timeline">
                  {thread.timeline.map((entry) => (
                    <article key={entry.id} className={`mail-message ${entry.kind === 'WORKFLOW' ? 'workflow' : ''}`}>
                      <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <b>{entry.actor || 'System'}</b><span className="muted">{fmtDateTime(entry.at)}</span>
                      </div>
                      {entry.kind === 'WORKFLOW' ? <div className="muted mt">{entry.body}</div> : <p>{entry.body}</p>}
                    </article>
                  ))}
                  {!thread.timeline.length && <div className="empty">{t('mailboxNoActivity')}</div>}
                </div>
                <div className="mail-compose"><Comments entityType="task" entityId={thread.task.id} /></div>
              </>
            ) : <div className="empty">{t('mailboxSelect')}</div>}
          </section>
        </div>
      )}
    </Page>
  );
}

function markMailRead(data, id) {
  if (!data) return data;
  const wasUnread = (data.mail_inbox || []).some((m) => m.id === id && m.unread);
  const patch = (rows) => (rows || []).map((m) => m.id === id ? { ...m, unread: false } : m);
  return {
    ...data,
    mail_inbox: patch(data.mail_inbox),
    mail_archive: patch(data.mail_archive),
    messages: patch(data.messages),
    unread_messages: (data.unread_messages || []).filter((m) => m.id !== id),
    unread_count: Math.max(0, (data.unread_count || 0) - (wasUnread ? 1 : 0)),
    mail_unread_count: Math.max(0, (data.mail_unread_count || 0) - (wasUnread ? 1 : 0)),
    mail_counts: data.mail_counts ? { ...data.mail_counts, unread: Math.max(0, (data.mail_counts.unread || 0) - (wasUnread ? 1 : 0)) } : data.mail_counts,
  };
}

function MailReader({ message, me, onReply, onEdit, onSend, onArchive, onUnarchive, onOpenLink }) {
  const isDraft = message.status === 'DRAFT' || message.status === 'QUEUED';
  const mineIsSender = message.sender_person_id === me.person_id;
  return (
    <>
      <header className="mail-reader-head">
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div>
            <div className="mono muted">{message.category} · {message.status}</div>
            <h2>{message.subject}</h2>
          </div>
          <div className="mail-reader-actions">
            {isDraft && mineIsSender && <button type="button" className="btn btn-sm" onClick={onEdit}>{t('mailboxEditDraft')}</button>}
            {isDraft && mineIsSender && <button type="button" className="btn btn-sm btn-primary" onClick={onSend}>{t('mailboxSend')}</button>}
            {!isDraft && <button type="button" className="btn btn-sm" onClick={onReply}>{t('mailboxReply')}</button>}
            {message.link && <button type="button" className="btn btn-sm" onClick={onOpenLink}>{t('mailboxOpenLink')}</button>}
            {message.archived
              ? <button type="button" className="btn btn-sm" onClick={onUnarchive}>{t('mailboxUnarchiveAction')}</button>
              : <button type="button" className="btn btn-sm" onClick={onArchive}>{t('mailboxArchiveAction')}</button>}
          </div>
        </div>
        <div className="mail-task-meta">
          <span>{t('mailboxFrom')}: {message.actor}</span>
          <span>{t('mailboxTo')}: {message.recipient}</span>
          {message.sent_at && <span>{t('mailboxSentAt')} {fmtDateTime(message.sent_at)}</span>}
          <TagChips tags={message.tags} />
        </div>
      </header>
      <div className="mail-message"><p style={{ whiteSpace: 'pre-wrap' }}>{message.body}</p></div>
    </>
  );
}

function MailCompose({ initial, me, onCancel, onSaved }) {
  const [recipients, setRecipients] = useState([]);
  const [recipient, setRecipient] = useState(initial?.recipient_person_id || '');
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState(initial?.subject || '');
  const [body, setBody] = useState(initial?.body || '');
  const [category, setCategory] = useState(initial?.category || 'GENERAL');
  const [priority, setPriority] = useState(initial?.priority || 'NORMAL');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get('/mailbox/recipients').then((list) => setRecipients(list || [])).catch((e) => setErr(e.message));
  }, []);

  const stored = recipients.find((r) => r.person_id === Number(recipient));
  // A reply pre-fills the original sender, who may sit outside the addressable
  // list; fall back to the name carried on the draft so the chip still renders.
  const selected = stored || (initial?.recipient_person_id && initial?.recipient_name
    ? { person_id: Number(initial.recipient_person_id), name: initial.recipient_name, role: '' }
    : null);
  const filtered = (query.trim()
    ? recipients.filter((r) => `${r.name} ${r.username} ${r.role}`.toLowerCase().includes(query.trim().toLowerCase()))
    : recipients
  ).slice(0, 40);

  async function save(status) {
    setErr(null);
    if (!Number(recipient)) { setErr(t('mailboxRecipientRequired')); return; }
    if (status === 'SENT' && !subject.trim()) { setErr(t('mailboxSubjectRequired')); return; }
    if (!subject.trim() && !body.trim()) { setErr(t('mailboxBodyRequired')); return; }
    setBusy(true);
    try {
      const payload = {
        recipient_person_id: Number(recipient),
        subject: subject.trim(),
        body: body.trim(),
        category,
        priority,
        status,
        thread_id: initial?.thread_id || null,
      };
      if (initial?.editId) {
        await api.put(`/mailbox/messages/${initial.editId}`, payload);
        if (status === 'SENT') await api.post(`/mailbox/messages/${initial.editId}/send`, {});
      } else {
        await api.post('/mailbox/messages', payload);
      }
      await onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <header className="mail-reader-head">
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h2>{initial?.editId ? t('mailboxEditDraft') : t('mailboxCompose')}</h2>
          <button type="button" className="btn btn-sm" onClick={onCancel}>{t('cancel')}</button>
        </div>
      </header>
      {err && <ErrorNote error={err} />}
      <div className="form-grid" style={{ padding: '0 4px' }}>
        <div className="field full">
          <label>{t('mailboxTo')}</label>
          {selected ? (
            <>
              <div className="spread" style={{ alignItems: 'center', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                <span><b>{selected.name}</b>{selected.role ? <span className="muted"> · {selected.role}</span> : null}</span>
                <button type="button" className="btn btn-sm" title={t('mailboxChangeRecipient')} onClick={() => setRecipient('')}>{'×'}</button>
              </div>
              {initial?.recipient_name && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t('mailboxReplyRecipientHint')}</div>
              )}
            </>
          ) : (
            <>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('mailboxRecipientPlaceholder')} />
              <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 6 }}>
                {filtered.map((r) => (
                  <button key={r.person_id} type="button" className="mail-recipient"
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', background: 'none', border: 0, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => { setRecipient(r.person_id); setQuery(''); }}>
                    <b>{r.name}</b> <span className="muted">· {r.role}{r.title ? ` · ${r.title}` : ''}</span>
                  </button>
                ))}
                {!filtered.length && <div className="muted" style={{ padding: 10 }}>{t('mailboxNoRecipients')}</div>}
              </div>
            </>
          )}
        </div>
        <div className="field full"><label>{t('mailboxSubject')}</label><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="field"><label>{t('mailboxCategory')}</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="GENERAL">GENERAL</option>
            <option value="REPORT">REPORT</option>
            <option value="EXECUTION">EXECUTION</option>
            <option value="REQUEST">REQUEST</option>
            <option value="ALERT">ALERT</option>
          </select>
        </div>
        <div className="field"><label>{t('mailboxPriority')}</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="LOW">LOW</option>
            <option value="NORMAL">NORMAL</option>
            <option value="HIGH">HIGH</option>
            <option value="URGENT">URGENT</option>
          </select>
        </div>
        <div className="field full"><label>{t('mailboxMessage')}</label><textarea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 140 }} /></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 4px' }}>
        <button type="button" className="btn" disabled={busy} onClick={() => save('DRAFT')}>{t('mailboxSaveDraft')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => save('QUEUED')}>{t('mailboxQueue')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save('SENT')}>{t('mailboxSend')}</button>
      </div>
    </>
  );
}

function ReportReader({ report, onOpen }) {
  return (
    <>
      <header className="mail-reader-head">
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div><div className="mono muted">{report.report_code}</div><h2>{report.title}</h2></div>
          <div className="mail-reader-actions">
            {onOpen && <button type="button" className="btn btn-sm" onClick={onOpen}>{t('mailboxOpenReport')}</button>}
            <span className="mail-kind">{String(report.report_type || 'REPORT').replace(/_/g, ' ')}</span>
          </div>
        </div>
        <div className="mail-task-meta"><span>Generated {fmtDateTime(report.generated_at)}</span><span>Period {fmtDate(report.period_start)} – {fmtDate(report.period_end)}</span></div>
      </header>
      <div className="mail-report-body">
        <ReportView data={report.data} />
      </div>
    </>
  );
}
