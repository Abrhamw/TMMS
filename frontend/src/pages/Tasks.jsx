import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, STATUS_COLORS } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, Progress, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser, getStoredToken } from '../auth';
import { KpiTile } from '../components/InfraVisuals';
import { assetsInScope, crewsInRegion, linesInRegion, subsInRegion, towersInScope } from '../cascade';

const TITLE = 'Maintenance Tasks';
const CRUMBS = 'TMMS / Operations';
const blank = { title: '', task_type: 'PREVENTIVE', priority: 'MEDIUM', description: '', region_id: 1, substation_id: null, line_id: null, tower_id: null, tower_from_id: null, tower_to_id: null, asset_id: null, checklist_template_ids: [], crew_id: null, due_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 16) };

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
  const [regionF, setRegionF] = useState('');
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

  // Cascade: a chosen region narrows the substation/line/asset lists, and a
  // chosen substation or line narrows the assets to that exact parent.
  const filterSubs = useMemo(() => subsInRegion(subs, regionF), [subs, regionF]);
  const filterLines = useMemo(() => linesInRegion(lines, regionF), [lines, regionF]);
  const filterTowers = useMemo(
    () => towersInScope(towers, { regionId: regionF, lineId: lineF }, { lines }),
    [towers, regionF, lineF, lines]
  );
  const filterAssets = useMemo(
    () => assetsInScope(assets, { regionId: regionF, substationId: subF, lineId: lineF }, { subs, lines }),
    [assets, regionF, subF, lineF, subs, lines]
  );
  const formSubs = useMemo(() => subsInRegion(subs, form?.region_id), [subs, form?.region_id]);
  const formLines = useMemo(() => linesInRegion(lines, form?.region_id), [lines, form?.region_id]);
  const formTowers = useMemo(
    () => towersInScope(towers, { regionId: form?.region_id, lineId: form?.line_id }, { lines }),
    [towers, form?.region_id, form?.line_id, lines]
  );
  const formLineTowers = useMemo(
    () => [...formTowers].sort((a, b) => (Number(a.km_marker) || 0) - (Number(b.km_marker) || 0) || a.id - b.id),
    [formTowers]
  );
  const formAssets = useMemo(
    () => assetsInScope(assets, { regionId: form?.region_id, substationId: form?.substation_id, lineId: form?.line_id }, { subs, lines }),
    [assets, form?.region_id, form?.substation_id, form?.line_id, subs, lines]
  );
  // Crew pickers narrow to the selected region when one is chosen; with no
  // region they keep showing every crew the user may assign.
  const filterCrews = useMemo(() => crewsInRegion(crews, regionF), [crews, regionF]);
  const formCrews = useMemo(() => crewsInRegion(crews, form?.region_id), [crews, form?.region_id]);
  const bulkCrews = useMemo(() => crewsInRegion(assignableCrews, regionF), [assignableCrews, regionF]);

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
    if (regionF) q.push(`region_id=${regionF}`);
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
  }, [statusFilter, typeFilter, overdueOnly, regionF, lineF, towerF, assetF, subF, crewF]);
  // Static picker lookups load once, not on every filter change. The full
  // tower and asset projections feed only the filters and the task form, so
  // they are deferred until either is actually used.
  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/crews').then(setCrews).catch(() => {});
    api.get('/checklists').then(setChecklists).catch(() => {});
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/lines').then(setLines).catch(() => {});
  }, []);
  const lookupsLoaded = useRef(false);
  const loadLookups = () => {
    if (lookupsLoaded.current) return;
    lookupsLoaded.current = true;
    api.get('/towers?brief=1').then(setTowers).catch(() => {});
    api.get('/assets?brief=1').then(setAssets).catch(() => {});
  };
  useEffect(() => { if (form) loadLookups(); }, [form]);

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
      if (regionF) q.push(`region_id=${regionF}`);
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

  if (!rows && error) return <Page title={TITLE} crumbs={CRUMBS}><ErrorNote error={error} /></Page>;
  if (!rows) return <Page title={TITLE} crumbs={CRUMBS}><Loading /></Page>;

  return (
    <Page title={TITLE} crumbs={CRUMBS}
      actions={<>
        {canCreate ? <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: regions[0]?.id || 1 })}>+ Add Task</button> : null}
        <button className="btn" onClick={exportCsv}>Export CSV</button>
      </>}>
      {error && <ErrorNote error={error} />}
      {dispatchNote && (
        <div className="card card-pad tone-warn" style={{ marginBottom: 12 }}>
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
        <SearchSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </SearchSelect>
        <SearchSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'].map((s) => <option key={s}>{s}</option>)}
        </SearchSelect>
        <label className="flex"><input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only</label>
        <SearchSelect value={regionF} onChange={(e) => { setRegionF(e.target.value); setSubF(''); setLineF(''); setTowerF(''); setAssetF(''); }}>
          <option value="">All regions</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </SearchSelect>
        <SearchSelect value={subF} onChange={(e) => { setSubF(e.target.value); setAssetF(''); }}>
          <option value="">All substations</option>
          {filterSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </SearchSelect>
        <SearchSelect value={lineF} onChange={(e) => { setLineF(e.target.value); setTowerF(''); setAssetF(''); }}>
          <option value="">All lines</option>
          {filterLines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </SearchSelect>
        <SearchSelect value={towerF} onFocus={loadLookups} onChange={(e) => { setTowerF(e.target.value); if (e.target.value) { const tw = towers.find((x) => x.id === Number(e.target.value)); if (tw && tw.line_id) setLineF(String(tw.line_id)); } }}>
          <option value="">All towers</option>
          {(filterTowers).map((tw) => <option key={tw.id} value={tw.id}>{tw.tower_id}</option>)}
        </SearchSelect>
        <SearchSelect value={assetF} onFocus={loadLookups} onChange={(e) => setAssetF(e.target.value)}>
          <option value="">All assets</option>
          {filterAssets.map((a) => <option key={a.id} value={a.id}>{a.name || a.asset_id}</option>)}
        </SearchSelect>
        <SearchSelect value={crewF} onChange={(e) => setCrewF(e.target.value)}>
          <option value="">All crews</option>
          {filterCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SearchSelect>
      </div>
      <div className="card">
        {canBulk && checked.length > 0 && (
          <div className="bulkbar tone-info" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b>{checked.length} selected</b>
            <SearchSelect value={bulkMode} onChange={(e) => { setBulkMode(e.target.value); setBulkVal(''); setBulkErr(null); }}>
              <option value="">Bulk action…</option>
              <option value="priority">Set priority</option>
              <option value="due_date">Set due date</option>
              <option value="schedule_start">Set schedule start</option>
              <option value="assign">Assign crew</option>
            </SearchSelect>
            {bulkMode === 'priority' && (
              <SearchSelect value={bulkVal} onChange={(e) => setBulkVal(e.target.value)}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}
              </SearchSelect>
            )}
            {bulkMode === 'due_date' && <input type="datetime-local" value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />}
            {bulkMode === 'schedule_start' && <input type="datetime-local" value={bulkVal} onChange={(e) => setBulkVal(e.target.value)} />}
            {bulkMode === 'assign' && (
              <SearchSelect value={bulkVal} onChange={(e) => setBulkVal(e.target.value)}>
                <option value="">Choose crew…</option>
                {bulkCrews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </SearchSelect>
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
              <SearchSelect value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })}>
                {['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'].map((s) => <option key={s}>{s}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Priority</label>
              <SearchSelect value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <option key={s}>{s}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Region</label>
              <SearchSelect value={form.region_id} onChange={(e) => setForm({ ...form, region_id: Number(e.target.value), substation_id: null, line_id: null, tower_id: null, asset_id: null })}>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Due date</label><input type="datetime-local" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></div>
            <div className="field"><label>Target substation</label>
              <SearchSelect value={form.substation_id || ''} onChange={(e) => setForm({ ...form, substation_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {formSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Target line</label>
              <SearchSelect value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value ? Number(e.target.value) : null, tower_id: null })}>
                <option value="">— none —</option>
                {formLines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Target tower</label>
              <SearchSelect value={form.tower_id || ''} onChange={(e) => {
                const tid = e.target.value ? Number(e.target.value) : null;
                const tw = towers.find((x) => x.id === tid);
                setForm({ ...form, tower_id: tid, tower_from_id: null, tower_to_id: null, line_id: tw ? tw.line_id : form.line_id });
              }}>
                <option value="">— none —</option>
                {(formTowers).map((tw) => (
                  <option key={tw.id} value={tw.id}>{tw.tower_id} ({tw.tower_number})</option>
                ))}
              </SearchSelect></div>
            <div className="field"><label>Section from tower</label>
              <SearchSelect value={form.tower_from_id || ''} onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                const tw = towers.find((x) => x.id === id);
                setForm({ ...form, tower_from_id: id, tower_id: null, line_id: tw ? tw.line_id : form.line_id });
              }}>
                <option value="">— none —</option>
                {(formLineTowers).map((tw) => (
                  <option key={tw.id} value={tw.id}>{tw.tower_id} ({tw.tower_number})</option>
                ))}
              </SearchSelect></div>
            <div className="field"><label>Section to tower</label>
              <SearchSelect value={form.tower_to_id || ''} onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                const tw = towers.find((x) => x.id === id);
                setForm({ ...form, tower_to_id: id, tower_id: null, line_id: tw ? tw.line_id : form.line_id });
              }}>
                <option value="">— none —</option>
                {(formLineTowers).map((tw) => (
                  <option key={tw.id} value={tw.id}>{tw.tower_id} ({tw.tower_number})</option>
                ))}
              </SearchSelect></div>
            <div className="field full"><span className="muted" style={{ fontSize: 12 }}>Whole line when no tower is chosen; a single tower inspects that tower; a from/to pair inspects that inclusive tower range.</span></div>
            <div className="field"><label>Target asset</label>
              <SearchSelect value={form.asset_id || ''} onChange={(e) => {
                const aid = e.target.value ? Number(e.target.value) : null;
                const asset = assets.find((a) => a.id === aid);
                setForm({
                  ...form,
                  asset_id: aid,
                  crew_id: asset?.default_crew_id ? asset.default_crew_id : form.crew_id,
                });
              }}>
                <option value="">— none —</option>
                {formAssets.map((a) => <option key={a.id} value={a.id}>{a.name} {a.default_crew_name ? `(${a.default_crew_name})` : ''}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Checklist templates</label>
              <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 8px' }}>
                {checklists.filter((c) => c.status === 'ACTIVE').map((c) => (
                  <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
                    <input
                      type="checkbox"
                      checked={(form.checklist_template_ids || []).includes(c.id)}
                      onChange={(e) => {
                        const cur = form.checklist_template_ids || [];
                        setForm({ ...form, checklist_template_ids: e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id) });
                      }}
                    />
                    <span>{c.name}</span>
                  </label>
                ))}
                {!checklists.filter((c) => c.status === 'ACTIVE').length && <span className="muted" style={{ fontSize: 12 }}>No active templates.</span>}
              </div>
            </div>
            <div className="field"><label>Crew</label>
              <SearchSelect value={form.crew_id || ''} onChange={(e) => setForm({ ...form, crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {formCrews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </SearchSelect></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
