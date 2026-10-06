import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, asArray } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, PrintButton, Progress } from '../components';
import { can, getStoredUser, getStoredToken } from '../auth';
import DocumentReport from '../components/DocumentReport';
import ExecutionDetail from '../components/ExecutionDetail';
import { t } from '../i18n';
import { getDevicePosition } from '../components/MapPicker';
import Comments from '../components/Comments';
import ViewMap from '../components/ViewMap';
import LineWorkspaceMap from '../components/LineWorkspaceMap';
import { entityColor, maxVoltageKv, isEnergized, parseVoltageLevels, voltageChip, popupRows, boundaryRing } from '../mapFocus';
import useRouteRecorder from '../useRouteRecorder';

const GPS_TOLERANCE = 500;
const haversineM = (la1, lo1, la2, lo2) => {
  const R = 6371000;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLng = ((lo2 - lo1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

export default function TaskDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const me = getStoredUser();
  const isAdmin = me?.role === 'ADMIN';
  const canAssign = can(me, 'task:assign');
  const canExecute = can(me, 'task:execute');
  const canVerify = can(me, 'task:verify');
  const canManage = can(me, 'task:manage');
  const canStart = can(me, 'task:start') || can(me, 'task:manage');
  const canSubmit = can(me, 'task:lead') || can(me, 'task:manage');
  const canAmend = can(me, 'task:amend');
  const canAttach = can(me, 'attachment:write');
  const canReport = can(me, 'report:write');
  const canCreate = can(me, 'task:create');
  const [task, setTask] = useState(null);
  const [tpl, setTpl] = useState(null);
  const [error, setError] = useState(null);
  const [checklist, setChecklist] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [verifyForm, setVerifyForm] = useState({ result: 'PASS', summary: '', cost: '' });
  const [notif, setNotif] = useState(null);
  const [findingForm, setFindingForm] = useState(null);
  const [cancelFlow, setCancelFlow] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [fuBusyKey, setFuBusyKey] = useState(null);
  const [checklists, setChecklists] = useState([]);
  const [fuTemplate, setFuTemplate] = useState({});
  const [trace, setTrace] = useState(null);
  const [lineDetail, setLineDetail] = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [equipmentDraft, setEquipmentDraft] = useState({});
  const [equipmentBusy, setEquipmentBusy] = useState(false);
  const [equipmentComment, setEquipmentComment] = useState('');
  const [assignOptions, setAssignOptions] = useState(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [editCrewId, setEditCrewId] = useState('');
  const [editChecklistIds, setEditChecklistIds] = useState([]);
  const [editBusy, setEditBusy] = useState(false);
  const [viewExec, setViewExec] = useState(null);
  const [documentBusy, setDocumentBusy] = useState(false);

  const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED', 'FAILED'];

  const FALLBACK_TITLE = 'Task Detail';
  const KIND_CHIP = { CHECKLIST: 'kind-checklist', FINDING: 'kind-finding', GPS: 'kind-gps' };

  const load = () => api.get(`/tasks/${id}`).then(setTask).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/checklists').then(setChecklists).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Non-blocking dispatch advisory for the task's checklist: required team /
  // skills and, when a crew is assigned, how well it matches.
  useEffect(() => {
    if (!task || !task.checklist_template_id) { setDispatch(null); return; }
    api.get(`/crews/eligibility?task_id=${id}`)
      .then((rows) => {
        const row = (rows || []).find((r) => r.dispatch_requirements);
        if (!row) { setDispatch(null); return; }
        setDispatch({ reqs: row.dispatch_requirements, mine: row.resolved_via ? row : null });
      })
      .catch(() => setDispatch(null));
  }, [task?.checklist_template_id, task?.crew_id, id]);

  // Semi-automatic assignment: rank the crews this user may assign against the
  // task's checklist requirements, best first. Refreshed whenever the task's
  // crew or checklist changes.
  useEffect(() => {
    if (!task || !canAssign) { setAssignOptions(null); return; }
    api.get(`/tasks/${id}/assign-options`).then(setAssignOptions).catch(() => setAssignOptions(null));
  }, [task?.crew_id, task?.checklist_template_id, task?.status, canAssign, id]);

  useEffect(() => {
    if (!task) return;
    setEditCrewId(task.crew_id || '');
    setEditChecklistIds((task.checklist_templates || []).map((x) => x.id));
  }, [task?.crew_id, task?.checklist_templates, task]);

  useEffect(() => {
    const checks = task?.readiness?.equipment_checks || [];
    setEquipmentDraft(Object.fromEntries(checks.map((item) => [item.equipment, item.available])));
  }, [task?.id, task?.readiness?.equipment_checks]);

  const lineId = task && task.line_id;
  const loadTrace = () => {
    if (!lineId) { setTrace(null); return; }
    api.get(`/tasks/${id}/trace`).then(setTrace).catch(() => setTrace(null));
  };

  useEffect(() => {
    if (!lineId) { setTrace(null); setLineDetail(null); return; }
    loadTrace();
    api.get(`/lines/${lineId}`).then(setLineDetail).catch(() => setLineDetail(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, id]);

  const recorder = useRouteRecorder(id, loadTrace);

  async function fetchChecklist(templateId) {
    try {
      const data = await api.get(`/tasks/${id}/checklist`);
      const list = data.templates || (data.template ? [data.template] : []);
      const chosen = list.find((x) => x.id === templateId) || list[0];
      if (!chosen) { setError('Task has no checklist template'); return; }
      setTpl(chosen);
      // Resume a previously saved draft: restore each item's captured value and
      // comment so field crews can carry on where they left off.
      const draftByItem = new Map((chosen.draft?.items || []).map((d) => [Number(d.template_item_id), d]));
      const items = {};
      chosen.items.forEach((it) => {
        const d = draftByItem.get(it.id);
        items[it.id] = { value: d ? d.response_value ?? null : null, comment: d?.comment || '' };
      });
      setChecklist(items);
      setVerifyForm({ ...verifyForm, summary: task?.completion_summary || '' });
      if (chosen.draft) setNotif('Resumed saved checklist draft');
    } catch (e) { setError(e.message); }
  }

  // Persist the current checklist capture as a draft (no submit, no advancement).
  async function saveChecklistDraft() {
    if (!tpl || !checklist) return;
    setDraftBusy(true);
    try {
      const items = Object.entries(checklist).map(([tid, v]) => ({ template_item_id: Number(tid), response_value: v.value, comment: v.comment }));
      await api.post(`/tasks/${id}/checklist/draft`, { template_id: tpl.id, items });
      setNotif('Checklist draft saved');
      setTimeout(() => setNotif(null), 2500);
    } catch (e) { setError(e.message); } finally { setDraftBusy(false); }
  }

  async function act(action, extra) {
    try {
      await api.post(`/tasks/${id}/state`, { action, ...extra });
      // Line inspection: tracing starts with the work and stops when the crew
      // submits for verification or parks the task on hold.
      if (action === 'start' && lineId) recorder.start();
      if ((action === 'submit' || action === 'hold') && recorder.recording) recorder.stop();
      setNotif(`Action "${action}" applied`);
      load();
      setTimeout(() => setNotif(null), 2500);
    } catch (e) { setError(e.message); }
  }

  // Assign or re-assign a crew. A task still waiting for a crew moves through
  // the normal assign transition; anything already crewed is re-pointed with a
  // plain edit so its status is untouched.
  async function commitAssign(crewId) {
    if (!crewId) return;
    setAssignBusy(true);
    try {
      const pending = task.status === 'DRAFT' || task.status === 'SCHEDULED' || (task.status === 'ASSIGNED' && !task.crew_id);
      if (pending) await api.post(`/tasks/${id}/state`, { action: 'assign', crew_id: Number(crewId) });
      else await api.put(`/tasks/${id}`, { crew_id: Number(crewId) });
      setNotif('Crew assigned');
      load();
      setTimeout(() => setNotif(null), 2500);
    } catch (e) { setError(e.message); } finally { setAssignBusy(false); }
  }

  // Change the checklist template on an existing task (task:manage).
  async function saveAssignment() {
    setEditBusy(true);
    try {
      const body = {};
      if (editCrewId !== String(task.crew_id || '')) body.crew_id = editCrewId ? Number(editCrewId) : null;
      const before = (task.checklist_templates || []).map((x) => x.id).sort((a, b) => a - b).join(',');
      const after = [...editChecklistIds].sort((a, b) => a - b).join(',');
      if (before !== after) body.checklist_template_ids = editChecklistIds;
      if (Object.keys(body).length) {
        await api.put(`/tasks/${id}`, body);
        setNotif('Assignment updated');
        load();
        setTimeout(() => setNotif(null), 2500);
      }
    } catch (e) { setError(e.message); } finally { setEditBusy(false); }
  }

  async function saveEquipmentChecks() {
    if (!task) return;
    setEquipmentBusy(true);
    try {
      const checks = (task.readiness?.equipment_checks || []).map((item) => ({
        equipment: item.equipment,
        available: equipmentDraft[item.equipment] === true,
      }));
      await api.put(`/tasks/${id}/equipment-checks`, { checks });
      setNotif('Equipment availability saved');
      load();
      setTimeout(() => setNotif(null), 2500);
    } catch (e) { setError(e.message); } finally { setEquipmentBusy(false); }
  }

  async function submitChecklist() {
    try {
      const items = Object.entries(checklist).map(([tid, v]) => ({ template_item_id: Number(tid), response_value: v.value, comment: v.comment }));
      const res = await api.post(`/tasks/${id}/checklist`, { template_id: tpl.id, items });
      setNotif(res.templates_done === false
        ? `Checklist result ${res.result} — other templates still pending, task not advanced`
        : res.advanced === false
          ? `Checklist result ${res.result} — required steps missing, task not advanced`
          : `Checklist submitted — result ${res.result}`);
      setChecklist(null);
      setTpl(null);
      load();
      setTimeout(() => setNotif(null), 3000);
    } catch (e) { setError(e.message); }
  }

  async function genTaskReport() {
    try {
      setReportBusy(true);
      setReportData(null);
      const res = await api.post('/reports/generate', { report_type: 'TASK_DETAIL', task_id: task.id });
      setReportData(res.data);
    } catch (e) { setError(e.message); }
    finally { setReportBusy(false); }
  }

  // Read-only document: available to anyone who can see the task, regardless of
  // report:write. This is what the "Task document" section links to.
  async function viewDocument() {
    try {
      setDocumentBusy(true);
      setReportData(null);
      const res = await api.get(`/reports/document?type=TASK_DETAIL&id=${task.id}`);
      setReportData(res.data ?? res);
    } catch (e) { setError(e.message); }
    finally { setDocumentBusy(false); }
  }

  async function createFollowUp(key) {
    try {
      setFuBusyKey(key);
      const picked = fuTemplate[key];
      const body = { key };
      // undefined = carry the source task's whole checklist selection.
      if (picked === '__none__') body.checklist_template_ids = [];
      else if (picked !== undefined && picked !== null && picked !== '') body.checklist_template_ids = [Number(picked)];
      await api.post(`/tasks/${task.id}/follow-ups`, body);
      load();
    } catch (e) { setError(e.message); }
    finally { setFuBusyKey(null); }
  }

  const canToggleItems = canExecute || canSubmit || canManage;
  async function toggleWorkItem(item, status) {
    try {
      await api.patch(`/tasks/${task.id}/work-items/${item.id}`, { status });
      load();
    } catch (e) { setError(e.message); }
  }

  async function verify() {
    try {
      await act('verify', {
        result: verifyForm.result,
        completion_summary: verifyForm.summary,
        cost: verifyForm.cost === '' ? null : Number(verifyForm.cost),
      });
      setVerifyForm({ result: 'PASS', summary: '', cost: '' });
    } catch (e) { setError(e.message); }
  }

  async function saveFinding() {
    try {
      await api.post(`/tasks/${id}/findings`, findingForm);
      setFindingForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  // Step 2 of the cancellation flow: the operator has reviewed the comment and
  // explicitly confirmed. The reason is required by the API.
  async function confirmCancel() {
    const reason = (cancelFlow?.reason || '').trim();
    if (!reason) return;
    setCancelFlow(null);
    await act('cancel', { reason });
  }

  async function retrieveTask() {
    await act('retrieve');
  }

  async function onUploadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        setUploadBusy(true);
        const data = String(reader.result || '').split(',')[1] || '';
        const isImg = String(file.type || '').startsWith('image/');
        await api.post(`/tasks/${id}/attachments`, {
          file_name: file.name,
          mime: file.type || 'application/octet-stream',
          kind: isImg ? 'PHOTO' : 'DOC',
          data,
          note: '',
        });
        load();
      } catch (e) { setError(e.message); }
      finally { setUploadBusy(false); }
    };
    reader.readAsDataURL(file);
  }

  if (error) return <Page title={FALLBACK_TITLE}><ErrorNote error={error} /></Page>;
  if (!task) return <Page title={FALLBACK_TITLE}>{error ? <ErrorNote error={error} /> : <Loading />}</Page>;

  const t = task;

  const targetPos = (() => {
    if (t.asset && typeof t.asset.latitude === 'number') {
      const a = t.asset;
      const kv = (a.line && a.line.voltage_kv) ?? (a.substation ? maxVoltageKv(a.substation.voltage_levels) : null);
      const status = a.operational_status || 'OPERATIONAL';
      const yardRing = boundaryRing(a.substation && a.substation.boundary_json);
      return {
        lat: a.latitude,
        lng: a.longitude,
        label: a.name,
        color: entityColor(kv, status),
        polygons: yardRing ? [{ points: yardRing, color: entityColor(kv, status), label: `${a.substation.name} yard` }] : [],
        popup: `<div class="tmms-pop"><b>${a.name}</b> ${voltageChip(kv, { energized: isEnergized(status) })}` +
          `<div class="tmms-pop-sub">${a.asset_id}${a.sub_type ? ` · ${a.sub_type}` : ''}</div>` +
          popupRows([
            ['Type', a.asset_type],
            ['Substation', a.substation?.name],
            ['Line', a.line?.name],
            ['Condition', a.condition_rating != null ? `${a.condition_rating}/10` : null],
            ['Criticality', a.criticality],
            ['Status', status],
          ]) + '</div>',
      };
    }
    if (t.tower && typeof t.tower.latitude === 'number') {
      const kv = t.line ? t.line.voltage_kv : null;
      const status = (t.line && t.line.operational_status) || 'OPERATIONAL';
      return {
        lat: t.tower.latitude,
        lng: t.tower.longitude,
        label: `${t.tower.tower_id} (Tower)`,
        color: entityColor(kv, status),
        popup: `<div class="tmms-pop"><b>${t.tower.tower_id}</b> ${voltageChip(kv, { energized: isEnergized(status) })}` +
          `<div class="tmms-pop-sub">${t.line?.name || ''}</div>` +
          popupRows([
            ['Line', t.line?.name],
            ['Type', t.tower.tower_type],
            ['km marker', t.tower.km_marker],
            ['Height', t.tower.height_m != null ? `${t.tower.height_m} m` : null],
            ['Status', status],
          ]) + '</div>',
      };
    }
    if (t.substation && typeof t.substation.latitude === 'number') {
      const s = t.substation;
      const kv = maxVoltageKv(s.voltage_levels);
      const ring = boundaryRing(s.boundary_json);
      return {
        lat: s.latitude,
        lng: s.longitude,
        label: s.name,
        color: entityColor(kv, s.operational_status),
        polygons: ring ? [{ points: ring, color: entityColor(kv, s.operational_status), label: `${s.name} yard` }] : [],
        popup: `<div class="tmms-pop"><b>${s.name}</b> ${voltageChip(kv, { energized: isEnergized(s.operational_status) })}` +
          `<div class="tmms-pop-sub">${s.substation_id || ''}${s.substation_type ? ` · ${s.substation_type}` : ''}</div>` +
          popupRows([
            ['Voltage', parseVoltageLevels(s.voltage_levels).join(', ') || null],
            ['Status', s.operational_status],
          ]) + '</div>',
      };
    }
    if (t.line) {
      const route = Array.isArray(t.line.route_json) ? t.line.route_json : [];
      const mid = route.length ? route[Math.floor(route.length / 2)] : null;
      if (Array.isArray(mid) && mid.length >= 2 && mid[0] != null && mid[1] != null) {
        const l = t.line;
        return {
          lat: Number(mid[0]),
          lng: Number(mid[1]),
          label: l.name,
          color: entityColor(l.voltage_kv, l.operational_status),
          popup: `<div class="tmms-pop"><b>${l.name}</b> ${voltageChip(l.voltage_kv, { energized: isEnergized(l.operational_status) })}` +
            `<div class="tmms-pop-sub">${l.line_id || ''}</div>` +
            popupRows([
              ['Voltage', `${l.voltage_kv} kV`],
              ['Length', l.length_km != null ? `${l.length_km} km` : null],
              ['Conductor', l.conductor_type],
              ['Status', l.operational_status],
            ]) + '</div>',
        };
      }
    }
    return null;
  })();

  return (
    <Page title={`${t.task_number}`} crumbs={`TMMS / Operations / Tasks / ${t.task_number}`}
      actions={<>
        <PrintButton />
        <button className="btn" onClick={() => nav('/tasks')}>← Back to tasks</button>
      </>}>
      {notif && <div className="alert alert-success">{notif}</div>}
      {error && <ErrorNote error={error} />}

      <div className="task-detail-flow">
      <div className="task-detail-mapblock">
      {t.line_id ? (
        <>
          <div className="lw-toolbar">
            {t.status !== 'COMPLETED' && canExecute && (
              <button className="btn btn-sm" onClick={() => (recorder.recording ? recorder.stop() : recorder.start())}>
                {recorder.recording ? 'Stop route' : 'Record route'}
              </button>
            )}
            {recorder.recording && (
              <span className="muted">
                Recording · {recorder.count} points{recorder.accuracy != null ? ` · ±${recorder.accuracy} m` : ''}
              </span>
            )}
            {recorder.error && <span className="error">{recorder.error}</span>}
          </div>
          <LineWorkspaceMap
            route={asArray((lineDetail && lineDetail.route_json) || t.line?.route_json)}
            towers={((lineDetail && lineDetail.towers) || []).map((tw) => ({ ...tw, lat: tw.latitude, lng: tw.longitude, state: 'existing' }))}
            inspectedIds={trace && trace.coverage ? new Set(trace.coverage.inspected_tower_ids) : null}
            coveredPaths={(trace && trace.coverage && trace.coverage.covered_paths) || []}
            tracePoints={((trace && trace.points) || []).map((p) => [p.lat, p.lng])}
            lineId={t.line_id}
            lineInfo={t.line}
            targetTowerId={t.tower_id || null}
            flashRoute={!t.tower_id}
            autoFocusTarget={false}
            height={260}
          />
          {trace && trace.coverage && (
            <div className="line-progress">
              <div className="line-progress-head">
                <b>Inspection progress</b>
                <span className="muted">
                  {trace.coverage.inspected_towers}/{trace.coverage.total_towers} towers ·{' '}
                  {trace.coverage.inspected_km}/{Math.round((trace.coverage.total_km || 0) * 10) / 10} km ·{' '}
                  {Math.round((trace.coverage.tower_progress || 0) * 100)}%
                </span>
              </div>
              <div className="line-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round((trace.coverage.tower_progress || 0) * 100)}>
                <div className="line-progress-fill" style={{ width: `${Math.round((trace.coverage.tower_progress || 0) * 100)}%` }} />
              </div>
              <div className="line-progress-meta">
                <span>Line covered {Math.round((trace.coverage.km_progress || 0) * 100)}%</span>
                <span>Crew path {recorder.recording ? recorder.count : (trace.points || []).length} pts</span>
                <span className="line-progress-legend">
                  <i style={{ background: '#16a34a' }} /> covered
                  <i style={{ background: '#0d9488' }} /> inspected
                  <i style={{ background: '#94a3b8' }} /> remaining
                  <i style={{ background: '#ea580c' }} /> crew path
                </span>
              </div>
            </div>
          )}
        </>
      ) : targetPos && (
        <ViewMap
          height={200}
          center={targetPos}
          markers={[{ lat: targetPos.lat, lng: targetPos.lng, label: targetPos.label, sub: 'Work target', color: targetPos.color || '#dc2626', radius: 7, flash: true, popup: targetPos.popup }]}
          polygons={targetPos.polygons || []}
          radius={GPS_TOLERANCE}
          radiusLatLng={{ lat: targetPos.lat, lng: targetPos.lng }}
          zoom={12}
          fit={false}
        />
      )}
      </div>

      <div className="grid grid-3 mt">
        <div className="card card-pad" style={{ gridColumn: 'span 2' }}>
          <h3 className="section-title">{t.title}</h3>
          <p className="muted">{t.description || 'No description.'}</p>
          <div className="kv">
            <span className="k">Type</span><span>{t.task_type}</span>
            <span className="k">Priority</span><span style={{ fontWeight: 700 }}>{t.priority}</span>
            <span className="k">Status</span><span><Pill value={t.status} /></span>
            <span className="k">Source</span><span>{t.source}</span>
            <span className="k">Target</span><span>{t.tower ? `${t.tower.tower_id} (Tower)` : t.asset?.name || t.substation?.name || t.line?.name || '—'}</span>
            <span className="k">Region</span><span>{t.region?.name}</span>
            <span className="k">Crew</span><span>{t.crew?.name || '—'}</span>
            <span className="k">Checklist</span><span>{(t.checklist_templates?.length ? t.checklist_templates : (t.checklist_template ? [t.checklist_template] : [])).map((x) => x.name).join(', ') || '—'}</span>
            <span className="k">Due</span><span>{fmtDateTime(t.due_date)}</span>
            <span className="k">Started / Ended</span><span>{fmtDateTime(t.actual_start)} / {fmtDateTime(t.actual_end)}</span>
            <span className="k">Result</span><span>{t.result || '—'}</span>
            {t.cancel_reason && <>
              <span className="k">Cancellation record</span>
              <span>{t.cancel_reason}<div className="muted">{t.cancelled_by_name || 'Unknown user'} · {fmtDateTime(t.cancelled_at)}</div></span>
            </>}
          </div>
          {dispatch && (
            <div className={'box mt ' + (dispatch.mine && !dispatch.mine.eligible ? 'tone-warn' : 'tone-info')}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}>DISPATCH ADVISORY (NON-BLOCKING)</div>
              <div style={{ fontSize: 12 }}>
                Team: {dispatch.reqs.team.join('; ') || '—'} · Skills: {dispatch.reqs.skills.join(', ') || '—'}
              </div>
              <div style={{ fontSize: 12 }}>
                Required certs: {dispatch.reqs.required_certs.join(', ') || '—'}
                {dispatch.reqs.recommended_certs?.length ? ` · Recommended: ${dispatch.reqs.recommended_certs.join(', ')}` : ''}
              </div>
              {dispatch.mine ? (
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  {dispatch.mine.resolved_via === 'ASSIGNED' ? 'Assigned crew' : 'Suggested crew (target default)'} <b>{dispatch.mine.name}</b> — {dispatch.mine.eligible ? <span className="ok">capability matched</span> : <span className="warn">warnings</span>}
                  {dispatch.mine.missing_skills?.length ? <div>Missing skills: {dispatch.mine.missing_skills.join(', ')}</div> : null}
                  {dispatch.mine.missing_certs?.length ? <div>Missing certs: {dispatch.mine.missing_certs.join(', ')}</div> : null}
                  {dispatch.mine.certs_to_obtain?.length ? <div>Certs to obtain: {dispatch.mine.certs_to_obtain.map((c) => `${c.cert} (${c.required ? 'required' : 'recommended'})`).join(', ')}</div> : null}
                  {dispatch.mine.team_shortfall ? <div>Team short by {dispatch.mine.team_shortfall}</div> : null}
                  <div>Equipment to secure: {dispatch.mine.equipment_to_secure.join(', ') || '—'}</div>
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  No crew assigned yet. Certs to obtain: {(dispatch.reqs.cert_requirements || []).map((c) => `${c.cert} (${c.level.toLowerCase()})`).join(', ') || '—'} · Equipment to secure: {dispatch.reqs.equipment_to_secure.join(', ') || '—'}
                </div>
              )}
            </div>
          )}
          {(task.readiness?.equipment_checks || []).length > 0 && (
            <div className="box mt">
              <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                <b>Recommended equipment availability</b>
                {(canAssign || canExecute) && ['DRAFT', 'SCHEDULED', 'ASSIGNED'].includes(task.status) && (
                  <button className="btn btn-sm btn-primary" disabled={equipmentBusy} onClick={saveEquipmentChecks}>
                    {equipmentBusy ? 'Saving…' : 'Save checks'}
                  </button>
                )}
              </div>
              <div className="equip-check-list mt">
                {task.readiness.equipment_checks.map((item) => (
                  <label key={item.equipment} className="equip-check-row">
                    <input
                      type="checkbox"
                      checked={equipmentDraft[item.equipment] === true}
                      disabled={!(canAssign || canExecute) || !['DRAFT', 'SCHEDULED', 'ASSIGNED'].includes(task.status) || equipmentBusy}
                      onChange={(e) => setEquipmentDraft({ ...equipmentDraft, [item.equipment]: e.target.checked })}
                    />
                    <span>{item.equipment}</span>
                    <span className={equipmentDraft[item.equipment] === true ? 'ok' : item.answered ? 'warn' : 'muted'}>
                      {equipmentDraft[item.equipment] === true ? 'Available / used' : item.answered ? 'Missed' : 'Unanswered'}
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt">
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Comment on a specific item of equipment:</div>
                <SearchSelect value={equipmentComment} onChange={(e) => setEquipmentComment(e.target.value)}>
                  <option value="">— select equipment —</option>
                  {task.readiness.equipment_checks.map((item) => <option key={item.equipment} value={item.equipment}>{item.equipment}</option>)}
                </SearchSelect>
                {equipmentComment && (
                  <div className="mt"><Comments entityType="equipment" entityRef={equipmentComment} title={`Comments — ${equipmentComment}`} placeholder="Comment on this equipment…" /></div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="card card-pad">
          <h3 className="section-title">Workflow</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {t.status === 'DRAFT' && (canAssign || canManage) && <button className="btn btn-primary" onClick={() => act('schedule')}>Schedule task</button>}
            {(t.status === 'SCHEDULED' || (t.status === 'ASSIGNED' && !t.crew_id)) && canAssign && <button className="btn btn-primary" onClick={() => act('assign')}>Assign (keep/assign crew)</button>}
            {t.status === 'ASSIGNED' && canStart && <button className="btn btn-primary" onClick={() => act('start')}>Start work</button>}
            {t.status === 'IN_PROGRESS' && (canExecute || canSubmit) && <>
              {canExecute && (t.checklist_templates?.length ? t.checklist_templates : (t.checklist_template ? [t.checklist_template] : [])).map((ct) => {
                const done = (t.executions || []).some((e) => e.template_id === ct.id && e.submitted_at && e.result && e.result !== 'INCOMPLETE');
                return (
                  <button key={ct.id} className={done ? 'btn' : 'btn btn-primary'} onClick={() => fetchChecklist(ct.id)}>
                    {done ? 'Re-run' : 'Run'} checklist: {ct.name}
                  </button>
                );
              })}
              {canSubmit && <button className="btn btn-primary" onClick={() => act('submit')}>Submit for verification</button>}
              {canSubmit && <button className="btn" onClick={() => act('hold')}>Hold (blocked)</button>}
              {canExecute && !canSubmit && <div className="muted" style={{ fontSize: 12 }}>Field capture recorded — the crew lead submits the run for verification.</div>}
            </>}
            {t.status === 'ON_HOLD' && canSubmit && <button className="btn btn-primary" onClick={() => act('resume')}>Resume work</button>}
            {t.status === 'PENDING_VERIFICATION' && (canVerify || canSubmit) && <>
              {(t.gps_validations || []).length > 0 && (
                <div className="box tone-info">
                  <div className="muted" style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, letterSpacing: 0.4 }}>GPS EVIDENCE (APP CAPTURE)</div>
                  {t.gps_validations.map((g, i) => (
                    <div key={i} className="spread" style={{ fontSize: 12, padding: '2px 0', flexWrap: 'wrap', gap: '4px 10px' }}>
                      <b className={g.result === 'PASS' ? 'ok' : g.result === 'FAIL' ? 'bad' : 'warn'}>{g.result === 'PASS' ? 'PASS' : g.result === 'FAIL' ? 'FAIL' : 'REVIEW'}</b>
                      <span className="mono">{Number(g.measured_lat).toFixed(6)}, {Number(g.measured_lng).toFixed(6)}</span>
                      <span className="muted">dist {Math.round(g.distance_m ?? 0)} m / tol {g.tolerance_m} m</span>
                      <span className="muted">{fmtDateTime(g.validated_at)}</span>
                    </div>
                  ))}
                </div>
              )}
              {canVerify && <>
                <div className="field"><label>Result</label>
                  <SearchSelect value={verifyForm.result} onChange={(e) => setVerifyForm({ ...verifyForm, result: e.target.value })}>
                    <option value="PASS">PASS</option><option value="FAIL">FAIL</option><option value="PARTIAL">PARTIAL</option><option value="DEFERRED">DEFERRED</option>
                  </SearchSelect></div>
                <div className="field"><label>Completion summary</label><textarea value={verifyForm.summary} onChange={(e) => setVerifyForm({ ...verifyForm, summary: e.target.value })} /></div>
                <div className="field"><label>Cost (optional)</label><input type="number" min="0" step="0.01" value={verifyForm.cost ?? ''} onChange={(e) => setVerifyForm({ ...verifyForm, cost: e.target.value })} /></div>
                <button className="btn btn-primary" onClick={verify}>Verify &amp; complete</button>
              </>}
              {canSubmit && <button className="btn" onClick={() => act('reopen')}>Reopen (rework)</button>}
            </>}
            {!['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) && canManage && <button className="btn btn-danger" onClick={() => setCancelFlow({ step: 1, reason: '' })}>Cancel task</button>}
            {t.status === 'CANCELLED' && isAdmin && <button className="btn" onClick={retrieveTask}>Retrieve task</button>}
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Flow: DRAFT → SCHEDULED → ASSIGNED → IN_PROGRESS → PENDING_VERIFICATION → COMPLETED</div>
          </div>
        </div>
      </div>
      </div>

      {!TERMINAL_STATUSES.includes(t.status) && (canAssign || canManage) && (
        <div className="card card-pad mt">
          <h3 className="section-title">Crew assignment (semi-auto)</h3>
          {assignOptions?.requirements && (
            <div className="muted mb" style={{ fontSize: 12 }}>
              Checklist <b>{assignOptions.checklist?.name || '—'}</b> needs team {assignOptions.requirements.team.join('; ') || '—'} · skills {assignOptions.requirements.skills.join(', ') || '—'} · certs {assignOptions.requirements.required_certs.join(', ') || '—'}
            </div>
          )}
          {canAssign && assignOptions && (
            <>
              <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, marginBottom: 6 }}>SUGGESTED CREWS (BEST FIRST)</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(assignOptions.candidates || []).slice(0, 6).map((c) => (
                  <div key={c.id} className="spread" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div>
                        <b>{c.name}</b> <span className="muted">{c.crew_code}</span>
                        {c.id === t.crew_id ? <span className="muted" style={{ fontSize: 12 }}> · current</span> : null}
                        {c.is_default && c.id !== t.crew_id ? <span className="muted" style={{ fontSize: 12 }}> · target default</span> : null}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {c.crew_type} · {c.member_count} member(s) · {c.open_task_count} open · score {c.score}
                      </div>
                      {!c.eligible && (c.missing_skills?.length || c.missing_certs?.length || c.team_shortfall) ? (
                        <div className="warn" style={{ fontSize: 12 }}>
                          {c.missing_skills?.length ? `Missing skills: ${c.missing_skills.join(', ')}. ` : ''}
                          {c.missing_certs?.length ? `Missing certs: ${c.missing_certs.join(', ')}. ` : ''}
                          {c.team_shortfall ? `Short ${c.team_shortfall} member(s).` : ''}
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {c.eligible ? <span className="ok" style={{ fontSize: 12 }}>eligible</span> : <span className="warn" style={{ fontSize: 12 }}>warnings</span>}
                      {!c.selectable ? <span className="bad" style={{ fontSize: 12 }}>{c.status}</span> : (
                        <button className="btn btn-sm btn-primary" disabled={assignBusy || c.id === t.crew_id} onClick={() => commitAssign(c.id)}>
                          {c.id === t.crew_id ? 'Assigned' : 'Assign'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {!(assignOptions.candidates || []).length && <div className="muted">No crews are within your assignment authority.</div>}
              </div>
            </>
          )}
          {canManage && (
            <div className="grid grid-2 mt" style={{ gap: 12 }}>
              <div className="field"><label>Crew</label>
                <SearchSelect value={editCrewId} onChange={(e) => setEditCrewId(e.target.value)}>
                  <option value="">— none —</option>
                  {(assignOptions?.candidates || []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.crew_code})</option>)}
                  {t.crew && !(assignOptions?.candidates || []).some((c) => c.id === t.crew_id) ? <option value={t.crew_id}>{t.crew.name}</option> : null}
                </SearchSelect>
              </div>
              <div className="field"><label>Checklist templates</label>
                <div className="checklist-tpl-list">
                  {checklists.filter((c) => c.status === 'ACTIVE').map((c) => (
                    <label key={c.id} className="checklist-tpl-row">
                      <input
                        type="checkbox"
                        checked={editChecklistIds.includes(c.id)}
                        onChange={(e) => setEditChecklistIds(e.target.checked
                          ? [...editChecklistIds, c.id]
                          : editChecklistIds.filter((x) => x !== c.id))}
                      />
                      <span>{c.name}</span>
                    </label>
                  ))}
                  {!checklists.filter((c) => c.status === 'ACTIVE').length && <span className="muted" style={{ fontSize: 12 }}>No active templates.</span>}
                </div>
              </div>
              <div>
                <button className="btn btn-primary" disabled={editBusy} onClick={saveAssignment}>Save assignment</button>
                {!canAssign && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>Changing a crew also requires assignment authority.</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {TERMINAL_STATUSES.includes(t.status) && (
        <div className="card card-pad mt">
          <h3 className="section-title">Who did the work (read-only)</h3>
          {!t.crew ? (
            <div className="muted">No crew was recorded for this task.</div>
          ) : (
            <>
              <div className="kv">
                <span className="k">Executing crew</span><span>{t.crew.name} ({t.crew.crew_code})</span>
                <span className="k">Crew type</span><span>{t.crew.crew_type || '—'}</span>
                <span className="k">Members</span><span>{t.readiness?.crew?.member_count ?? '—'}</span>
                <span className="k">Crew source</span><span>{t.readiness?.crew?.resolved_via || 'ASSIGNED'}</span>
                <span className="k">Executed by</span><span>{(t.executions || []).find((e) => e.submitted_at)?.executed_by_name || '—'}</span>
                <span className="k">Assigned by</span><span>{t.assigned_by_name || '—'}</span>
                <span className="k">Verified by</span><span>{t.verified_by_name || '—'}</span>
                <span className="k">Result</span><span>{t.result || '—'}</span>
                <span className="k">Started / Ended</span><span>{fmtDateTime(t.actual_start)} / {fmtDateTime(t.actual_end)}</span>
              </div>
              {t.readiness && (
                <div className="box mt" style={{ background: t.readiness.eligible === false ? '#fffbeb' : '#f8fafc' }}>
                  <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}>ELIGIBILITY OF THE CREW THAT DID THE WORK</div>
                  {t.readiness.eligible == null ? (
                    <div style={{ fontSize: 12 }}>No checklist requirements to evaluate (task has no checklist template).</div>
                  ) : (
                    <div style={{ fontSize: 12 }}>
                      Verdict: {t.readiness.eligible ? <b className="ok">capability matched</b> : <b className="warn">warnings</b>}
                      {t.readiness.missing_skills?.length ? <div>Missing skills: {t.readiness.missing_skills.join(', ')}</div> : null}
                      {t.readiness.missing_certs?.length ? <div>Missing required certs: {t.readiness.missing_certs.join(', ')}</div> : null}
                      {t.readiness.certs_to_obtain?.length ? <div>Certs to obtain: {t.readiness.certs_to_obtain.map((c) => `${c.cert} (${c.required ? 'required' : 'recommended'})`).join(', ')}</div> : null}
                      {t.readiness.team_shortfall ? <div>Team short by {t.readiness.team_shortfall}</div> : null}
                      {t.readiness.equipment_to_secure?.length ? <div>Equipment to secure: {t.readiness.equipment_to_secure.join(', ')}</div> : null}
                      {t.readiness.warnings?.length ? <div className="muted">Notes: {t.readiness.warnings.join('; ')}</div> : null}
                      {t.readiness.eligible && !t.readiness.missing_skills?.length && !t.readiness.missing_certs?.length && !t.readiness.team_shortfall ? <div className="muted">No gaps against the checklist requirements.</div> : null}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {t.status === 'CANCELLED' && (
        <div className="card card-pad mt tone-danger">
          <h3 className="section-title">Cancellation (read-only)</h3>
          <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}>CANCELLATION</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{t.cancel_reason || t.completion_summary || '—'}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {t.cancelled_by_name || '—'} · {fmtDateTime(t.cancelled_at)}
            {t.status_before_cancel ? <> · <span>was</span> {t.status_before_cancel}</> : ''}
          </div>
          {isAdmin && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>As administrator you can retrieve this task from the Workflow panel.</div>}
        </div>
      )}

      {checklist && tpl && (
        <Modal title={`Checklist — ${tpl.name}`} onClose={() => setChecklist(null)} wide
          footer={<>
            <button className="btn" onClick={() => setChecklist(null)}>Cancel</button>
            <button className="btn" onClick={saveChecklistDraft} disabled={draftBusy}>{draftBusy ? 'Saving…' : 'Save draft'}</button>
            <button className="btn btn-primary" onClick={submitChecklist}>Submit execution</button>
          </>}>
          {tpl.draft && <div className="alert" style={{ marginBottom: 10 }}>Resumed a saved draft from {fmtDateTime(tpl.draft.updated_at)}. Save your progress or submit when finished.</div>}
          <div className="muted mb">Safety: {tpl.safety_notes || '—'}</div>
          {tpl.materials && <div className="muted mb">Materials: {tpl.materials}</div>}
          {tpl.required_personnel && <div className="muted mb">Personnel: {tpl.required_personnel}</div>}
          <div className="muted mb">Est. {tpl.estimated_minutes || '?'} min · v{tpl.version}</div>
          {tpl.items.map((it) => (
            <div key={it.id} className="card card-pad mb" style={{ padding: 12 }}>
              <div className="spread">
                <b>{it.sequence}. {it.instruction}</b>
                <span className="pill pill-soft">{it.response_type}{it.required ? ' *' : ''}</span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{it.section || '—'}{it.test_equipment ? ` · Equipment: ${it.test_equipment}` : ''}</div>
              <div className="mt">
                <ItemInput item={it} target={targetPos} state={checklist[it.id]} setState={(s) => setChecklist({ ...checklist, [it.id]: s })} />
              </div>
            </div>
          ))}
        </Modal>
      )}

      <h3 className="section-title">Field log — findings &amp; photos</h3>
      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="card-head">
            <h3 className="card-title">Findings <span className="muted">({(task.findings || []).length})</span></h3>
            {canAmend && ['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status) === false && (
              <button className="btn btn-sm btn-primary" onClick={() => setFindingForm({ severity: 'MEDIUM', title: '', detail: '', equipment_name: '' })}>+ Record finding</button>
            )}
          </div>
          {(task.findings || []).length === 0 && <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>No ad-hoc findings recorded for this task.</div>}
          {(task.findings || []).map((f) => (
            <div key={f.id} className="box" style={{ marginTop: 8 }}>
              <div className="spread">
                <b>{f.title}</b>
                <span className={'pill pill-soft' + (f.severity === 'CRITICAL' || f.severity === 'HIGH' ? ' bad' : f.severity === 'MEDIUM' ? ' warn' : '')} style={{ fontWeight: 700 }}>{f.severity}</span>
              </div>
              {f.detail && <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>{f.detail}</p>}
              <div className="finding-links">
                <span className="patch-chip">Task {task.task_number}</span>
                {f.asset_name && <a className="patch-chip" href={`/assets?asset=${f.asset_id}`}>Asset: {f.asset_name}</a>}
                {f.tower_code && <span className="patch-chip">Tower: {f.tower_code}</span>}
                {f.equipment_name && <span className="patch-chip">Equipment: {f.equipment_name}</span>}
                {f.checklist_item_instruction && <span className="patch-chip" title={f.checklist_item_instruction}>Item: {f.checklist_item_instruction}</span>}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{f.created_by_name || '—'} · {fmtDateTime(f.captured_at)}</div>
              <details className="mt" style={{ fontSize: 12 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>Comments on this finding</summary>
                <div className="mt"><Comments entityType="finding" entityId={f.id} title="" placeholder="Comment on this finding…" /></div>
              </details>
            </div>
          ))}
        </div>
        <div className="card card-pad">
          <div className="card-head">
            <h3 className="card-title">Photos &amp; attachments <span className="muted">({(task.attachments || []).length})</span></h3>
            {canAttach && (
              <label className="btn btn-sm btn-primary" style={{ cursor: 'pointer' }}>
                {uploadBusy ? 'Uploading…' : '+ Add photo / file'}
                <input type="file" style={{ display: 'none' }} disabled={uploadBusy} onChange={(e) => { onUploadFile(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            )}
          </div>
          {(task.attachments || []).length === 0 && <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>No photos or files captured for this task.</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {(task.attachments || []).map((a) => (
              <TaskFileThumb key={a.id} a={a} taskId={t.id} />
            ))}
          </div>
        </div>
      </div>

      {findingForm && (
        <Modal title="Record finding" onClose={() => setFindingForm(null)}
          footer={<>
            <button className="btn" onClick={() => setFindingForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveFinding}>Save finding</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Title</label><input value={findingForm.title} onChange={(e) => setFindingForm({ ...findingForm, title: e.target.value })} placeholder="e.g. Loose vibration damper" /></div>
            <div className="field full"><label>Severity</label>
              <SearchSelect value={findingForm.severity} onChange={(e) => setFindingForm({ ...findingForm, severity: e.target.value })}>
                {['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s}>{s}</option>)}
              </SearchSelect></div>
            <div className="field full"><label>Detail</label><textarea value={findingForm.detail || ''} onChange={(e) => setFindingForm({ ...findingForm, detail: e.target.value })} /></div>
            <div className="field full"><label>Related equipment (optional)</label>
              <SearchSelect value={findingForm.equipment_name || ''} onChange={(e) => setFindingForm({ ...findingForm, equipment_name: e.target.value })}>
                <option value="">— none —</option>
                {(task.readiness?.equipment_checks || []).map((item) => <option key={item.equipment} value={item.equipment}>{item.equipment}</option>)}
                {findingForm.equipment_name && !(task.readiness?.equipment_checks || []).some((i) => i.equipment === findingForm.equipment_name) && (
                  <option value={findingForm.equipment_name}>{findingForm.equipment_name}</option>
                )}
              </SearchSelect></div>
          </div>
        </Modal>
      )}

      {cancelFlow && (
        <Modal title="Cancel task" onClose={() => setCancelFlow(null)}
          footer={cancelFlow.step === 1 ? (
            <>
              <button className="btn" onClick={() => setCancelFlow(null)}>Keep task</button>
              <button className="btn btn-danger" disabled={!cancelFlow.reason.trim()} onClick={() => setCancelFlow({ step: 2, reason: cancelFlow.reason })}>Continue</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setCancelFlow({ step: 1, reason: cancelFlow.reason })}>Back</button>
              <button className="btn btn-danger" onClick={confirmCancel}>Confirm cancellation</button>
            </>
          )}>
          {cancelFlow.step === 1 ? (
            <div className="form-grid">
              <div className="field full"><label>Cancellation comment</label>
                <textarea value={cancelFlow.reason} onChange={(e) => setCancelFlow({ ...cancelFlow, reason: e.target.value })} placeholder="Why is this task being cancelled?" />
              </div>
              <div className="muted full" style={{ fontSize: 12 }}>A comment is required and is kept on the task record.</div>
            </div>
          ) : (
            <>
              <div className="box tone-danger">
                <b>Confirm cancellation</b> <span className="mono">{t.task_number}</span>
                <div style={{ marginTop: 6, fontSize: 13 }}><span className="muted">Comment:</span> {cancelFlow.reason}</div>
              </div>
              <div className="muted mt" style={{ fontSize: 12 }}>This closes the task. Only an administrator can retrieve it afterwards.</div>
            </>
          )}
        </Modal>
      )}

      {task.progress_graded > 0 && (
        <div className="mt mb" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <b>Checklist progress</b>
          <Progress pct={task.progress_pct} graded={task.progress_graded} passed={task.progress_passed} width={160} />
          <span className="muted" style={{ fontSize: 12 }}>(latest submitted execution · display only)</span>
        </div>
      )}

      <h3 className="section-title">Checklist Executions</h3>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Execution</th><th>Crew</th><th>Executed by</th><th>Template (v)</th><th>Submitted</th><th>Result</th><th>Steps (pass/fail)</th><th>Notes</th></tr></thead>
            <tbody>
              {(task.executions || []).map((e) => (
                <tr key={e.id}>
                  <td className="mono">EX-{String(e.id).padStart(5, '0')}</td>
                  <td>{e.crew_name ? `${e.crew_name}${e.crew_code ? ` (${e.crew_code})` : ''}` : '—'}</td>
                  <td>{e.executed_by_name || '—'}</td>
                  <td>{e.template_name || e.template_id} (v{e.template_version})</td>
                  <td>{fmtDateTime(e.submitted_at)}</td>
                  <td><Pill value={e.result || 'INCOMPLETE'} /></td>
                  <td>
                    {e.item_count ? (
                      <button className="btn btn-sm" onClick={() => setViewExec(e)}>{e.pass_count}/{e.fail_count}</button>
                    ) : '—'}
                  </td>
                  <td>{e.notes || '—'}</td>
                </tr>
              ))}
              {(task.executions || []).length === 0 && <tr><td colSpan={8} className="empty">No executions yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {viewExec && (
        <ExecutionDetail exec={viewExec} onClose={() => setViewExec(null)} />
      )}

      {(task.work_items || []).length > 0 && (
        <>
          <h3 className="section-title">Work items</h3>
          <div className="card card-pad">
            {(task.work_items || []).map((wi) => (
              <div key={wi.id} className="spread box" style={{ marginTop: wi.sequence > 1 ? 6 : 0, gap: '6px 10px' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className={'kind-chip ' + (KIND_CHIP[wi.kind] || 'kind-remediate')}>
                      {wi.kind}
                    </span>
                    <b>{wi.sequence}. {wi.title}</b>
                  </div>
                  {wi.detail && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{wi.detail}</div>}
                </div>
                {canToggleItems ? (
                  <label className="flex" style={{ gap: 6, fontSize: 13, alignItems: 'center', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={wi.status === 'DONE'} onChange={(e) => toggleWorkItem(wi, e.target.checked ? 'DONE' : 'OPEN')} />
                    {wi.status === 'DONE' ? 'Done' : 'Open'}
                  </label>
                ) : (
                  <Pill value={wi.status} />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="section-title">Task document</h3>
      <div className="card card-pad">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={documentBusy} onClick={viewDocument}>
            {documentBusy ? 'Loading…' : 'View task document'}
          </button>
          {canReport && (
            <button className="btn" disabled={reportBusy} onClick={genTaskReport}>
              {reportBusy ? 'Generating…' : 'Generate & save document'}
            </button>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Summarises the task, target asset, crew, checklist executions (item-by-item), field findings,
          photos, GPS validation and verification verdict into one printable report.
          {!canReport ? ' Viewing is read-only; saving a report requires report:write.' : ''}
        </p>
      </div>
      {reportData && (
        <div className="card card-pad mt print-report-scope" style={{ borderTop: '3px solid var(--accent)' }}>
          <h4 className="section-title">Task Detail Document</h4>
          <DocumentReport data={reportData} />
        </div>
      )}

      {(task.follow_ups?.length || task.recommended_follow_ups?.length) && (
        <h3 className="section-title mt">Follow-up work</h3>
      )}
      {(task.follow_ups || []).length > 0 && (
        <div className="card card-pad">
          <div className="card-head"><h3 className="card-title">Raised follow-up tasks</h3><span className="muted">auto-generated from this task result</span></div>
          <div className="tbl-wrap mt">
            <table>
              <thead><tr><th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>Due</th><th></th></tr></thead>
              <tbody>
                {(task.follow_ups || []).map((fu) => (
                  <tr key={fu.id}>
                    <td>
                      <b>{fu.task_number}</b><br />
                      <span className="muted">{fu.title}</span>
                      {(fu.work_items || []).length > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>carries {fu.work_items.length} work item(s)</div>
                      )}
                    </td>
                    <td><Pill value={fu.task_type} /></td>
                    <td>{fu.priority}</td>
                    <td><Pill value={fu.status} /></td>
                    <td>{fmtDate(fu.due_date)}</td>
                    <td><a className="btn btn-sm" href={`/tasks/${fu.id}`}>Open</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {(task.recommended_follow_ups || []).length > 0 && (
        <div className="card card-pad">
          <div className="card-head"><h3 className="card-title">Recommended follow-up</h3><span className="muted">based on this task result &amp; findings</span></div>
          {(task.recommended_follow_ups || []).map((plan) => (
            <div key={plan.key} className="spread box mt" style={{ flexWrap: 'wrap', gap: '6px 10px' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <b><Pill value={plan.task_type} /> {plan.title}</b>
                <div className="muted" style={{ fontSize: 12 }}>{plan.reason}</div>
                {plan.description && <div className="muted" style={{ fontSize: 12 }}>{plan.description}</div>}
                {plan.carry_count > 0 ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Carries {plan.carry_count} work item(s)
                    {plan.carry_checklist_name ? <> · checklist “{plan.carry_checklist_name}”</> : null}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>No work items to carry from the source task.</div>
                )}
              </div>
              <div style={{ textAlign: 'right', maxWidth: 300 }}>
                <div className="muted" style={{ fontSize: 11 }}>due {fmtDate(plan.due_date)} · priority {plan.priority}</div>
                {canCreate && (
                  <>
                    {(plan.carry_checklist_template_id || plan.carry_count > 0) && (
                      <div className="field" style={{ margin: '6px 0' }}>
                        <label>Checklist templates</label>
                        <SearchSelect
                          style={{ width: '100%' }}
                          value={fuTemplate[plan.key] ?? ''}
                          onChange={(e) => setFuTemplate({ ...fuTemplate, [plan.key]: e.target.value })}
                        >
                          <option value="">Carry source — {plan.carry_checklist_name || 'none'}</option>
                          {checklists.filter((c) => c.status === 'ACTIVE' && !(plan.carry_checklist_template_ids || []).includes(c.id)).map((c) => (
                            <option key={c.id} value={String(c.id)}>{c.name}</option>
                          ))}
                          <option value="__none__">— no checklist —</option>
                        </SearchSelect>
                      </div>
                    )}
                    <button className="btn btn-sm btn-primary mt" disabled={fuBusyKey === plan.key} onClick={() => createFollowUp(plan.key)}>
                      {fuBusyKey === plan.key ? 'Creating…' : 'Create task'}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className="section-title">Discussion</h3>
      <div className="card card-pad">
        <Comments entityType="task" entityId={task.id} />
      </div>
    </Page>
  );
}

function ItemInput({ item, state, setState, target }) {
  const set = (value) => setState({ ...state, value });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (item.response_type === 'PASS_FAIL' || item.response_type === 'YES_NO') {
    return (
      <SearchSelect value={state.value ?? ''} onChange={(e) => set(e.target.value === 'true' ? true : e.target.value === 'false' ? false : null)}>
        <option value="">Select…</option>
        <option value="true">Pass / Yes</option>
        <option value="false">Fail / No</option>
      </SearchSelect>
    );
  }
  if (item.response_type === 'NUMERIC') {
    const pc = item.pass_criteria;
    return (
      <div className="flex">
        <input type="number" style={{ width: 180 }} value={state.value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} placeholder="Enter value" />
        {pc && <span className="muted">Pass range: {pc.min}–{pc.max} {pc.unit || ''}</span>}
      </div>
    );
  }
  if (item.response_type === 'SELECT') {
    const opts = item.pass_criteria?.options || [];
    return (
      <SearchSelect value={state.value ?? ''} onChange={(e) => set(e.target.value)}>
        <option value="">Select…</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </SearchSelect>
    );
  }
  if (item.response_type === 'GPS_POINT') {
    let pos = null;
    try { pos = typeof state.value === 'string' ? JSON.parse(state.value) : state.value; } catch (_) { /* ignore */ }
    const dist = pos && target ? Math.round(haversineM(target.lat, target.lng, Number(pos.lat), Number(pos.lng))) : null;
    const verdict = dist !== null ? (dist <= GPS_TOLERANCE ? 'PASS' : 'FAIL') : null;
    async function capture() {
      setBusy(true);
      setErr(null);
      try {
        const p = await getDevicePosition();
        set(JSON.stringify({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy || 5, captured_at: p.ts }));
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
    }
    return (
      <div>
        <div className="flex" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={capture} disabled={busy}>
            <span aria-hidden style={{ marginRight: 5 }}>◎</span>{busy ? t('loading') : t('captureFromDevice')}
          </button>
          {target && <span className="muted">Target: <b>{target.label}</b></span>}
        </div>
        {err && <div className="alert alert-error mt">{err}</div>}
        {pos && (
          <div className={`alert ${verdict === 'PASS' ? 'alert-success' : verdict === 'FAIL' ? 'alert-error' : 'alert'} mt`} style={{ marginBottom: 0 }}>
            {t('coordinates')}: <b className="mono">{Number(pos.lat).toFixed(6)}, {Number(pos.lng).toFixed(6)}</b> · {t('accuracy')}: {pos.accuracy_m ?? '?'} m
            {dist !== null && <> · {t('distance')}: {dist} m / {t('tolerance')} {GPS_TOLERANCE} m → <b>{verdict === 'PASS' ? t('pass') : t('fail')}</b></>}
            {verdict === 'FAIL' && <span> — outside tolerance; still captured and sent for verification review.</span>}
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => set(null)}>✕ Clear</button>
          </div>
        )}
        {!target && <p className="muted mt">GPS confirmation is captured in the field app at the target coordinates.</p>}
      </div>
    );
  }
  if (item.response_type === 'PHOTO') {
    return <input value={state.value ?? ''} onChange={(e) => set(e.target.value)} placeholder="Photo reference / attachment id" />;
  }
  return <input value={state.value ?? ''} onChange={(e) => set(e.target.value)} />;
}

function TaskFileThumb({ a, taskId }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);
  const isImg = String(a.mime || '').startsWith('image/');
  useEffect(() => {
    if (!isImg) return;
    let revoke;
    fetch(`/api/tasks/${taskId}/attachments/${a.id}/file`, { headers: { Authorization: `Bearer ${getStoredToken()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((blob) => { revoke = URL.createObjectURL(blob); setUrl(revoke); })
      .catch((e) => setErr(e.message));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, isImg]);
  async function open() {
    try {
      const r = await fetch(`/api/tasks/${taskId}/attachments/${a.id}/file`, { headers: { Authorization: `Bearer ${getStoredToken()}` } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      window.open(u, '_blank');
      setTimeout(() => URL.revokeObjectURL(u), 60000);
    } catch (e) { setErr(e.message); }
  }
  return (
    <div style={{ width: 132 }}>
      {isImg ? (
        url ? <img src={url} alt={a.file_name} onClick={open} style={{ width: 132, height: 88, objectFit: 'cover', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)' }} /> : <div className="muted" style={{ fontSize: 11 }}>Loading…</div>
      ) : (
        <div style={{ fontSize: 11 }} className="pill" >{a.mime || 'FILE'}</div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.file_name} · {Math.round((a.size_bytes || 0) / 1024)} KB</div>
      {err && <div className="bad" style={{ fontSize: 10 }}>{err}</div>}
    </div>
  );
}
