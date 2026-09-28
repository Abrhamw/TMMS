import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDateTime, fmtDate } from '../api';
import { ErrorNote, Loading, Page, Pill, SearchField } from '../components';
import Comments from '../components/Comments';
import { t } from '../i18n';
import { ReportView } from './Reports';

const FOLDERS = [
  { key: 'inbox', labelKey: 'mailboxInbox' },
  { key: 'messages', labelKey: 'mailboxAll' },
  { key: 'unread', labelKey: 'mailboxUnread' },
  { key: 'reports', labelKey: 'mailboxReports' },
  { key: 'sent', labelKey: 'mailboxSent' },
  { key: 'history', labelKey: 'mailboxHistory' },
];

function isMessageFolder(folder) {
  return folder === 'unread' || folder === 'messages' || folder === 'reports';
}

function folderRows(data, folder) {
  if (!data) return [];
  if (folder === 'unread') return data.unread_messages || [];
  if (folder === 'reports') return (data.messages || []).filter((m) => m.kind === 'REPORT');
  return data[folder] || [];
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
  const [data, setData] = useState(null);
  const [folder, setFolder] = useState('inbox');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessageKey, setSelectedMessageKey] = useState(null);
  const [thread, setThread] = useState(null);
  const [reportDocument, setReportDocument] = useState(null);
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
      const message = data?.messages?.find((item) => item.key === selectedMessageKey);
      if (!message) return;
      let alive = true;
      setLoadingThread(true);
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
    if (!selectedId) { setThread(null); setReportDocument(null); return; }
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
        item.actor, item.line_name, item.crew_name, item.status,
        (item.tags || []).join(' '), item.latest?.summary,
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(needle);
    })
    : sourceRows;
  const visibleRows = rows.slice(0, listLimit);

  return (
    <Page title={t('mailboxTitle')} crumbs="TMMS / Operations / Mailbox" fill>
      {error && <ErrorNote error={error} />}
      {!data ? <Loading /> : (
        <div className="mailbox-layout">
          <aside className="mailbox-list">
            <div className="mailbox-unread-total"><b>{data.unread_count || 0}</b> {t('mailboxUnreadTotal')}</div>
            <div className="mailbox-folders" role="tablist" aria-label="Mailbox folders">
              {FOLDERS.map((item) => (
                <button key={item.key} className={'mail-folder' + (folder === item.key ? ' active' : '')}
                  role="tab" aria-selected={folder === item.key}
                  onClick={() => {
                    setFolder(item.key);
                    const nextRows = folderRows(data, item.key);
                    if (isMessageFolder(item.key)) { setSelectedId(null); setSelectedMessageKey(nextRows?.[0]?.key || null); }
                    else { setSelectedMessageKey(null); setSelectedId(nextRows?.[0]?.id || null); }
                  }}>
                  <span>{t(item.labelKey)}</span><b>{item.key === 'unread' ? data.unread_count || 0 : item.key === 'messages' ? data.message_count || 0 : item.key === 'reports' ? data.report_count || 0 : data[item.key]?.length || 0}</b>
                </button>
              ))}
            </div>
            <SearchField value={query} onChange={setQuery} placeholder={t('mailboxSearch')} />
            <div className="mail-thread-list">
              {visibleRows.map((item) => isMessageFolder(folder) ? (
                <button key={item.key} className={'mail-thread' + (selectedMessageKey === item.key ? ' active' : '')} onClick={() => { setSelectedId(null); setSelectedMessageKey(item.key); }}>
                  <div className="spread"><b>{item.kind === 'REPORT' ? item.report_code : item.task_number}</b><span className="mail-kind">{item.kind === 'REPORT' ? t('mailboxKindReport') : item.kind === 'COMMENT' ? t('mailboxKindMessage') : t('mailboxKindUpdate')}</span></div>
                  {item.unread && <span className="mail-unread">{t('mailboxUnreadOne')}</span>}
                  <div className="mail-thread-title">{item.subject}</div>
                  <div className="muted mail-thread-meta">{item.actor} · {fmtDate(item.at)}</div>
                  <TagChips tags={item.tags} />
                  <div className="mail-thread-last"><span>{item.body}</span></div>
                </button>
              ) : (
                <button key={item.id} className={'mail-thread' + (selectedId === item.id ? ' active' : '')} onClick={() => { setSelectedMessageKey(null); setSelectedId(item.id); }}>
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
            {loadingThread ? <Loading /> : reportDocument ? (
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
