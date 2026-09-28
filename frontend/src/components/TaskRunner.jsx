import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '../api';
import { Pill, Loading, ErrorNote } from '../components';
import { can, getStoredUser } from '../auth';
import { priorityLabel, taskTypeLabel, statusLabel } from '../labels';
import { getDevicePosition } from './MapPicker';
import ChecklistItem from './ChecklistItem';
import ReadinessNotes from './ReadinessNotes';
import { t } from '../i18n';

// One guided execution surface for a crew member or lead: start work, run the
// checklist, capture the finishing location and photos, then hand off. It wraps
// the same task endpoints the full Task Detail page uses, but presents a single
// obvious next step instead of eight sections.
export default function TaskRunner({ taskId, onClose, onChanged }) {
  const me = getStoredUser();
  const canExecute = can(me, 'task:execute');
  const canStart = can(me, 'task:start') || can(me, 'task:manage');
  const canLead = can(me, 'task:lead') || can(me, 'task:manage');
  const canAttach = can(me, 'attachment:write');

  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const [notif, setNotif] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [gps, setGps] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/tasks/${taskId}`).then((x) => { setTask(x); setError(null); }).catch((e) => setError(e.message));

  useEffect(() => {
    setTask(null); setTpl(null); setChecklist(null); setGps(null); setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  function flash(msg, ms = 3200) {
    setNotif(msg);
    setTimeout(() => setNotif(null), ms);
  }

  async function act(action, extra) {
    try {
      setBusy(true);
      await api.post(`/tasks/${taskId}/state`, { action, ...extra });
      await load();
      if (onChanged) onChanged();
      flash(t('updated'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function openChecklist() {
    try {
      const data = await api.get(`/tasks/${taskId}/checklist`);
      const items = {};
      data.template.items.forEach((it) => { items[it.id] = { value: null, comment: '' }; });
      setTpl(data.template);
      setChecklist(items);
    } catch (e) { setError(e.message); }
  }

  async function submitRun() {
    try {
      setBusy(true);
      const items = Object.entries(checklist).map(([tid, v]) => ({ template_item_id: Number(tid), response_value: v.value, comment: v.comment }));
      const body = { items };
      if (gps) body.finish_gps = gps;
      const res = await api.post(`/tasks/${taskId}/checklist`, body);
      setTpl(null); setChecklist(null);
      await load();
      if (onChanged) onChanged();
      if (canLead) flash(`${t('result')}: ${res.result}`);
      else flash(t('waitingLead'), 4200);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function capture() {
    try {
      setBusy(true);
      const p = await getDevicePosition();
      setGps({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy });
      flash(t('locationCaptured'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function uploadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setBusy(true);
        const data = String(reader.result || '').split(',')[1] || '';
        const isImg = String(file.type || '').startsWith('image/');
        await api.post(`/tasks/${taskId}/attachments`, { file_name: file.name, mime: file.type || 'application/octet-stream', kind: isImg ? 'PHOTO' : 'DOC', data, note: '' });
        await load();
        if (onChanged) onChanged();
      } catch (e) { setError(e.message); }
      finally { setBusy(false); }
    };
    reader.readAsDataURL(file);
  }

  if (error && !task) return <div className="work-panel work-panel--modal"><ErrorNote error={error} /><button className="btn btn-sm mt" onClick={onClose}>{t('cancel')}</button></div>;
  if (!task) return <div className="work-panel work-panel--modal"><Loading /></div>;

  const x = task;
  const where = x.tower?.tower_id || x.asset?.name || x.substation?.name || x.line?.name || '—';
  const answered = checklist
    ? tpl.items.filter((it) => {
        const v = checklist[it.id]?.value;
        return v !== null && v !== undefined && v !== '';
      }).length
    : 0;
  const total = tpl ? tpl.items.length : 0;
  const done = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(x.status);
  const inRun = checklist !== null;

  return (
    <div className="work-panel work-panel--modal">
      <div className="work-panel-head">
        <div>
          <b>{x.task_number} — {x.title}</b>
          <div className="muted" style={{ fontSize: 12 }}>{taskTypeLabel(x.task_type)} · {priorityLabel(x.priority)}</div>
        </div>
        <div className="flex">
          <a className="btn btn-sm" href={`/tasks/${taskId}`}>{t('openFullTask')}</a>
          <button className="btn btn-sm" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>

      {notif && <div className="alert alert-success">{notif}</div>}
      {error && <ErrorNote error={error} />}

      <div className="kv">
        <span className="k">{t('status')}</span><span><Pill value={x.status} /></span>
        <span className="k">{t('type')}</span><span>{taskTypeLabel(x.task_type)}</span>
        <span className="k">{t('priority')}</span><span>{priorityLabel(x.priority)}</span>
        <span className="k">{t('due')}</span><span>{fmtDateTime(x.due_date)}</span>
        <span className="k">{t('region')}</span><span>{x.region?.name || '—'}</span>
        <span className="k">{t('assignedTo')}</span><span>{x.crew?.name || '—'}</span>
        <span className="k">{t('checklist')}</span><span>{x.checklist_template?.name || '—'}</span>
      </div>
      <p className="muted">{x.description || x.title}</p>
      <ReadinessNotes taskId={taskId} />

      {inRun ? (
        <div className="mt">
          <div className="spread">
            <b>{t('runChecklist')}</b>
            <span className="muted">{answered} / {total}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            {t('checklistProgress')}: {total ? Math.round((answered / total) * 100) : 0}%
          </div>
          {tpl.items.map((it) => (
            <div key={it.id} className="box mt">
              <b>{it.sequence}. {it.instruction}</b>
              <div className="muted" style={{ fontSize: 12 }}>{it.section || '—'}{it.test_equipment ? ` · ${it.test_equipment}` : ''}</div>
              <div className="mt">
                <ChecklistItem item={it} state={checklist[it.id]} setState={(s) => setChecklist({ ...checklist, [it.id]: s })} />
              </div>
            </div>
          ))}
          <div className="mt">
            <button className="btn btn-sm" onClick={capture} disabled={busy}>{t('useDeviceLocation')}</button>
            {gps && <span className="muted" style={{ marginLeft: 8 }}>{Number(gps.lat).toFixed(5)}, {Number(gps.lng).toFixed(5)} · {t('accuracy')} {gps.accuracy_m} m</span>}
          </div>
          <div className="flex mt">
            <button className="btn btn-primary" onClick={submitRun} disabled={busy}>{x.status === 'ASSIGNED' ? t('startWork') : t('submitTask')}</button>
            <button className="btn" onClick={() => { setChecklist(null); setTpl(null); }} disabled={busy}>{t('cancel')}</button>
          </div>
        </div>
      ) : (
        <div className="mt" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Step
            n={1}
            title={t('runChecklist')}
            detail={x.checklist_template ? x.checklist_template.name : t('noData')}
          >
            {x.status === 'ASSIGNED' && canStart && (
              <button className="btn btn-primary" onClick={() => act('start')} disabled={busy}>{t('startWork')}</button>
            )}
            {x.status === 'ASSIGNED' && !canStart && (
              <span className="muted">{t('waitingLead')}</span>
            )}
            {x.status === 'IN_PROGRESS' && x.checklist_template_id && canExecute && (
              <button className="btn btn-primary" onClick={openChecklist} disabled={busy}>{t('runChecklist')}</button>
            )}
            {!done && x.status !== 'ASSIGNED' && !x.checklist_template_id && <span className="muted">{t('noData')}</span>}
          </Step>

          <Step n={2} title={t('locationCheck')} detail={gps ? `${Number(gps.lat).toFixed(5)}, ${Number(gps.lng).toFixed(5)} · ${t('accuracy')} ${gps.accuracy_m} m` : t('captureGps')}>
            <button className="btn btn-sm" onClick={capture} disabled={busy}>{t('useDeviceLocation')}</button>
          </Step>

          <Step n={3} title={t('photoEvidence')} detail={`${(x.attachments || []).length}`}>
            {canAttach && (
              <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                + {t('photoEvidence')}
                <input type="file" style={{ display: 'none' }} onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            )}
            {(x.attachments || []).length > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {(x.attachments || []).slice(0, 4).map((a) => a.file_name).join(' · ')}
              </div>
            )}
          </Step>

          <Step n={4} title={t('handOff')} detail={statusLabel(x.status)}>
            {x.status === 'IN_PROGRESS' && canLead && (
              <button className="btn btn-primary" onClick={() => act('submit')} disabled={busy}>{t('submitTask')}</button>
            )}
            {x.status === 'IN_PROGRESS' && !canLead && <span className="muted">{t('waitingLead')}</span>}
            {x.status === 'ON_HOLD' && canLead && (
              <button className="btn btn-primary" onClick={() => act('resume')} disabled={busy}>{t('resumeTask')}</button>
            )}
            {x.status === 'PENDING_VERIFICATION' && <span className="muted">{t('stPendingVerification')}</span>}
            {x.status === 'PENDING_VERIFICATION' && canLead && (
              <button className="btn btn-sm mt" onClick={() => act('reopen')} disabled={busy}>{t('reopenTask')}</button>
            )}
            {done && <span className="muted">{t('result')}: {x.result || statusLabel(x.status)}</span>}
          </Step>
        </div>
      )}

      {(x.executions || []).length > 0 && (
        <div className="muted mt" style={{ fontSize: 12 }}>
          {x.executions.map((e) => `${e.result || '—'} @ ${fmtDateTime(e.submitted_at)}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, detail, children }) {
  return (
    <div className="card card-pad">
      <div className="spread">
        <b>{n}. {title}</b>
        <span className="muted" style={{ fontSize: 12 }}>{detail}</span>
      </div>
      {children && <div className="mt">{children}</div>}
    </div>
  );
}
