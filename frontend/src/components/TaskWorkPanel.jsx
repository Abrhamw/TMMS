import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '../api';
import { SearchSelect, Pill, Loading, ErrorNote, Modal } from '../components';
import { can, getStoredUser } from '../auth';
import ChecklistItem from './ChecklistItem';
import WorkPanelOverlay from './WorkPanelOverlay';
import ExecutionDetail from './ExecutionDetail';
import { describeTarget } from '../checklistFormat';
import { taskTypeLabel, priorityLabel } from '../labels';

const GPS_TOLERANCE = 500;

const NARROW_QUERY = '(max-width: 900px)';

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e) => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export default function TaskWorkPanel({ taskId, readOnly = false, reason, onClose, onChanged }) {
  const me = getStoredUser();
  const narrow = useNarrow();
  const [task, setTask] = useState(null);
  const [crews, setCrews] = useState([]);
  const [error, setError] = useState(null);
  const [notif, setNotif] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [crewPick, setCrewPick] = useState('');
  const [viewExec, setViewExec] = useState(null);
  const [cancelFlow, setCancelFlow] = useState(null);
  const [verifyForm, setVerifyForm] = useState({ result: 'PASS', summary: '', cost: '' });

  const assignableCrews = crews.filter((c) => c.assignable !== false);

  const canAssign = !readOnly && can(me, 'task:assign');
  const canManage = !readOnly && can(me, 'task:manage');
  const canStart = !readOnly && (can(me, 'task:start') || can(me, 'task:manage'));
  const canLead = !readOnly && (can(me, 'task:lead') || can(me, 'task:manage'));
  const canExecute = !readOnly && can(me, 'task:execute');
  const canVerify = !readOnly && can(me, 'task:verify');
  const canAmend = !readOnly && can(me, 'task:amend');
  const canAttach = !readOnly && can(me, 'attachment:write');

  const load = () => api.get(`/tasks/${taskId}`).then((t) => { setTask(t); setError(null); setCrewPick(t.crew_id || ''); }).catch((e) => setError(e.message));
  useEffect(() => {
    setTask(null); setChecklist(null); setTpl(null); setError(null);
    load();
    if (!readOnly) api.get('/crews').then(setCrews).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  async function act(action, extra) {
    try {
      await api.post(`/tasks/${taskId}/state`, { action, ...extra });
      setNotif(`Action "${action}" applied`);
      await load();
      if (onChanged) onChanged();
      setTimeout(() => setNotif(null), 2500);
      return true;
    } catch (e) { setError(e.message); return false; }
  }

  async function confirmCancel() {
    const reason = String(cancelFlow?.reason || '').trim();
    if (!reason) return;
    if (await act('cancel', { reason })) setCancelFlow(null);
  }

  async function runChecklist(templateId) {
    try {
      const data = await api.get(`/tasks/${taskId}/checklist`);
      const list = data.templates || (data.template ? [data.template] : []);
      const chosen = list.find((y) => y.id === templateId) || list[0];
      if (!chosen) { setError('Task has no checklist template'); return; }
      const items = {};
      chosen.items.forEach((it) => { items[it.id] = { value: null, comment: '' }; });
      setTpl(chosen);
      setChecklist(items);
    } catch (e) { setError(e.message); }
  }

  async function submitChecklist() {
    try {
      const items = Object.entries(checklist).map(([tid, v]) => ({ template_item_id: Number(tid), response_value: v.value, comment: v.comment }));
      const res = await api.post(`/tasks/${taskId}/checklist`, { template_id: tpl.id, items });
      setNotif(res.templates_done === false
        ? `Checklist result ${res.result} — other templates still pending, task not advanced`
        : res.advanced === false
          ? `Checklist result ${res.result} — required steps missing, task not advanced`
          : `Checklist submitted — result ${res.result}`);
      setChecklist(null); setTpl(null);
      await load();
      if (onChanged) onChanged();
      setTimeout(() => setNotif(null), 3000);
    } catch (e) { setError(e.message); }
  }

  async function saveFinding(f) {
    try { await api.post(`/tasks/${taskId}/findings`, f); await load(); if (onChanged) onChanged(); }
    catch (e) { setError(e.message); }
  }

  async function uploadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = String(reader.result || '').split(',')[1] || '';
        const isImg = String(file.type || '').startsWith('image/');
        await api.post(`/tasks/${taskId}/attachments`, { file_name: file.name, mime: file.type || 'application/octet-stream', kind: isImg ? 'PHOTO' : 'DOC', data, note: '' });
        await load();
      } catch (e) { setError(e.message); }
    };
    reader.readAsDataURL(file);
  }

  const t = task;
  const tgt = t ? describeTarget(t.target) : {};
  const body = !t
    ? (error ? <ErrorNote error={error} /> : <Loading />)
    : (
    <>
      {notif && <div className="alert alert-success">{notif}</div>}
      {error && <ErrorNote error={error} />}

      <div className="kv">
        <span className="k">Status</span><span><Pill value={t.status} /></span>
        <span className="k">Type</span><span>{taskTypeLabel(t.task_type)}</span>
        <span className="k">Priority</span><span>{priorityLabel(t.priority)}</span>
        <span className="k">Due</span><span>{fmtDateTime(t.due_date)}</span>
        <span className="k">Region</span><span>{t.region?.name || '—'}</span>
        <span className="k">Asset worked on</span><span>{tgt.asset || '—'}</span>
        <span className="k">Infrastructure</span><span>{tgt.infrastructure || '—'}</span>
        <span className="k">Crew</span><span>{t.crew?.name || '—'}</span>
        <span className="k">Checklist</span><span>{(t.checklist_templates?.length ? t.checklist_templates : (t.checklist_template ? [t.checklist_template] : [])).map((c) => c.name).join(', ') || '—'}</span>
        <span className="k">Result</span><span>{t.result || '—'}</span>
      </div>
      <p className="muted">{t.description || 'No description.'}</p>
      {t.completion_summary && <p className="muted"><b>Completion summary:</b> {t.completion_summary}</p>}
      {t.cancel_reason && <p className="muted"><b>Cancellation record:</b> {t.cancel_reason} · {t.cancelled_by_name || 'Unknown user'} · {fmtDateTime(t.cancelled_at)}</p>}
      {!readOnly && reason && <p className="muted"><b>Reason:</b> {reason}</p>}

      {!readOnly && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {t.status === 'DRAFT' && (canAssign || canManage) && <button className="btn btn-primary" onClick={() => act('schedule')}>Schedule task</button>}
          {t.status === 'SCHEDULED' || (t.status === 'ASSIGNED' && !t.crew_id) ? canAssign && (
            <div className="flex">
              <SearchSelect value={crewPick} onChange={(e) => setCrewPick(e.target.value)}>
                <option value="">Choose crew…</option>
                {assignableCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SearchSelect>
              <button className="btn btn-primary" disabled={!crewPick} onClick={() => act('assign', { crew_id: Number(crewPick) })}>Assign</button>
            </div>
          ) : null}
          {t.status === 'ASSIGNED' && canStart && <button className="btn btn-primary" onClick={() => act('start')}>Start work</button>}
          {t.status === 'IN_PROGRESS' && (
            <>
              {canExecute && (t.checklist_templates?.length ? t.checklist_templates : (t.checklist_template ? [t.checklist_template] : [])).map((ct) => {
                const doneRun = (t.executions || []).some((e) => e.template_id === ct.id && e.submitted_at && e.result && e.result !== 'INCOMPLETE');
                return (
                  <button key={ct.id} className={doneRun ? 'btn' : 'btn btn-primary'} onClick={() => runChecklist(ct.id)}>
                    {doneRun ? 'Re-run' : 'Run'} checklist: {ct.name}
                  </button>
                );
              })}
              {canLead && <button className="btn btn-primary" onClick={() => act('submit')}>Submit for verification</button>}
              {canLead && <button className="btn" onClick={() => act('hold')}>Hold (blocked)</button>}
            </>
          )}
          {t.status === 'ON_HOLD' && canLead && <button className="btn btn-primary" onClick={() => act('resume')}>Resume work</button>}
          {t.status === 'PENDING_VERIFICATION' && canVerify && (
            <>
              <div className="field"><label>Result</label>
                <SearchSelect value={verifyForm.result} onChange={(e) => setVerifyForm({ ...verifyForm, result: e.target.value })}>
                  <option>PASS</option><option>FAIL</option><option>PARTIAL</option><option>DEFERRED</option>
                </SearchSelect>
              </div>
              <div className="field"><label>Completion summary</label><textarea value={verifyForm.summary} onChange={(e) => setVerifyForm({ ...verifyForm, summary: e.target.value })} /></div>
              <div className="field"><label>Cost (optional)</label><input type="number" min="0" step="0.01" value={verifyForm.cost ?? ''} onChange={(e) => setVerifyForm({ ...verifyForm, cost: e.target.value })} /></div>
              <button className="btn btn-primary" onClick={() => act('verify', { result: verifyForm.result, completion_summary: verifyForm.summary, cost: verifyForm.cost === '' ? null : Number(verifyForm.cost) })}>Verify &amp; complete</button>
            </>
          )}
          {t.status === 'PENDING_VERIFICATION' && canLead && <button className="btn" onClick={() => act('reopen')}>Reopen (rework)</button>}
          {!['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) && canManage && <button className="btn btn-danger" onClick={() => setCancelFlow({ step: 1, reason: '' })}>Cancel task</button>}
        </div>
      )}

      {!readOnly && canAmend && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) && (
        <button className="btn btn-sm btn-primary mt" onClick={() => saveFinding({ severity: 'MEDIUM', title: 'On-site finding', detail: '' })}>+ Quick finding</button>
      )}

      {!readOnly && canAttach && (
        <label className="btn btn-sm mt" style={{ cursor: 'pointer' }}>
          + Add photo / file
          <input type="file" style={{ display: 'none' }} onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      )}

      {(t.gps_validations || []).length > 0 && (
        <div className="box mt">
          {t.gps_validations.map((g, i) => (
            <div key={i} className="muted" style={{ fontSize: 12 }}>
              <b className={g.result === 'PASS' ? 'ok' : g.result === 'FAIL' ? 'bad' : 'warn'}>{g.result}</b>{' '}
              dist {Math.round(g.distance_m ?? 0)} m / tol {g.tolerance_m} m · {fmtDateTime(g.validated_at)}
            </div>
          ))}
        </div>
      )}

      {(t.executions || []).length > 0 && (
        <div className="mt">
          <div className="muted" style={{ fontSize: 12 }}>Executed checklists on this task — open to read or print:</div>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {t.executions.map((e) => (
              <button key={e.id} className="btn btn-sm" onClick={() => setViewExec(e)} title="View and print the executed checklist">
                {e.result || 'INCOMPLETE'} · {fmtDate(e.submitted_at)}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const inChecklist = checklist !== null && !readOnly;

  const content = (
    <>
      <div className="work-panel-head">
        <div>
          <b>{t ? t.task_number : 'Task'} — {t ? t.title : ''}</b>
        </div>
        <div className="flex">
          <a className="btn btn-sm" href={`/tasks/${taskId}`}>Open full task</a>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>

      {inChecklist ? (
        <div className="work-panel-checklist">
          <div className="spread"><b>Checklist</b><button className="btn btn-sm" onClick={() => { setChecklist(null); setTpl(null); }}>Cancel</button></div>
          {tpl.items.map((it) => (
            <div key={it.id} className="box mt">
              <b>{it.sequence}. {it.instruction}</b>
              <div className="muted" style={{ fontSize: 12 }}>{it.section || '—'}{it.test_equipment ? ` · Equipment: ${it.test_equipment}` : ''}</div>
              <div className="mt">
                <ChecklistItem item={it} state={checklist[it.id]} setState={(s) => setChecklist({ ...checklist, [it.id]: s })} />
              </div>
            </div>
          ))}
          <div className="work-panel-actions">
            <button className="btn btn-primary" onClick={submitChecklist}>Submit execution</button>
          </div>
        </div>
      ) : body}

      {viewExec && <ExecutionDetail exec={viewExec} onClose={() => setViewExec(null)} />}
      {cancelFlow && (
        <Modal title="Cancel task" onClose={() => setCancelFlow(null)}
          footer={cancelFlow.step === 1 ? (
            <>
              <button className="btn" onClick={() => setCancelFlow(null)}>Keep task</button>
              <button className="btn btn-danger" disabled={!cancelFlow.reason.trim()} onClick={() => setCancelFlow({ ...cancelFlow, step: 2 })}>Continue</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setCancelFlow({ ...cancelFlow, step: 1 })}>Back</button>
              <button className="btn btn-danger" onClick={confirmCancel}>Confirm cancellation</button>
            </>
          )}>
          {cancelFlow.step === 1 ? (
            <div className="field">
              <label>Cancellation comment</label>
              <textarea value={cancelFlow.reason} onChange={(e) => setCancelFlow({ ...cancelFlow, reason: e.target.value })} placeholder="Why is this task being cancelled?" />
              <div className="muted" style={{ fontSize: 12 }}>A comment is required and retained in the task history.</div>
            </div>
          ) : (
            <div className="box">
              <b>Confirm cancellation</b>
              <div className="muted mt">{cancelFlow.reason}</div>
              <div className="muted mt" style={{ fontSize: 12 }}>Only an administrator can retrieve this task afterwards.</div>
            </div>
          )}
        </Modal>
      )}
    </>
  );

  return (inChecklist || narrow) ? <WorkPanelOverlay>{content}</WorkPanelOverlay> : <div className="work-panel">{content}</div>;
}
