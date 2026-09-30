import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, PrintButton, MoneyCard, SearchField, useSearchFilter } from '../components';
import { BarRow, KpiTile } from '../components/InfraVisuals';
import AnalyticsBlock from '../components/AnalyticsBlock';
import { can, getStoredUser } from '../auth';
import { assetsInScope, linesInRegion } from '../cascade';
import DocumentReport from '../components/DocumentReport';

const DOCUMENT_TYPES = ['ASSET_DETAIL', 'CREW_DETAIL', 'PERSON_DETAIL', 'TASK_DETAIL', 'LINE_DETAIL'];
// Person profiles have no seed template but are reachable from the entity
// picker, so offer a card for them alongside the templated ones.
const PERSON_PROFILE = { id: 'person_profile', report_type: 'PERSON_DETAIL', name: 'Person Detail Profile', description: 'Per-person record: crews, certifications, findings and executions.' };

const PERIOD_OPTIONS = [
  { key: 1, label: '1 month' },
  { key: 3, label: '3 months' },
  { key: 6, label: '6 months' },
  { key: 12, label: '12 months' },
];
const PERIOD_SUB = {
  1: 'in this fiscal month',
  3: 'in this fiscal quarter',
  6: 'in this fiscal half year',
  12: 'in this fiscal year to date',
};

