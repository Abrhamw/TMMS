import { useEffect, useMemo, useState, Fragment } from 'react';
import { api, fmtDate, fmtMoney } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, CondPill, ConfirmButton, PrintButton, SearchField } from '../components';
import { can, getStoredUser } from '../auth';
import { Gauge, Sparkline } from '../components/viz';
import { crewsInRegion, linesForSubstation, linesInRegion, subsInRegion } from '../cascade';
import MapPicker from '../components/MapPicker';
import Comments from '../components/Comments';
import ImportDialog from '../components/ImportDialog';
import Document from '../components/Document';
import RegisterTree from '../components/RegisterTree';
import ViewMap from '../components/ViewMap';
import { entityColor, maxVoltageKv, isEnergized, parseVoltageLevels, voltageChip, popupRows, esc } from '../mapFocus';
import { t } from '../i18n';

// The register can hold tens of thousands of assets, so filtering, searching
// and paging all happen on the server. This is the page size requested per view.
const REGISTER_PAGE_SIZE = 50;

// Voltage shown for an asset: its parent line if known, else the substation's
// highest declared level.
function assetVoltage(a) {
  if (a.line && a.line.voltage_kv != null) return a.line.voltage_kv;
  if (a.substation) return maxVoltageKv(a.substation.voltage_levels);
  return null;
}

// Best position for the asset: its own point, else the parent tower, the
// parent substation, or the start of its line.
function assetPosition(d) {
  if (d.latitude != null && d.longitude != null) return [d.latitude, d.longitude];
  if (d.tower && d.tower.latitude != null) return [d.tower.latitude, d.tower.longitude];
  if (d.substation && d.substation.latitude != null) return [d.substation.latitude, d.substation.longitude];
  const route = d.line && Array.isArray(d.line.route_json) ? d.line.route_json : null;
  if (route && route.length) return [route[0][0], route[0][1]];
  return null;
}

function substationMapPopup(s) {
  return `<div class="tmms-pop"><b>${esc(s.name)}</b> ${voltageChip(maxVoltageKv(s.voltage_levels), { energized: isEnergized(s.operational_status) })}` +
    `<div class="tmms-pop-sub">${esc(s.substation_id || '')}${s.substation_type ? ` · ${esc(s.substation_type)}` : ''}</div>` +
    popupRows([
      ['Voltage', parseVoltageLevels(s.voltage_levels).join(', ') || null],
      ['Region', s.region_name],
      ['Owner', s.owner],
      ['Status', s.operational_status],
      ['Fence', s.fence_radius_m ? `${s.fence_radius_m} m` : null],
    ]) + '</div>';
}

