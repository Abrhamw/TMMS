import { useEffect, useState } from 'react';
import { api, fmtDate, STATUS_COLORS } from '../api';
import { Page, Pill, Modal, ErrorNote, Loading, Progress, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser, getStoredToken } from '../auth';
import { KpiTile } from '../components/InfraVisuals';

const TITLE = 'Maintenance Tasks';
const CRUMBS = 'TMMS / Operations';
const blank = { title: '', task_type: 'PREVENTIVE', priority: 'MEDIUM', description: '', region_id: 1, substation_id: null, line_id: null, tower_id: null, asset_id: null, checklist_template_id: null, crew_id: null, due_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 16) };

const STATUSES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION', 'COMPLETED', 'CANCELLED', 'FAILED'];

export default function Tasks() {
  const me = getStoredUser();
  const canCreate = can(me, 'task:create');
  const canAssign = can(me, 'task:assign');
  const canExecute = can(me, 'task:execute');
  const canVerify = can(me, 'task:verify');
  const canStart = can(me, 'task:start') || can(me, 'task:manage');
  const canSubmit = can(me, 'task:lead') || can(me, 'task:manage');
  const [rows, setRows] = useState(null);
  const [regions, setRegions] = useState([]);
  const [crews, setCrews] = useState([]);
  const [checklists, setChecklists] = useState([]);
  const [subs, setSubs] = useState([]);
  const [lines, setLines] = useState([]);
  const [towers, setTowers] = useState([]);
  const [assets, setAssets] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [lineF, setLineF] = useState('');
  const [towerF, setTowerF] = useState('');
  const [assetF, setAssetF] = useState('');
  const [subF, setSubF] = useState('');
  const [crewF, setCrewF] = useState('');
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const canBulk = can(me, 'task:bulk');
  const [kpi, setKpi] = useState(null);
  const [checked, setChecked] = useState([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkVal, setBulkVal] = useState('');
  const [bulkErr, setBulkErr] = useState(null);
  const [dispatchNote, setDispatchNote] = useState(null);

  const assignableCrews = crews.filter((c) => c.assignable !== false);
  const { query, setQuery, results } = useSearchFilter(rows);

  const noteFor = (task, dispatch) => {
    if (!dispatch) return null;
    const parts = (dispatch.warnings || []).map((w) => w.message);
    const recs = (dispatch.recommendations || []).filter((r) => !r.required).map((r) => r.message);
    if (!parts.length && !recs.length) return null;
    return `${task?.task_number || 'Task'} · ${dispatch.template_name || dispatch.template_code}: ${[...parts, ...recs].join(' | ')}`;
  };

  const load = () => {
    const q = [];
    if (statusFilter) q.push(`status=${statusFilter}`);
    if (typeFilter) q.push(`task_type=${typeFilter}`);
    if (overdueOnly) q.push('overdue=true');
    if (lineF) q.push(`line_id=${lineF}`);
    if (towerF) q.push(`tower_id=${towerF}`);
    if (assetF) q.push(`asset_id=${assetF}`);
    if (subF) q.push(`substation_id=${subF}`);
    if (crewF) q.push(`crew_id=${crewF}`);
    return api.get(`/tasks${q.length ? '?' + q.join('&') : ''}`).then(setRows).catch((e) => setError(e.message));
  };
  const loadKpi = () => api.get('/tasks/kpi').then(setKpi).catch(() => {});
  useEffect(() => {
    load();
    loadKpi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, typeFilter, overdueOnly, lineF, towerF, assetF, subF, crewF]);
  // Static picker lookups load once, not on every filter change. Towers/assets
  // use the compact brief projection so this page is not pulling 18 MB.
  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/crews').then(setCrews).catch(() => {});
    api.get('/checklists').then(setChecklists).catch(() => {});
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/lines').then(setLines).catch(() => {});
    api.get('/towers?brief=1').then(setTowers).catch(() => {});
    api.get('/assets?brief=1').then(setAssets).catch(() => {});
  }, []);

  // Deep links from the Home task buckets: ?task_type=EMERGENCY pre-filters and
  // opens the raise form for users allowed to create work.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const tt = p.get('task_type');
    if (!tt) return;
    setTypeFilter(tt);
    if (tt === 'EMERGENCY' && can(me, 'task:create')) {
      setForm({ ...blank, task_type: 'EMERGENCY', priority: 'HIGH' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    try {
      const created = await api.post('/tasks', { ...form, due_date: new Date(form.due_date).toISOString() });
      setForm(null);
      setDispatchNote(noteFor(created, created.dispatch));
      load();
    } catch (e) { setError(e.message); }
  }

  async function exportCsv() {
    try {
      const q = [];
      if (statusFilter) q.push(`status=${statusFilter}`);
      if (typeFilter) q.push(`task_type=${typeFilter}`);
      if (overdueOnly) q.push('overdue=true');
      if (lineF) q.push(`line_id=${lineF}`);
      if (towerF) q.push(`tower_id=${towerF}`);
      if (assetF) q.push(`asset_id=${assetF}`);
      if (subF) q.push(`substation_id=${subF}`);
      if (crewF) q.push(`crew_id=${crewF}`);
      const res = await fetch(`/api/tasks/export.csv${q.length ? '?' + q.join('&') : ''}`, { headers: { Authorization: `Bearer ${getStoredToken() || ''}` } });
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (res.headers.get('Content-Disposition')?.match(/filename=(.+)/)?.[1]) || 'tasks.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(e.message); }
  }

  async function applyBulk() {
    try {
      if (bulkMode === 'assign') {
        const crewId = Number(bulkVal);
        const res = await api.post('/tasks/bulk', { ids: checked, action: 'assign', value: crewId });
        const notes = (res.advisories || []).map((a) => noteFor({ task_number: `Task ${a.task_id}` }, a.dispatch)).filter(Boolean);
        if (notes.length) setDispatchNote(`Assigned with warnings:\n${notes.join('\n')}`);
      } else if (bulkMode === 'priority') {
        await api.post('/tasks/bulk', { ids: checked, action: 'priority', value: bulkVal });
      } else if (bulkMode === 'due_date' || bulkMode === 'schedule_start') {
        await api.post('/tasks/bulk', { ids: checked, action: bulkMode, value: new Date(bulkVal).toISOString() });
      }
      setChecked([]); setBulkMode(false); setBulkVal('');
      load();
    } catch (e) { setBulkErr(e.message); }
  }

  async function act(id, action, extra) {
    try {
      const res = await api.post(`/tasks/${id}/state`, { action, ...extra });
      if (action === 'assign') setDispatchNote(noteFor(res, res.dispatch));
      load();
    } catch (e) { setError(e.message); }
  }

  const nextAction = (t) => {
    const assignBtn = canAssign ? <button className="btn btn-sm btn-primary" onClick={() => act(t.id, 'assign', { crew_id: t.crew_id || (crews.find((c) => c.status !== 'OFF_DUTY' && c.status !== 'UNAVAILABLE') || crews[0] || {}).id })}>Assign</button> : null;
    switch (t.status) {
      case 'DRAFT': return canAssign ? <button className="btn btn-sm btn-primary" onClick={() => act(t.id, 'schedule')}>Schedule</button> : null;
      case 'SCHEDULED': return assignBtn;
      // An EMERGENCY task is created ASSIGNED but may still be waiting for a crew.
      case 'ASSIGNED': return !t.crew_id ? assignBtn : (canStart ? <button className="btn btn-sm btn-primary" onClick={() => act(t.id, 'start')}>Start</button> : null);
      case 'IN_PROGRESS': return canExecute ? <a className="btn btn-sm btn-primary" href={`/tasks/${t.id}`}>{canSubmit ? 'Execute / submit' : 'Execute'}</a> : null;
      case 'ON_HOLD': return canSubmit ? <button className="btn btn-sm" onClick={() => act(t.id, 'resume')}>Resume</button> : null;
      case 'PENDING_VERIFICATION': return canVerify ? <a className="btn btn-sm btn-primary" href={`/tasks/${t.id}`}>Verify</a> : (canSubmit ? <a className="btn btn-sm" href={`/tasks/${t.id}`}>Review</a> : null);
      default: return null;
    }
  };

  if (!rows) return <Page title={TITLE} crumbs={CRUMBS}><Loading /></Page>;

  return (
    <Page title={TITLE} crumbs={CRUMBS}
      actions={<>
        {canCreate ? <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: regions[0]?.id || 1 })}>+ Add Task</button> : null}
        <button className="btn" onClick={exportCsv}>Export CSV</button>
      </>}>
      {error && <ErrorNote error={error} />}
      {dispatchNote && (
        <div className="card card-pad" style={{ background: '#fffbeb', borderColor: '#f59e0b', marginBottom: 12 }}>
          <button className="btn btn-sm" style={{ float: 'right' }} onClick={() => setDispatchNote(null)}>Dismiss</button>
          <b>Dispatch advisory (non-blocking)</b>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 4 }}>{dispatchNote}</div>
        </div>
      )}
      {kpi && (
        <div className="kpi-strip mt mb">
          <KpiTile label="Overdue" value={kpi.overdue} tone={kpi.overdue > 0 ? 'bad' : undefined} />
          <KpiTile label="Critical overdue" value={kpi.critical_overdue} tone={kpi.critical_overdue > 0 ? 'bad' : undefined} />
          <KpiTile label="Completion rate" value={`${kpi.completion_rate}%`} />
          <KpiTile label="Completed this week" value={kpi.completed_this_week} />
          <KpiTile label="Avg cycle" value={kpi.avg_cycle_hours == null ? '—' : `${kpi.avg_cycle_hours}h`} />
        </div>
      )}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search tasks…" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="flex"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
        <select value={lineF} onChange={(e) => { setLineF(e.target.value); setTowerF(''); }}>
          <option value="">All lines</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={towerF} onChange={(e) => { setTowerF(e.target.value); if (e.target.value) { const tw = towers.find((x) => x.id === Number(e.target.value)); if (tw && tw.line_id) setLineF(String(tw.line_id)); } }}>
          <option value="">All towers</option>
          {(lineF ? towers.filter((tw) => tw.line_id === Number(lineF)) : towers).map((tw) => <option key={tw.id} value={tw.id}>{tw.tower_id}</option>)}
        </select>
        <select value={assetF} onChange={(e) => setAssetF(e.target.value)}>
          <option value="">All assets</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name || a.asset_id}</option>)}
        </select>
        <select value={subF} onChange={(e) => setSubF(e.target.value)}>
          <option value="">All substations</option>
          {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={crewF} onChange={(e) => setCrewF(e.target.value)}>
          <option value="">All crews</option>
          {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="card">
        {canBulk && checked.length > 0 && (
          <div className="bulkbar" style={{ padding: '10px 14px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: '#f0f9ff' }}>
            <b>{checked.length} selected</b>
            <select value={bulkMode} onChange={(e) => { setBulkMode(e.target.value); setBulkVal(''); setBulkErr(null); }}>
              <option value="">Bulk action…</option>
              <option value="priority">Set priority</option>
              <option value="due_date">Set due date</option>
              <option value="schedule_start">Set schedule start</option>
              <option value="assign">Assign crew</option>
            </select>
            {bulkMode === 'priority' && (
              <select value={bulkVal} onChange={(e) => setBulkVal(e.target.value)}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}
              </select>
            )}
            {bulkMode === 'due_date' && <input type="datetime-local" value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />}
            {bulkMode === 'schedule_start' && <input type="datetime-local" value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />}
            {bulkMode === 'assign' && (
              <select value={bulkVal} onChange={(e) => setBulkVal(e.target.value)}>
                <option value="">Choose crew…</option>
                {assignableCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button className="btn btn-sm btn-primary" disabled={!bulkMode || (!bulkVal && bulkMode !== 'priority')} onClick={applyBulk}>Apply</button>
            <button className="btn btn-sm" onClick={() => { setChecked([]); setBulkMode(false); setBulkVal(''); }}>Clear</button>
            {bulkErr && <span className="bad">{bulkErr}</span>}
          </div>
        )}
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              {canBulk && <th style={{ width: 30 }}><input type="checkbox" checked={checked.length === results.length && results.length > 0} onChange={(e) => setChecked(e.target.checked ? results.map((r) => r.id) : [])} /></th>}
              <th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>Progress</th><th>Target</th><th>Due</th><th>Crew</th><th>Action</th>
            </tr></thead>
            <tbody>
              {results.map((t) => {
                const overdue = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'].includes(t.status) && new Date(t.due_date) < new Date();
                return (
                  <tr key={t.id}>
                    {canBulk && (
                      <td><input type="checkbox" checked={checked.includes(t.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, t.id] : checked.filter((i) => i !== t.id))} /></td>
                    )}
                    <td>
                      <a className="link" style={{ fontWeight: 600 }} href={`/tasks/${t.id}`}>{t.task_number}</a><br />
                      <span className="muted">{t.title}</span>
                    </td>
                    <td>{t.task_type}</td>
                    <td style={{ color: STATUS_COLORS[t.priority] || undefined, fontWeight: 600 }}>{t.priority}</td>
                    <td><Pill value={t.status} /></td>
                    <td><Progress pct={t.progress_pct} graded={t.progress_graded} passed={t.progress_passed} /></td>
                    <td>{t.tower ? `${t.tower.tower_id} (Tower)` : t.asset ? t.asset.name : t.substation ? t.substation.name : t.line ? t.line.name : '—'}</td>
                    <td className={overdue ? 'overdue' : undefined}>{fmtDate(t.due_date)}</td>
                    <td>{t.crew?.name || '—'}</td>
                    <td className="td-actions">{nextAction(t)}</td>
                  </tr>
                );
              })}
              {results.length === 0 && (
                <tr><td colSpan={canBulk ? 10 : 9} className="muted center">{query ? 'No tasks match your search' : 'No tasks found'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {form && (
        <Modal title="Add Task" onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Create</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
            <div className="field full"><label>Description</label><textarea value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="field"><label>Task type</label>
              <select value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })}>
                {['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'].map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>Priority</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>Region</label>
              <select value={form.region_id} onChange={(e) => setForm({ ...form, region_id: Number(e.target.value) })}>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></div>
            <div className="field"><label>Due date</label><input type="datetime-local" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
            <div className="field"><label>Target substation</label>
              <select value={form.substation_id || ''} onChange={(e) => setForm({ ...form, substation_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
            <div className="field"><label>Target line</label>
              <select value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value ? Number(e.target.value) : null, tower_id: null })}>
                <option value="">— none —</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
            <div className="field"><label>Target tower</label>
              <select value={form.tower_id || ''} onChange={(e) => {
                const tid = e.target.value ? Number(e.target.value) : null;
                const tw = towers.find((x) => x.id === tid);
                setForm({ ...form, tower_id: tid, line_id: tw ? tw.line_id : form.line_id });
              }}>
                <option value="">— none —</option>
                {(form.line_id ? towers.filter((tw) => tw.line_id === Number(form.line_id)) : towers).map((tw) => (
                  <option key={tw.id} value={tw.id}>{tw.tower_id} ({tw.tower_number})</option>
                ))}
              </select></div>
            <div className="field"><label>Target asset</label>
              <select value={form.asset_id || ''} onChange={(e) => {
                const aid = e.target.value ? Number(e.target.value) : null;
                const asset = assets.find((a) => a.id === aid);
                setForm({
                  ...form,
                  asset_id: aid,
                  crew_id: asset?.default_crew_id ? asset.default_crew_id : form.crew_id,
                });
              }}>
                <option value="">— none —</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.name} {a.default_crew_name ? `(${a.default_crew_name})` : ''}</option>)}
              </select></div>
            <div className="field"><label>Checklist</label>
              <select value={form.checklist_template_id || ''} onChange={(e) => setForm({ ...form, checklist_template_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {checklists.filter((c) => c.status === 'ACTIVE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="field"><label>Crew</label>
              <select value={form.crew_id || ''} onChange={(e) => setForm({ ...form, crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </select></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