function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, dim));
  return d;
}
// The reporting year is anchored to Hamle 1 (7 July, Ethiopian calendar). The
// selected period is the current fiscal month/quarter/half/year, and KPIs are
// counted over [start, end).
function fiscalYearStart(now) {
  const anchor = new Date(now.getFullYear(), 6, 7);
  return now >= anchor ? anchor : new Date(now.getFullYear() - 1, 6, 7);
}
// `months` is the window length (1, 3, 6 or 12). The window is the current
// fiscal block of that length, so 1 month is the fiscal month, 3 the quarter,
// 6 the half year and 12 the whole fiscal year.
function fiscalPeriodRange(months, now = new Date()) {
  const fyStart = fiscalYearStart(now);
  const monthsIn = (now.getFullYear() - fyStart.getFullYear()) * 12 + (now.getMonth() - fyStart.getMonth());
  const span = months === 12 ? 12 : months;
  const offset = span >= 12 ? 0 : Math.floor(monthsIn / span) * span;
  const start = addMonths(fyStart, offset);
  const end = addMonths(start, span);
  return { start, end };
}
const dayFmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function Reports() {
  const canGenerate = can(getStoredUser(), 'report:write');
  const [templates, setTemplates] = useState([]);
  const [reports, setReports] = useState([]);
  const [regions, setRegions] = useState([]);
  const [error, setError] = useState(null);
  const [genForm, setGenForm] = useState(null);
  const [view, setView] = useState(null);
  const [busy, setBusy] = useState(false);
  const [entityLists, setEntityLists] = useState({ tasks: [], lines: [], assets: [], crews: [], people: [], regions: [], subs: [] });
  const canPerf = canGenerate;
  const [perfScope, setPerfScope] = useState('crew');
  const [perf, setPerf] = useState(null);
  const [perfErr, setPerfErr] = useState(null);
  const [perfExpanded, setPerfExpanded] = useState(false);
  const [period, setPeriod] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [documents, setDocuments] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [makeSchedule, setMakeSchedule] = useState(false);
  const [scheduleMonths, setScheduleMonths] = useState(1);
  const [shareTarget, setShareTarget] = useState(null);
  const [shareTo, setShareTo] = useState(() => new Set());
  const [shareNote, setShareNote] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareErr, setShareErr] = useState(null);
  const [monitor, setMonitor] = useState(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const { query, setQuery, results: reportRows } = useSearchFilter(reports);
  const [searchParams, setSearchParams] = useSearchParams();

  const range = useMemo(() => fiscalPeriodRange(period), [period]);
  const rangeLabel = `${dayFmt(range.start)} → ${dayFmt(new Date(range.end.getTime() - 864e5))}`;
  const kpis = useMemo(() => {
    let total = 0;
    let docs = 0;
    for (const r of reports) {
      const t = r.generated_at ? new Date(r.generated_at) : null;
      if (!t || t < range.start || t >= range.end) continue;
      total += 1;
      if (DOCUMENT_TYPES.includes(r.report_type)) docs += 1;
    }
    return { total, docs, analysis: total - docs };
  }, [reports, range]);
  const byType = useMemo(() => {
    const m = new Map();
    for (const r of reports) {
      const t = r.generated_at ? new Date(r.generated_at) : null;
      if (!t || t < range.start || t >= range.end) continue;
      m.set(r.report_type, (m.get(r.report_type) || 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [reports, range]);
  const trend = useMemo(() => {
    const now = new Date();
    const fyStart = fiscalYearStart(now);
    const monthsIn = (now.getFullYear() - fyStart.getFullYear()) * 12 + (now.getMonth() - fyStart.getMonth());
    const first = Math.max(0, monthsIn - 5);
    const out = [];
    for (let j = first; j <= monthsIn; j += 1) {
      const s = addMonths(fyStart, j);
      const e = addMonths(s, 1);
      const value = reports.filter((r) => {
        const t = r.generated_at ? new Date(r.generated_at) : null;
        return t && t >= s && t < e;
      }).length;
      out.push({ label: s.toLocaleDateString('en-GB', { month: 'short' }), value });
    }
    return out;
  }, [reports]);

  const profileTemplates = useMemo(() => {
    const list = templates.filter((t) => DOCUMENT_TYPES.includes(t.report_type));
    return list.some((t) => t.report_type === 'PERSON_DETAIL') ? list : [...list, PERSON_PROFILE];
  }, [templates]);
  const analysisTemplates = useMemo(() => templates.filter((t) => !DOCUMENT_TYPES.includes(t.report_type)), [templates]);
  const modalTemplates = useMemo(() => [...profileTemplates, ...analysisTemplates], [profileTemplates, analysisTemplates]);
  const recent = useMemo(() => [...reports].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 6), [reports]);
  const filteredReports = useMemo(() => reportRows.filter((r) => {
    if (typeFilter === 'profile' && !DOCUMENT_TYPES.includes(r.report_type)) return false;
    if (typeFilter === 'analysis' && DOCUMENT_TYPES.includes(r.report_type)) return false;
    if (regionFilter && String(r.scope_region_id || '') !== regionFilter) return false;
    return true;
  }), [reportRows, typeFilter, regionFilter]);

  // Click-through drill-down: push an entity document onto the stack and fetch
  // its read-only detail (scoped to the caller). Clicking an entity inside a
  // document pushes another level so the reader can keep walking the chain.
  function openDocument(type, id, label) {
    if (!type || id == null) return;
    const key = `${Date.now()}-${Math.random()}`;
    setDocuments((d) => [...d, { key, type, id, label, loading: true }]);
    api.get(`/reports/document?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`)
      .then((res) => setDocuments((d) => d.map((x) => (x.key === key ? { ...x, data: res.data ?? res, loading: false } : x))))
      .catch((e) => setDocuments((d) => d.map((x) => (x.key === key ? { ...x, error: e.message, loading: false } : x))));
  }
  const popDocument = () => setDocuments((d) => d.slice(0, -1));
  const openReport = (id) => {
    setDocuments([]);
    api.get(`/reports/${id}`).then(setView).catch((e) => setError(e.message));
  };
  const startReport = (report_type) => {
    const r = fiscalPeriodRange(period);
    setGenForm({
      report_type,
      period_start: isoDay(r.start),
      period_end: isoDay(new Date(r.end.getTime() - 864e5)),
      scope_region_id: '',
    });
  };
  const applyPeriodMonths = (months) => {
    const r = fiscalPeriodRange(months);
    setGenForm((f) => ({ ...f, period_start: isoDay(r.start), period_end: isoDay(new Date(r.end.getTime() - 864e5)) }));
  };

  const loadSchedules = () => api.get('/report-schedules').then(setSchedules).catch(() => {});
  const loadMonitor = () => api.get('/asset-monitor').then(setMonitor).catch(() => {});
  const runMonitor = () => {
    setMonitorBusy(true);
    api.post('/asset-monitor/run', {})
      .then(() => { loadMonitor(); load(); })
      .catch((e) => setError(e.message))
      .finally(() => setMonitorBusy(false));
  };
  const toggleSchedule = (s) => api.patch(`/report-schedules/${s.id}`, { active: !s.active })
    .then(() => loadSchedules()).catch((e) => setError(e.message));
  const load = () => {
    api.get('/report-templates').then(setTemplates).catch((e) => setError(e.message));
    api.get('/reports').then(setReports).catch(() => {});
    loadSchedules();
    loadMonitor();
  };
  useEffect(() => {
    load();
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/tasks').then((r) => setEntityLists((e) => ({ ...e, tasks: r }))).catch(() => {});
    api.get('/lines').then((r) => setEntityLists((e) => ({ ...e, lines: r }))).catch(() => {});
    api.get('/assets?brief=1').then((r) => setEntityLists((e) => ({ ...e, assets: r }))).catch(() => {});
    api.get('/crews').then((r) => setEntityLists((e) => ({ ...e, crews: r }))).catch(() => {});
    api.get('/people').then((r) => setEntityLists((e) => ({ ...e, people: r }))).catch(() => {});
    api.get('/regions').then((r) => setEntityLists((e) => ({ ...e, regions: r }))).catch(() => {});
    api.get('/substations').then((r) => setEntityLists((e) => ({ ...e, subs: r }))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!canPerf) return;
    const from = isoDay(range.start);
    const to = isoDay(new Date(range.end.getTime() - 864e5));
    api.get(`/performance?scope=${perfScope}&date_from=${from}&date_to=${to}`)
      .then((r) => setPerf(r.rows))
      .catch((e) => setPerfErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfScope, canPerf, range]);

  // Deep link from the mailbox: /reports?report=<id> opens the saved report in
  // the reader, and /reports?document=<TYPE>&id=<id> opens an entity document.
  // A handled-key ref dedupes the StrictMode double-invoke while the query
  // params are cleared afterwards so the URL stays clean — clearing the params
  // re-runs this effect, so we must not cancel the in-flight load on cleanup
  // (that left the reader blank).
  const deepLinkRef = useRef('');
  useEffect(() => {
    const dtype = searchParams.get('document');
    const did = searchParams.get('id');
    if (dtype && did) {
      const key = `doc:${dtype}:${did}`;
      if (deepLinkRef.current === key) return undefined;
      deepLinkRef.current = key;
      setView(null);
      setDocuments([]);
      openDocument(dtype, did);
      setSearchParams({}, { replace: true });
      return undefined;
    }
    const rid = searchParams.get('report');
    if (!rid) return undefined;
    const key = `rep:${rid}`;
    if (deepLinkRef.current === key) return undefined;
    deepLinkRef.current = key;
    setDocuments([]);
    api.get(`/reports/${encodeURIComponent(rid)}`)
      .then((res) => setView(res))
      .catch((e) => setError(e.message));
    setSearchParams({}, { replace: true });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function generate() {
    try {
      setBusy(true);
      if (makeSchedule) {
        await api.post('/report-schedules', { ...genForm, months: scheduleMonths });
        loadSchedules();
        setGenForm(null);
        setMakeSchedule(false);
        return;
      }
      const res = await api.post('/reports/generate', genForm);
      setDocuments([]);
      setView(res);
      load();
      setGenForm(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function submitShare() {
    if (!shareTarget || shareTo.size === 0) return;
    try {
      setShareBusy(true);
      setShareErr(null);
      const recipients = [...shareTo];
      if (shareTarget.kind === 'document') {
        await api.post('/reports/document/share', { type: shareTarget.type, id: shareTarget.id, recipients, note: shareNote });
      } else {
        await api.post(`/reports/${shareTarget.id}/share`, { recipients, note: shareNote });
      }
      setShareTarget(null);
      setShareTo(new Set());
      setShareNote('');
    } catch (e) { setShareErr(e.message); }
    finally { setShareBusy(false); }
  }
  if (!templates.length && !reports.length && !error) return <Page title="Operational & Compliance Reports"><Loading /></Page>;

  return (
    <Page title="Operational & Compliance Reports" crumbs="TMMS / Validation & Compliance"
      actions={canGenerate ? <button className="btn btn-primary" onClick={() => startReport(templates[0]?.report_type || 'MAINTENANCE_COST')}>+ Generate Report</button> : null}>
      {error && <ErrorNote error={error} />}

      <div className="period-bar">
        <div className="seg" role="group" aria-label="Report period">
          {PERIOD_OPTIONS.map((p) => (
            <button key={p.key} type="button" className={period === p.key ? 'on' : ''} onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
        <span className="period-range">Showing <b>{rangeLabel}</b></span>
        <span className="ref-note">Periods anchored to Hamle 1 (7 July) - Ethiopian fiscal calendar</span>
      </div>

      <div className="kpi-strip">
        <KpiTile label="Reports generated" value={kpis.total} sub={PERIOD_SUB[period]} tone="ok" />
        <KpiTile label="Entity profiles" value={kpis.docs} sub="asset / crew / person / task / line" />
        <KpiTile label="Analysis &amp; compliance" value={kpis.analysis} sub="cost / valuation / readiness / performance" />
        <KpiTile label="Report templates" value={templates.length} sub="not period-scoped" />
      </div>

      <div className="grid grid-2 mt">
        <div className="card card-pad">
          <div className="card-head"><h3>Reports by type</h3><span className="muted">{rangeLabel}</span></div>
          {byType.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No reports in this period.</div>}
          {byType.map((r) => (
            <BarRow key={r.label} label={r.label} value={r.value} max={byType[0]?.value} />
          ))}
        </div>
        <div className="card card-pad">
          <div className="card-head"><h3>Generation trend</h3><span className="muted">last {trend.length} fiscal month(s)</span></div>
          {trend.map((r) => (
            <BarRow key={r.label} label={r.label} value={r.value} max={Math.max(1, ...trend.map((t) => t.value))} color="#0f766e" />
          ))}
        </div>
      </div>

      <h3 className="section-title">Report templates <span className="hint">click a template to start a report</span></h3>
      <div className="card card-pad mb">
        <div className="card-head"><h3>Entity profiles</h3><span className="muted">one record, complete history</span></div>
        <div className="grid grid-4">
          {profileTemplates.map((t) => <TemplateCard key={t.report_type} t={t} onPick={startReport} />)}
        </div>
      </div>
      <div className="card card-pad">
        <div className="card-head"><h3>Analysis &amp; compliance</h3><span className="muted">period &amp; portfolio</span></div>
        <div className="grid grid-3">
          {analysisTemplates.map((t) => <TemplateCard key={t.report_type} t={t} onPick={startReport} />)}
        </div>
      </div>

      {monitor && (
        <div className="card card-pad mt">
          <div className="card-head">
            <h3>Asset condition monitoring</h3>
            <div className="chip-row">
              <span className="ref-note">Revaluation agent · {monitor.summary?.last_run_at ? `last run ${fmtDate(monitor.summary.last_run_at)}` : 'not run yet'}</span>
              {canGenerate && <button type="button" className="btn btn-sm btn-primary" disabled={monitorBusy} onClick={runMonitor}>{monitorBusy ? 'Revaluing…' : 'Run revaluation'}</button>}
            </div>
          </div>
          <div className="kpi-strip">
            <KpiTile label="Assets evaluated" value={monitor.summary?.candidate_assets ?? 0} sub="carrying field evidence" />
            <KpiTile label="Condition changes (30d)" value={monitor.summary?.assets_changed_30d ?? 0} />
            <KpiTile label="Degraded (180d)" value={monitor.summary?.degraded ?? 0} tone={monitor.summary?.degraded ? 'bad' : 'ok'} />
            <KpiTile label="Snapshots logged" value={monitor.summary?.snapshots ?? 0} />
          </div>
          {(() => {
            const degradations = (monitor.recent || []).filter((c) => c.delta < 0);
            return degradations.length ? (
              <div className="tbl-wrap mt">
                <table>
                  <thead><tr><th>Asset</th><th>Region</th><th>Recorded</th><th>Suggested</th><th>Recommended action</th></tr></thead>
                  <tbody>
                    {degradations.map((c) => (
                      <tr key={c.asset_pk} className="row-link" title="View asset details" onClick={() => openDocument('ASSET_DETAIL', c.asset_pk, c.asset_name)}>
                        <td><b>{c.asset_code}</b> · {c.asset_name}</td>
                        <td>{c.region || '—'}</td>
                        <td>{c.from_rating ?? '—'}</td>
                        <td className="bad">{c.to_rating ?? '—'}</td>
                        <td>{c.recommendation_label || c.recommendation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted mt" style={{ fontSize: 13 }}>No degraded assets in the last 180 days. Run the agent to reassess evidence-bearing assets.</p>;
          })()}
        </div>
      )}

      <div className="grid grid-2 mt">
        <div className="card card-pad">
          <div className="card-head"><h3>Recent reports</h3><span className="muted">latest {recent.length}</span></div>
          <div className="recent-list">
            {recent.map((r) => (
              <button key={r.id} type="button" className="recent-item" onClick={() => openReport(r.id)}>
                <span className={`pill ${DOCUMENT_TYPES.includes(r.report_type) ? 'pill-doc' : 'pill-analysis'}`}>{r.report_type.replace(/_DETAIL$/, '').replace(/_/g, ' ')}</span>
                <span className="recent-main"><b>{r.title}</b><span className="muted">{r.report_code} · {fmtDate(r.generated_at)}</span></span>
                <span className="link">View</span>
              </button>
            ))}
            {recent.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No reports generated yet</div>}
          </div>
        </div>

        {canPerf && (
          <div className="card card-pad">
            <div className="card-head"><h3>Field team performance</h3>
              <div className="chip-row">
                <button type="button" className={`chip${perfScope === 'crew' ? ' chip-on' : ''}`} onClick={() => setPerfScope('crew')}>By crew</button>
                <button type="button" className={`chip${perfScope === 'person' ? ' chip-on' : ''}`} onClick={() => setPerfScope('person')}>By person</button>
              </div>
            </div>
            {perfErr && <ErrorNote error={perfErr} />}
            {!perf && !perfErr && <Loading />}
            {perf && (
              <>
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>{perfScope === 'crew' ? 'Crew' : 'Person'}</th><th>Tasks</th><th>Rate</th><th>On time</th><th>Overdue</th></tr></thead>
                    <tbody>
                      {(perfExpanded ? perf : perf.slice(0, 5)).map((r) => {
                        const detailType = perfScope === 'crew' ? 'CREW_DETAIL' : 'PERSON_DETAIL';
                        return (
                          <tr key={r.id} className="row-link" title={`Click to view ${perfScope} details`} onClick={() => openDocument(detailType, r.id, r.name)}>
                            <td><b>{r.name}</b></td>
                            <td>{r.tasks}</td>
                            <td>{r.completion_rate}%</td>
                            <td>{r.on_time_rate}%</td>
                            <td className={r.overdue ? 'bad' : undefined}>{r.overdue ?? 0}</td>
                          </tr>
                        );
                      })}
                      {perf.length === 0 && <tr><td colSpan={5} className="muted center">No data for this scope.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {perf.length > 5 && (
                  <div className="mt">
                    <button className="btn btn-sm" onClick={() => setPerfExpanded((v) => !v)}>
                      {perfExpanded ? 'Show less' : `View full performance table (${perf.length})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <h3 className="section-title">Scheduled reports <span className="hint">{schedules.filter((s) => s.active).length} active</span></h3>
      <div className="card mb">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Report</th><th>Cadence</th><th>Next run</th><th>Last run</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {schedules.map((s) => {
                const tpl = modalTemplates.find((t) => t.report_type === s.report_type);
                return (
                  <tr key={s.id}>
                    <td><b>{tpl ? tpl.name : s.report_type}</b></td>
                    <td>Every {s.months} month{s.months === 1 ? '' : 's'}</td>
                    <td className="nowrap">{fmtDate(s.next_run_at)}</td>
                    <td className="nowrap">{s.last_run_at ? fmtDate(s.last_run_at) : '—'}</td>
                    <td>{s.active ? <span className="ok">Active</span> : <span className="muted">Paused</span>}</td>
                    <td>{canGenerate ? <button className="btn btn-sm" onClick={() => toggleSchedule(s)}>{s.active ? 'Pause' : 'Resume'}</button> : null}</td>
                  </tr>
                );
              })}
              {schedules.length === 0 && <tr><td colSpan="6" className="muted center">No scheduled reports. Tick "Schedule" when generating a report.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <h3 className="section-title">Generated reports <span className="hint">{reports.length} total</span></h3>
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search reports…" />
        <SearchSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          <option value="profile">Entity profiles</option>
          <option value="analysis">Analysis &amp; compliance</option>
        </SearchSelect>
        <SearchSelect value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
          <option value="">All regions</option>
          {regions.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
        </SearchSelect>
        <span className="muted" style={{ fontSize: 12 }}>{filteredReports.length} of {reports.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Period</th><th>Generated</th><th></th></tr></thead>
            <tbody>
              {filteredReports.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.report_code}</td>
                  <td><b>{r.title}</b></td>
                  <td>{r.report_type}</td>
                  <td className="nowrap">{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</td>
                  <td className="nowrap">{fmtDate(r.generated_at)}</td>
                  <td><button className="btn btn-sm" onClick={() => openReport(r.id)}>View</button></td>
                </tr>
              ))}
              {filteredReports.length === 0 && (
                <tr><td colSpan="6" className="muted center">{query || typeFilter || regionFilter ? 'No reports match your filters' : 'No reports generated yet'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {genForm && (
        <Modal title="Generate Report" onClose={() => setGenForm(null)}
          footer={<>
            <button className="btn" onClick={() => setGenForm(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={generate}>{busy ? 'Working…' : (makeSchedule ? 'Schedule report' : 'Generate')}</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Report type</label>
              <SearchSelect value={genForm.report_type} onChange={(e) => setGenForm({ ...genForm, report_type: e.target.value })}>
                {modalTemplates.map((t) => <option key={t.report_type} value={t.report_type}>{t.name}</option>)}
              </SearchSelect></div>
            {DOCUMENT_TYPES.includes(genForm.report_type) ? (
              <EntityPicker type={genForm.report_type} form={genForm} lists={entityLists} setForm={setGenForm} />
            ) : (
              <>
                <div className="field full"><label>Quick period</label>
                  <div className="chip-row">
                    {PERIOD_OPTIONS.map((p) => (
                      <button key={p.key} type="button" className="chip" onClick={() => applyPeriodMonths(p.key)}>{p.label}</button>
                    ))}
                  </div>
                </div>
                <div className="field"><label>Period start</label><input type="date" value={genForm.period_start} onChange={(e) => setGenForm({ ...genForm, period_start: e.target.value })} /></div>
                <div className="field"><label>Period end</label><input type="date" value={genForm.period_end} onChange={(e) => setGenForm({ ...genForm, period_end: e.target.value })} /></div>
                <div className="field"><label>Region scope</label>
                  <SearchSelect value={genForm.scope_region_id || ''} onChange={(e) => setGenForm({ ...genForm, scope_region_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">All regions</option>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </SearchSelect></div>
              </>
            )}
            {canGenerate && (
              <div className="field full">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none' }}>
                  <input type="checkbox" checked={makeSchedule} onChange={(e) => setMakeSchedule(e.target.checked)} />
                  Schedule this report to run automatically
                </label>
                {makeSchedule && (
                  <div style={{ marginTop: 6 }}>
                    <SearchSelect value={String(scheduleMonths)} onChange={(e) => setScheduleMonths(Number(e.target.value))}>
                      <option value="1">Every 1 month</option>
                      <option value="3">Every 3 months</option>
                      <option value="6">Every 6 months</option>
                      <option value="12">Every 12 months</option>
                    </SearchSelect>
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {(view || documents.length > 0) && (() => {
        const top = documents[documents.length - 1];
        const shareDoc = top && top.data && !top.loading && !top.error;
        const canShare = !!shareDoc || (!top && view?.id);
        return (
          <Modal title={top ? (top.data?.title || top.label || 'Entity Profile') : (view?.title || view?.data?.title || 'Report')}
            onClose={() => (top ? popDocument() : setView(null))} wide printable
            footer={(
              <>
                {top ? <button className="btn" onClick={popDocument}>{documents.length > 1 ? 'Back' : (view ? 'Back to report' : 'Close')}</button> : null}
                {canShare ? (
                  <button className="btn" onClick={() => {
                    if (top) setShareTarget({ kind: 'document', type: top.type, id: top.id, label: top.data?.title || top.label });
                    else setShareTarget({ kind: 'report', id: view.id, label: view.title });
                  }}>Share</button>
                ) : null}
                <PrintButton />
                {!top ? <button className="btn btn-primary" onClick={() => setView(null)}>Close</button> : null}
              </>
            )}>
            {top
              ? (top.loading ? <Loading /> : top.error ? <ErrorNote error={top.error} /> : <DocumentReport data={top.data} onOpenEntity={openDocument} />)
              : <ReportView data={view?.data} onOpenEntity={openDocument} />}
          </Modal>
        );
      })()}

      {shareTarget && (
        <Modal title={shareTarget.kind === 'document' ? 'Share profile' : 'Share report'} onClose={() => setShareTarget(null)}
          footer={<>
            <button className="btn" onClick={() => setShareTarget(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={shareBusy || shareTo.size === 0} onClick={submitShare}>{shareBusy ? 'Sending…' : `Send to ${shareTo.size}`}</button>
          </>}>
          {shareErr && <ErrorNote error={shareErr} />}
          <div className="field"><label>Note (optional)</label><textarea rows={3} value={shareNote} onChange={(e) => setShareNote(e.target.value)} placeholder="Add a message for the recipients…" /></div>
          <div className="field"><label>Recipients</label>
            <div className="share-list">
              {entityLists.people.map((p) => {
                const label = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || `Person ${p.id}`;
                const on = shareTo.has(p.id);
                return (
                  <label key={p.id} className={`share-item${on ? ' on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => setShareTo((cur) => {
                      const n = new Set(cur);
                      if (n.has(p.id)) n.delete(p.id); else n.add(p.id);
                      return n;
                    })} />
                    <span>{label}{p.title ? <span className="muted"> · {p.title}</span> : null}</span>
                  </label>
                );
              })}
              {entityLists.people.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No people available.</div>}
            </div>
          </div>
        </Modal>
      )}
    </Page>
  );
}

function TemplateCard({ t, onPick }) {
  const initials = (t.report_type || '').split('_').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <button type="button" className="card card-pad tpl-card" onClick={() => onPick(t.report_type)}>
      <span className="tpl-ico">{initials}</span>
      <b>{t.name}</b>
      <span className="tpl-desc">{t.description || '—'}</span>
      <span className="tpl-go">Generate →</span>
    </button>
  );
}

function ReportView({ data, onOpenEntity }) {
  if (!data) return <div className="muted">No data</div>;
  return (
    <div>
      {data.analytics && !data.document ? <AnalyticsBlock a={data.analytics} /> : null}
      <ReportBody data={data} onOpenEntity={onOpenEntity} />
    </div>
  );
}

function ReportBody({ data, onOpenEntity }) {
  const canDrill = typeof onOpenEntity === 'function';
  const ENTITY_KEYS = { crew_id: 'CREW_DETAIL', task_id: 'TASK_DETAIL', asset_pk: 'ASSET_DETAIL', line_id: 'LINE_DETAIL' };
  const linkRow = (entity) => (canDrill && entity && entity.id != null
    ? { className: 'row-link', title: 'Click to view details', onClick: () => onOpenEntity(entity.type, entity.id, entity.label) }
    : {});
  const rowEntity = (r) => {
    if (!r) return null;
    for (const k of Object.keys(ENTITY_KEYS)) {
      if (r[k] != null) return { type: ENTITY_KEYS[k], id: r[k], label: r.name || r.code };
    }
    return null;
  };
  if (!data) return <div className="muted">No data</div>;
  if (data.document) return <DocumentReport data={data} onOpenEntity={onOpenEntity} />;
  if (data.financial) return <FinancialTables f={data.financial} onOpenEntity={onOpenEntity} />;
  if (Array.isArray(data.by_asset)) {
    return (
      <div>
        <table>
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>{(data.rows || []).map((r, i) => <tr key={i}><td>{r.label}</td><td><b>{r.value}</b></td></tr>)}</tbody>
        </table>
        <h3 className="section-title">Highest-cost assets</h3>
        <table>
          <thead><tr><th>Asset</th><th>Region</th><th>Condition</th><th>Events</th><th>Spend</th></tr></thead>
          <tbody>
            {(data.by_asset || []).map((x) => (
              <tr key={x.asset_pk} {...linkRow({ type: 'ASSET_DETAIL', id: x.asset_pk, label: x.asset_name })}>
                <td><b>{x.asset_code}</b> · {x.asset_name}</td>
                <td>{x.region || '—'}</td>
                <td>{x.condition ?? '—'}</td>
                <td>{x.events}</td>
                <td>{fmtMoney(x.spend, data.totals?.currency)}</td>
              </tr>
            ))}
            {(data.by_asset || []).length === 0 && <tr><td colSpan={5} className="empty">No asset spend in the period.</td></tr>}
          </tbody>
        </table>
        <h3 className="section-title">Spend by crew</h3>
        <table>
          <thead><tr><th>Crew</th><th>Events</th><th>Spend</th></tr></thead>
          <tbody>{(data.by_crew || []).map((c, i) => <tr key={i}><td>{c.crew}</td><td>{c.events}</td><td>{fmtMoney(c.spend, data.totals?.currency)}</td></tr>)}</tbody>
        </table>
        <h3 className="section-title">Spend vs asset value by region</h3>
        <table>
          <thead><tr><th>Region</th><th>Events</th><th>Spend</th><th>Asset value</th><th>Spend / value</th></tr></thead>
          <tbody>
            {(data.by_region || []).map((r, i) => (
              <tr key={i}><td>{r.region}</td><td>{r.events}</td><td>{fmtMoney(r.spend, data.totals?.currency)}</td><td>{fmtMoney(r.value, data.totals?.currency)}</td><td>{r.ratio == null ? '—' : `${r.ratio}%`}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (data.rows) {
    if (data.rows.length && data.rows[0] && 'label' in data.rows[0]) {
      return (
        <div>
          <table>
            <thead><tr><th>Metric</th><th>Value</th></tr></thead>
            <tbody>{data.rows.map((r, i) => <tr key={i}><td>{r.label}</td><td><b>{r.value}</b></td></tr>)}</tbody>
          </table>
          {data.by_status && (
            <>
              <h3 className="section-title">By status</h3>
              <table>
                <thead><tr><th>Status</th><th>Count</th></tr></thead>
                <tbody>{Object.entries(data.by_status).map(([k, v]) => <tr key={k}><td>{k}</td><td><b>{v}</b></td></tr>)}</tbody>
              </table>
            </>
          )}
        </div>
      );
    }
    const cols = Object.keys(data.rows[0] || {}).filter((k) => !(k in ENTITY_KEYS));
    return (
      <table>
        <thead><tr>{cols.map((k) => <th key={k}>{k}</th>)}</tr></thead>
        <tbody>{data.rows.map((r, i) => (
          <tr key={i} {...linkRow(rowEntity(r))}>
            {cols.map((k) => <td key={k}>{r[k]?.label ?? r[k]}</td>)}
          </tr>
        ))}</tbody>
      </table>
    );
  }
  // OVERDUE_TASK also carries `buckets` (aging buckets) plus `total_overdue`.
  // Guard so the generic bucket renderer does not swallow the richer overdue
  // view below (aging buckets, by_status and the overdue task list).
  if (data.buckets && data.total_overdue === undefined) {
    return (
      <div>
        <table>
          <thead><tr><th>Bucket</th><th>Count</th></tr></thead>
          <tbody>{data.buckets.map((b, i) => <tr key={i}><td>{b.label || b.key}</td><td><b>{b.count}</b></td></tr>)}</tbody>
        </table>
        {data.by_region && (
          <>
            <h3 className="section-title">By Region</h3>
            <table>
              <thead><tr><th>Region</th><th>Assets</th><th>Avg Condition</th></tr></thead>
              <tbody>{data.by_region.map((r, i) => <tr key={i}><td>{r.region}</td><td>{r.count}</td><td>{r.avg_condition}</td></tr>)}</tbody>
            </table>
          </>
        )}
        {data.total_assets !== undefined && <p className="mt muted">Total assets assessed: {data.total_assets}</p>}
      </div>
    );
  }
  if (data.checklist_compliance) {
    return (
      <div>
        <div className="grid grid-2">
          <MoneyCard label="Checklist compliance" value={data.checklist_compliance} />
          <MoneyCard label="GPS validation pass rate" value={data.gps_pass_rate} />
          <MoneyCard label="Certifications" value={data.expired_certs} sub={`of ${data.total_certs} expired`} />
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Region cert status</h3></div>
            <div className="tbl-wrap">
              <table><thead><tr><th>Region</th><th>Expired</th><th>Total</th></tr></thead><tbody>
                {(data.region_cert_status || []).map((r, i) => <tr key={i}><td>{r.region}</td><td>{r.expired}</td><td>{r.total}</td></tr>)}
              </tbody></table>
            </div>
          </div>
        </div>
        {(data.execution_summary || []).length > 0 && (
          <>
            <h3 className="section-title">Checklist executions ({data.execution_summary.length})</h3>
            <table>
              <thead><tr><th>Execution</th><th>Task</th><th>Items</th><th>Pass</th><th>Fail</th><th>Result</th></tr></thead>
              <tbody>
                {data.execution_summary.map((x) => {
                  const e = x.execution || {};
                  const entity = e.task_id != null
                    ? { type: 'TASK_DETAIL', id: e.task_id, label: e.task_number || `Task ${e.task_id}` }
                    : e.asset_id != null ? { type: 'ASSET_DETAIL', id: e.asset_id, label: 'Asset' } : null;
                  return (
                    <tr key={e.id} {...linkRow(entity)}>
                      <td className="mono">EX-{String(e.id).padStart(5, '0')}</td>
                      <td>{e.task_number || e.task_id || '—'}</td>
                      <td>{x.total}</td>
                      <td>{x.pass}</td>
                      <td>{x.fail}</td>
                      <td><Pill value={e.result || 'INCOMPLETE'} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        {(data.missed_certifications || []).length > 0 && (
          <>
            <h3 className="section-title">Missed / expiring certifications ({data.missed_certifications.length})</h3>
            <table>
              <thead><tr><th>Person</th><th>Certification</th><th>Expires</th><th>Status</th><th>Days</th></tr></thead>
              <tbody>
                {data.missed_certifications.map((c) => (
                  <tr key={c.id}>
                    <td>{c.person_name || (c.person_id ? `Person #${c.person_id}` : '—')}</td>
                    <td>{c.cert_type}{c.issuing_body ? ` · ${c.issuing_body}` : ''}</td>
                    <td className="nowrap">{fmtDate(c.expires_at)}</td>
                    <td><Pill value={c.status} /></td>
                    <td className={c.days < 0 ? 'bad' : undefined}>{c.days < 0 ? `${Math.abs(c.days)} overdue` : `${c.days} left`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {(data.missed_equipment || []).length > 0 && (
          <>
            <h3 className="section-title">Missed equipment & maintenance ({data.missed_equipment_total ?? data.missed_equipment.length})</h3>
            {data.missed_equipment_total > data.missed_equipment.length && (
              <p className="muted" style={{ fontSize: 12 }}>
                Showing the {data.missed_equipment.length} most overdue of {data.missed_equipment_total}
                {data.missed_equipment_by_kind ? ` (${data.missed_equipment_by_kind.assets} assets · ${data.missed_equipment_by_kind.schedules} schedules)` : ''}.
              </p>
            )}
            <table>
              <thead><tr><th>Item</th><th>Kind</th><th>Type</th><th>Due</th><th>Detail</th></tr></thead>
              <tbody>
                {data.missed_equipment.map((m, i) => (
                  <tr key={`${m.kind}-${m.id}-${i}`} {...linkRow(m.kind === 'ASSET' && m.asset_pk != null ? { type: 'ASSET_DETAIL', id: m.asset_pk, label: m.label } : null)}>
                    <td><b>{m.label}</b></td>
                    <td>{m.kind === 'ASSET' ? 'Asset' : 'Schedule'}</td>
                    <td>{m.asset_type || '—'}</td>
                    <td className="nowrap">{m.due ? fmtDate(m.due) : '—'}</td>
                    <td>{m.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    );
  }
  if (data.by_type) {
    return (
      <table>
        <thead><tr><th>Target type</th><th>Total</th><th>Pass</th><th>Fail</th><th>Rate</th></tr></thead>
        <tbody>{(data.by_type || []).map((x, i) => <tr key={i}><td>{x.target_type}</td><td>{x.total}</td><td>{x.pass}</td><td>{x.fail}</td><td>{x.rate}</td></tr>)}</tbody>
      </table>
    );
  }
  if (data.incidents) {
    return (
      <div>
        <p className="muted">Incidents: {data.totals?.incidents} · Substations out: {data.totals?.substations_out} · Lines out: {data.totals?.lines_out}</p>
        <table>
          <thead><tr><th>Task</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>{(data.incidents || []).map((t) => (
            <tr key={t.id} {...linkRow({ type: 'TASK_DETAIL', id: t.id, label: t.task_number })}>
              <td>{t.task_number}</td><td>{t.task_type}</td><td><Pill value={t.status} /></td>
            </tr>
          ))}</tbody>
        </table>
        {(data.substations_out || []).length > 0 && (
          <>
            <h3 className="section-title">Substations out of service</h3>
            <table>
              <thead><tr><th>Substation</th><th>Status</th></tr></thead>
              <tbody>{(data.substations_out || []).map((s) => <tr key={s.id}><td>{s.name}</td><td><Pill value={s.operational_status} /></td></tr>)}</tbody>
            </table>
          </>
        )}
        {(data.lines_out || []).length > 0 && (
          <>
            <h3 className="section-title">Lines out of service</h3>
            <table>
              <thead><tr><th>Line</th><th>Status</th></tr></thead>
              <tbody>{(data.lines_out || []).map((l) => (
                <tr key={l.id} {...linkRow({ type: 'LINE_DETAIL', id: l.id, label: l.name })}>
                  <td>{l.name}</td><td><Pill value={l.operational_status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </>
        )}
      </div>
    );
  }
  if (data.total_overdue !== undefined) {
    return (
      <div>
        <p><b>Total overdue: {data.total_overdue}</b></p>
        <table>
          <thead><tr><th>Aging bucket</th><th>Count</th></tr></thead>
          <tbody>{data.buckets.map((b, i) => <tr key={i}><td>{b.label}</td><td><b>{b.count}</b></td></tr>)}</tbody>
        </table>
        {data.by_status && (
          <>
            <h3 className="section-title">By status</h3>
            <table>
              <thead><tr><th>Status</th><th>Count</th></tr></thead>
              <tbody>{Object.entries(data.by_status).map(([k, v]) => <tr key={k}><td>{k}</td><td><b>{v}</b></td></tr>)}</tbody>
            </table>
          </>
        )}
        <h3 className="section-title">Overdue tasks ({data.overdue_tasks?.length || 0})</h3>
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Region</th><th>Due</th></tr></thead>
          <tbody>
            {(data.overdue_tasks || []).map((t) => (
              <tr key={t.id} {...linkRow({ type: 'TASK_DETAIL', id: t.id, label: t.task_number })}>
                <td><b>{t.task_number}</b> · {t.title}</td>
                <td><Pill value={t.status} /></td>
                <td>{t.region?.name || '—'}</td>
                <td>{fmtDate(t.due_date)}</td>
              </tr>
            ))}
            {(data.overdue_tasks || []).length === 0 && <tr><td colSpan={4} className="empty">No overdue tasks</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }
  if (Array.isArray(data.changes)) {
    const rows = data.changes;
    return (
      <div>
        <p><b>{data.totals?.changed ?? rows.length}</b> condition change(s) — {data.totals?.degraded ?? 0} degraded, {data.totals?.improved ?? 0} improved.</p>
        <table>
          <thead><tr><th>Asset</th><th>Region</th><th>Recorded</th><th>Suggested</th><th>Change</th><th>Recommended action</th></tr></thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.asset_pk}-${i}`} {...linkRow({ type: 'ASSET_DETAIL', id: c.asset_pk, label: c.asset_name })}>
                <td><b>{c.asset_code}</b> · {c.asset_name}</td>
                <td>{c.region || '—'}</td>
                <td>{c.from_rating ?? '—'}</td>
                <td>{c.to_rating ?? '—'}</td>
                <td className={c.delta < 0 ? 'bad' : c.delta > 0 ? 'ok' : undefined}>{c.delta > 0 ? `+${c.delta}` : c.delta}</td>
                <td>{c.recommendation_label || c.recommendation || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="empty">No condition changes recorded.</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }
  if (data.rows || Array.isArray(data)) {
    return <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>;
  }
  return <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>;
}

function EntityPicker({ type, form, lists, setForm }) {
  const key = { ASSET_DETAIL: ['asset_id', 'assets'], CREW_DETAIL: ['crew_id', 'crews'], PERSON_DETAIL: ['person_id', 'people'], TASK_DETAIL: ['task_id', 'tasks'], LINE_DETAIL: ['line_id', 'lines'] }[type];
  const [field, listKey] = key || [];
  const regions = lists.regions || [];
  const regionId = form.scope_region_id || '';
  const items = useMemo(() => {
    const raw = lists[listKey] || [];
    if (!regionId) return raw;
    if (listKey === 'lines') return linesInRegion(raw, regionId);
    if (listKey === 'assets') return assetsInScope(raw, { regionId }, { subs: lists.subs || [], lines: lists.lines || [] });
    return raw.filter((x) => x.region_id == null || String(x.region_id) === String(regionId));
  }, [lists, listKey, regionId]);
  const label = field === 'asset_id' ? 'Asset' : field === 'crew_id' ? 'Crew' : field === 'person_id' ? 'Person' : field === 'line_id' ? 'Line' : 'Task';
  const val = form[field];
  const selected = items.find((x) => x.id === Number(val));
  return (
    <div className="field full"><label>{label}</label>
      <SearchSelect value={regionId} onChange={(e) => setForm({ ...form, scope_region_id: e.target.value ? Number(e.target.value) : null, [field]: null })}>
        <option value="">All regions</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </SearchSelect>
      <div className="mt" />
      <SearchSelect value={val || ''} onChange={(e) => setForm({ ...form, [field]: e.target.value ? Number(e.target.value) : null })}>
        <option value="">Select {label.toLowerCase()}…</option>
        {items.map((x) => (
          <option key={x.id} value={x.id}>
            {field === 'task_id' ? `${x.task_number} — ${x.title}` : field === 'person_id' ? `${x.first_name} ${x.last_name}` : x.name || x.asset_id || x.line_id || x.crew_code}
          </option>
        ))}
      </SearchSelect>
      {selected && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Region scoping applied to your access.</div>}
    </div>
  );
}

function Table({ head, rows, rowProps }) {
  return (
    <div className="tbl-wrap">
      <table className="mt">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} {...(rowProps ? rowProps(i) : {})}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={head.length} className="muted">No data.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function FinancialTables({ f, onOpenEntity }) {
  const code = f.currency && typeof f.currency === 'object' ? f.currency.code : (f.currency || 'USD');
  const money = (v) => fmtMoney(v, code);
  if (f.kind === 'valuation') {
    return (
      <div>
        <div className="grid grid-4">
          <MoneyCard label="Population" value={f.count} />
          <MoneyCard label="RCN" value={money(f.rcn)} />
          <MoneyCard label="Current value" value={money(f.current)} />
          <MoneyCard label="Unpriced" value={f.unpriced_count} />
        </div>
        <h3 className="section-title">By location</h3>
        <Table head={['Location', 'Assets', 'RCN', 'Current value']} rows={(f.by_location || []).map((r) => [r.label, r.count, money(r.rcn), money(r.current)])} />
        <h3 className="section-title">By family</h3>
        <Table head={['Family', 'Assets', 'RCN', 'Current value']} rows={(f.by_family || []).map((r) => [r.family_label, r.count, money(r.rcn), money(r.current)])} />
        <h3 className="section-title">By asset type</h3>
        <Table head={['Type', 'Assets', 'RCN', 'Current value']} rows={(f.by_type || []).map((r) => [r.label, r.count, money(r.rcn), money(r.current)])} />
        {(f.unpriced_types || []).length > 0 && (
          <>
            <h3 className="section-title">Unpriced types</h3>
            <Table head={['Asset type', 'Assets']} rows={(f.unpriced_types || []).map((r) => [r.asset_type, r.count])} />
          </>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="grid grid-3">
        <MoneyCard label="Total spend" value={money(f.totals.spend)} />
        <MoneyCard label="Events" value={f.totals.count} />
        <MoneyCard label="Avg / event" value={money(f.totals.avg)} />
      </div>
      <h3 className="section-title">By region</h3>
      <Table head={['Region', 'Events', 'Spend']} rows={(f.by_region || []).map((r) => [r.region, r.count, money(r.spend)])} />
      <h3 className="section-title">By asset type</h3>
      <Table head={['Type', 'Events', 'Spend']} rows={(f.by_asset_type || []).map((r) => [r.asset_type, r.count, money(r.spend)])} />
      <h3 className="section-title">By event type</h3>
      <Table head={['Event type', 'Events', 'Spend']} rows={(f.by_event_type || []).map((r) => [r.event_type, r.count, money(r.spend)])} />
      <h3 className="section-title">Monthly spend</h3>
      <Table head={['Month', 'Events', 'Spend']} rows={(f.monthly || []).map((r) => [r.month, r.count, money(r.spend)])} />
      <h3 className="section-title">Recent events</h3>
      <Table head={['Date', 'Asset', 'Type', 'Cost']}
        rowProps={onOpenEntity ? (i) => {
          const r = (f.recent || [])[i];
          return r && r.asset_pk != null
            ? { className: 'row-link', title: 'Click to view asset details', onClick: () => onOpenEntity('ASSET_DETAIL', r.asset_pk, r.asset_name) }
            : {};
        } : undefined}
        rows={(f.recent || []).map((r) => [fmtDate(r.performed_at), r.asset_name || '—', r.event_type, money(r.cost)])} />
    </div>
  );
}

// Shared with the mailbox reader so saved reports render identically wherever
// they are opened (the mailbox report messages use this, keeping a single
// source of truth for every report_type layout).
export { ReportView };
