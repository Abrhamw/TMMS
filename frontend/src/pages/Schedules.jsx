import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Page, Pill, Modal, ErrorNote, Loading, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';

const SCOPE = ['ASSET', 'SUBSTATION', 'LINE', 'LINE_TOWERS', 'TOWER', 'ASSET_CLASS'];
const ASSET_TYPES = ['TRANSFORMER', 'CIRCUIT_BREAKER', 'DISCONNECTOR', 'REACTOR', 'CAPACITOR_BANK', 'LIGHTNING_ARRESTER', 'CT', 'PT', 'BUSBAR', 'PROTECTION_RELAY', 'METER'];
const TASK_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'];

const WEEKDAY_OPTS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const NTH_OPTS = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [5, 'Fifth'], [-1, 'Last']];
const PATTERNS = [
  ['INTERVAL_DAYS', 'Every N days'],
  ['WEEKLY', 'Every N weeks on'],
  ['MONTHLY_DAY', 'Every N months on day'],
  ['MONTHLY_NTH', 'Monthly on the'],
];

function blankRule(anchorISO) {
  const d = anchorISO ? new Date(anchorISO) : new Date();
  return { type: 'MONTHLY_DAY', interval: 1, weekdays: [], day: d.getUTCDate(), nth: 1, weekday: 1, endType: 'never', until: '', count: 2 };
}

function ruleToUi(rule) {
  if (!rule || !rule.type) return blankRule();
  const ui = {
    type: rule.type,
    interval: rule.interval || 1,
    weekdays: Array.isArray(rule.weekdays) ? rule.weekdays : [],
    day: rule.day || 1,
    nth: rule.nth == null ? 1 : rule.nth,
    weekday: rule.weekday || 1,
    endType: 'never',
    until: '',
    count: 2,
  };
  if (rule.ends && rule.ends.until) { ui.endType = 'until'; ui.until = rule.ends.until; }
  else if (rule.ends && rule.ends.count) { ui.endType = 'count'; ui.count = rule.ends.count; }
  return ui;
}

