import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmtDate, fmtMoney } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, PrintButton, MoneyCard, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import { assetsInScope, linesInRegion } from '../cascade';
import DocumentReport from '../components/DocumentReport';

const DOCUMENT_TYPES = ['ASSET_DETAIL', 'CREW_DETAIL', 'PERSON_DETAIL', 'TASK_DETAIL', 'LINE_DETAIL'];

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
  const [documents, setDocuments] = useState([]);
  const { query, setQuery, results: reportRows } = useSearchFilter(reports);
  const [searchParams, setSearchParams] = useSearchParams();

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

  const load = () => {
    api.get('/report-templates').then(setTemplates).catch((e) => setError(e.message));
    api.get('/reports').then(setReports).catch(() => {});
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
    api.get(`/performance?scope=${perfScope}`).then((r) => setPerf(r.rows)).catch((e) => setPerfErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfScope, canPerf]);

  // Deep link from the mailbox: /reports?report=<id> opens the saved report in
  // the reader. The query param is cleared afterwards so the URL stays clean.
  useEffect(() => {
    const rid = searchParams.get('report');
    if (!rid) return;
    let alive = true;
    setDocuments([]);
    api.get(`/reports/${encodeURIComponent(rid)}`)
      .then((res) => { if (alive) setView(res); })
      .catch((e) => { if (alive) setError(e.message); });
    setSearchParams({}, { replace: true });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function generate() {
    try {
      setBusy(true);
      const res = await api.post('/reports/generate', genForm);
      setDocuments([]);
      setView(res);
      load();
      setGenForm(null);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!templates.length && !reports.length && !error) return <Page title="Operational & Compliance Reports"><Loading /></Page>;

  return (
    <Page title="Operational & Compliance Reports" crumbs="TMMS / Validation & Compliance"
      actions={canGenerate ? <button className="btn btn-primary" onClick={() => setGenForm({ report_type: templates[0]?.report_type || 'MAINTENANCE_COMPLETION', period_start: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), period_end: new Date().toISOString().slice(0, 10), scope_region_id: '' })}>+ Generate Report</button> : null}>
      {error && <ErrorNote error={error} />}

      {canPerf && (
        <div className="mt mb">
          <div className="spread">
            <h3 className="section-title">Field Team Performance</h3>
            <div>
              <button className={`btn btn-sm${perfScope === 'crew' ? ' btn-primary' : ''}`} onClick={() => setPerfScope('crew')}>By crew</button>{' '}
              <button className={`btn btn-sm${perfScope === 'person' ? ' btn-primary' : ''}`} onClick={() => setPerfScope('person')}>By person</button>
            </div>
          </div>
          {perfErr && <ErrorNote error={perfErr} />}
          {!perf && !perfErr && <Loading />}
          {perf && (
            <div className="card">
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>{perfScope === 'crew' ? 'Crew' : 'Person'}</th><th>Tasks</th><th>Completed</th><th>Rate</th><th>On time</th><th>On-time rate</th><th>Open</th><th>Overdue</th><th>Avg cycle (h)</th><th>Findings</th><th>GPS viol.</th></tr></thead>
                  <tbody>
                    {perf.map((r) => {
                      const detailType = perfScope === 'crew' ? 'CREW_DETAIL' : 'PERSON_DETAIL';
                      return (
                        <tr key={r.id} className="row-link"
                          onClick={() => openDocument(detailType, r.id, r.name)}
                          title={`Click to view ${perfScope} details`}>
                          <td><b>{r.name}</b></td>
                          <td>{r.tasks}</td>
                          <td>{r.completed}</td>
                          <td>{r.completion_rate}%</td>
                          <td>{r.on_time}</td>
                          <td>{r.on_time_rate}%</td>
                          <td>{r.open ?? 0}</td>
                          <td className={r.overdue ? 'bad' : undefined}>{r.overdue ?? 0}</td>
                          <td>{r.avg_cycle_hours != null ? r.avg_cycle_hours : '—'}</td>
                          <td>{r.findings}</td>
                          <td>{r.gps_violations}</td>
                        </tr>
                      );
                    })}
                    {perf.length === 0 && <tr><td colSpan={11} className="muted center">No data for this scope.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <h3 className="section-title">Available Report Templates</h3>
      <div className="grid grid-4">
        {templates.map((t) => (
          <div key={t.id} className="card card-pad" style={{ cursor: 'pointer' }} onClick={() => setGenForm({ report_type: t.report_type, period_start: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), period_end: new Date().toISOString().slice(0, 10), scope_region_id: '' })}>
            <b>{t.name}</b>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t.description || '—'}</div>
          </div>
        ))}
      </div>

      <h3 className="section-title">Generated Reports</h3>
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search reports…" />
        <span className="muted" style={{ fontSize: 12 }}>{reportRows.length} of {reports.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Period</th><th>Generated</th><th></th></tr></thead>
            <tbody>
              {reportRows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.report_code}</td>
                  <td><b>{r.title}</b></td>
                  <td>{r.report_type}</td>
                  <td className="nowrap">{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</td>
                  <td className="nowrap">{fmtDate(r.generated_at)}</td>
                  <td><button className="btn btn-sm" onClick={() => { setDocuments([]); api.get(`/reports/${r.id}`).then(setView).catch((e) => setError(e.message)); }}>View</button></td>
                </tr>
              ))}
              {reportRows.length === 0 && (
                <tr><td colSpan="6" className="muted center">{query ? 'No reports match your search' : 'No reports generated yet'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {genForm && (
        <Modal title="Generate Report" onClose={() => setGenForm(null)}
          footer={<>
            <button className="btn" onClick={() => setGenForm(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={generate}>{busy ? 'Generating…' : 'Generate'}</button>
          </>}>
          <div className="form-grid">
            <div className="field full"><label>Report type</label>
              <SearchSelect value={genForm.report_type} onChange={(e) => setGenForm({ ...genForm, report_type: e.target.value })}>
                {templates.map((t) => <option key={t.id} value={t.report_type}>{t.name}</option>)}
              </SearchSelect></div>
            {DOCUMENT_TYPES.includes(genForm.report_type) ? (
              <EntityPicker type={genForm.report_type} form={genForm} lists={entityLists} setForm={setGenForm} />
            ) : (
              <>
                <div className="field"><label>Period start</label><input type="date" value={genForm.period_start} onChange={(e) => setGenForm({ ...genForm, period_start: e.target.value })} /></div>
                <div className="field"><label>Period end</label><input type="date" value={genForm.period_end} onChange={(e) => setGenForm({ ...genForm, period_end: e.target.value })} /></div>
                <div className="field"><label>Region scope</label>
                  <SearchSelect value={genForm.scope_region_id || ''} onChange={(e) => setGenForm({ ...genForm, scope_region_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">All regions</option>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </SearchSelect></div>
              </>
            )}
          </div>
        </Modal>
      )}

      {(view || documents.length > 0) && (() => {
        const top = documents[documents.length - 1];
        return (
          <Modal title={top ? (top.data?.title || top.label || 'Entity Document') : (view?.title || view?.data?.title || 'Report')}
            onClose={() => (top ? popDocument() : setView(null))} wide printable
            footer={top ? (
              <>
                <button className="btn" onClick={popDocument}>{documents.length > 1 ? 'Back' : (view ? 'Back to report' : 'Close')}</button>
                <PrintButton />
              </>
            ) : (
              <><PrintButton /><button className="btn btn-primary" onClick={() => setView(null)}>Close</button></>
            )}>
            {top
              ? (top.loading ? <Loading /> : top.error ? <ErrorNote error={top.error} /> : <DocumentReport data={top.data} onOpenEntity={openDocument} />)
              : <ReportView data={view?.data} onOpenEntity={openDocument} />}
          </Modal>
        );
      })()}
    </Page>
  );
}

function ReportView({ data, onOpenEntity }) {
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
