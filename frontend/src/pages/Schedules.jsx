import { useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { Page, Pill, Modal, ErrorNote, Loading, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import { t } from '../i18n';

const SCOPE = ['ASSET', 'SUBSTATION', 'LINE', 'LINE_TOWERS', 'TOWER', 'ASSET_CLASS'];
const ASSET_TYPES = ['TRANSFORMER', 'CIRCUIT_BREAKER', 'DISCONNECTOR', 'REACTOR', 'CAPACITOR_BANK', 'LIGHTNING_ARRESTER', 'CT', 'PT', 'BUSBAR', 'PROTECTION_RELAY', 'METER'];
const TASK_TYPES = ['PREVENTIVE', 'CORRECTIVE', 'EMERGENCY', 'INSPECTION', 'REPLACEMENT', 'TESTING', 'REPAIR'];

const WEEKDAY_OPTS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const NTH_OPTS = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [5, 'Fifth'], [-1, 'Last']];
const PATTERNS = [
  ['INTERVAL_DAYS', 'schedPatternInterval'],
  ['WEEKLY', 'schedPatternWeekly'],
  ['MONTHLY_DAY', 'schedPatternMonthlyDay'],
  ['MONTHLY_NTH', 'schedPatternMonthlyNth'],
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
  const [tab, setTab] = useState('schedules');
  const [upDays, setUpDays] = useState(60);
  const [upcoming, setUpcoming] = useState(null);
  const [adhDays, setAdhDays] = useState(90);
  const [adherence, setAdherence] = useState(null);
  const { query, setQuery, results } = useSearchFilter(rows);

  const load = () => api.get('/schedules').then(setRows).catch((e) => setError(e.message));
  const loadUpcoming = () => api.get(`/schedules/upcoming?days=${upDays}`).then(setUpcoming).catch((e) => setError(e.message));
  const loadAdherence = () => api.get(`/schedules/adherence?days=${adhDays}`).then(setAdherence).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/checklists').then(setChecklists).catch(() => {});
    api.get('/crews').then(setCrews).catch(() => {});
    api.get('/assets?brief=1').then(setAssets).catch(() => {});
    api.get('/lines').then(setLines).catch(() => {});
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/towers?brief=1').then(setTowers).catch(() => {});
  }, []);
  useEffect(() => { if (tab === 'upcoming') loadUpcoming(); /* eslint-disable-next-line */ }, [tab, upDays]);
  useEffect(() => { if (tab === 'adherence') loadAdherence(); /* eslint-disable-next-line */ }, [tab, adhDays]);

  async function toggleActive(s) {
    try {
      await api.put(`/schedules/${s.id}`, { is_active: s.is_active ? 0 : 1 });
      load();
    } catch (e) { setError(e.message); }
  }

  async function runOne(s) {
    try {
      const res = await api.post('/schedules/run', { schedule_id: s.id });
      const err = res.errors?.[0]?.error;
      setRunMsg(err
        ? `${s.schedule_name}: ${err}`
        : `${s.schedule_name}: generated ${res.generated} · ${res.skipped_duplicate} skipped · ${res.not_due} not due`);
      load();
      if (tab === 'upcoming') loadUpcoming();
    } catch (e) { setError(e.message); }
  }

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

  if (!rows) return <Page title={t('schedTitle')}><Loading /></Page>;

  return (
    <Page title={t('schedTitle')} crumbs="TMMS / Operations"
      actions={<>
        {canRun && <button className="btn" onClick={run}>▶ {t('schedRun')}</button>}
        {canWrite && <button className="btn btn-primary" onClick={() => { setForm({ ...blank }); setRule(blankRule(blank.next_due_date)); }}>+ {t('schedAdd')}</button>}
      </>}>
      {error && <ErrorNote error={error} />}
      {runMsg && <div className="alert alert-success">{runMsg}</div>}
      <div className="tabs">
        {[['schedules', 'schedTabSchedules'], ['upcoming', 'schedTabUpcoming'], ['adherence', 'schedTabAdherence']].map(([key, labelKey]) => (
          <button key={key} className={'tab' + (tab === key ? ' active' : '')} onClick={() => setTab(key)}>{t(labelKey)}</button>
        ))}
      </div>
      {tab === 'schedules' && (<>
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder={t('schedSearch')} />
        <span className="muted" style={{ fontSize: 12 }}>{results.length} / {rows.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>{t('schedColSchedule')}</th><th>{t('schedColScope')}</th><th>{t('schedColTaskType')}</th><th>{t('schedColFrequency')}</th><th>{t('schedColNextDue')}</th><th>{t('schedColTargets')}</th><th>{t('schedColOpenTasks')}</th><th>{t('schedColChecklist')}</th><th>{t('schedColActive')}</th><th></th></tr></thead>
            <tbody>
              {results.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.schedule_name}</b><br /><span className="mono muted">{s.schedule_code}</span></td>
                  <td>{s.scope_type}{s.asset_type ? ` · ${s.asset_type}` : ''}</td>
                  <td><Pill value={s.task_type} /></td>
                  <td>{s.recurrence_summary || s.frequency}</td>
                  <td className={s.due_state === 'OVERDUE' ? 'overdue' : undefined}>
                    {fmtDate(s.next_due_date)}
                    {s.due_state && s.due_state !== 'SCHEDULED' && <><br /><span className="sched-state muted">{s.due_state === 'GENERATING' ? `generating since ${fmtDate(s.generate_by)}` : s.due_state.toLowerCase()}</span></>}
                  </td>
                  <td>{s.target_count ?? s.targets?.length ?? 0}</td>
                  <td>{s.open_generated_tasks ?? 0}</td>
                  <td>{s.checklist_template?.name || '—'}</td>
                  <td><Pill value={s.is_active ? 'ACTIVE' : 'INACTIVE'} /></td>
                  <td className="nowrap">
                    <button className="btn btn-sm" onClick={() => preview(s)}>{t('schedPreview')}</button>{' '}
                    {canRun && <button className="btn btn-sm" onClick={() => runOne(s)} title="Generate due tasks for this schedule">{t('schedRunOne')}</button>}{' '}
                    {canWrite && <button className="btn btn-sm" onClick={() => toggleActive(s)}>{s.is_active ? t('schedPause') : t('schedResume')}</button>}{' '}
                    {canWrite && <button className="btn btn-sm" onClick={() => { setForm({ ...s, next_due_date: s.next_due_date.slice(0, 10) }); setRule(ruleToUi(s.recurrence)); }}>{t('schedEdit')}</button>}
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan="10" className="muted center">{query ? t('schedNoMatch') : t('schedNone')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>)}

      {tab === 'upcoming' && (
        <UpcomingView data={upcoming} days={upDays} setDays={setUpDays} />
      )}

      {tab === 'adherence' && (
        <AdherenceView data={adherence} days={adhDays} setDays={setAdhDays} />
      )}

      {detail && detail.targets && (
        <Modal title={`${detail.schedule_name} — ${t('schedColNextDue')} ${fmtDate(detail.next_due_date)}`} onClose={() => setDetail(null)} wide>
          <div className="kv">
            <span className="k">{t('schedColScope')}</span><span>{detail.scope_type} {detail.asset_type || ''}</span>
            <span className="k">{t('schedColTaskType')}</span><span><Pill value={detail.task_type} /></span>
            <span className="k">{t('schedRecurrence')}</span><span>{detail.recurrence_summary || detail.frequency}{detail.occurrences_generated ? ` · ${detail.occurrences_generated} ${t('schedColGenerated').toLowerCase()}` : ''}</span>
            <span className="k">{t('schedResponsibleCrew')}</span><span>{detail.responsible_crew?.name || '—'}</span>
            <span className="k">{t('schedPriorityLabel')}</span><span>{detail.priority}</span>
            <span className="k">{t('schedInstructions')}</span><span>{detail.instructions || '—'}</span>
          </div>
          <div className="card-head mt"><h3 className="card-title">{t('schedWillGenerate')} {detail.target_count} {t('schedTargets')} — {fmtDate(detail.next_due_date)}</h3></div>
          {(detail.next_occurrences || []).length > 0 && (
            <>
              <div className="card-head mt"><h3 className="card-title">{t('schedUpcomingOcc')}</h3></div>
              <ul className="occ-list">
                {detail.next_occurrences.map((d) => <li key={d}>{fmtDate(d)}</li>)}
              </ul>
            </>
          )}
          {detail.is_active === 0 && detail.occurrences_generated > 0 && (
            <div className="muted mt" style={{ fontSize: 12 }}>{t('schedEnded')}</div>
          )}
          <div className="tbl-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>{t('schedColTargets')}</th><th>{t('schedColTaskType')}</th></tr></thead>
              <tbody>
                {(detail.targets || []).map((tgt) => (
                  <tr key={tgt.id}><td>{tgt.name}</td><td>{tgt.type}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {form && (
        <Modal title={form.id ? `${t('schedEdit')} — ${form.schedule_name}` : t('schedAdd')} onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>{t('cancel')}</button>
            <button className="btn btn-primary" onClick={save}>{t('save')}</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>{t('schedName')}</label><input value={form.schedule_name || ''} onChange={(e) => setForm({ ...form, schedule_name: e.target.value })} /></div>
            <div className="field"><label>{t('schedCode')}</label><input value={form.schedule_code || ''} onChange={(e) => setForm({ ...form, schedule_code: e.target.value })} /></div>
            <div className="field"><label>{t('schedScopeType')}</label>
              <select value={form.scope_type} onChange={(e) => setForm({ ...form, scope_type: e.target.value })}>
                {SCOPE.map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>{t('schedAssetTypeHint')}</label>
              <select value={form.asset_type || ''} onChange={(e) => setForm({ ...form, asset_type: e.target.value })}>
                <option value="">—</option>
                {ASSET_TYPES.map((at) => <option key={at}>{at}</option>)}
              </select></div>
            {form.scope_type === 'ASSET' && (
              <div className="field"><label>{t('schedTargetAsset')}</label>
                <select value={form.asset_id || ''} onChange={(e) => setForm({ ...form, asset_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('schedNoneOption')}</option>
                  {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select></div>
            )}
            {form.scope_type === 'SUBSTATION' && (
              <div className="field"><label>{t('schedTargetSubstation')}</label>
                <select value={form.substation_id || ''} onChange={(e) => setForm({ ...form, substation_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">{t('schedNoneOption')}</option>
                  {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
            )}
            {(form.scope_type === 'LINE' || form.scope_type === 'LINE_TOWERS') && (
              <div className="field"><label>{t('schedTargetLine')}</label>
                <select value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value ? Number(e.target.value) : null, tower_id: null })}>
                  <option value="">{t('schedNoneOption')}</option>
                  {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select></div>
            )}
            {form.scope_type === 'TOWER' && (
              <div className="field"><label>{t('schedTargetTower')}</label>
                <select value={form.tower_id || ''} onChange={(e) => {
                  const tid = e.target.value ? Number(e.target.value) : null;
                  const tw = towers.find((x) => x.id === tid);
                  setForm({ ...form, tower_id: tid, line_id: tw ? tw.line_id : form.line_id });
                }}>
                  <option value="">{t('schedNoneOption')}</option>
                  {(form.line_id ? towers.filter((tw) => tw.line_id === Number(form.line_id)) : towers).map((tw) => (
                    <option key={tw.id} value={tw.id}>{tw.tower_id}</option>
                  ))}
                </select></div>
            )}
            <div className="field"><label>{t('schedRecurrence')}</label>
              <select value={rule.type} onChange={(e) => setRule({ ...rule, type: e.target.value })}>
                {PATTERNS.map(([value, labelKey]) => <option key={value} value={value}>{t(labelKey)}</option>)}
              </select></div>
            {rule.type !== 'MONTHLY_NTH' && (
              <div className="field"><label>{rule.type === 'INTERVAL_DAYS' ? t('schedDaysBetween') : rule.type === 'WEEKLY' ? t('schedWeeksBetween') : t('schedMonthsBetween')}</label>
                <input type="number" min="1" max="1000" value={rule.interval} onChange={(e) => setRule({ ...rule, interval: e.target.value })} /></div>
            )}
            {rule.type === 'WEEKLY' && (
              <div className="field full"><label>{t('schedOnWeekdays')}</label>
                <div className="chip-row">
                  {WEEKDAY_OPTS.map(([value, label]) => (
                    <button type="button" key={value} className={`chip${rule.weekdays.includes(value) ? ' chip-on' : ''}`}
                      onClick={() => setRule({ ...rule, weekdays: rule.weekdays.includes(value) ? rule.weekdays.filter((x) => x !== value) : [...rule.weekdays, value] })}>{label}</button>
                  ))}
                </div></div>
            )}
            {rule.type === 'MONTHLY_DAY' && (
              <div className="field"><label>{t('schedDayOfMonth')}</label>
                <input type="number" min="1" max="31" value={rule.day} onChange={(e) => setRule({ ...rule, day: e.target.value })} /></div>
            )}
            {rule.type === 'MONTHLY_NTH' && (<>
              <div className="field"><label>{t('schedWhich')}</label>
                <select value={rule.nth} onChange={(e) => setRule({ ...rule, nth: Number(e.target.value) })}>
                  {NTH_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></div>
              <div className="field"><label>{t('schedWeekday')}</label>
                <select value={rule.weekday} onChange={(e) => setRule({ ...rule, weekday: Number(e.target.value) })}>
                  {WEEKDAY_OPTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></div>
            </>)}
            <div className="field full"><label>{t('schedEnds')}</label>
              <div className="chip-row">
                {[['never', t('schedNever')], ['until', t('schedOnDate')], ['count', t('schedAfterN')]].map(([value, label]) => (
                  <button type="button" key={value} className={`chip${rule.endType === value ? ' chip-on' : ''}`}
                    onClick={() => setRule({ ...rule, endType: value })}>{label}</button>
                ))}
              </div></div>
            {rule.endType === 'until' && (
              <div className="field"><label>{t('schedEndDate')}</label>
                <input type="date" value={rule.until} onChange={(e) => setRule({ ...rule, until: e.target.value })} /></div>
            )}
            {rule.endType === 'count' && (
              <div className="field"><label>{t('schedOccurrencesLabel')}</label>
                <input type="number" min="1" value={rule.count} onChange={(e) => setRule({ ...rule, count: e.target.value })} /></div>
            )}
            <div className="field"><label>{t('schedPriorityLabel')}</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}
              </select></div>
            <div className="field"><label>{t('schedTaskTypeGen')}</label>
              <select value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })}>
                {TASK_TYPES.map((ty) => <option key={ty}>{ty}</option>)}
              </select></div>
            <div className="field"><label>{t('schedNextDueDate')}</label><input type="date" value={form.next_due_date} onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} /></div>
            <div className="field"><label>{t('schedLeadTime')}</label><input type="number" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: Number(e.target.value) })} /></div>
            <div className="field"><label>{t('schedChecklistLabel')}</label>
              <select value={form.checklist_template_id || ''} onChange={(e) => setForm({ ...form, checklist_template_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('schedNoneOption')}</option>
                {checklists.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="field"><label>{t('schedResponsibleCrew')}</label>
              <select value={form.responsible_crew_id || ''} onChange={(e) => setForm({ ...form, responsible_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('schedNoneOption')}</option>
                {crews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </select></div>
            <div className="field full"><label>{t('schedInstructions')}</label><textarea value={form.instructions || ''} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </Page>
  );
}

const RANGES = [30, 60, 90];

function RangeChips({ days, setDays }) {
  return (
    <div className="chip-row">
      {RANGES.map((d) => (
        <button type="button" key={d} className={`chip${days === d ? ' chip-on' : ''}`} onClick={() => setDays(d)}>{t('schedNext')} {d} {t('schedDays')}</button>
      ))}
    </div>
  );
}

function monthLabel(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  catch (_) { return iso.slice(0, 7); }
}

function UpcomingView({ data, days, setDays }) {
  if (!data) return <Loading />;
  const groups = [];
  for (const occ of data.occurrences) {
    const label = monthLabel(occ.due_date);
    let group = groups[groups.length - 1];
    if (!group || group.label !== label) { group = { label, items: [] }; groups.push(group); }
    group.items.push(occ);
  }
  return (
    <>
      <div className="card-head">
        <h3 className="card-title">{t('schedUpcomingPlan')}</h3>
        <RangeChips days={days} setDays={setDays} />
      </div>
      <div className="sched-summary">
        <div className="sched-kpi"><b>{data.count}</b><span>{t('schedOccurrences')}</span></div>
        <div className={'sched-kpi' + (data.overdue_count ? ' warn' : '')}><b>{data.overdue_count}</b><span>{t('schedOverdue')}</span></div>
        <div className="sched-kpi"><b>{data.generate_now_count}</b><span>{t('schedReadyGenerate')}</span></div>
      </div>
      {!data.occurrences.length && <div className="empty">{t('schedNoOccurrences')} {days} {t('schedDays')}.</div>}
      {groups.map((group) => (
        <div key={group.label} className="sched-month">
          <div className="sched-month-label">{group.label}</div>
          <div className="sched-timeline">
            {group.items.map((occ, i) => {
              const d = new Date(occ.due_date);
              const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
              return (
                <div key={`${occ.schedule_id}-${occ.due_date}-${i}`} className={'sched-item' + (occ.overdue ? ' overdue' : '') + (occ.generate_now && !occ.overdue ? ' due-now' : '')}>
                  <div className="sched-date"><b>{d.getDate()}</b><span>{weekday}</span></div>
                  <div className="sched-body">
                    <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <b>{occ.schedule_name}</b>
                      <span className="mail-tags"><Pill value={occ.task_type} /><Pill value={occ.priority} /></span>
                    </div>
                    <div className="muted sched-meta">
                      <span className="mono">{occ.schedule_code}</span>
                      <span>{occ.scope_type}{occ.asset_type ? ` · ${occ.asset_type}` : ''}</span>
                      <span>{occ.target_count} {t('schedTargets')}</span>
                      <span>{occ.crew_name || t('schedUnassigned')}</span>
                    </div>
                    <div className="sched-when muted">
                      {occ.overdue
                        ? `${t('schedOverdueSince')} ${fmtDate(occ.due_date)} — ${t('schedWillGenerateNow')}`
                        : occ.generate_now
                          ? `${t('schedGenerateNow')} · ${t('schedDueLabel')} ${fmtDate(occ.due_date)}`
                          : `${t('schedGenerates')} ${fmtDate(occ.generate_by)} · ${t('schedDueLabel')} ${fmtDate(occ.due_date)}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

function RateBar({ value }) {
  if (value == null) return <span className="muted">—</span>;
  return (
    <div className="rate-bar" title={`${value}%`}>
      <div className="rate-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      <span className="rate-label">{value}%</span>
    </div>
  );
}

function AdherenceView({ data, days, setDays }) {
  if (!data) return <Loading />;
  const totals = data.totals || {};
  return (
    <>
      <div className="card-head">
        <h3 className="card-title">{t('schedAdherence')}</h3>
        <RangeChips days={days} setDays={setDays} />
      </div>
      <div className="sched-summary">
        <div className="sched-kpi"><b>{totals.completion_rate == null ? '—' : `${totals.completion_rate}%`}</b><span>{t('schedCompletion')}</span></div>
        <div className="sched-kpi"><b>{totals.on_time_rate == null ? '—' : `${totals.on_time_rate}%`}</b><span>{t('schedOnTime')}</span></div>
        <div className={'sched-kpi' + (totals.overdue_open ? ' warn' : '')}><b>{totals.overdue_open || 0}</b><span>{t('schedOverdueOpen')}</span></div>
        <div className="sched-kpi"><b>{totals.due || 0}</b><span>{t('schedDueOcc')}</span></div>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>{t('schedColSchedule')}</th><th>{t('schedColScope')}</th><th>{t('schedColGenerated')}</th><th>{t('schedColDue')}</th><th>{t('schedColCompleted')}</th><th>{t('schedColOnTime')}</th><th>{t('schedColOverdue')}</th><th>{t('schedColCompletion')}</th><th>{t('schedColOnTimeRate')}</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.schedule_id}>
                  <td><b>{r.schedule_name}</b><br /><span className="mono muted">{r.schedule_code}</span></td>
                  <td>{r.scope_type}</td>
                  <td>{r.generated}</td>
                  <td>{r.due}</td>
                  <td>{r.completed}</td>
                  <td>{r.on_time}</td>
                  <td className={r.overdue_open ? 'overdue' : undefined}>{r.overdue_open}</td>
                  <td><RateBar value={r.completion_rate} /></td>
                  <td><RateBar value={r.on_time_rate} /></td>
                </tr>
              ))}
              {!data.rows.length && <tr><td colSpan="9" className="muted center">{t('schedNoneReport')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