function uiToRule(ui) {
  const interval = Number(ui.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) throw new Error('Interval must be an integer 1..1000');
  const rule = { type: ui.type, interval };
  if (ui.type === 'WEEKLY') {
    const weekdays = [...new Set((ui.weekdays || []).map(Number))].sort((a, b) => a - b);
    if (!weekdays.length) throw new Error('Pick at least one weekday');
    rule.weekdays = weekdays;
  } else if (ui.type === 'MONTHLY_DAY') {
    const day = Number(ui.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Day of month must be 1..31');
    rule.day = day;
  } else if (ui.type === 'MONTHLY_NTH') {
    const nth = Number(ui.nth);
    if (!(nth === -1 || (Number.isInteger(nth) && nth >= 1 && nth <= 5))) throw new Error('Ordinal must be 1..5 or Last');
    const weekday = Number(ui.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error('Weekday must be 1..7');
    rule.nth = nth;
    rule.weekday = weekday;
  }
  if (ui.endType === 'until') {
    if (!ui.until) throw new Error('Pick an end date');
    rule.ends = { until: ui.until };
  } else if (ui.endType === 'count') {
    const count = Number(ui.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('Occurrence count must be an integer >= 1');
    rule.ends = { count };
  }
  return rule;
}

const blank = {
  schedule_name: '', schedule_code: '', scope_type: 'ASSET', asset_type: 'TRANSFORMER',
  asset_id: null, substation_id: null, line_id: null, tower_id: null, region_id: null,
  checklist_template_id: null, responsible_crew_id: null,
  priority: 'MEDIUM', task_type: 'PREVENTIVE', lead_time_days: 7, next_due_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
  expected_duration_hours: null, instructions: '', is_active: 1,
};

export default function Schedules() {
  const canWrite = can(getStoredUser(), 'schedule:write');
  const canRun = can(getStoredUser(), 'schedule:run');
  const [rows, setRows] = useState(null);
  const [checklists, setChecklists] = useState([]);
  const [crews, setCrews] = useState([]);
  const [assets, setAssets] = useState([]);
  const [lines, setLines] = useState([]);
  const [subs, setSubs] = useState([]);
  const [towers, setTowers] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [rule, setRule] = useState(blankRule());
  const [detail, setDetail] = useState(null);
  const [runMsg, setRunMsg] = useState(null);
  const { query, setQuery, results } = useSearchFilter(rows);

  const load = () => api.get('/schedules').then(setRows).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/checklists').then(setChecklists).catch(() => {});
    api.get('/crews').then(setCrews).catch(() => {});
    api.get('/assets?brief=1').then(setAssets).catch(() => {});
    api.get('/lines').then(setLines).catch(() => {});
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/towers?brief=1').then(setTowers).catch(() => {});
  }, []);

  async function save() {
    try {
      const body = {
        ...form,
        frequency: 'CUSTOM',
        frequency_config: JSON.stringify(uiToRule(rule)),
        next_due_date: new Date(form.next_due_date).toISOString(),
      };
      if (form.id) await api.put(`/schedules/${form.id}`, body);
      else await api.post('/schedules', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function run() {
    try {
      const res = await api.post('/schedules/run', {});
      setRunMsg(`Generated ${res.generated} tasks · ${res.skipped_duplicate} skipped (duplicates) · ${res.not_due} not due`);
      load();
    } catch (e) { setError(e.message); }
  }

  async function preview(s) {
    try {
      setDetail({ ...(await api.get(`/schedules/${s.id}`)), ...(await api.get(`/schedules/${s.id}/preview`)) });
    } catch (e) { setError(e.message); }
  }

  if (!rows) return <Page title="Maintenance Schedules"><Loading /></Page>;

  return (
    <Page title="Maintenance Schedules" crumbs="TMMS / Operations"
      actions={<>
        {canRun && <button className="btn" onClick={run}>▶ Run generation</button>}
        {canWrite && <button className="btn btn-primary" onClick={() => { setForm({ ...blank }); setRule(blankRule(blank.next_due_date)); }}>+ Add Schedule</button>}
      </>}>
      {error && <ErrorNote error={error} />}
      {runMsg && <div className="alert alert-success">{runMsg}</div>}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search schedules…" />
        <span className="muted" style={{ fontSize: 12 }}>{results.length} of {rows.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Schedule</th><th>Scope</th><th>Task Type</th><th>Frequency</th><th>Next Due</th><th>Targets</th><th>Open Tasks</th><th>Checklist</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {results.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.schedule_name}</b><br /><span className="mono muted">{s.schedule_code}</span></td>
                  <td>{s.scope_type}{s.asset_type ? ` · ${s.asset_type}` : ''}</td>
                  <td><Pill value={s.task_type} /></td>
                  <td>{s.recurrence_summary || s.frequency}</td>
                  <td className={new Date(s.next_due_date) < new Date() ? 'overdue' : undefined}>{fmtDate(s.next_due_date)}</td>
                  <td>{s.targets?.length ?? 0}</td>
                  <td>{s.open_generated_tasks ?? 0}</td>
                  <td>{s.checklist_template?.name || '—'}</td>
                  <td><Pill value={s.is_active ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td className="nowrap">
                    <button className="btn btn-sm" onClick={() => preview(s)}>Preview</button>{' '}
                    {canWrite && <button className="btn btn-sm" onClick={() => { setForm({ ...s, next_due_date: s.next_due_date.slice(0, 10) }); setRule(ruleToUi(s.recurrence)); }}>Edit</button>}
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan="10" className="muted center">{query ? 'No schedules match your search' : 'No schedules found'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && detail.targets && (
        <Modal title={`${detail.schedule_name} — next due ${fmtDate(detail.next_due_date)}`} onClose={() => setDetail(null)} wide>
          <div className="kv">
            <span className="k">Scope</span><span>{detail.scope_type} {detail.asset_type || ''}</span>
            <span className="k">Task Type</span><span><Pill value={detail.task_type} /></span>
            <span className="k">Recurrence</span><span>{detail.recurrence_summary || detail.frequency}{detail.occurrences_generated ? ` · ${detail.occurrences_generated} generated` : ''}</span>
            <span className="k">Crew</span><span>{detail.responsible_crew?.name || '—'}</span>
            <span className="k">Priority</span><span>{detail.priority}</span>
            <span className="k">Instructions</span><span>{detail.instructions || '—'}</span>
          </div>
          <div className="card-head mt"><h3 className="card-title">Will generate tasks for {detail.target_count} targets on {fmtDate(detail.next_due_date)}</h3></div>
          {(detail.next_occurrences || []).length > 0 && (
            <>
              <div className="card-head mt"><h3 className="card-title">Upcoming occurrences</h3></div>
              <ul className="occ-list">
                {detail.next_occurrences.map((d) => <li key={d}>{fmtDate(d)}</li>)}
              </ul>
            </>
          )}
          {detail.is_active === 0 && detail.occurrences_generated > 0 && (
            <div className="muted mt" style={{ fontSize: 12 }}>This schedule has ended.</div>
          )}
          <div className="tbl-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Target</th><th>Type</th></tr></thead>
              <tbody>
                {(detail.targets || []).map((t) => (
                  <tr key={t.id}><td>{t.name}</td><td>{t.type}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {form && (
        <Modal title={form.id ? `Edit — ${form.schedule_name}` : 'Add Schedule'} onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Schedule name</label><input value={form.schedule_name || ''} onChange={(e) => setForm({ ...form, schedule_name: e.target.value })} /></div>
            <div className="field"><label>Code</label><input value={form.schedule_code || ''} onChange={(e) => setForm({ ...form, schedule_code: e.target.value })} /></div>
            <div className="field"><label>Scope type</label>
              <select value={form.scope_type} onChange={(e) => setForm({ ...form, scope_type: e.target.value })}>
                {SCOPE.map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>Asset type (if ASSET_CLASS)</label>
              <select value={form.asset_type || ''} onChange={(e) => setForm({ ...form, asset_type: e.target.value })}>
                <option value="">—</option>
                {ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select></div>
            {form.scope_type === 'ASSET' && (
              <div className="field"><label>Target asset</label>
                <select value={form.asset_id || ''} onChange={(e) => setForm({ ...form, asset_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select></div>
            )}
            {form.scope_type === 'SUBSTATION' && (
              <div className="field"><label>Target substation</label>
                <select value={form.substation_id || ''} onChange={(e) => setForm({ ...form, substation_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
            )}
            {(form.scope_type === 'LINE' || form.scope_type === 'LINE_TOWERS') && (
              <div className="field"><label>Target line</label>
                <select value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value ? Number(e.target.value) : null, tower_id: null })}>
                  <option value="">— none —</option>
                  {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select></div>
            )}
            {form.scope_type === 'TOWER' && (
              <div className="field"><label>Target tower</label>
                <select value={form.tower_id || ''} onChange={(e) => {
                  const tid = e.target.value ? Number(e.target.value) : null;
                  const tw = towers.find((x) => x.id === tid);
                  setForm({ ...form, tower_id: tid, line_id: tw ? tw.line_id : form.line_id });
                }}>
                  <option value="">— none —</option>
                  {(form.line_id ? towers.filter((tw) => tw.line_id === Number(form.line_id)) : towers).map((tw) => (
                    <option key={tw.id} value={tw.id}>{tw.tower_id}</option>
                  ))}
                </select></div>
            )}
            <div className="field"><label>Recurrence</label>
              <select value={rule.type} onChange={(e) => setRule({ ...rule, type: e.target.value })}>
                {PATTERNS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
            {rule.type !== 'MONTHLY_NTH' && (
              <div className="field"><label>{rule.type === 'INTERVAL_DAYS' ? 'Days between' : rule.type === 'WEEKLY' ? 'Weeks between' : 'Months between'}</label>
                <input type="number" min="1" max="1000" value={rule.interval} onChange={(e) => setRule({ ...rule, interval: e.target.value })} /></div>
            )}
            {rule.type === 'WEEKLY' && (
              <div className="field full"><label>On weekdays</label>
                <div className="chip-row">
                  {WEEKDAY_OPTS.map(([value, label]) => (
                    <button type="button" key={value} className={`chip${rule.weekdays.includes(value) ? ' chip-on' : ''}`}
                      onClick={() => setRule({ ...rule, weekdays: rule.weekdays.includes(value) ? rule.weekdays.filter((x) => x !== value) : [...rule.weekdays, value] })}>{label}</button>
                  ))}
                </div></div>
            )}
            {rule.type === 'MONTHLY_DAY' && (
              <div className="field"><label>Day of month</label>
                <input type="number" min="1" max="31" value={rule.day} onChange={(e) => setRule({ ...rule, day: e.target.value })} /></div>
            )}
            {rule.type === 'MONTHLY_NTH' && (<>
              <div className="field"><label>Which</label>
                <select value={rule.nth} onChange={(e) => setRule({ ...rule, nth: Number(e.target.value) })}>
                  {NTH_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></div>
              <div className="field"><label>Weekday</label>
                <select value={rule.weekday} onChange={(e) => setRule({ ...rule, weekday: Number(e.target.value) })}>
                  {WEEKDAY_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></div>
            </>)}
            <div className="field full"><label>Ends</label>
              <div className="chip-row">
                {[['never', 'Never'], ['until', 'On date'], ['count', 'After N occurrences']].map(([value, label]) => (
                  <button type="button" key={value} className={`chip${rule.endType === value ? ' chip-on' : ''}`}
                    onClick={() => setRule({ ...rule, endType: value })}>{label}</button>
                ))}
              </div></div>
            {rule.endType === 'until' && (
              <div className="field"><label>End date</label>
                <input type="date" value={rule.until} onChange={(e) => setRule({ ...rule, until: e.target.value })} /></div>
            )}
            {rule.endType === 'count' && (
              <div className="field"><label>Occurrences</label>
                <input type="number" min="1" value={rule.count} onChange={(e) => setRule({ ...rule, count: e.target.value })} /></div>
            )}
            <div className="field"><label>Priority</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>Task type (generated)</label>
              <select value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })}>
                {TASK_TYPES.map((ty) => <option key={ty}>{ty}</option>)}
              </select></div>
            <div className="field"><label>Next due date</label><input type="date" value={form.next_due_date} onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} /></div>
            <div className="field"><label>Lead time (days)</label><input type="number" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: Number(e.target.value) })} /></div>
            <div className="field"><label>Checklist</label>
              <select value={form.checklist_template_id || ''} onChange={(e) => setForm({ ...form, checklist_template_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {checklists.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="field"><label>Responsible crew</label>
              <select value={form.responsible_crew_id || ''} onChange={(e) => setForm({ ...form, responsible_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </select></div>
            <div className="field full"><label>Instructions</label><textarea value={form.instructions || ''} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}