function lineMapPopup(l) {
  const fromName = l.from_name || (l.from && l.from.name) || '?';
  const toName = l.to_name || (l.to && l.to.name) || '?';
  return `<div class="tmms-pop"><b>${esc(l.name)}</b> ${voltageChip(l.voltage_kv, { energized: isEnergized(l.operational_status) })}` +
    `<div class="tmms-pop-sub">${esc(l.line_id)}</div>` +
    popupRows([
      ['From → To', `${fromName} → ${toName}`],
      ['Length', l.length_km != null ? `${l.length_km} km` : null],
      ['Conductor', l.conductor_type],
      ['Circuits', l.circuit_count],
      ['Towers', l.tower_count],
      ['Region', l.region_name],
      ['Status', l.operational_status],
    ]) + (l.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') + '</div>';
}

function assetMapPopup(d) {
  return `<div class="tmms-pop"><b>${esc(d.name)}</b> ${voltageChip(assetVoltage(d), { energized: isEnergized(d.operational_status) })}` +
    `<div class="tmms-pop-sub">${esc(d.asset_id)}${d.sub_type ? ` · ${esc(d.sub_type)}` : ''}</div>` +
    popupRows([
      ['Type', d.asset_type],
      ['Substation', d.substation?.name],
      ['Line', d.line?.name],
      ['Condition', d.condition_rating != null ? `${d.condition_rating}/10` : null],
      ['Criticality', d.criticality],
      ['Status', d.operational_status],
      ['Lifecycle', d.lifecycle_status],
    ]) + (d.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') + '</div>';
}

// Builds the map layers for an asset detail: the parent line route (with its
// full details), the substation yard/fence and its connected lines, the parent
// tower, plus the flashing selected asset. A tower asset frames its line; a
// substation/transformer asset frames the yard.
function buildAssetMap(d) {
  const primaryLine = d.line || null;
  const primarySub = d.substation || null;
  const assetPos = assetPosition(d);
  const polylines = [];
  const polygons = [];
  const circles = [];
  const markers = [];
  const seenLine = new Set();
  const seenSub = new Set();

  const addLine = (l) => {
    if (!l || seenLine.has(l.id)) return;
    if (!Array.isArray(l.route_json) || l.route_json.length < 2) return;
    seenLine.add(l.id);
    polylines.push({
      points: l.route_json.map((p) => [p[0], p[1]]),
      color: entityColor(l.voltage_kv, l.operational_status),
      weight: primaryLine && l.id === primaryLine.id ? 5 : 3,
      popup: lineMapPopup(l),
    });
  };
  const addSub = (s, primary) => {
    if (!s || seenSub.has(s.id)) return;
    seenSub.add(s.id);
    const color = entityColor(maxVoltageKv(s.voltage_levels), s.operational_status);
    if (Array.isArray(s.boundary_json) && s.boundary_json.length >= 3) {
      polygons.push({
        points: s.boundary_json, color, weight: primary ? 2.5 : 1.5,
        fillOpacity: primary ? 0.12 : 0.06, label: `${s.name} yard`, popup: substationMapPopup(s),
      });
    } else if (s.fence_radius_m) {
      circles.push({
        lat: s.latitude, lng: s.longitude, radius: s.fence_radius_m, color,
        weight: primary ? 2.5 : 1.5, dashArray: '5 5', fillOpacity: 0.06, popup: substationMapPopup(s),
      });
    }
    if (s.latitude != null) {
      markers.push({
        lat: s.latitude, lng: s.longitude, radius: primary ? 8 : 5, color,
        label: s.name, sub: s.substation_id, popup: substationMapPopup(s),
      });
    }
  };

  addLine(primaryLine);
  (d.related_lines || []).forEach(addLine);
  addSub(primarySub, true);
  if (primaryLine) { addSub(primaryLine.from, false); addSub(primaryLine.to, false); }
  (d.related_lines || []).forEach((l) => { addSub(l.from, false); addSub(l.to, false); });

  if (d.tower && d.tower.latitude != null) {
    markers.push({
      lat: d.tower.latitude, lng: d.tower.longitude, radius: 5, color: '#0ea5e9',
      label: d.tower.tower_id, sub: 'Tower',
      popup: `<div class="tmms-pop"><b>${esc(d.tower.tower_id)}</b>` +
        `<div class="tmms-pop-sub">${esc(d.tower.tower_type || '')}</div>` +
        popupRows([['Line', primaryLine?.name], ['km marker', d.tower.km_marker], ['Height', d.tower.height_m != null ? `${d.tower.height_m} m` : null]]) + '</div>',
    });
  }
  if (assetPos) {
    markers.push({
      lat: assetPos[0], lng: assetPos[1], radius: 8, flash: true,
      color: entityColor(assetVoltage(d), d.operational_status), label: d.name, popup: assetMapPopup(d),
    });
  }

  const focus = [];
  if (primarySub) {
    if (Array.isArray(primarySub.boundary_json)) primarySub.boundary_json.forEach((p) => focus.push(p));
    else if (primarySub.latitude != null) focus.push([primarySub.latitude, primarySub.longitude]);
  }
  if (!focus.length && primaryLine && Array.isArray(primaryLine.route_json)) primaryLine.route_json.forEach((p) => focus.push(p));
  if (!focus.length && assetPos) focus.push(assetPos);

  return { assetPos, polylines, polygons, circles, markers, focus };
}

// Asset type/family vocabulary comes from the backend catalog.

const blank = {
  asset_id: '', name: '', asset_type: 'TRANSFORMER', sub_type: '', substation_id: null, line_id: null, tower_id: null,
  parent_asset_id: null, manufacturer: '', model: '', serial_number: '', installation_date: '', commissioned_date: '',
  latitude: null, longitude: null, condition_rating: 7, lifecycle_status: 'IN_SERVICE', operational_status: 'OPERATIONAL',
  criticality: 'MEDIUM', warranty_expiry: '', last_maintenance_at: '', next_maintenance_at: '', metadata: '{}',
  location_type: 'OUTDOOR', bay: '',
};

function flattenCatalog(cat) {
  if (!cat) return [];
  const out = [];
  for (const f of cat.families) for (const r of f.types) out.push({ ...r, family_label: f.family_label });
  return out;
}
function typesForFamily(cat, family) {
  return (cat?.families || []).find((f) => f.family === family)?.types || [];
}
function familyOf(cat, type) {
  return flattenCatalog(cat).find((r) => r.asset_type === type && !r.sub_type)?.family || '';
}

const SIM_FIELDS = [
  ['load_pct', 'Peak loading %', 0, 200, 5],
  ['thermal_c', 'Top-oil temp (C)', 20, 120, 1],
  ['through_faults', 'Through-faults (12m)', 0, 10, 1],
  ['trips', 'Trips (12m)', 0, 10, 1],
  ['age_years', 'Age (years)', 0, 60, 1],
  ['months_since_maintenance', 'Months since maintenance', 0, 60, 1],
];

export default function Assets() {
  const canWrite = can(getStoredUser(), 'asset:write');
  const canEvaluate = can(getStoredUser(), 'asset:evaluate');
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [regions, setRegions] = useState([]);
  const [subs, setSubs] = useState([]);
  const [lines, setLines] = useState([]);
  const [crews, setCrews] = useState([]);
  const [geo, setGeo] = useState(null);       // { format, fileName, preview, confirmToken, busy, error }
  const [showImport, setShowImport] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [subFilter, setSubFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [viewMode, setViewMode] = useState('register');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [registerRegion, setRegisterRegion] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [document, setDocument] = useState(null);
  const [currency, setCurrency] = useState('USD');
  const [addEv, setAddEv] = useState(null);
  const [evalState, setEvalState] = useState(null);
  const [perf, setPerf] = useState(null);
  const [perfReading, setPerfReading] = useState(null);
  const [perfEvent, setPerfEvent] = useState(null);
  const [perfCsv, setPerfCsv] = useState(null);
  const [sim, setSim] = useState(null);
  const [simResult, setSimResult] = useState(null);
  const [simBusy, setSimBusy] = useState(false);
  // Region -> substation/line cascade for the asset form. Picking a region
  // narrows both pickers; picking a substation narrows the line picker to the
  // circuits that terminate there.
  const formSubs = useMemo(() => subsInRegion(subs, form?.region_id), [subs, form?.region_id]);
  const formLines = useMemo(
    () => (form?.substation_id ? linesForSubstation(lines, form.substation_id) : linesInRegion(lines, form?.region_id)),
    [lines, form?.region_id, form?.substation_id]
  );
  const filterSubs = useMemo(() => subsInRegion(subs, regionFilter), [subs, regionFilter]);
  const formCrews = useMemo(() => crewsInRegion(crews, form?.region_id), [crews, form?.region_id]);

  useEffect(() => {
    const h = setTimeout(() => { setDebouncedQuery(query); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [query]);

  const load = () => {
    const q = new URLSearchParams();
    if (typeFilter) q.set('asset_type', typeFilter);
    if (subFilter) q.set('substation_id', subFilter);
    if (regionFilter) q.set('region_id', regionFilter);
    if (debouncedQuery) q.set('q', debouncedQuery);
    q.set('page', page);
    q.set('page_size', REGISTER_PAGE_SIZE);
    return api.get(`/assets?${q.toString()}`)
      .then((res) => {
        if (Array.isArray(res)) { setRows(res); setTotal(res.length); }
        else {
          setRows(res.items || []);
          setTotal(res.total || 0);
          const lastPage = Math.max(1, Math.ceil((res.total || 0) / (res.page_size || REGISTER_PAGE_SIZE)));
          if (res.page > lastPage) setPage(lastPage);
        }
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, subFilter, regionFilter, debouncedQuery, page]);

  useEffect(() => {
    api.get('/asset-catalog').then(setCatalog).catch(() => setCatalog({ families: [] }));
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/lines').then(setLines).catch(() => {});
    api.get('/crews').then(setCrews).catch(() => {});
    api.get('/settings').then((s) => { if (s && s.currency) setCurrency(s.currency); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!detail || !sim) return undefined;
    let cancelled = false;
    const h = setTimeout(() => {
      setSimBusy(true);
      api.post(`/assets/${detail.id}/performance/simulate`, sim)
        .then((out) => { if (!cancelled) setSimResult(out); })
        .catch((e) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setSimBusy(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(h); };
  }, [sim, detail]);

  async function save() {
    try {
      let metadata = form.metadata;
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }
      const body = { ...form, metadata };
      if (form.id) await api.put(`/assets/${form.id}`, body);
      else await api.post('/assets', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(a) {
    try { await api.del(`/assets/${a.id}`); load(); } catch (e) { setError(e.message); }
  }

  async function openDetail(a) {
    try {
      setDetail(await api.get(`/assets/${a.id}`));
      setEvalState(null);
      setPerf(null);
      setPerfReading(null);
      setPerfEvent(null);
      setPerfCsv(null);
      setSim(null);
      setSimResult(null);
      api.get(`/assets/${a.id}/performance`).then(setPerf).catch(() => {});
      if (canEvaluate) {
        api.get(`/assets/${a.id}/condition-suggestion`)
          .then((s) => setEvalState({ suggestion: s, rating: s.suggested_rating, notes: '', busy: false }))
          .catch(() => {});
      }
    } catch (e) { setError(e.message); }
  }

  async function refreshPerf() {
    if (!detail) return;
    try { setPerf(await api.get(`/assets/${detail.id}/performance`)); } catch (e) { setError(e.message); }
  }

  async function addReading() {
    if (!detail || !perfReading) return;
    try {
      await api.post(`/assets/${detail.id}/readings`, {
        reading_type: perfReading.reading_type,
        value_num: Number(perfReading.value_num),
        recorded_at: perfReading.recorded_at,
      });
      setPerfReading(null);
      await refreshPerf();
    } catch (e) { setError(e.message); }
  }

  async function addPerfEvent() {
    if (!detail || !perfEvent) return;
    try {
      await api.post(`/assets/${detail.id}/performance-events`, {
        event_type: perfEvent.event_type,
        severity: perfEvent.severity,
        occurred_at: perfEvent.occurred_at,
        magnitude: perfEvent.magnitude === '' ? null : perfEvent.magnitude,
      });
      setPerfEvent(null);
      await refreshPerf();
    } catch (e) { setError(e.message); }
  }

  async function runImport(dry) {
    if (!detail || !perfCsv) return;
    try {
      const out = await api.post('/assets/performance/import', { csv: perfCsv.csv, dry_run: dry });
      setPerfCsv({ ...perfCsv, result: out });
      if (!dry) await refreshPerf();
    } catch (e) { setError(e.message); }
  }

  async function saveScenario() {
    if (!detail) return;
    try {
      await api.post(`/assets/${detail.id}/performance/snapshots`, { source: 'WHATIF' });
      await refreshPerf();
    } catch (e) { setError(e.message); }
  }

  async function acceptSimulated() {
    if (!detail || !simResult) return;
    try {
      const updated = await api.post(`/assets/${detail.id}/evaluation`, { combined: true, evaluation_notes: `What-if accepted: ${simResult.computed.combined_rating}/10` });
      setDetail({ ...detail, ...updated });
      await refreshPerf();
    } catch (e) { setError(e.message); }
  }

  // Confirm the evidence-based suggestion, or save a manual rating override.
  async function confirmEvaluation(useSuggested) {
    if (!detail || !evalState) return;
    setEvalState({ ...evalState, busy: true });
    try {
      const body = useSuggested
        ? { use_suggested: true }
        : { condition_rating: Number(evalState.rating) };
      if (evalState.notes) body.evaluation_notes = evalState.notes;
      const updated = await api.post(`/assets/${detail.id}/evaluation`, body);
      setDetail({ ...detail, ...updated });
      const s = await api.get(`/assets/${detail.id}/condition-suggestion`);
      setEvalState({ suggestion: s, rating: s.suggested_rating, notes: '', busy: false });
      load();
    } catch (e) {
      setError(e.message);
      setEvalState({ ...evalState, busy: false });
    }
  }

  async function addEvent() {
    if (!detail || !addEv) return;
    try {
      await api.post('/maintenance-events', {
        asset_id: detail.id,
        event_type: addEv.event_type,
        performed_at: new Date(addEv.performed_at).toISOString(),
        work_summary: addEv.work_summary,
        cost: addEv.cost === '' ? undefined : Number(addEv.cost),
        ...(addEv.condition_after ? { condition_after: Number(addEv.condition_after) } : {}),
      });
      setAddEv(null);
      openDetail({ id: detail.id });
    } catch (e) { setError(e.message); }
  }

  if (!rows) return error
    ? <Page title="Assets"><ErrorNote error={error} /></Page>
    : <Page title="Assets"><Loading /></Page>;

  const PAGE_SIZE = REGISTER_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = rows || [];

  return (
    <Page title="Assets" crumbs="TMMS / Infrastructure"
      actions={<>
        {canWrite && <button className="btn" onClick={() => setGeo({ format: 'kmz', fileName: '', preview: null, busy: false, error: null })}>Import KMZ/KML</button>}
        {canWrite && <button className="btn" onClick={() => setShowImport(true)}>Import CSV</button>}
        {canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blank })}>+ Add Asset</button> : null}
      </>}>
      {error && <ErrorNote error={error} />}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search assets…" />
        <SearchSelect value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}>
          <option value="">All asset types</option>
          {Array.from(new Map(flattenCatalog(catalog).filter((r) => !r.sub_type && r.family !== 'TOWER_PARTS').map((r) => [r.asset_type, r])).values()).map((r) => <option key={r.asset_type} value={r.asset_type}>{r.asset_type}</option>)}
        </SearchSelect>
        <SearchSelect value={regionFilter} onChange={(e) => { setRegionFilter(e.target.value); setSubFilter(''); setPage(1); }}>
          <option value="">All regions</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </SearchSelect>
        <SearchSelect value={subFilter} onChange={(e) => { setSubFilter(e.target.value); setPage(1); }}>
          <option value="">All substations</option>
          {filterSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </SearchSelect>
        <span className="muted">{total.toLocaleString()} assets</span>
        <span className="grow" />
        <button className={`btn btn-sm${viewMode === 'register' ? ' btn-primary' : ''}`} onClick={() => setViewMode('register')}>Register</button>
        <button className={`btn btn-sm${viewMode === 'table' ? ' btn-primary' : ''}`} onClick={() => setViewMode('table')}>Table</button>
        <button className={`btn btn-sm${viewMode === 'cards' ? ' btn-primary' : ''}`} onClick={() => setViewMode('cards')}>Cards</button>
      </div>
      {viewMode !== 'register' && pageCount > 1 && (
        <div className="filters mb">
          <button className="btn btn-sm" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</button>
          <span className="muted">Page {curPage} of {pageCount}</span>
          <button className="btn btn-sm" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>Next</button>
          <span className="grow" />
          <span className="muted">Showing {pageRows.length} of {total.toLocaleString()}</span>
        </div>
      )}

      {viewMode === 'register' ? (
        <RegisterTree
          canWrite={canWrite}
          regionId={registerRegion}
          onChangeRegion={setRegisterRegion}
          onSelectAsset={(a) => openDetail({ id: a.id })}
          onNewAsset={(ctx) => {
            const base = { ...blank, ...ctx, latitude: null, longitude: null };
            if (ctx.substation_id) base.location_type = 'INDOOR';
            setForm(base);
            window.scrollTo(0, 0);
          }}
        />
      ) : viewMode === 'table' ? (
        <div className="card">
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Asset ID</th><th>Name</th><th>Type</th><th>Location</th><th>Place</th><th>Bay</th><th>Manufacturer</th><th>Condition</th><th>Criticality</th><th>Lifecycle</th><th>GPS</th><th></th></tr></thead>
              <tbody>
                {pageRows.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.asset_id}</td>
                    <td><b>{a.name}</b></td>
                    <td>{a.asset_type}</td>
                    <td>{a.substation?.name || a.line?.name || (a.latitude ? 'point' : '—')}</td>
                    <td>{a.location_type || 'OUTDOOR'}</td>
                    <td>{a.bay || '—'}</td>
                    <td>{a.manufacturer || '—'}</td>
                    <td><CondPill rating={a.condition_rating} /></td>
                    <td>{a.criticality}</td>
                    <td><Pill value={a.lifecycle_status} /></td>
                    <td>{a.gps_validated ? <span className="ok">✓</span> : <span className="bad">✗</span>}</td>
                    <td className="nowrap">
                      <button className="btn btn-sm" onClick={() => openDetail(a)}>View</button>{' '}
                      <button className="btn btn-sm" onClick={() => setForm({ ...a, metadata: JSON.stringify(a.metadata || {}, null, 2) })}>Edit</button>{' '}
                      <ConfirmButton label="Delete" onConfirm={() => remove(a)} title={`Delete ${a.asset_id}?`} />
                    </td>
                  </tr>
                ))}
                {total === 0 && (
                  <tr><td colSpan="12" className="muted center">{query ? 'No assets match your search' : 'No assets found'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div>
          {Object.entries(
            pageRows.reduce((acc, a) => {
              const key = a.substation_id || 'uncategorized';
              (acc[key] = acc[key] || { name: a.substation?.name || 'Uncategorized', list: [] });
              acc[key].list.push(a);
              return acc;
            }, {})
          ).map(([key, group]) => (
            <div key={key}>
              <h3 className="section-title">{group.name} <span className="muted">· {group.list.length} assets</span></h3>
              <div className="grid grid-3">
                {group.list.map((a) => (
                  <div key={a.id} className="card card-pad" style={{ borderLeft: `4px solid ${a.gps_validated ? 'var(--ok-text)' : 'var(--danger-text)'}` }}>
                    <div className="spread">
                      <div><b>{a.name}</b><div className="mono muted" style={{ fontSize: 12 }}>{a.asset_id}</div></div>
                      <button className="btn btn-sm btn-ghost" onClick={() => openDetail(a)}>View</button>
                    </div>
                    <div className="kv mt" style={{ fontSize: 12, gridTemplateColumns: '110px 1fr' }}>
                      <span className="k">Type</span><span>{a.asset_type} {a.sub_type ? `(${a.sub_type})` : ''}</span>
                      <span className="k">Place</span><span>{a.location_type || 'OUTDOOR'}{a.bay ? ` · ${a.bay}` : ''}</span>
                      <span className="k">Condition</span><span><CondPill rating={a.condition_rating} /></span>
                      <span className="k">Criticality</span><span>{a.criticality}</span>
                      <span className="k">Lifecycle</span><span><Pill value={a.lifecycle_status} /></span>
                      <span className="k">Manufacturer</span><span>{a.manufacturer || '—'}</span>
                      <span className="k">GPS</span><span>{a.gps_validated ? <span className="ok">✓ validated</span> : <span className="bad">✗ unvalidated</span>}</span>
                    </div>
                    {canWrite && (
                      <div className="mt">
                        <button className="btn btn-sm" onClick={() => setForm({ ...a, metadata: JSON.stringify(a.metadata || {}, null, 2) })}>Edit</button>{' '}
                        <ConfirmButton label="Delete" onConfirm={() => remove(a)} title={`Delete ${a.asset_id}?`} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {total === 0 && <div className="card card-pad muted center">{query ? 'No assets match your search' : 'No assets found'}</div>}
        </div>
      )}

      {detail && (
        <Modal title={`${detail.name} — ${detail.asset_id}`} onClose={() => setDetail(null)} wide printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
            <button className="btn btn-primary" onClick={() => setDocument({ asset_id: detail.id })}>Generate document</button>
          </>}>
          {(() => {
            const m = buildAssetMap(detail);
            if (!m.focus.length && !m.assetPos) return null;
            return (
              <ViewMap
                height={300}
                center={m.assetPos ? { lat: m.assetPos[0], lng: m.assetPos[1] } : undefined}
                markers={m.markers}
                polylines={m.polylines}
                polygons={m.polygons}
                circles={m.circles}
                focus={m.focus}
                focusKey={detail.id}
              />
            );
          })()}
          <div className="grid grid-2 mt">
            <div>
              <div className="kv">
                <span className="k">Type</span><span>{detail.asset_type} {detail.sub_type ? `(${detail.sub_type})` : ''}</span>
                <span className="k">Location</span><span>{detail.substation?.name || detail.line?.name || 'Standalone point'}</span>
                <span className="k">Place</span><span>{detail.location_type || 'OUTDOOR'}</span>
                <span className="k">Bay</span><span>{detail.bay || '—'}</span>
                <span className="k">Chainage</span><span>{detail.line_id ? (detail.km_from != null || detail.km_to != null ? `${detail.km_from ?? 0} – ${detail.km_to ?? '—'} km` : 'line-located') : (detail.latitude != null ? 'point' : '—')}</span>
                <span className="k">Position</span><span className="mono">{detail.latitude?.toFixed(4) ?? '—'}, {detail.longitude?.toFixed(4) ?? '—'}</span>
                <span className="k">Manufacturer</span><span>{detail.manufacturer || '—'} {detail.model ? `(${detail.model})` : ''}</span>
                <span className="k">Serial</span><span className="mono">{detail.serial_number || '—'}</span>
                <span className="k">Installed</span><span>{fmtDate(detail.installation_date)}</span>
                <span className="k">Condition</span><span><CondPill rating={detail.condition_rating} /></span>
                <span className="k">Health index</span><span>{detail.health_index} · RUL ≈ {detail.remaining_useful_life_years} yr</span>
                <span className="k">Criticality</span><span>{detail.criticality}</span>
                <span className="k">Lifecycle</span><span><Pill value={detail.lifecycle_status} /></span>
                <span className="k">Last maint</span><span>{fmtDate(detail.last_maintenance_at)}</span>
              </div>
              {canEvaluate && evalState?.suggestion && (
                <div className="box mt" style={{ background: '#f8fafc' }}>
                  <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}>CONDITION EVALUATION (EVIDENCE-BASED)</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    Suggested rating <b>{evalState.suggestion.suggested_rating}/10</b>
                    {evalState.suggestion.delta != null && evalState.suggestion.delta !== 0 ? <span className="muted"> ({evalState.suggestion.delta > 0 ? '+' : ''}{evalState.suggestion.delta} vs current)</span> : null}
                    {' · '}Recommendation <b>{evalState.suggestion.recommendation_label}</b>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    Health {evalState.suggestion.health_index} · RUL ≈ {evalState.suggestion.remaining_useful_life_years} yr · Confidence {evalState.suggestion.confidence}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Evidence — tasks {evalState.suggestion.evidence.tasks} ({evalState.suggestion.evidence.failed_tasks} failed) · checklist fails {evalState.suggestion.evidence.checklist_fails} ({evalState.suggestion.evidence.critical_fails} critical) · findings {evalState.suggestion.evidence.findings_critical} critical / {evalState.suggestion.evidence.findings_high} high · GPS fails {evalState.suggestion.evidence.gps_fails} · age {evalState.suggestion.evidence.age_years ?? '—'} yr
                  </div>
                  {evalState.suggestion.reasons?.length ? (
                    <ul className="muted" style={{ fontSize: 12, margin: '4px 0 0 16px', padding: 0 }}>
                      {evalState.suggestion.reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  ) : null}
                  <div className="grid grid-2 mt" style={{ gap: 8 }}>
                    <div className="field"><label>Rating (1–10)</label>
                      <input type="number" min="1" max="10" value={evalState.rating} onChange={(e) => setEvalState({ ...evalState, rating: e.target.value })} /></div>
                    <div className="field"><label>Evaluation notes</label>
                      <input value={evalState.notes || ''} onChange={(e) => setEvalState({ ...evalState, notes: e.target.value })} placeholder="optional" /></div>
                  </div>
                  <div className="mt" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-sm btn-primary" disabled={evalState.busy} onClick={() => confirmEvaluation(true)}>
                      Confirm suggested ({evalState.suggestion.suggested_rating})
                    </button>
                    <button className="btn btn-sm" disabled={evalState.busy} onClick={() => confirmEvaluation(false)}>Save my rating</button>
                  </div>
                </div>
              )}
              {detail.metadata && Object.keys(detail.metadata).length > 0 && (
                <div className="mt">
                  <b>Type-specific attributes</b>
                  <div className="kv mt" style={{ fontSize: 12 }}>
                    {Object.entries(detail.metadata).map(([k, v]) => (
                      <Fragment key={k}><span className="k">{k}</span><span>{String(v)}</span></Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div>
              <div className="card-head"><h3 className="card-title">Open Tasks</h3></div>
              {(detail.open_tasks || []).map((t) => (
                <div key={t.id} className="card card-pad mb" style={{ padding: 10 }}>
                  <a href={`/tasks/${t.id}`} className="link">{t.task_number}</a> <Pill value={t.status} /><br />
                  <span className="muted">{t.title}</span>
                </div>
              ))}
              {(detail.open_tasks || []).length === 0 && <div className="muted">No open tasks.</div>}
              <div className="card-head mt"><h3 className="card-title">Maintenance History</h3></div>
              <div className="tbl-wrap">
              <table>
                <thead><tr><th>Date</th><th>Type</th><th>Summary</th><th>Cost</th></tr></thead>
                <tbody>
                  {(detail.maintenance_events || []).map((e) => (
                    <tr key={e.id}><td className="nowrap">{fmtDate(e.performed_at)}</td><td>{e.event_type}</td><td>{e.work_summary || '—'}</td><td>{e.cost != null ? fmtMoney(e.cost, currency) : '—'}</td></tr>
                  ))}
                  {(detail.maintenance_events || []).length === 0 && <tr><td colSpan={4} className="muted">No maintenance events.</td></tr>}
                </tbody>
              </table>
              </div>
              {canWrite && (
                <div className="mt">
                  {!addEv && <button className="btn btn-sm" onClick={() => setAddEv({ event_type: 'CORRECTIVE', performed_at: new Date().toISOString().slice(0, 10), work_summary: '', cost: '', condition_after: '' })}>+ Add maintenance event</button>}
                  {addEv && (
                    <div className="card card-pad" style={{ padding: 10 }}>
                      <div className="grid grid-2" style={{ rowGap: 6 }}>
                        <div className="field"><label>Type</label>
                          <SearchSelect value={addEv.event_type} onChange={(e) => setAddEv({ ...addEv, event_type: e.target.value })}>
                            {['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'REPAIR', 'REPLACEMENT', 'TESTING'].map((x) => <option key={x} value={x}>{x}</option>)}
                          </SearchSelect></div>
                        <div className="field"><label>Date</label><input type="date" value={addEv.performed_at} onChange={(e) => setAddEv({ ...addEv, performed_at: e.target.value })} /></div>
                        <div className="field full"><label>Work summary</label><textarea value={addEv.work_summary} onChange={(e) => setAddEv({ ...addEv, work_summary: e.target.value })} /></div>
                        <div className="field"><label>Cost (optional)</label><input type="number" min="0" step="0.01" value={addEv.cost} onChange={(e) => setAddEv({ ...addEv, cost: e.target.value })} /></div>
                        <div className="field"><label>Condition after (1–10)</label><input type="number" min="1" max="10" value={addEv.condition_after} onChange={(e) => setAddEv({ ...addEv, condition_after: e.target.value })} /></div>
                      </div>
                      <div className="mt">
                        <button className="btn btn-sm btn-primary" onClick={addEvent}>Save event</button>{' '}
                        <button className="btn btn-sm" onClick={() => setAddEv(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="card-head mt"><h3 className="card-title">GPS Validations</h3></div>
              {(detail.gps_validations || []).map((v) => (
                <div key={v.id} className="mb" style={{ fontSize: 12 }}><Pill value={v.result} /> <span className="muted">{fmtDate(v.validated_at)} · {v.distance_m} m from expected (tol {v.tolerance_m} m)</span></div>
              ))}
              <div className="card-head mt"><h3 className="card-title">Discussion</h3></div>
              <Comments entityType="asset" entityId={detail.id} />
            </div>
          </div>
          {perf && (() => {
            const c = perf.computed;
            const deltaAbs = Math.abs(Number(c.performance_delta) || 0);
            const total = (Number(c.base_rating) || 0) + deltaAbs || 1;
            const basePct = ((Number(c.base_rating) || 0) / total) * 100;
            const daPct = (deltaAbs / total) * 100;
            const ageYearsDefault = detail.installation_date ? Math.max(0, Math.round(((Date.now() - new Date(detail.installation_date).getTime()) / (365.25 * 864e5)) * 10) / 10) : 0;
            const monthsMaintDefault = detail.last_maintenance_at ? Math.max(0, Math.round((Date.now() - new Date(detail.last_maintenance_at).getTime()) / (30.44 * 864e5))) : 12;
            const simV = sim || { load_pct: 80, thermal_c: 60, through_faults: 0, trips: 0, age_years: ageYearsDefault, months_since_maintenance: monthsMaintDefault, environment: false };
            const trend = (perf.readings || []).slice().sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at)).map((r) => Number(r.value_num)).filter((n) => Number.isFinite(n));
            return (
              <div className="mt">
                <div className="card-head">
                  <h3 className="card-title">Condition &amp; Performance</h3>
                  <span className="muted">Advisory — accept to make the rating official</span>
                </div>
                <div className="grid grid-3" style={{ alignItems: 'start' }}>
                  <div className="card card-pad">
                    <Gauge value={c.combined_rating} max={10} sub={`${c.recommendation_label || c.recommendation || ''}`} bands={[{ max: 3, color: '#dc2626' }, { max: 5, color: '#ea580c' }, { max: 7, color: '#d97706' }, { max: 10, color: '#16a34a' }]} />
                    <div className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
                      Base {c.base_rating} · performance {c.performance_delta} · {c.confidence} confidence · RUL {c.remaining_useful_life_years ?? '—'} yr
                    </div>
                    <div className="contribution-bar mt">
                      <div className="contribution-seg" style={{ width: `${basePct}%`, background: '#14532d' }}>Base</div>
                      {deltaAbs > 0 && <div className="contribution-seg" style={{ width: `${daPct}%`, background: '#dc2626' }}>{c.performance_delta}</div>}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>{c.reasons?.join('; ')}</div>
                  </div>
                  <div className="card card-pad">
                    <b>Factors</b>
                    {(c.factors || []).length ? (
                      <table className="factor-table mt">
                        <thead><tr><th>Factor</th><th>Value</th><th>Δ</th></tr></thead>
                        <tbody>
                          {c.factors.map((f) => (
                            <tr key={f.key}>
                              <td>{f.label}<div className="muted" style={{ fontSize: 11 }}>{f.reason}</div></td>
                              <td>{f.value}</td>
                              <td className={f.contribution < 0 ? 'contribution-neg' : 'contribution-pos'}>{f.contribution}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <div className="muted mt">No operational readings or performance events recorded.</div>}
                  </div>
                  <div className="card card-pad">
                    <b>Reading trend</b>
                    {trend.length ? <div className="mt"><Sparkline values={trend} width={220} height={48} /></div> : <div className="muted mt">No readings recorded.</div>}
                    <div className="muted mt" style={{ fontSize: 12 }}>
                      {(perf.readings || []).length} reading(s) · {(perf.events || []).length} event(s) · {(perf.snapshots || []).length} snapshot(s)
                    </div>
                  </div>
                </div>
                {canEvaluate && (
                  <div className="grid grid-2 mt" style={{ alignItems: 'start' }}>
                    <div className="card card-pad">
                      <b>Record data</b>
                      <div className="mt">
                        {perfReading ? (
                          <div className="grid grid-2" style={{ rowGap: 6 }}>
                            <div className="field"><label>Reading type</label>
                              <SearchSelect value={perfReading.reading_type} onChange={(e) => setPerfReading({ ...perfReading, reading_type: e.target.value })}>
                                {perf.vocab.reading_types.map((x) => <option key={x} value={x}>{x}</option>)}
                              </SearchSelect>
                            </div>
                            <div className="field"><label>Value</label><input type="number" step="any" value={perfReading.value_num} onChange={(e) => setPerfReading({ ...perfReading, value_num: e.target.value })} /></div>
                            <div className="field"><label>Date</label><input type="date" value={perfReading.recorded_at} onChange={(e) => setPerfReading({ ...perfReading, recorded_at: e.target.value })} /></div>
                            <div className="field" style={{ alignSelf: 'end' }}>
                              <button className="btn btn-sm btn-primary" onClick={addReading}>Save reading</button>{' '}
                              <button className="btn btn-sm" onClick={() => setPerfReading(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button className="btn btn-sm" onClick={() => setPerfReading({ reading_type: perf.vocab.reading_types[0], value_num: '', recorded_at: new Date().toISOString().slice(0, 10) })}>+ Add reading</button>
                        )}
                      </div>
                      <div className="mt">
                        {perfEvent ? (
                          <div className="grid grid-2" style={{ rowGap: 6 }}>
                            <div className="field"><label>Event type</label>
                              <SearchSelect value={perfEvent.event_type} onChange={(e) => setPerfEvent({ ...perfEvent, event_type: e.target.value })}>
                                {perf.vocab.event_types.map((x) => <option key={x} value={x}>{x}</option>)}
                              </SearchSelect>
                            </div>
                            <div className="field"><label>Severity</label>
                              <SearchSelect value={perfEvent.severity} onChange={(e) => setPerfEvent({ ...perfEvent, severity: e.target.value })}>
                                {perf.vocab.severities.map((x) => <option key={x} value={x}>{x}</option>)}
                              </SearchSelect>
                            </div>
                            <div className="field"><label>Date</label><input type="date" value={perfEvent.occurred_at} onChange={(e) => setPerfEvent({ ...perfEvent, occurred_at: e.target.value })} /></div>
                            <div className="field"><label>Magnitude (optional)</label><input type="number" step="any" value={perfEvent.magnitude} onChange={(e) => setPerfEvent({ ...perfEvent, magnitude: e.target.value })} /></div>
                            <div className="field">
                              <button className="btn btn-sm btn-primary" onClick={addPerfEvent}>Save event</button>{' '}
                              <button className="btn btn-sm" onClick={() => setPerfEvent(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button className="btn btn-sm" onClick={() => setPerfEvent({ event_type: perf.vocab.event_types[0], severity: 'MEDIUM', occurred_at: new Date().toISOString().slice(0, 10), magnitude: '' })}>+ Add performance event</button>
                        )}
                      </div>
                      <div className="mt">
                        {perfCsv ? (
                          <div>
                            <textarea rows={4} style={{ width: '100%' }} placeholder="asset_code,kind,type,value,severity,occurred_at" value={perfCsv.csv} onChange={(e) => setPerfCsv({ ...perfCsv, csv: e.target.value })} />
                            <div className="mt">
                              <button className="btn btn-sm" onClick={() => runImport(true)}>Preview import</button>{' '}
                              <button className="btn btn-sm btn-primary" onClick={() => runImport(false)}>Apply import</button>{' '}
                              <button className="btn btn-sm" onClick={() => setPerfCsv(null)}>Cancel</button>
                            </div>
                            {perfCsv.result && (
                              <div className="muted mt" style={{ fontSize: 12 }}>
                                {perfCsv.result.dry_run ? 'Preview' : 'Applied'} · created {perfCsv.result.created} · errors {perfCsv.result.errors}
                              </div>
                            )}
                          </div>
                        ) : (
                          <button className="btn btn-sm" onClick={() => setPerfCsv({ csv: 'asset_code,kind,type,value,severity,occurred_at\n' })}>Import CSV</button>
                        )}
                      </div>
                    </div>
                    <div className="card card-pad">
                      <b>What-if simulator</b>
                      <div className="mt">
                        {SIM_FIELDS.map(([k, label, min, max, step]) => (
                          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span className="muted" style={{ fontSize: 12, minWidth: 130 }}>{label}</span>
                            <input type="range" min={min} max={max} step={step} value={simV[k]} onChange={(e) => setSim({ ...simV, [k]: Number(e.target.value) })} style={{ flex: 1 }} />
                            <span style={{ fontSize: 12, minWidth: 40, textAlign: 'right' }}>{simV[k]}</span>
                          </div>
                        ))}
                        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                          <input type="checkbox" checked={simV.environment} onChange={(e) => setSim({ ...simV, environment: e.target.checked })} /> Severe corrosion / environment
                        </label>
                      </div>
                      <div className="mt" style={{ border: '1px solid var(--border, #e2e8f0)', borderRadius: 8, padding: 8 }}>
                        {simBusy && <span className="muted" style={{ fontSize: 12 }}>Simulating…</span>}
                        {simResult && !simBusy && (
                          <span style={{ fontSize: 13 }}>
                            Simulated <b>{simResult.computed.combined_rating}/10</b> · {simResult.delta_vs_current >= 0 ? '+' : ''}{simResult.delta_vs_current} vs current · {simResult.computed.recommendation_label || simResult.computed.recommendation}
                          </span>
                        )}
                        {!simResult && !simBusy && <span className="muted" style={{ fontSize: 12 }}>Adjust a slider to model a what-if scenario.</span>}
                      </div>
                      <div className="mt">
                        <button className="btn btn-sm btn-primary" disabled={!simResult || simBusy} onClick={acceptSimulated}>Accept simulated rating</button>{' '}
                        <button className="btn btn-sm" disabled={!simResult || simBusy} onClick={saveScenario}>Save scenario</button>{' '}
                        <button className="btn btn-sm" onClick={() => { setSim(null); setSimResult(null); }}>Reset</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </Modal>
      )}

      {document && <Document type="ASSET_DETAIL" params={document} title="Asset Detail Document" onClose={() => setDocument(null)} />}

      {form && (() => {
        const sub = subs.find((s) => s.id === form.substation_id);
        const line = lines.find((l) => l.id === form.line_id);
        const pickerMarkers = [];
        if (sub) pickerMarkers.push({ lat: sub.latitude, lng: sub.longitude, label: sub.name, color: '#2563eb', radius: 9 });
        if (line) {
          if (line.from_substation) pickerMarkers.push({ lat: line.from_substation.latitude, lng: line.from_substation.longitude, label: line.from_substation.name, color: '#7c3aed', radius: 6 });
          if (line.to_substation) pickerMarkers.push({ lat: line.to_substation.latitude, lng: line.to_substation.longitude, label: line.to_substation.name, color: '#7c3aed', radius: 6 });
        }
        return (
        <Modal title={form.id ? `Edit — ${form.name}` : 'Add Asset'} onClose={() => setForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Asset ID</label><input value={form.asset_id || ''} onChange={(e) => setForm({ ...form, asset_id: e.target.value })} /></div>
            <div className="field"><label>Name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Family</label>
              <SearchSelect value={form.asset_type ? familyOf(catalog, form.asset_type) : ''} onChange={(e) => {
                const fam = e.target.value;
                const first = typesForFamily(catalog, fam)[0];
                setForm({ ...form, asset_type: first ? first.asset_type : '', sub_type: '' });
              }}>
                <option value="">— pick family —</option>
                {(catalog?.families || []).filter((f) => f.family !== 'TOWER_PARTS' && f.family !== 'TOWER_STRUCTURE').map((f) => <option key={f.family} value={f.family}>{f.family_label}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Asset type</label>
              <SearchSelect value={form.asset_type} onChange={(e) => {
                const t = e.target.value;
                const withSub = typesForFamily(catalog, familyOf(catalog, t));
                setForm({ ...form, asset_type: t, sub_type: withSub.some((r) => r.sub_type) ? (withSub.find((r) => r.sub_type)?.sub_type || '') : '' });
              }}>
                <option value="">— pick type —</option>
                {typesForFamily(catalog, familyOf(catalog, form.asset_type)).filter((r) => !r.sub_type).map((r) => <option key={r.asset_type} value={r.asset_type}>{r.asset_type}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Place (location type)</label>
              <SearchSelect value={form.location_type || 'OUTDOOR'} onChange={(e) => setForm({ ...form, location_type: e.target.value })}>
                {['OUTDOOR', 'INDOOR', 'BUILDING', 'CELLAR', 'UNDERGROUND'].map((c) => <option key={c}>{c}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Bay / feeder bay</label><input value={form.bay || ''} onChange={(e) => setForm({ ...form, bay: e.target.value })} placeholder="e.g. Bay 2, Feeder 5" /></div>
            <div className="field"><label>Region</label>
              <SearchSelect value={form.region_id || ''} onChange={(e) => setForm({ ...form, region_id: e.target.value ? Number(e.target.value) : null, substation_id: null, line_id: null })}>
                <option value="">— none —</option>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Substation</label>
              <SearchSelect value={form.substation_id || ''} onChange={(e) => setForm({ ...form, substation_id: e.target.value ? Number(e.target.value) : null, line_id: null })}>
                <option value="">— none —</option>
                {formSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Line</label>
              <SearchSelect value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {formLines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </SearchSelect></div>
            {form.line_id ? (
              <>
                <div className="field"><label>km from</label><input type="number" step="0.01" value={form.km_from ?? ''} onChange={(e) => setForm({ ...form, km_from: e.target.value === '' ? null : Number(e.target.value) })} /></div>
                <div className="field"><label>km to</label><input type="number" step="0.01" value={form.km_to ?? ''} onChange={(e) => setForm({ ...form, km_to: e.target.value === '' ? null : Number(e.target.value) })} /></div>
              </>
            ) : null}
            <div className="field"><label>Manufacturer</label><input value={form.manufacturer || ''} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} /></div>
            <div className="field"><label>Model</label><input value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>
            <div className="field"><label>Serial number</label><input value={form.serial_number || ''} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} /></div>
            <div className="field"><label>Installation date</label><input type="date" value={form.installation_date || ''} onChange={(e) => setForm({ ...form, installation_date: e.target.value })} /></div>
            <div className="field"><label>Condition (1–10)</label><input type="number" min="1" max="10" value={form.condition_rating ?? 7} onChange={(e) => setForm({ ...form, condition_rating: Number(e.target.value) })} /></div>
            <div className="field"><label>Criticality</label>
              <SearchSelect value={form.criticality} onChange={(e) => setForm({ ...form, criticality: e.target.value })}>
                {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((c) => <option key={c}>{c}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Lifecycle</label>
              <SearchSelect value={form.lifecycle_status} onChange={(e) => setForm({ ...form, lifecycle_status: e.target.value })}>
                {['IN_SERVICE', 'OUT_OF_SERVICE', 'RESERVED', 'RETIRED', 'SPARE'].map((c) => <option key={c}>{c}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Default crew</label>
              <SearchSelect value={form.default_crew_id || ''} onChange={(e) => setForm({ ...form, default_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {formCrews.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.status === 'OFF_DUTY' || c.status === 'UNAVAILABLE'}>
                    {c.name} ({c.status}{c.open_task_count ? ` · ${c.open_task_count} active` : ''})
                  </option>
                ))}
              </SearchSelect>
              <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>Prefills new tasks; overrides a schedule's crew at generation.</p></div>
            <div className="field"><label>Operational status</label>
              <SearchSelect value={form.operational_status} onChange={(e) => setForm({ ...form, operational_status: e.target.value })}>
                {['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'UNDER_CONSTRUCTION', 'DECOMMISSIONED'].map((c) => <option key={c}>{c}</option>)}
              </SearchSelect></div>
            <div className="field"><label>{t('latitude')}</label><input type="number" step="0.0001" value={form.latitude ?? ''} onChange={(e) => setForm({ ...form, latitude: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>{t('longitude')}</label><input type="number" step="0.0001" value={form.longitude ?? ''} onChange={(e) => setForm({ ...form, longitude: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field full">
              <label>{t('pickLocation')} — {t('clickMapToSetPoint')}</label>
              <MapPicker
                value={(typeof form.latitude === 'number' && typeof form.longitude === 'number') ? { lat: form.latitude, lng: form.longitude } : null}
                onChange={(p) => setForm({ ...form, latitude: p.lat, longitude: p.lng })}
                markers={pickerMarkers}
                radius={500}
                radiusLabel={t('gpsTolerance500')}
                zoom={form.id ? 13 : 9}
              />
              <p className="muted" style={{ marginTop: 6 }}>If the asset sits inside a substation or on a line, coordinates are optional — they are inherited for GPS checks.</p>
            </div>
            <div className="field full"><label>Metadata (JSON)</label><textarea value={typeof form.metadata === 'string' ? form.metadata : JSON.stringify(form.metadata || {}, null, 2)} onChange={(e) => setForm({ ...form, metadata: e.target.value })} /></div>
          </div>
        </Modal>
        );
      })()}

      {geo && (
        <Modal title="Import assets from KMZ/KML" onClose={() => setGeo(null)} wide
          footer={<>
            <button className="btn" onClick={() => setGeo(null)}>Cancel</button>
            {geo.preview && (
              <button className="btn btn-primary" disabled={geo.busy}
                onClick={async () => {
                  try {
                    setGeo({ ...geo, busy: true, error: null });
                    const res = await api.post('/assets/import-geo', { token: geo.preview.token });
                    setGeo(null);
                    load();
                  } catch (e) { setGeo({ ...geo, busy: false, error: e.message }); }
                }}>
                Confirm import ({geo.preview.count} placemark{geo.preview.count === 1 ? '' : 's'})
              </button>
            )}
          </>}>
          {geo.error && <ErrorNote error={geo.error} />}
          <div className="field">
            <label>File ({geo.format === 'kmz' ? '.kmz — zipped KML' : '.kml'})</label>
            <input type="file" accept={geo.format === 'kmz' ? '.kmz' : '.kml'}
              onChange={async (e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                const content = geo.format === 'kmz'
                  ? await fileToBase64(f)
                  : await f.text();
                try {
                  setGeo({ ...geo, busy: true, error: null });
                  const res = await api.post('/assets/import-geo/preview', { format: geo.format, content });
                  setGeo({ ...geo, fileName: f.name, preview: res, busy: false, error: null });
                } catch (err) { setGeo({ ...geo, busy: false, error: err.message }); }
              }} />
          </div>
          {geo.preview && (
            <>
              <h4 className="section-title">Preview — review before inserting</h4>
              <div className="card"><div className="tbl-wrap"><table>
                <thead><tr><th>Name</th><th>Type (mapped)</th><th>Kind</th><th>Lat</th><th>Lng</th><th>Status</th></tr></thead>
                <tbody>
                  {geo.preview.candidates.map((c, i) => (
                    <tr key={i}>
                      <td><b>{c.name}</b></td>
                      <td>{c.asset_type}</td>
                      <td>{c.kind}</td>
                      <td className="mono">{c.lat}</td>
                      <td className="mono">{c.lng}</td>
                      <td>{c.will_skip ? <span style={{ color: '#dc2626' }}>skip: {c.reason}</span> : <span style={{ color: '#16a34a' }}>will import</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div></div>
            </>
          )}
        </Modal>
      )}

      {showImport && (
        <ImportDialog
          title="Import assets from CSV"
          endpoint="/assets/import"
          templatePath="/assets/import/template"
          templateName="tmms-assets-template.csv"
          columns={[
            { key: 'asset_id', label: 'Asset ID', mono: true },
            { key: 'name', label: 'Name' },
            { key: 'asset_type', label: 'Type' },
            { key: 'anchor', label: 'Anchor' },
          ]}
          regions={regions}
          supportsUpdate
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); load(); }}
        />
      )}
    </Page>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const b64 = r.result.split(',')[1]; if (b64) resolve(b64); else reject(new Error('Could not read file')); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
