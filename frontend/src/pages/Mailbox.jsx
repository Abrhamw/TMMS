import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtDate } from '../api';
import { ErrorNote, Loading, Page, Pill, SearchField } from '../components';
import Comments from '../components/Comments';
import DossierReport from '../components/DossierReport';

const FOLDERS = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'messages', label: 'All messages' },
  { key: 'unread', label: 'Unread messages' },
  { key: 'sent', label: 'Sent' },
  { key: 'history', label: 'History' },
];

export default function Mailbox() {
  const [data, setData] = useState(null);
  const [folder, setFolder] = useState('inbox');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedMessageKey, setSelectedMessageKey] = useState(null);
  const [thread, setThread] = useState(null);
  const [reportDocument, setReportDocument] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [loadingThread, setLoadingThread] = useState(false);

  async function load() {
    try {
      const result = await api.get('/mailbox');
      setData(result);
      const rows = folder === 'unread' ? result.unread_messages || [] : result[folder] || [];
      if (!selectedId && !selectedMessageKey && rows.length) {
        if (folder === 'unread' || folder === 'messages') setSelectedMessageKey(rows[0].key);
        else setSelectedId(rows[0].id);
      }
    } catch (e) { setError(e.message); }
  }

  useEffect(() => { load(); }, []);

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

  const sourceRows = folder === 'unread' ? data?.unread_messages || [] : data?.[folder] || [];
  const rows = sourceRows.filter((item) => {
    const text = `${item.task_number} ${item.title} ${item.line_name || ''} ${item.crew_name || ''} ${item.latest?.summary || ''}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  return (
    <Page title="Task Mailbox" crumbs="TMMS / Operations / Mailbox">
      {error && <ErrorNote error={error} />}
      {!data ? <Loading /> : (
        <div className="mailbox-layout">
          <aside className="mailbox-list">
            <div className="mailbox-unread-total"><b>{data.unread_count || 0}</b> unread message(s)</div>
            <div className="mailbox-folders" role="tablist" aria-label="Mailbox folders">
              {FOLDERS.map((item) => (
                <button key={item.key} className={'mail-folder' + (folder === item.key ? ' active' : '')}
                  role="tab" aria-selected={folder === item.key}
                  onClick={() => {
                    setFolder(item.key);
                    const nextRows = item.key === 'unread' ? data.unread_messages : data[item.key];
                    if (item.key === 'unread' || item.key === 'messages') { setSelectedId(null); setSelectedMessageKey(nextRows?.[0]?.key || null); }
                    else { setSelectedMessageKey(null); setSelectedId(nextRows?.[0]?.id || null); }
                  }}>
                  <span>{item.label}</span><b>{item.key === 'unread' ? data.unread_count || 0 : item.key === 'messages' ? data.message_count || 0 : data[item.key]?.length || 0}</b>
                </button>
              ))}
            </div>
            <SearchField value={query} onChange={setQuery} placeholder="Search tasks and messages" />
            <div className="mail-thread-list">
              {rows.map((item) => folder === 'unread' || folder === 'messages' ? (
                <button key={item.key} className={'mail-thread' + (selectedMessageKey === item.key ? ' active' : '')} onClick={() => { setSelectedId(null); setSelectedMessageKey(item.key); }}>
                  <div className="spread"><b>{item.kind === 'REPORT' ? item.report_code : item.task_number}</b><span className="mail-kind">{item.kind === 'REPORT' ? 'REPORT' : item.kind === 'COMMENT' ? 'MESSAGE' : 'TASK UPDATE'}</span></div>
                  {item.unread && <span className="mail-unread">Unread message</span>}
                  <div className="mail-thread-title">{item.subject}</div>
                  <div className="muted mail-thread-meta">{item.actor} · {fmtDate(item.at)}</div>
                  <div className="mail-thread-last"><span>{item.body}</span></div>
                </button>
              ) : (
                <button key={item.id} className={'mail-thread' + (selectedId === item.id ? ' active' : '')} onClick={() => { setSelectedMessageKey(null); setSelectedId(item.id); }}>
                  <div className="spread"><b>{item.task_number}</b><Pill value={item.status} /></div>
                  {item.unread_count > 0 && <span className="mail-unread">{item.unread_count} unread message(s)</span>}
                  <div className="mail-thread-title">{item.title}</div>
                  <div className="muted mail-thread-meta">{item.line_name || item.crew_name || 'Task'} · {fmtDate(item.due_date)}</div>
                  <div className="mail-thread-last"><b>{item.latest?.actor || 'System'}</b><span>{item.latest?.summary}</span></div>
                </button>
              ))}
              {!rows.length && <div className="empty mailbox-empty">No tasks in this folder.</div>}
            </div>
          </aside>
          <section className="mailbox-reader">
            {loadingThread ? <Loading /> : reportDocument ? (
              <ReportReader report={reportDocument} />
            ) : thread ? (
              <>
                <header className="mail-reader-head">
                  <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <div><div className="mono muted">{thread.task.task_number}</div><h2>{thread.task.title}</h2></div>
                    <Pill value={thread.task.status} />
                  </div>
                  <div className="mail-task-meta">
                    <span>{thread.task.line_name || 'No line linked'}</span>
                    <span>{thread.task.crew_name || 'Unassigned'}</span>
                    <span>Due {fmtDateTime(thread.task.due_date)}</span>
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
                  {!thread.timeline.length && <div className="empty">No task activity recorded yet.</div>}
                </div>
                <div className="mail-compose"><Comments entityType="task" entityId={thread.task.id} /></div>
              </>
            ) : <div className="empty">Select a task thread to read its messages and history.</div>}
          </section>
        </div>
      )}
    </Page>
  );
}

function ReportReader({ report }) {
  const data = report.data || {};
  return (
    <>
      <header className="mail-reader-head">
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div><div className="mono muted">{report.report_code}</div><h2>{report.title}</h2></div>
          <span className="mail-kind">{report.report_type.replace(/_/g, ' ')}</span>
        </div>
        <div className="mail-task-meta"><span>Generated {fmtDateTime(report.generated_at)}</span><span>Period {fmtDate(report.period_start)} – {fmtDate(report.period_end)}</span></div>
      </header>
      <div className="mail-report-body">
        {data.dossier ? <DossierReport data={data} /> : <SavedReportContent data={data} />}
      </div>
    </>
  );
}

function SavedReportContent({ data }) {
  const financial = data.financial;
  if (financial) {
    const code = financial.currency?.code || financial.currency || 'USD';
    const money = (value) => {
      try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(Number(value) || 0); }
      catch (_) { return `${code} ${Number(value || 0).toLocaleString()}`; }
    };
    const rows = financial.kind === 'valuation'
      ? (financial.by_type || []).map((row) => ({ type: row.label || row.asset_type, count: row.count, replacement_cost: money(row.rcn), current_value: money(row.current) }))
      : (financial.by_asset_type || []).map((row) => ({ type: row.asset_type, events: row.count, spend: money(row.spend) }));
    return (
      <>
        <ReportKeyValues values={financial.totals || { count: financial.count, rcn: financial.rcn != null ? money(financial.rcn) : undefined, current: financial.current != null ? money(financial.current) : undefined, spend: financial.totals?.spend != null ? money(financial.totals.spend) : undefined }} />
        <ReportTable rows={rows} />
      </>
    );
  }
  if (Array.isArray(data.rows) && data.rows.length && data.rows[0] && 'label' in data.rows[0]) {
    return <table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>{data.rows.map((row, index) => <tr key={index}><td>{row.label}</td><td>{String(row.value ?? '—')}</td></tr>)}</tbody></table>;
  }
  if (Array.isArray(data.rows) && data.rows.length) return <ReportTable rows={data.rows} />;
  if (data.buckets) return <ReportTable rows={data.buckets} />;
  return (
    <ReportKeyValues values={data} />
  );
}

function ReportTable({ rows }) {
  if (!rows?.length) return <div className="muted">No tabular rows were saved in this report.</div>;
  const keys = Object.keys(rows[0]);
  return <div className="tbl-wrap"><table><thead><tr>{keys.map((key) => <th key={key}>{key.replace(/_/g, ' ')}</th>)}</tr></thead><tbody>
    {rows.map((row, index) => <tr key={index}>{keys.map((key) => <td key={key}>{row[key] == null ? '—' : typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key])}</td>)}</tr>)}
  </tbody></table></div>;
}

function ReportKeyValues({ values }) {
  const rows = Object.entries(values || {}).filter(([, value]) => value == null || ['string', 'number', 'boolean'].includes(typeof value));
  return rows.length ? <table><tbody>{rows.map(([key, value]) => <tr key={key}><th>{key.replace(/_/g, ' ')}</th><td>{value == null ? '—' : String(value)}</td></tr>)}</tbody></table> : null;
}
