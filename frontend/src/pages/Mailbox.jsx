import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Trash2, Inbox, ShieldAlert, RotateCcw } from 'lucide-react';
import { api, fmtDateTime, fmtDate } from '../api';
import { ErrorNote, Loading, Modal, Page, Pill, PrintButton, SearchField, SearchSelect } from '../components';
import Comments from '../components/Comments';
import { ExecutionDetailBody } from '../components/ExecutionDetail';
import { t } from '../i18n';
import { can, getStoredUser } from '../auth';
import { ReportView } from './Reports';

// Folders, in the order they appear. The first five are real directed mail
// (authored messages); the remainder are the read-time task/report activity
// stream.
const FOLDERS = [
  { key: 'mailinbox', labelKey: 'mailboxInbox', mail: true },
  { key: 'junk', labelKey: 'mailboxJunk', mail: true },
  { key: 'trash', labelKey: 'mailboxTrash', mail: true },
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

// Activity folders are rendered from the already-loaded payload, so they show
// the whole list at once (the mailbox is bounded to a few hundred entries). The
// cap only guards against a pathological size; directed-mail folders instead
// page on the server.
const ACTIVITY_LIST_LIMIT = 5000;

// Server folder keys returned in `mail_counts`, for badge totals that hold even
// when only the first page of a folder has been loaded.
const MAIL_COUNT_KEYS = { mailinbox: 'inbox', junk: 'junk', trash: 'trash', outbox: 'outbox', mailsent: 'sent', drafts: 'drafts', archive: 'archive' };

// Format an ISO timestamp for a `datetime-local` input.
function toLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function folderRows(data, folder) {
  if (!data) return [];
  switch (folder) {
    case 'mailinbox': return data.mail_inbox || [];
    case 'junk': return data.mail_junk || [];
    case 'trash': return data.mail_trash || [];
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
  // Directed-mail folders page on the server, so trust the server total even
  // before their first page is loaded. Every activity folder is derived from
  // the payload arrays, so count its rows directly — that keeps the badge in
  // lockstep with the list and covers folders the server does not tally.
  const countKey = MAIL_COUNT_KEYS[folder];
  if (countKey && data.mail_counts && data.mail_counts[countKey] != null) return data.mail_counts[countKey];
  return folderRows(data, folder).length;
}

function isMessageFolder(folder) {
  return MAIL_FOLDERS.has(folder) || folder === 'unread' || folder === 'messages' || folder === 'reports';
}

function findMessage(data, key) {
  if (!data || !key) return null;
  const pools = [
    data.messages, data.unread_messages, data.mail_inbox, data.mail_junk, data.mail_trash,
    data.mail_outbox, data.mail_sent, data.mail_drafts, data.mail_archive,
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
  const [preview, setPreview] = useState(null);
  const [query, setQuery] = useState('');
  const [listLimit, setListLimit] = useState(ACTIVITY_LIST_LIMIT);
  const [error, setError] = useState(null);
  const [loadingThread, setLoadingThread] = useState(false);
  // Server-paged mail feed (labels + search + pagination live on the server so a
  // large mailbox never ships to the browser in one payload).
  const [labels, setLabels] = useState([]);
  const [labelView, setLabelView] = useState(null);
  const [labelManage, setLabelManage] = useState(false);
  const [actionOnly, setActionOnly] = useState(false);
  const [serverPage, setServerPage] = useState(null);
  const [loadingPage, setLoadingPage] = useState(false);
  // Deeper messaging UX: saved searches, conversation view, bulk selection.
  const [searches, setSearches] = useState([]);
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [conversation, setConversation] = useState(null);
  const [selectedForBulk, setSelectedForBulk] = useState(() => new Set());
  const [undo, setUndo] = useState(null);
  const [confirmState, setConfirmState] = useState(null);

  function pushUndo(label, undoFn) {
    const entry = { id: Date.now(), label, undoFn };
    setUndo(entry);
    setTimeout(() => setUndo((cur) => (cur && cur.id === entry.id ? null : cur)), 6500);
  }

  function askConfirm(config) { setConfirmState(config); }

  async function loadSearches() {
    try { setSearches(await api.get('/mailbox/searches') || []); } catch (_) { /* optional */ }
  }

  async function loadLabels() {
    try { setLabels(await api.get('/mailbox/labels') || []); } catch (_) { /* labels are optional */ }
  }

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

  useEffect(() => { load(); loadLabels(); loadSearches(); }, []);

  // A mail folder or a label drives the server-paged feed; other folders are the
  // read-time task/report stream handled client-side below.
  const useServerFeed = MAIL_FOLDERS.has(folder) || !!labelView;

  function serverParams(page) {
    const params = new URLSearchParams({
      folder: labelView ? 'mailany' : folder,
      page: String(page),
      page_size: '50',
    });
    if (query.trim()) params.set('q', query.trim());
    if (labelView) params.set('label', labelView);
    if (actionOnly) params.set('action', '1');
    return params.toString();
  }

  useEffect(() => {
    if (!useServerFeed) { setServerPage(null); return undefined; }
    let alive = true;
    setLoadingPage(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.get(`/mailbox/folder?${serverParams(1)}`);
        if (alive) setServerPage(result);
      } catch (e) { if (alive) setError(e.message); }
      finally { if (alive) setLoadingPage(false); }
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, labelView, query, actionOnly, data]);

  async function loadMoreMail() {
    if (!serverPage || loadingPage) return;
    setLoadingPage(true);
    try {
      const result = await api.get(`/mailbox/folder?${serverParams(serverPage.page + 1)}`);
      setServerPage((cur) => (cur ? { ...result, rows: [...cur.rows, ...result.rows] } : result));
    } catch (e) { setError(e.message); } finally { setLoadingPage(false); }
  }

  // Keep the rendered list bounded: with hundreds of messages, painting every
  // row at once makes the pane sluggish. Reset to the first page whenever the
  // folder or search term changes.
  useEffect(() => { setListLimit(ACTIVITY_LIST_LIMIT); }, [folder, query]);

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
      // A message opened from a server-paged folder/label is not in the first
      // `/mailbox` payload, so resolve it from the loaded feed first.
      const message = (serverPage?.rows || []).find((m) => m.key === selectedMessageKey)
        || findMessage(data, selectedMessageKey);
      if (!message) return;
      let alive = true;
      setLoadingThread(true);
      if (message.kind === 'MAIL') {
        setThread(null);
        setReportDocument(null);
        setMailMessage(message);
        setLoadingThread(false);
        openConversation(message);
        if (message.unread) {
          api.put(`/mailbox/messages/${message.id}/read`, {}).then(() => {
            if (!alive) return;
            setData((current) => markMailRead(current, message.id));
            setServerPage((cur) => (cur ? { ...cur, rows: cur.rows.map((m) => (m.id === message.id ? { ...m, unread: false } : m)) } : cur));
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
    // Opening a task must drop any previously opened mail/report, otherwise the
    // reader keeps rendering the stale message and its "Open task" action is
    // never reachable.
    setMailMessage(null);
    setReportDocument(null);
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

  const sourceRows = useServerFeed ? (serverPage?.rows || []) : folderRows(data, folder);
  const needle = query.trim().toLowerCase();
  const rows = useServerFeed || !needle
    ? sourceRows
    : sourceRows.filter((item) => {
      const text = [
        item.task_number, item.title, item.subject, item.body, item.report_code,
        item.actor, item.recipient, item.category, item.line_name, item.crew_name, item.status,
        (item.tags || []).join(' '), item.latest?.summary,
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(needle);
    });
  const visibleRows = useServerFeed ? rows : rows.slice(0, listLimit);

  function selectFolder(key) {
    setFolder(key);
    setLabelView(null);
    setCompose(null);
    setSelectedForBulk(new Set());
    const nextRows = folderRows(data, key);
    if (isMessageFolder(key)) { setSelectedId(null); setSelectedMessageKey(nextRows?.[0]?.key || null); }
    else { setSelectedMessageKey(null); setSelectedId(nextRows?.[0]?.id || null); }
  }

  function selectLabel(name) {
    setCompose(null);
    setSelectedId(null);
    setSelectedMessageKey(null);
    setSelectedForBulk(new Set());
    setLabelView((cur) => (cur === name ? null : name));
  }

  // Replace this account's labels on a message and refresh the sidebar counts.
  async function setMessageLabels(messageId, labelIds) {
    try {
      await api.put(`/mailbox/messages/${messageId}/labels`, { label_ids: labelIds });
      if (mailMessage && mailMessage.id === messageId) {
        setMailMessage((cur) => (cur ? { ...cur, labels: labels.filter((l) => labelIds.includes(l.id)) } : cur));
      }
      await loadLabels();
      if (labelView) await load();
    } catch (e) { setError(e.message); }
  }

  // A recipient confirms an action-required message.
  async function acknowledge(messageId) {
    try {
      const result = await api.put(`/mailbox/messages/${messageId}/acknowledge`, {});
      setMailMessage((cur) => (cur ? { ...cur, my_acknowledged: true, my_acknowledged_at: result.acknowledged_at } : cur));
      setServerPage((cur) => (cur ? { ...cur, rows: cur.rows.map((m) => (m.id === messageId ? { ...m, my_acknowledged: true, my_acknowledged_at: result.acknowledged_at } : m)) } : cur));
    } catch (e) { setError(e.message); }
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
    setConversation(null);
  }

  // Reply pre-fills the sender; reply-all also carries every other To and Cc
  // party (never the sender's own account), each editable before sending.
  function replyCompose(message, all) {
    const selfId = Number(me.person_id);
    const seen = new Set();
    const recipients = [];
    const push = (personId, name, kind) => {
      const pid = Number(personId);
      if (!pid || pid === selfId || seen.has(pid)) return;
      seen.add(pid);
      recipients.push({ person_id: pid, name: name || `Person ${pid}`, kind });
    };
    push(message.sender_person_id, message.actor, 'TO');
    if (all) {
      (message.to || []).forEach((r) => push(r.person_id, r.name, 'TO'));
      (message.cc || []).forEach((r) => push(r.person_id, r.name, 'CC'));
    }
    return {
      recipients,
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      // Quote the original so the thread keeps its context.
      body: `\n\nOn ${fmtDateTime(message.at)}, ${message.actor} wrote:\n> ${String(message.body || '').split('\n').join('\n> ')}`,
      category: message.category,
      thread_id: message.id,
      parent_id: message.id,
    };
  }

  // Forward starts a real draft server-side (subject, quote and a physical copy
  // of the attachments), then opens it in the composer for free editing.
  async function startForward(message) {
    try {
      const draft = await api.post(`/mailbox/messages/${message.id}/forward`, {});
      await load();
      startCompose({ editId: draft.id, ...draft, forwardHint: true });
    } catch (e) { setError(e.message); }
  }

  // Load the whole conversation a mail belongs to.
  async function openConversation(message) {
    if (!message || message.kind !== 'MAIL') { setConversation(null); return; }
    try { setConversation(await api.get(`/mailbox/messages/${message.id}/thread`)); }
    catch (e) { setError(e.message); }
  }

  function toggleBulk(id) {
    setSelectedForBulk((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function runBulk(action, labelId) {
    const ids = [...selectedForBulk];
    if (!ids.length) return;
    try {
      await api.post('/mailbox/messages/bulk', { ids, action, label_id: labelId });
      setSelectedForBulk(new Set());
      await load();
      await loadLabels();
      const back = { archive: 'restore', trash: 'restore', junk: 'not_junk' }[action];
      if (back) pushUndo(t('mailboxBulkDone'), () => runBulk(back));
    } catch (e) { setError(e.message); }
  }

  // ---- Per-message filing actions (junk / trash / star / delete) ----
  function patchMessage(id, patch) {
    setMailMessage((cur) => (cur && cur.id === id ? { ...cur, ...patch } : cur));
    setServerPage((cur) => (cur && cur.rows ? { ...cur, rows: cur.rows.map((m) => (m.id === id ? { ...m, ...patch } : m)) } : cur));
  }

  async function setJunk(id, junk) {
    try {
      await api.put(`/mailbox/messages/${id}/junk`, { junk });
      patchMessage(id, { junked: junk, junk_reason: junk ? 'MANUAL' : null });
      await load();
      pushUndo(junk ? t('mailboxMovedToJunk') : t('mailboxMovedToInbox'), () => setJunk(id, !junk));
    } catch (e) { setError(e.message); }
  }

  async function setTrash(id, trash) {
    try {
      await api.put(`/mailbox/messages/${id}/trash`, { trash });
      patchMessage(id, { trashed: trash });
      await load();
      pushUndo(trash ? t('mailboxMovedToTrash') : t('mailboxRestored'), () => setTrash(id, !trash));
    } catch (e) { setError(e.message); }
  }

  async function toggleStar(id, starred) {
    try {
      await api.put(`/mailbox/messages/${id}/star`, { starred });
      patchMessage(id, { starred });
      await load();
    } catch (e) { setError(e.message); }
  }

  async function deleteForever(id) {
    try {
      await api.del(`/mailbox/messages/${id}`);
      if (selectedMessageKey && mailMessage && mailMessage.id === id) setSelectedMessageKey(null);
      await load();
    } catch (e) { setError(e.message); }
  }

  async function emptyTrash() {
    try {
      await api.post('/mailbox/trash/empty', {});
      setSelectedMessageKey(null);
      await load();
    } catch (e) { setError(e.message); }
  }

  function confirmDelete(id) {
    askConfirm({
      title: t('mailboxDeleteForever'),
      body: t('mailboxDeleteForeverBody'),
      confirmLabel: t('mailboxDeleteForever'),
      danger: true,
      onConfirm: () => { setConfirmState(null); deleteForever(id); },
    });
  }

  function confirmEmptyTrash() {
    askConfirm({
      title: t('mailboxEmptyTrash'),
      body: t('mailboxEmptyTrashBody'),
      confirmLabel: t('mailboxEmptyTrash'),
      danger: true,
      onConfirm: () => { setConfirmState(null); emptyTrash(); },
    });
  }

  function applySearch(s) {
    setCompose(null);
    setSelectedId(null);
    setSelectedMessageKey(null);
    setSelectedForBulk(new Set());
    setQuery(s.query || '');
    setActionOnly(!!s.action_only);
    setLabelView(s.label || null);
    if (s.folder && MAIL_FOLDERS.has(s.folder)) setFolder(s.folder);
  }

  async function saveCurrentSearch(name) {
    try {
      await api.post('/mailbox/searches', {
        name,
        query: query.trim() || null,
        folder: labelView ? 'mailany' : folder,
        label: labelView || null,
        action_only: actionOnly,
      });
      setSaveSearchOpen(false);
      await loadSearches();
    } catch (e) { setError(e.message); }
  }

  async function deleteSearch(id) {
    try { await api.del(`/mailbox/searches/${id}`); await loadSearches(); }
    catch (e) { setError(e.message); }
  }

  return (
    <Page title={t('mailboxTitle')} crumbs="TMMS / Operations / Mailbox" fill>
      {error && <ErrorNote error={error} />}
      {!data ? (error ? null : <Loading />) : (
        <div className="mailbox-layout">
          <aside className="mailbox-nav">
            <button type="button" className="btn btn-primary mailbox-compose-btn" onClick={() => startCompose()}>
              {t('mailboxCompose')}
            </button>
            <div className="mailbox-unread-total"><b>{data.unread_count || 0}</b> {t('mailboxUnreadTotal')}</div>
            <div className="mailbox-folders" role="tablist" aria-label="Mailbox folders">
              {folders.map((item) => (
                <button key={item.key} className={'mail-folder' + (folder === item.key && !compose && !labelView ? ' active' : '')}
                  role="tab" aria-selected={folder === item.key && !compose && !labelView}
                  onClick={() => selectFolder(item.key)}>
                  <span>{t(item.labelKey)}</span>
                  {item.key === 'mailinbox' && data.mail_unread_count > 0
                    ? <b className="mail-folder-unread">{data.mail_unread_count}</b>
                    : item.key === 'junk' && data.mail_counts?.junk_unread > 0
                      ? <b className="mail-folder-unread">{data.mail_counts.junk_unread}</b>
                      : <b>{folderCount(data, item.key)}</b>}
                </button>
              ))}
            </div>
            <div className="mail-labels">
              <div className="mail-labels-head">
                <span>{t('mailboxLabels')}</span>
                <button type="button" className="btn btn-sm" onClick={() => setLabelManage((v) => !v)}>
                  {labelManage ? t('mailboxDone') : t('mailboxManageLabels')}
                </button>
              </div>
              {labelManage && <LabelManager labels={labels} onChanged={loadLabels} />}
              {!labelManage && labels.map((l) => (
                <button key={l.id} type="button" className={'mail-label' + (labelView === l.name ? ' active' : '')}
                  onClick={() => selectLabel(l.name)}>
                  <span className="mail-label-dot" style={{ background: l.color || '#64748b' }} />
                  <span className="mail-label-name">{l.name}</span>
                  {l.unread > 0 ? <b className="mail-folder-unread">{l.unread}</b> : <b>{l.count}</b>}
                </button>
              ))}
              {!labelManage && !labels.length && <div className="muted mail-labels-empty">{t('mailboxNoLabels')}</div>}
            </div>
            <div className="mail-searches">
              <div className="mail-searches-head">
                <span>{t('mailboxSavedSearches')}</span>
                <button type="button" className="btn btn-sm" onClick={() => setSaveSearchOpen((v) => !v)}>
                  {saveSearchOpen ? t('cancel') : t('mailboxSaveSearch')}
                </button>
              </div>
              {saveSearchOpen && <SaveSearchForm onSave={saveCurrentSearch} />}
              {searches.map((s) => (
                <div key={s.id} className="mail-search-row">
                  <button type="button" className="mail-search-apply" onClick={() => applySearch(s)} title={s.query || ''}>
                    <span className="mail-label-name">{s.name}</span>
                    {s.query && <span className="muted"> · {s.query}</span>}
                  </button>
                  <button type="button" className="mail-attach-x" title={t('delete')} onClick={() => deleteSearch(s.id)}>{'×'}</button>
                </div>
              ))}
            </div>
            <label className="mail-action-filter">
              <input type="checkbox" checked={actionOnly} onChange={(e) => setActionOnly(e.target.checked)} />
              {t('mailboxActionOnly')}
            </label>
          </aside>
          <aside className="mailbox-list">
            <div className="mail-list-head">
              <SearchField value={query} onChange={setQuery} placeholder={t('mailboxSearch')} />
              {folder === 'trash' && (
                <button type="button" className="btn btn-sm btn-danger mail-empty-trash" onClick={confirmEmptyTrash}>
                  {t('mailboxEmptyTrash')}
                </button>
              )}
            </div>
            {useServerFeed && serverPage && (
              <div className="muted mail-result-count">
                {labelView ? t('mailboxLabelView') + ': ' + labelView : t('mailboxFolderResults')} · {serverPage.total}
              </div>
            )}
            {selectedForBulk.size > 0 && (
              <div className="mail-bulk-bar">
                <span>{selectedForBulk.size} {t('mailboxSelected')}</span>
                <button type="button" className="btn btn-sm" onClick={() => runBulk('archive')}>{t('mailboxArchiveAction')}</button>
                <button type="button" className="btn btn-sm" onClick={() => runBulk('unarchive')}>{t('mailboxUnarchiveAction')}</button>
                <button type="button" className="btn btn-sm" onClick={() => runBulk('junk')}>{t('mailboxJunkAction')}</button>
                <button type="button" className="btn btn-sm" onClick={() => runBulk('trash')}>{t('mailboxTrashAction')}</button>
                <button type="button" className="btn btn-sm" onClick={() => runBulk('star')}>{t('mailboxStar')}</button>
                {labels.length > 0 && (
                  <SearchSelect className="mail-bulk-label" value="" aria-label={t('mailboxAddLabel')}
                    onChange={(e) => { if (e.target.value) runBulk('label_add', Number(e.target.value)); }}>
                    <option value="">{t('mailboxAddLabel')}</option>
                    {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </SearchSelect>
                )}
                <button type="button" className="btn btn-sm" onClick={() => setSelectedForBulk(new Set())}>{t('mailboxClearSelection')}</button>
              </div>
            )}
            <div className="mail-thread-list">
              {visibleRows.map((item) => isMessageFolder(folder) || labelView ? (
                <div key={item.key} className={'mail-thread-wrap' + (selectedMessageKey === item.key && !compose ? ' active' : '')}>
                  <label className="mail-thread-check" title={t('mailboxSelectMessage')}>
                    <input type="checkbox" checked={selectedForBulk.has(item.id)} onChange={() => toggleBulk(item.id)} />
                  </label>
                  <button className={'mail-thread' + (selectedMessageKey === item.key && !compose ? ' active' : '')}
                    onClick={() => { setCompose(null); setSelectedId(null); setSelectedMessageKey(item.key); }}>
                    <div className="spread">
                      <b>{item.kind === 'MAIL' ? (item.outgoing ? `${t('mailboxTo')}: ${item.recipient}` : item.actor) : item.kind === 'REPORT' ? item.report_code : item.task_number}</b>
                      <div className="mail-thread-flags">
                        {item.starred && <Star size={13} className="mail-flag-star" fill="currentColor" />}
                        <span className="mail-kind">{item.kind === 'MAIL' ? tagLabel(item.category) : item.kind === 'REPORT' ? t('mailboxKindReport') : item.kind === 'COMMENT' ? t('mailboxKindMessage') : t('mailboxKindUpdate')}</span>
                      </div>
                    </div>
                    {item.unread && <span className="mail-unread">{t('mailboxUnreadOne')}</span>}
                    {item.action_required && <span className="mail-action-badge">{t('mailboxActionRequired')}</span>}
                    <div className="mail-thread-title">{item.subject}</div>
                    <div className="muted mail-thread-meta">{item.kind === 'MAIL' ? `${item.actor} · ${fmtDate(item.at)}` : `${item.actor} · ${fmtDate(item.at)}`}</div>
                    {item.junked && <span className="mail-junk-chip">{t('mailboxJunkChip')}{item.junk_reason ? `: ${item.junk_reason}` : ''}</span>}
                    <TagChips tags={item.tags} />
                    <div className="mail-thread-last"><span>{item.body}</span></div>
                  </button>
                  {item.kind === 'MAIL' && (
                    <div className="mail-thread-actions">
                      <button type="button" className="mail-icon-btn" title={item.starred ? t('mailboxUnstar') : t('mailboxStar')}
                        onClick={(e) => { e.stopPropagation(); toggleStar(item.id, !item.starred); }}>
                        <Star size={14} fill={item.starred ? 'currentColor' : 'none'} />
                      </button>
                      <button type="button" className="mail-icon-btn" title={item.junked ? t('mailboxNotJunk') : t('mailboxJunkAction')}
                        onClick={(e) => { e.stopPropagation(); setJunk(item.id, !item.junked); }}>
                        {item.junked ? <Inbox size={14} /> : <ShieldAlert size={14} />}
                      </button>
                      {item.trashed ? (
                        <>
                          <button type="button" className="mail-icon-btn" title={t('mailboxRestore')}
                            onClick={(e) => { e.stopPropagation(); setTrash(item.id, false); }}>
                            <RotateCcw size={14} />
                          </button>
                          <button type="button" className="mail-icon-btn" title={t('mailboxDeleteForever')}
                            onClick={(e) => { e.stopPropagation(); confirmDelete(item.id); }}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : (
                        <button type="button" className="mail-icon-btn" title={t('mailboxTrashAction')}
                          onClick={(e) => { e.stopPropagation(); setTrash(item.id, true); }}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
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
              {loadingPage && !visibleRows.length && <Loading />}
              {!rows.length && !loadingPage && <div className="empty mailbox-empty">{t('mailboxEmptyFolder')}</div>}
              {useServerFeed
                ? (serverPage && serverPage.has_more && (
                  <button type="button" className="btn btn-sm mail-more" disabled={loadingPage} onClick={loadMoreMail}>
                    {t('mailboxShowMore')}
                  </button>
                ))
                : (rows.length > visibleRows.length && (
                  <button type="button" className="btn btn-sm mail-more" onClick={() => setListLimit((n) => n + 60)}>
                    {t('mailboxShowMore')} ({rows.length - visibleRows.length} {t('mailboxRemaining')})
                  </button>
                ))}
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
                onReply={() => startCompose(replyCompose(mailMessage, false))}
                onReplyAll={() => startCompose(replyCompose(mailMessage, true))}
                onForward={() => startForward(mailMessage)}
                onEdit={() => startCompose({
                  editId: mailMessage.id,
                  recipients: mailMessage.recipients,
                  subject: mailMessage.subject,
                  body: mailMessage.body,
                  category: mailMessage.category,
                  priority: mailMessage.priority,
                  attachments: mailMessage.attachments || [],
                  action_required: mailMessage.action_required,
                  due_date: mailMessage.due_date,
                  scheduled_at: mailMessage.scheduled_at,
                })}
                onSend={() => withReload(() => api.post(`/mailbox/messages/${mailMessage.id}/send`, {}))}
                onArchive={() => withReload(() => api.put(`/mailbox/messages/${mailMessage.id}/archive`, {}))}
                onUnarchive={() => withReload(() => api.put(`/mailbox/messages/${mailMessage.id}/unarchive`, {}))}
                onJunk={() => setJunk(mailMessage.id, !mailMessage.junked)}
                onTrash={() => setTrash(mailMessage.id, !mailMessage.trashed)}
                onStar={() => toggleStar(mailMessage.id, !mailMessage.starred)}
                onDelete={() => confirmDelete(mailMessage.id)}
                onOpenLink={() => { if (mailMessage.link) nav(mailMessage.link); }}
                onOpenTask={(tid) => nav(`/tasks/${tid}`)}
                onPreview={setPreview}
                allLabels={labels}
                onLabels={(ids) => setMessageLabels(mailMessage.id, ids)}
                onAcknowledge={() => acknowledge(mailMessage.id)}
                conversation={conversation}
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
      {preview && (
        <MailAttachmentPreview
          attachment={preview}
          onClose={() => setPreview(null)}
          onOpenTask={(tid) => { setPreview(null); nav(`/tasks/${tid}`); }}
        />
      )}
      {undo && (
        <div className="mail-undo-toast" role="status">
          <span>{undo.label}</span>
          <button type="button" className="btn btn-sm" onClick={() => { const fn = undo.undoFn; setUndo(null); fn(); }}>{t('mailboxUndo')}</button>
          <button type="button" className="mail-undo-x" aria-label={t('close')} onClick={() => setUndo(null)}>{'×'}</button>
        </div>
      )}
      {confirmState && (
        <div className="mail-confirm-overlay" role="dialog" aria-modal="true">
          <div className="mail-confirm">
            <h3>{confirmState.title}</h3>
            <p className="muted">{confirmState.body}</p>
            <div className="mail-confirm-actions">
              <button type="button" className="btn btn-sm" onClick={() => setConfirmState(null)}>{t('cancel')}</button>
              <button type="button" className={'btn btn-sm' + (confirmState.danger ? ' btn-danger' : '')} onClick={confirmState.onConfirm}>
                {confirmState.confirmLabel || t('confirm')}
              </button>
            </div>
          </div>
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

function TextPreview({ url }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(url).then((r) => r.text()).then((x) => { if (alive) setText(x); }).catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [url]);
  if (err) return <ErrorNote error={err} />;
  return <div className="mail-preview-body"><pre className="mail-preview-text">{text}</pre></div>;
}

// One printable preview for any mailbox attachment: an uploaded file (inline
// PDF / image / text with a download), a saved report, an execution summary, or
// any entity document. The Print button turns the previewed summary into a PDF
// via the browser's "Save as PDF".
function MailAttachmentPreview({ attachment, onClose, onOpenTask }) {
  const [state, setState] = useState({ loading: true });
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let alive = true;
    let revoke = null;
    setState({ loading: true });
    setUrl(null);
    (async () => {
      try {
        if (attachment.has_file && attachment.id != null) {
          const blob = await api.blob(`/mailbox/attachments/${attachment.id}/file`);
          const objectUrl = URL.createObjectURL(blob);
          revoke = objectUrl;
          if (!alive) { URL.revokeObjectURL(objectUrl); return; }
          setUrl(objectUrl);
          setState({ loading: false, file: { url: objectUrl, type: blob.type || attachment.mime || '', name: attachment.file_name || 'attachment' } });
        } else if (attachment.kind === 'REPORT' || attachment.entity_type === 'REPORT') {
          const res = await api.get(`/reports/${attachment.entity_id}`);
          if (alive) setState({ loading: false, report: res });
        } else if (attachment.entity_type === 'CHECKLIST_EXECUTION') {
          const res = await api.get(`/checklist-executions/${attachment.entity_id}`);
          if (alive) setState({ loading: false, execution: res });
        } else if (attachment.entity_type && attachment.entity_id != null) {
          const res = await api.get(`/reports/document?type=${encodeURIComponent(attachment.entity_type)}&id=${encodeURIComponent(attachment.entity_id)}`);
          if (alive) setState({ loading: false, document: res.data ?? res });
        } else {
          setState({ loading: false, none: true });
        }
      } catch (e) {
        if (alive) setState({ loading: false, error: e.message });
      }
    })();
    return () => { alive = false; if (revoke) URL.revokeObjectURL(revoke); };
  }, [attachment]);

  const file = state.file;
  const isPdf = !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
  const isImage = !!file && (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name));
  const isText = !!file && (file.type.startsWith('text/') || /\.(txt|csv|json|log|md)$/i.test(file.name));
  // A task id whenever the attachment is bound to a task, so the preview can
  // jump straight to it: the stored link, the execution's task, or a task
  // document.
  const linkedTaskId = (() => {
    const fromLink = /\/tasks\/(\d+)/.exec(attachment.link || '');
    if (fromLink) return fromLink[1];
    if (state.execution && state.execution.task_id) return state.execution.task_id;
    const doc = (state.document && state.document.document) || (state.report && state.report.data && state.report.data.document);
    if (doc && doc.task && doc.task.id) return doc.task.id;
    return null;
  })();

  return (
    <Modal
      title={attachment.label || attachment.file_name || t('mailboxAttachments')}
      onClose={onClose}
      wide
      printable
      hideHeaderOnPrint
      footer={<>
        {linkedTaskId && <button type="button" className="btn btn-sm no-print" onClick={() => onOpenTask(linkedTaskId)}>{t('mailboxOpenTask')}</button>}
        {file && <button type="button" className="btn btn-sm no-print" onClick={() => api.download(`/mailbox/attachments/${attachment.id}/file`, file.name)}>{t('mailboxAttachDownload')}</button>}
        {url && <a className="btn btn-sm no-print" href={url} target="_blank" rel="noreferrer">{t('mailboxOpenInNewTab')}</a>}
        <PrintButton />
        <button className="btn btn-primary" onClick={onClose}>Close</button>
      </>}
    >
      {state.loading && <Loading />}
      {state.error && <ErrorNote error={state.error} />}
      {state.report && <div className="mail-preview-body"><ReportView data={state.report.data ?? state.report} /></div>}
      {state.execution && <div className="mail-preview-body"><ExecutionDetailBody exec={state.execution} /></div>}
      {state.document && <ReportView data={state.document} />}
      {file && isPdf && <iframe className="mail-preview-frame" src={file.url} title={file.name} />}
      {file && isImage && <div className="mail-preview-body"><img className="mail-preview-img" src={file.url} alt={file.name} /></div>}
      {file && isText && <TextPreview url={file.url} />}
      {file && !isPdf && !isImage && !isText && <div className="empty">{t('mailboxPreviewUnavailable')}</div>}
      {state.none && <div className="empty">{t('mailboxPreviewUnavailable')}</div>}
    </Modal>
  );
}

function MessageBody({ body }) {
  const [showQuote, setShowQuote] = useState(false);
  const text = String(body || '');
  // Split the readable part from a trailing quoted reply so long threads stay
  // scannable. The quote is collapsed behind a toggle rather than always shown.
  const lines = text.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*>/.test(lines[i])) { cut = i; break; }
    if (/^On .+ wrote:\s*$/.test(lines[i].trim())) { cut = i; break; }
  }
  const main = cut === -1 ? text : lines.slice(0, cut).join('\n');
  const quote = cut === -1 ? '' : lines.slice(cut).join('\n');
  return (
    <div className="mail-body-card">
      <p className="mail-body-text">{main.trim() || '—'}</p>
      {quote && (
        <>
          <button type="button" className="mail-quote-toggle" onClick={() => setShowQuote((v) => !v)}>
            {showQuote ? t('mailboxHideQuoted') : t('mailboxShowQuoted')}
          </button>
          {showQuote && <pre className="mail-quoted">{quote}</pre>}
        </>
      )}
    </div>
  );
}

function MailReader({ message, me, onReply, onReplyAll, onForward, onEdit, onSend, onArchive, onUnarchive, onJunk, onTrash, onStar, onDelete, onOpenLink, onPreview, onOpenTask, allLabels, onLabels, onAcknowledge, conversation }) {
  const [showConversation, setShowConversation] = useState(false);
  const threadMessages = (conversation && conversation.messages) || [];
  const isDraft = message.status === 'DRAFT' || message.status === 'QUEUED';
  const mineIsSender = message.sender_person_id === me.person_id;
  const attachments = message.attachments || [];
  const labels = message.labels || [];
  const labelIds = labels.map((l) => l.id);
  const availableLabels = (allLabels || []).filter((l) => !labelIds.includes(l.id));
  const isRecipient = !!message.my_kind;
  const canAcknowledge = onAcknowledge && message.action_required && isRecipient;
  const linkedTaskId = (() => {
    const m = /\/tasks\/(\d+)/.exec(message.link || '');
    return m ? m[1] : null;
  })();
  const to = message.to || [];
  const cc = message.cc || [];
  const bcc = message.bcc || [];
  // Reply-all is offered whenever the mail reached more than just the sender.
  const canReplyAll = onReplyAll && (to.length + cc.length + bcc.length) > 1;
  const receipts = mineIsSender ? (message.read_receipts || []).filter((r) => r.kind !== 'BCC') : [];
  const receiptRead = receipts.filter((r) => r.read_at).length;
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
            {!isDraft && canReplyAll && <button type="button" className="btn btn-sm" onClick={onReplyAll}>{t('mailboxReplyAll')}</button>}
            {!isDraft && onForward && <button type="button" className="btn btn-sm" onClick={onForward}>{t('mailboxForward')}</button>}
            {onStar && (
              <button type="button" className={'btn btn-sm mail-star-btn' + (message.starred ? ' on' : '')}
                title={message.starred ? t('mailboxUnstar') : t('mailboxStar')}
                aria-pressed={!!message.starred} onClick={onStar}>
                <Star size={15} fill={message.starred ? 'currentColor' : 'none'} />
                <span className="mail-btn-label">{message.starred ? t('mailboxStarred') : t('mailboxStar')}</span>
              </button>
            )}
            {onJunk && (
              <button type="button" className="btn btn-sm" onClick={onJunk}>
                {message.junked ? t('mailboxNotJunk') : t('mailboxJunkAction')}
              </button>
            )}
            {onTrash && (
              <button type="button" className="btn btn-sm" onClick={onTrash}>
                {message.trashed ? t('mailboxRestore') : t('mailboxTrashAction')}
              </button>
            )}
            {message.trashed && onDelete && (
              <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>{t('mailboxDeleteForever')}</button>
            )}
            {threadMessages.length > 1 && (
              <button type="button" className={'btn btn-sm' + (showConversation ? ' btn-primary' : '')} onClick={() => setShowConversation((v) => !v)}>
                {t('mailboxConversation')} ({threadMessages.length})
              </button>
            )}
            {linkedTaskId
              ? <button type="button" className="btn btn-sm" onClick={() => onOpenTask(linkedTaskId)}>{t('mailboxOpenTask')}</button>
              : message.link && <button type="button" className="btn btn-sm" onClick={onOpenLink}>{t('mailboxOpenLink')}</button>}
            {message.archived
              ? <button type="button" className="btn btn-sm" onClick={onUnarchive}>{t('mailboxUnarchiveAction')}</button>
              : <button type="button" className="btn btn-sm" onClick={onArchive}>{t('mailboxArchiveAction')}</button>}
          </div>
        </div>
        <div className="mail-task-meta">
          <span>{t('mailboxFrom')}: {message.actor}</span>
          <span>{t('mailboxTo')}: {to.length ? to.map((r) => r.name).join(', ') : message.recipient}</span>
          {cc.length > 0 && <span>{t('mailboxCc')}: {cc.map((r) => r.name).join(', ')}</span>}
          {bcc.length > 0 && <span>{t('mailboxBcc')}: {bcc.map((r) => r.name).join(', ')}</span>}
          {message.sent_at && <span>{t('mailboxSentAt')} {fmtDateTime(message.sent_at)}</span>}
          {isDraft && message.scheduled_at && <span>{t('mailboxScheduledFor')} {fmtDateTime(message.scheduled_at)}</span>}
          {message.action_required && message.due_date && <span className="mail-due">{t('mailboxDue')} {fmtDate(message.due_date)}</span>}
          <TagChips tags={message.tags} />
        </div>
        {(message.action_required || labels.length > 0 || onLabels) && (
          <div className="mail-reader-tags">
            {message.action_required && (
              <span className={'mail-action-banner' + (message.my_acknowledged ? ' done' : '')}>
                {t('mailboxActionRequired')}
                {canAcknowledge
                  ? (message.my_acknowledged
                    ? <span className="mail-ack-done"> · {t('mailboxAcknowledged')} {fmtDateTime(message.my_acknowledged_at)}</span>
                    : <button type="button" className="btn btn-sm btn-primary" onClick={onAcknowledge}>{t('mailboxAcknowledge')}</button>)
                  : null}
              </span>
            )}
            {labels.map((l) => (
              <span key={l.id} className="mail-label-chip" style={{ borderColor: l.color || '#64748b' }}>
                <span className="mail-label-dot" style={{ background: l.color || '#64748b' }} />{l.name}
                {onLabels && <button type="button" className="mail-attach-x" title={t('mailboxAttachRemove')}
                  onClick={() => onLabels(labelIds.filter((id) => id !== l.id))}>{'×'}</button>}
              </span>
            ))}
            {onLabels && availableLabels.length > 0 && (
              <SearchSelect className="mail-label-add" value="" aria-label={t('mailboxAddLabel')}
                onChange={(e) => { if (e.target.value) onLabels([...labelIds, Number(e.target.value)]); }}>
                <option value="">{t('mailboxAddLabel')}</option>
                {availableLabels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </SearchSelect>
            )}
          </div>
        )}
        {receipts.length > 0 && (
          <div className="mail-receipts">
            <span className="muted">{t('mailboxReadReceipts')}: {receiptRead}/{receipts.length}</span>
            {receipts.map((r) => (
              <span key={r.person_id} className={'mail-receipt' + (r.read_at ? ' read' : '')} title={r.read_at ? fmtDateTime(r.read_at) : ''}>
                {r.name}
              </span>
            ))}
          </div>
        )}
      </header>
      <div className="mail-scroll">
        {message.junked && (
          <div className="mail-junk-banner">
            <b>{t('mailboxJunkBanner')}</b>
            {message.junk_reason && <span className="muted"> · {message.junk_reason}</span>}
            {onJunk && <button type="button" className="btn btn-sm" onClick={onJunk}>{t('mailboxNotJunk')}</button>}
          </div>
        )}
        <MessageBody body={message.body} />
        {attachments.length > 0 && (
          <div className="mail-attach-reader">
            <div className="mail-attach-reader-title">{t('mailboxAttachments')} ({attachments.length})</div>
            <div className="mail-attach-chips">
              {attachments.map((a) => (
                <button key={attachmentKey(a)} type="button" className="mail-attach-chip mail-attach-chip-btn"
                  title={t('mailboxPreview')}
                  onClick={() => onPreview(a)}>
                  <span className="mail-attach-chip-label">{a.label || a.file_name}</span>
                  <span className="mail-attach-chip-kind">{a.has_file ? t('mailboxAttachDownload') : t('mailboxAttachOpen')}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {showConversation && threadMessages.length > 0 && (
          <div className="mail-conversation">
            <div className="mail-attach-reader-title">{t('mailboxConversation')} ({threadMessages.length})</div>
            {threadMessages.map((m) => (
              <article key={m.id} className={'mail-message mail-conversation-item' + (m.id === message.id ? ' current' : '')}>
                <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <b>{m.actor}</b>
                  <span className="muted">{fmtDateTime(m.at)}</span>
                </div>
                <div className="muted mail-thread-meta">{t('mailboxTo')}: {m.to && m.to.length ? m.to.map((r) => r.name).join(', ') : m.recipient}</div>
                <p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const ATTACH_TYPES = [
  { value: 'REPORT', labelKey: 'mailboxAttachReports' },
  { value: 'EXECUTION', labelKey: 'mailboxAttachExecutions' },
  { value: 'TASK', labelKey: 'mailboxAttachTasks' },
  { value: 'ASSET', labelKey: 'mailboxAttachAssets' },
  { value: 'LINE', labelKey: 'mailboxAttachLines' },
  { value: 'CREW', labelKey: 'mailboxAttachCrews' },
  { value: 'PERSON', labelKey: 'mailboxAttachPeople' },
  { value: 'FILE', labelKey: 'mailboxAttachFile' },
];

function attachmentKey(a) {
  if (!a) return '';
  if (a.id != null) return `id-${a.id}`;
  if (a.entity_id != null && a.entity_type) return `${a.entity_type}-${a.entity_id}`;
  return `file-${a.file_name || a.label}-${a.size_bytes || ''}`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// Compose-time attachment chooser: pick a saved report, an execution, or any
// task/asset/line/crew/person record (scoped to the caller), or upload a file.
function AttachmentField({ value, onChange }) {
  const [type, setType] = useState('REPORT');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (type === 'FILE') { setResults([]); return undefined; }
    let alive = true;
    const handle = setTimeout(() => {
      api.get(`/mailbox/attachments/catalog?type=${type}&q=${encodeURIComponent(query.trim())}`)
        .then((res) => { if (alive) { setResults(res.items || []); setErr(null); } })
        .catch((e) => { if (alive) setErr(e.message); });
    }, 250);
    return () => { alive = false; clearTimeout(handle); };
  }, [type, query]);

  const has = (item) => value.some((a) => a.entity_type === item.entity_type && Number(a.entity_id) === Number(item.entity_id));
  function addEntity(item) {
    if (has(item)) return;
    onChange([...value, { kind: item.type, entity_type: item.entity_type, entity_id: item.entity_id, label: item.label, link: item.link }]);
  }
  function remove(a) {
    onChange(value.filter((x) => attachmentKey(x) !== attachmentKey(a)));
  }
  async function addFiles(fileList) {
    setErr(null);
    const added = [];
    for (const file of Array.from(fileList || [])) {
      if (file.size > 8 * 1024 * 1024) { setErr(t('mailboxAttachTooLarge')); continue; }
      try {
        const data = await fileToBase64(file);
        added.push({ kind: 'FILE', file_name: file.name, mime: file.type || 'application/octet-stream', label: file.name, size_bytes: file.size, data });
      } catch (_) { setErr(t('mailboxAttachTooLarge')); }
    }
    if (added.length) onChange([...value, ...added]);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="field full">
      <label>{t('mailboxAttachments')}</label>
      {value.length > 0 && (
        <div className="mail-attach-chips">
          {value.map((a) => (
            <span key={attachmentKey(a)} className="mail-attach-chip" title={a.link || a.file_name || a.label}>
              <span className="mail-attach-chip-label">{a.label || a.file_name}</span>
              <button type="button" className="mail-attach-x" title={t('mailboxAttachRemove')} onClick={() => remove(a)}>{'×'}</button>
            </span>
          ))}
        </div>
      )}
      {err && <ErrorNote error={err} />}
      <div className="mail-attach-picker">
        <SearchSelect value={type} onChange={(e) => setType(e.target.value)} aria-label={t('mailboxAttachType')}>
          {ATTACH_TYPES.map((opt) => <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>)}
        </SearchSelect>
        {type === 'FILE' ? (
          <input ref={fileRef} type="file" multiple onChange={(e) => addFiles(e.target.files)} />
        ) : (
          <>
            <SearchField value={query} onChange={setQuery} placeholder={t('mailboxAttachSearch')} />
            <div className="mail-attach-results">
              {results.map((item) => (
                <button key={`${item.entity_type}-${item.entity_id}`} type="button" className="mail-attach-option"
                  disabled={has(item)} onClick={() => addEntity(item)}>
                  <span>{item.label}</span>
                  {item.sub && <span className="muted"> · {String(item.sub).replace(/_/g, ' ')}</span>}
                  {has(item) && <span className="muted"> · {t('mailboxAttachAdded')}</span>}
                </button>
              ))}
              {!results.length && <div className="muted mail-attach-empty">{t('mailboxAttachNoResults')}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function initialRecipients(initial, kind) {
  const list = Array.isArray(initial?.recipients) ? initial.recipients : [];
  const out = list
    .filter((r) => (String(r.kind || 'TO').toUpperCase() === kind))
    .map((r) => ({ person_id: Number(r.person_id), name: r.name || `Person ${r.person_id}`, role: r.role || '' }));
  if (!out.length && kind === 'TO' && initial?.recipient_person_id && !list.length) {
    out.push({ person_id: Number(initial.recipient_person_id), name: initial.recipient_name || `Person ${initial.recipient_person_id}`, role: '' });
  }
  return out;
}

// A single To / Cc / Bcc line: type-to-filter over the addressable people,
// chips for the chosen parties, and a remove control on each chip.
function RecipientField({ label, value, onChange, contacts, placeholder }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const blurTimer = useRef(null);
  const selected = new Set(value.map((r) => Number(r.person_id)));
  const q = query.trim().toLowerCase();
  const pool = contacts.filter((c) => !selected.has(Number(c.person_id)));
  const matched = q ? pool.filter((c) => `${c.name} ${c.username} ${c.role} ${c.title || ''}`.toLowerCase().includes(q)) : pool;
  const results = matched.slice(0, 30);
  return (
    <div className="field full">
      <label>{label}</label>
      <div className="mail-recipient-box">
        {value.map((r) => (
          <span key={r.person_id} className="mail-recipient-chip">
            <span>{r.name}</span>
            <button type="button" className="mail-attach-x" title={t('mailboxAttachRemove')}
              onClick={() => onChange(value.filter((x) => Number(x.person_id) !== Number(r.person_id)))}>{'×'}</button>
          </span>
        ))}
        <input value={query}
          onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setOpen(true); }}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder || t('mailboxRecipientPlaceholder')} />
      </div>
      {open && (
        <div className="mail-recipient-menu">
          {results.map((c) => (
            <button key={c.person_id} type="button" className="mail-recipient"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange([...value, { person_id: c.person_id, name: c.name, role: c.role }]); setQuery(''); }}>
              <b>{c.name}</b> <span className="muted">· {c.role}{c.title ? ` · ${c.title}` : ''}</span>
            </button>
          ))}
          {!results.length && <div className="muted" style={{ padding: 10 }}>{t('mailboxNoRecipients')}</div>}
        </div>
      )}
    </div>
  );
}

function MailCompose({ initial, me, onCancel, onSaved }) {
  const [contacts, setContacts] = useState([]);
  const [to, setTo] = useState(() => initialRecipients(initial, 'TO'));
  const [cc, setCc] = useState(() => initialRecipients(initial, 'CC'));
  const [bcc, setBcc] = useState(() => initialRecipients(initial, 'BCC'));
  const [showCc, setShowCc] = useState(() => initialRecipients(initial, 'CC').length > 0);
  const [showBcc, setShowBcc] = useState(() => initialRecipients(initial, 'BCC').length > 0);
  const [subject, setSubject] = useState(initial?.subject || '');
  const [body, setBody] = useState(initial?.body || '');
  const [category, setCategory] = useState(initial?.category || 'GENERAL');
  const [priority, setPriority] = useState(initial?.priority || 'NORMAL');
  const [actionRequired, setActionRequired] = useState(!!initial?.action_required);
  const [dueDate, setDueDate] = useState(initial?.due_date || '');
  const [schedule, setSchedule] = useState(initial?.scheduled_at ? toLocalInput(initial.scheduled_at) : '');
  const [attachments, setAttachments] = useState(() => (initial?.attachments || []).map((a) => ({
    id: a.id,
    kind: a.kind || 'FILE',
    entity_type: a.entity_type || null,
    entity_id: a.entity_id ?? null,
    label: a.label || a.file_name,
    link: a.link || null,
    file_name: a.file_name || null,
    mime: a.mime || null,
    has_file: !!a.has_file,
  })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const savedIdRef = useRef(initial?.editId || null);
  const busyRef = useRef(false);
  const statusRef = useRef(initial?.status && initial.status !== 'SENT' ? initial.status : 'DRAFT');
  const firstRunRef = useRef(true);

  useEffect(() => {
    api.get('/mailbox/recipients').then((list) => setContacts(list || [])).catch((e) => setErr(e.message));
  }, []);

  // A person can only hold one place on the envelope; whichever line they are
  // added to removes the other occurrences.
  const setKind = (kind, next) => {
    const ids = new Set(next.map((r) => Number(r.person_id)));
    const prune = (rows) => rows.filter((r) => !ids.has(Number(r.person_id)));
    if (kind !== 'TO') setTo(prune);
    if (kind !== 'CC') setCc(prune);
    if (kind !== 'BCC') setBcc(prune);
    if (kind === 'TO') setTo(next);
    if (kind === 'CC') { setCc(next); setShowCc(true); }
    if (kind === 'BCC') { setBcc(next); setShowBcc(true); }
  };

  function buildPayload(status) {
    return {
      to: to.map((r) => Number(r.person_id)),
      cc: cc.map((r) => Number(r.person_id)),
      bcc: bcc.map((r) => Number(r.person_id)),
      subject: subject.trim(),
      body: body.trim(),
      category,
      priority,
      status,
      scheduled_at: schedule ? new Date(schedule).toISOString() : null,
      action_required: actionRequired,
      due_date: actionRequired && dueDate ? dueDate : null,
      thread_id: initial?.thread_id || null,
      parent_id: initial?.parent_id || null,
      attachments: attachments.map((a) => ({
        id: a.id ?? null,
        kind: a.kind,
        entity_type: a.entity_type || null,
        entity_id: a.entity_id ?? null,
        label: a.label || a.file_name || null,
        link: a.link || null,
        file_name: a.file_name || null,
        mime: a.mime || null,
        data: a.data || null,
      })),
    };
  }

  // Autosave the working draft a moment after typing stops so a compose is never
  // lost. A new compose becomes a server-side draft; later saves reuse its id.
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return undefined; }
    if (busyRef.current) return undefined;
    const hasContent = to.length || cc.length || bcc.length || subject.trim() || body.trim() || attachments.length > 0;
    if (!hasContent) { setSaveState('idle'); return undefined; }
    const timer = setTimeout(async () => {
      if (busyRef.current) return;
      try {
        setSaveState('saving');
        const payload = buildPayload(statusRef.current);
        if (savedIdRef.current) {
          await api.put(`/mailbox/messages/${savedIdRef.current}`, payload);
        } else {
          const created = await api.post('/mailbox/messages', payload);
          savedIdRef.current = created.id;
        }
        setSaveState('saved');
      } catch (e) { setSaveState('error'); setErr(e.message); }
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, body, category, priority, attachments, actionRequired, dueDate, schedule]);

  async function save(status) {
    setErr(null);
    if (status !== 'DRAFT' && !to.length) { setErr(t('mailboxRecipientRequired')); return; }
    if (status === 'SENT' && !subject.trim()) { setErr(t('mailboxSubjectRequired')); return; }
    if (!subject.trim() && !body.trim()) { setErr(t('mailboxBodyRequired')); return; }
    // A send with a future time is held in the Outbox and delivered when due.
    const scheduledAt = schedule ? new Date(schedule).toISOString() : null;
    const effectiveStatus = status === 'SENT' && scheduledAt && new Date(schedule) > new Date() ? 'QUEUED' : status;
    busyRef.current = true;
    setBusy(true);
    try {
      const payload = buildPayload(effectiveStatus);
      const editId = savedIdRef.current || initial?.editId || null;
      if (editId) {
        await api.put(`/mailbox/messages/${editId}`, payload);
        if (effectiveStatus === 'SENT') await api.post(`/mailbox/messages/${editId}/send`, {});
      } else {
        await api.post('/mailbox/messages', payload);
      }
      await onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); busyRef.current = false; }
  }

  return (
    <>
      <header className="mail-reader-head">
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h2>{savedIdRef.current || initial?.editId ? t('mailboxEditDraft') : t('mailboxCompose')}</h2>
          <div className="mail-compose-head-right">
            {saveState === 'saving' && <span className="muted mail-savestate">{t('mailboxSaving')}</span>}
            {saveState === 'saved' && <span className="muted mail-savestate">{t('mailboxDraftSaved')}</span>}
            {saveState === 'error' && <span className="mail-savestate err">{t('mailboxDraftSaveFailed')}</span>}
            <button type="button" className="btn btn-sm" onClick={onCancel}>{t('cancel')}</button>
          </div>
        </div>
      </header>
      <div className="mail-scroll">
        {err && <ErrorNote error={err} />}
        <div className="form-grid" style={{ padding: '0 4px' }}>
          <RecipientField label={t('mailboxTo')} value={to} onChange={(next) => setKind('TO', next)} contacts={contacts} />
          {(showCc || cc.length > 0) && (
            <RecipientField label={t('mailboxCc')} value={cc} onChange={(next) => setKind('CC', next)} contacts={contacts} />
          )}
          {(showBcc || bcc.length > 0) && (
            <RecipientField label={t('mailboxBcc')} value={bcc} onChange={(next) => setKind('BCC', next)} contacts={contacts} />
          )}
          {(!showCc || !showBcc) && (
            <div className="mail-recipient-toggles">
              {!showCc && <button type="button" className="btn btn-sm" onClick={() => setShowCc(true)}>{t('mailboxAddCc')}</button>}
              {!showBcc && <button type="button" className="btn btn-sm" onClick={() => setShowBcc(true)}>{t('mailboxAddBcc')}</button>}
            </div>
          )}
          {initial?.forwardHint && <div className="muted field full" style={{ fontSize: 12 }}>{t('mailboxForwardHint')}</div>}
          <div className="field full"><label>{t('mailboxSubject')}</label><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
          <AttachmentField value={attachments} onChange={setAttachments} />
          <div className="field"><label>{t('mailboxCategory')}</label>
            <SearchSelect value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="GENERAL">GENERAL</option>
              <option value="REPORT">REPORT</option>
              <option value="EXECUTION">EXECUTION</option>
              <option value="REQUEST">REQUEST</option>
              <option value="ALERT">ALERT</option>
            </SearchSelect>
          </div>
          <div className="field"><label>{t('mailboxPriority')}</label>
            <SearchSelect value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="LOW">LOW</option>
              <option value="NORMAL">NORMAL</option>
              <option value="HIGH">HIGH</option>
              <option value="URGENT">URGENT</option>
            </SearchSelect>
          </div>
          <div className="field full"><label>{t('mailboxMessage')}</label><textarea value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 140 }} /></div>
          <div className="field full mail-task-options">
            <label className="mail-check">
              <input type="checkbox" checked={actionRequired} onChange={(e) => setActionRequired(e.target.checked)} />
              {t('mailboxActionRequired')}
            </label>
            {actionRequired && (
              <label className="mail-due-field">
                {t('mailboxDue')}
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </label>
            )}
          </div>
          <div className="field full">
            <label>{t('mailboxScheduleSend')}</label>
            <input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
            <span className="muted mail-schedule-hint">
              {schedule ? t('mailboxScheduleHint') : t('mailboxScheduleNow')}
            </span>
          </div>
        </div>
      </div>
      <div className="mail-compose-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => save('DRAFT')}>{t('mailboxSaveDraft')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => save('QUEUED')}>{t('mailboxQueue')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save('SENT')}>
          {schedule && new Date(schedule) > new Date() ? t('mailboxScheduleSend') : t('mailboxSend')}
        </button>
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

// Name a mailbox filter and save it for reuse.
function SaveSearchForm({ onSave }) {
  const [name, setName] = useState('');
  return (
    <div className="mail-label-create">
      <input value={name} maxLength={60} placeholder={t('mailboxSearchName')}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onSave(name.trim()); }} />
      <button type="button" className="btn btn-sm" disabled={!name.trim()} onClick={() => onSave(name.trim())}>{t('save')}</button>
    </div>
  );
}

// Create, rename and remove the account's private filing labels.
function LabelManager({ labels, onChanged }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState(null);

  async function create() {
    if (!name.trim()) return;
    try { await api.post('/mailbox/labels', { name: name.trim() }); setName(''); setErr(null); await onChanged(); }
    catch (e) { setErr(e.message); }
  }

  async function rename(label) {
    try { await api.put(`/mailbox/labels/${label.id}`, { name: editing.name }); setEditing(null); setErr(null); await onChanged(); }
    catch (e) { setErr(e.message); }
  }

  async function remove(label) {
    try { await api.del(`/mailbox/labels/${label.id}`); setErr(null); await onChanged(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="mail-label-manager">
      {err && <div className="muted mail-label-err">{err}</div>}
      <div className="mail-label-create">
        <input value={name} maxLength={40} placeholder={t('mailboxNewLabel')}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button type="button" className="btn btn-sm" onClick={create}>{t('mailboxAddLabel')}</button>
      </div>
      {labels.map((l) => (
        <div key={l.id} className="mail-label-row">
          <span className="mail-label-dot" style={{ background: l.color || '#64748b' }} />
          {editing && editing.id === l.id ? (
            <>
              <input className="mail-label-rename" value={editing.name} maxLength={40}
                onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') rename(l); }} />
              <button type="button" className="btn btn-sm" onClick={() => rename(l)}>{t('save')}</button>
            </>
          ) : (
            <>
              <span className="mail-label-name">{l.name}</span>
              <button type="button" className="btn btn-sm" onClick={() => setEditing({ id: l.id, name: l.name })}>{t('edit')}</button>
            </>
          )}
          <button type="button" className="btn btn-sm" onClick={() => remove(l)}>{t('delete')}</button>
        </div>
      ))}
    </div>
  );
}
