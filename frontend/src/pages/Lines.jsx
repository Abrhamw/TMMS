import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { api, fmtDate, asArray } from '../api';
import { SearchSelect, Page, Pill, Modal, ErrorNote, Loading, PrintButton, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import { subsInRegion } from '../cascade';
import DossierReport from '../components/DossierReport';
import ImportDialog from '../components/ImportDialog';
import ViewMap from '../components/ViewMap';
import { KpiTile } from '../components/InfraVisuals';
import { entityColor, maxVoltageKv, isEnergized, parseVoltageLevels, voltageChip, popupRows, boundaryRing } from '../mapFocus';
import { t } from '../i18n';

const R = 6371;
const haversineKm = (a, b) => {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function substationMarker(s, sub) {
  const kv = maxVoltageKv(s.voltage_levels);
  return {
    lat: s.latitude,
    lng: s.longitude,
    label: s.name,
    sub,
    color: entityColor(kv, s.operational_status),
    popup: `<div class="tmms-pop"><b>${s.name}</b> ${voltageChip(kv, { energized: isEnergized(s.operational_status) })}` +
      `<div class="tmms-pop-sub">${s.substation_id || ''}</div>` +
      popupRows([
        ['Voltage', parseVoltageLevels(s.voltage_levels).join(', ') || null],
        ['Type', s.substation_type],
        ['Status', s.operational_status],
      ]) + '</div>',
  };
}

function substationPerimeter(s, sub) {
  const ring = boundaryRing(s && s.boundary_json);
  if (!ring) return null;
  const kv = maxVoltageKv(s.voltage_levels);
  return {
    points: ring,
    color: entityColor(kv, s.operational_status),
    label: `${s.name} perimeter`,
    sub,
  };
}

function towerMarker(t, kv, status, lineName) {
  return {
    lat: t.latitude,
    lng: t.longitude,
    radius: 4,
    color: entityColor(kv, status),
    popup: `<div class="tmms-pop"><b>${t.tower_id}</b> ${voltageChip(kv, { energized: isEnergized(status) })}` +
      popupRows([
        ['Line', lineName],
        ['Type', t.tower_type],
        ['km marker', t.km_marker],
      ]) + '</div>',
  };
}

const blank = {
  line_id: '', name: '', region_id: null, from_substation_id: null, to_substation_id: null,
  voltage_kv: 138, line_type: 'OVERHEAD', length_km: 0, conductor_type: '', circuit_count: 1,
  rating_mva: null, construction_date: '', commissioned_date: '', operational_status: 'ENERGIZED',
  veg_clearance_m: '', waypoints: [], route_json: [],
};

export default function Lines({ embedded }) {
  const canWrite = can(getStoredUser(), 'line:write');
  const canTowerWrite = can(getStoredUser(), 'tower:write');
  const canReport = can(getStoredUser(), 'report:write');
  const me = getStoredUser();
  const [rows, setRows] = useState(null);
  const [regions, setRegions] = useState([]);
  const [subs, setSubs] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [lineTasks, setLineTasks] = useState([]);
  const [reportData, setReportData] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [routeImport, setRouteImport] = useState(null); // { mode, format, content, error, busy }
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [importLines, setImportLines] = useState([]);
  const [lineValidation, setLineValidation] = useState(null);
  const { query, setQuery, results } = useSearchFilter(rows);

  // Region narrows the substation pickers, both in the edit form and in the
  // route import dialog.
  const formSubs = useMemo(() => subsInRegion(subs, form?.region_id), [subs, form?.region_id]);
  const routeSubs = useMemo(() => subsInRegion(subs, routeImport?.region_id), [subs, routeImport?.region_id]);
  const detailRoute = asArray(detail && detail.route_json);

  const load = () => api.get('/lines').then(setRows).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/lines').then(setImportLines).catch(() => {});
  }, []);

  async function save() {
    try {
      const a = subs.find((s) => s.id === Number(form.from_substation_id));
      const b = subs.find((s) => s.id === Number(form.to_substation_id));
      const wps = (form.waypoints || []).filter((w) => w && typeof w.lat === 'number');
      const route = [];
      if (a && typeof a.latitude === 'number') route.push([a.latitude, a.longitude]);
      route.push(...wps.map((w) => [w.lat, w.lng]));
      if (b && typeof b.latitude === 'number') route.push([b.latitude, b.longitude]);
      let length = 0;
      for (let i = 1; i < route.length; i++) length += haversineKm(route[i - 1], route[i]);
      const body = { ...form, route_json: route, length_km: Number(form.length_km) || Number(length.toFixed(2)) || 0 };
      body.veg_clearance_m = form.veg_clearance_m === '' || form.veg_clearance_m == null ? undefined : Number(form.veg_clearance_m);
      delete body.waypoints;
      if (form.id) await api.put(`/lines/${form.id}`, body);
      else await api.post('/lines', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(l) {
    try {
      await api.del(`/lines/${l.id}`);
      load();
    } catch (e) {
      if (String(e.message || '').startsWith('Cannot delete:')) {
        if (window.confirm(`${e.message}.\n\nDelete anyway? This removes the line's towers, assets and tasks.`)) {
          try {
            await api.del(`/lines/${l.id}?force=1`);
            load();
            setError(null);
          } catch (e2) { setError(e2.message); }
        }
      } else {
        setError(e.message);
      }
    }
  }

  async function openDetail(l) {
    try {
      const d = await api.get(`/lines/${l.id}`);
      setDetail(d);
      setLineTasks(d.tasks || []);
      setReportData(null);
      loadLineValidation(d.id);
    } catch (e) { setError(e.message); }
  }

  async function loadLineValidation(id) {
    setLineValidation(null);
    try { setLineValidation(await api.get(`/infrastructure/validation?line_id=${id}`)); }
    catch { setLineValidation(null); }
  }

  function closeDetail() {
    setDetail(null);
    setLineValidation(null);
  }

  async function genLineReport() {
    try {
      setReportBusy(true);
      setReportData(null);
      const res = await api.post('/reports/generate', { report_type: 'LINE_DETAIL', line_id: detail.id });
      setReportData(res.data);
    } catch (e) { setError(e.message); }
    finally { setReportBusy(false); }
  }

  async function towersFromRoute() {
    try {
      const res = await api.post(`/lines/${detail.id}/towers-from-route`, {});
      setDetail(await api.get(`/lines/${detail.id}`));
      load();
      setError(null);
      setNotice(res.created > 0
        ? `Created ${res.created} tower(s) from the route points.`
        : (res.message || 'Route points already match existing towers.'));
    } catch (e) { setError(e.message); }
  }

  if (!rows) return embedded ? <Loading /> : <Page title="Transmission Lines"><Loading /></Page>;

  const actions = (
    <>
      {canWrite && <button className="btn" onClick={() => setRouteImport({ mode: 'create', format: 'geojson', content: '', error: null, busy: false })}>Import route file</button>}
      {canWrite && <button className="btn" onClick={() => setShowBulkImport(true)}>{t('importLines')}</button>}
      {canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: me?.region_id || regions[0]?.id || 1, from_substation_id: subs[0]?.id, to_substation_id: subs[1]?.id || subs[0]?.id })}>+ Add Line</button> : null}
    </>
  );
  const body = (
    <>
      {embedded && actions && <div className="mb">{actions}</div>}
      {error && <ErrorNote error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      {Array.isArray(rows) && (
        <div className="grid grid-3 mb">
          <KpiTile label="Lines" value={rows.length} />
          <KpiTile label="Energized" value={rows.filter((l) => l.operational_status === 'ENERGIZED').length} />
          <KpiTile label="Towers" value={rows.reduce((a, l) => a + (Number(l.tower_count) || 0), 0)} />
        </div>
      )}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search lines…" />
        <span className="muted" style={{ fontSize: 12 }}>{results.length} of {rows.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Line ID</th><th>Name</th><th>kV</th><th>From</th><th>To</th><th>Length (km)</th><th>Towers</th><th>Status</th><th>GPS</th><th></th></tr></thead>
            <tbody>
              {results.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.line_id}</td>
                  <td><b>{l.name}</b></td>
                  <td>{l.voltage_kv}</td>
                  <td>{l.from_substation?.name}</td>
                  <td>{l.to_substation?.name}</td>
                  <td>{l.length_km}</td>
                  <td>{l.tower_count}</td>
                  <td><Pill value={l.operational_status} /></td>
                  <td>{l.gps_validated ? <span className="ok">✓</span> : <span className="bad">✗</span>}</td>
                  <td className="td-actions">
                    <button className="btn btn-sm" onClick={() => openDetail(l)}>View</button>{' '}
                    <button className="btn btn-sm" onClick={() => setForm({ ...l, route_json: undefined, waypoints: asArray(l.route_json).slice(1, -1).map((p) => ({ lat: p[0], lng: p[1] })) })}>Edit</button>{' '}
                    <ConfirmButton label="Delete" title={`Delete ${l.name}?`} onConfirm={() => remove(l)} />
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan="10" className="muted center">{query ? 'No lines match your search' : 'No lines found'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <Modal title={`${detail.name} — ${detail.line_id}`} onClose={closeDetail} wide printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={closeDetail}>Close</button>
          </>}>
          <ViewMap
            height={240}
            markers={[
              ...(detail.from_substation?.latitude != null ? [substationMarker(detail.from_substation, 'From substation')] : []),
              ...(detail.to_substation?.latitude != null ? [substationMarker(detail.to_substation, 'To substation')] : []),
              ...(detail.towers || []).filter((t) => t.latitude != null).map((t) => towerMarker(t, detail.voltage_kv, detail.operational_status, detail.name)),
            ]}
            polylines={detailRoute.length ? [{
              points: detailRoute,
              label: `${detail.name} route`,
              color: entityColor(detail.voltage_kv, detail.operational_status),
              weight: 5,
              flash: true,
              popup: `<div class="tmms-pop"><b>${detail.name}</b> ${voltageChip(detail.voltage_kv, { energized: isEnergized(detail.operational_status) })}` +
                `<div class="tmms-pop-sub">${detail.line_id}</div>` +
                popupRows([
                  ['Voltage', `${detail.voltage_kv} kV`],
                  ['Length', detail.length_km != null ? `${detail.length_km} km` : null],
                  ['Conductor', detail.conductor_type],
                  ['Circuits', detail.circuit_count],
                  ['Status', detail.operational_status],
                ]) + '</div>',
            }] : []}
            polygons={[
              substationPerimeter(detail.from_substation, 'From substation'),
              substationPerimeter(detail.to_substation, 'To substation'),
            ].filter(Boolean)}
            focus={detailRoute.length ? detailRoute : null}
            focusKey={detail.id}
          />
          <div className="grid grid-2 mt">
            <div>
              <div className="kv">
                <span className="k">Route</span><span>{detail.from_substation?.name} → {detail.to_substation?.name}</span>
                <span className="k">Voltage</span><span>{detail.voltage_kv} kV</span>
                <span className="k">Length</span><span>{detail.length_km} km</span>
                <span className="k">Conductor</span><span>{detail.conductor_type || '—'}</span>
                <span className="k">Circuits</span><span>{detail.circuit_count}</span>
                <span className="k">Rating</span><span>{detail.rating_mva || '—'} MVA</span>
                <span className="k">Veg clearance</span><span>{detail.veg_clearance_m ? `${detail.veg_clearance_m} m` : '—'} {detail.veg_clearance_last_checked_at ? `· last checked ${fmtDate(detail.veg_clearance_last_checked_at)}` : ''}</span>
                <span className="k">Status</span><span><Pill value={detail.operational_status} /></span>
                <span className="k">Commissioned</span><span>{fmtDate(detail.commissioned_date)}</span>
              </div>
              <div className="card-head mt"><h3 className="card-title">Route polyline points</h3></div>
              <div className="muted" style={{ fontSize: 12, maxHeight: 120, overflowY: 'auto' }}>
                {detailRoute.map((p, i) => <div key={i} className="mono">({p[0]}, {p[1]})</div>)}
              </div>
            </div>
            <div>
              <div className="card-head"><h3 className="card-title">Towers ({detail.towers?.length || 0})</h3></div>
              {canWrite && (
                <div className="mb">
                  <button className="btn btn-sm btn-primary" onClick={towersFromRoute}>
                    Convert route points → towers
                  </button>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                    Creates a tower (with standard parts) at every route point.
                  </span>
                </div>
              )}
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Tower</th><th>Type</th><th>km</th><th>Corrosion</th></tr></thead>
                  <tbody>
                    {(detail.towers || []).map((t) => (
                      <tr key={t.id}><td className="mono">{t.tower_id}</td><td>{t.tower_type}</td><td>{t.km_marker}</td><td>{t.corrosion_rating}/10</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {lineValidation && lineValidation.lines[0] && (
                <div className="card card-pad mt">
                  <div className="spread">
                    <div>
                      <b>Standards</b>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lineValidation.lines[0].actual_tower_count} towers · {lineValidation.lines[0].non_standard_towers} non-standard · {lineValidation.lines[0].missing_mirrors} missing mirror(s)
                      </div>
                    </div>
                    {canTowerWrite && lineValidation.lines[0].non_standard_towers > 0 && (
                      <button className="btn btn-sm" onClick={async () => {
                        try {
                          await api.post(`/lines/${detail.id}/reset-tower-components`, {});
                          setDetail(await api.get(`/lines/${detail.id}`));
                          loadLineValidation(detail.id);
                          load();
                        } catch (e) { setError(e.message); }
                      }}>Reset all towers to standard</button>
                    )}
                  </div>
                </div>
              )}
              <div className="card-head mt"><h3 className="card-title">Line Assets ({detail.assets?.length || 0})</h3></div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Asset</th><th>Type</th></tr></thead>
                  <tbody>
                    {(detail.assets || []).map((a) => (
                      <tr key={a.id}><td className="mono">{a.asset_id}</td><td>{a.asset_type}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <h4 className="section-title mt">Related maintenance tasks <span className="muted">({lineTasks.length})</span></h4>
          <div className="card">
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Task</th><th>Status</th><th>Result</th><th>Crew</th><th>Due</th><th></th></tr></thead>
                <tbody>
                  {(lineTasks || []).map((tk) => (
                    <tr key={tk.id}>
                      <td><b>{tk.task_number}</b><br /><span className="muted">{tk.title}</span></td>
                      <td><Pill value={tk.status} /></td>
                      <td>{tk.result || '—'}</td>
                      <td>{tk.crew?.name || '—'}</td>
                      <td>{fmtDate(tk.due_date)}</td>
                      <td><a className="btn btn-sm" href={`/tasks/${tk.id}`}>Open</a></td>
                    </tr>
                  ))}
                  {(lineTasks || []).length === 0 && <tr><td colSpan={6} className="empty">No tasks target this line yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {canReport && (
            <div className="mt">
              <button className="btn btn-primary" disabled={reportBusy} onClick={genLineReport}>
                {reportBusy ? 'Generating…' : 'Generate line detail dossier'}
              </button>
            </div>
          )}
          {reportData && (
            <div className="card card-pad mt" style={{ borderTop: '3px solid var(--accent)' }}>
              <div className="card-head"><h3 className="card-title">Line Detail Dossier</h3></div>
              <DossierReport data={reportData} />
            </div>
          )}
        </Modal>
      )}

      {form && (() => {
        const a = subs.find((s) => s.id === Number(form.from_substation_id));
        const b = subs.find((s) => s.id === Number(form.to_substation_id));
        const fromPt = a && typeof a.latitude === 'number' ? { lat: a.latitude, lng: a.longitude } : null;
        const toPt = b && typeof b.latitude === 'number' ? { lat: b.latitude, lng: b.longitude } : null;
        return (
        <Modal title={form.id ? `Edit — ${form.name}` : 'Add Transmission Line'} onClose={() => setForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Line ID</label><input value={form.line_id || ''} onChange={(e) => setForm({ ...form, line_id: e.target.value })} /></div>
            <div className="field"><label>Name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Region</label>
              <SearchSelect value={form.region_id || ''} onChange={(e) => setForm({ ...form, region_id: Number(e.target.value), from_substation_id: null, to_substation_id: null })}>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>From substation</label>
              <SearchSelect value={form.from_substation_id || ''} onChange={(e) => setForm({ ...form, from_substation_id: Number(e.target.value) })}>
                {formSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>To substation</label>
              <SearchSelect value={form.to_substation_id || ''} onChange={(e) => setForm({ ...form, to_substation_id: Number(e.target.value) })}>
                {formSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Voltage (kV)</label><input type="number" value={form.voltage_kv} onChange={(e) => setForm({ ...form, voltage_kv: Number(e.target.value) })} /></div>
            <div className="field"><label>Type</label>
              <SearchSelect value={form.line_type} onChange={(e) => setForm({ ...form, line_type: e.target.value })}>
                {['OVERHEAD', 'UNDERGROUND', 'MIXED'].map((t) => <option key={t}>{t}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Status</label>
              <SearchSelect value={form.operational_status} onChange={(e) => setForm({ ...form, operational_status: e.target.value })}>
                {['ENERGIZED', 'DE_ENERGIZED', 'UNDER_MAINTENANCE', 'UNDER_CONSTRUCTION', 'RETIRED'].map((s) => <option key={s}>{s}</option>)}
              </SearchSelect></div>
            <div className="field"><label>Length (km)</label><input type="number" value={form.length_km ?? ''} onChange={(e) => setForm({ ...form, length_km: Number(e.target.value) })} /></div>
            <div className="field"><label>Conductor</label><input value={form.conductor_type || ''} onChange={(e) => setForm({ ...form, conductor_type: e.target.value })} /></div>
            <div className="field"><label>Circuits</label><input type="number" value={form.circuit_count} onChange={(e) => setForm({ ...form, circuit_count: Number(e.target.value) })} /></div>
            <div className="field"><label>Rating (MVA)</label><input type="number" value={form.rating_mva ?? ''} onChange={(e) => setForm({ ...form, rating_mva: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Vegetation clearance (m)</label><input type="number" step="0.1" value={form.veg_clearance_m ?? ''} onChange={(e) => setForm({ ...form, veg_clearance_m: e.target.value === '' ? '' : Number(e.target.value) })} placeholder="auto by kV (7.6 m @ 220 kV)" /></div>
            <div className="field"><label>Construction date</label><input type="date" value={form.construction_date || ''} onChange={(e) => setForm({ ...form, construction_date: e.target.value })} /></div>
            <div className="field"><label>Commissioned date</label><input type="date" value={form.commissioned_date || ''} onChange={(e) => setForm({ ...form, commissioned_date: e.target.value })} /></div>
            <div className="field full">
              <label>{t('routeWaypoints')} — {t('addWaypointHint')}</label>
              <LineRouteMap
                from={fromPt}
                to={toPt}
                waypoints={form.waypoints || []}
                setWaypoints={(wps) => setForm({ ...form, waypoints: wps })}
              />
              {(form.waypoints || []).length > 0 && (
                <div className="flex mt" style={{ flexWrap: 'wrap' }}>
                  {(form.waypoints || []).map((w, i) => (
                    <span key={i} className="pill" style={{ background: '#e0f2fe', color: '#0369a1', cursor: 'pointer' }}
                      onClick={() => setForm({ ...form, waypoints: (form.waypoints || []).filter((_, j) => j !== i) })}>
                      {w.lat.toFixed(4)}, {w.lng.toFixed(4)} ✕
                    </span>
                  ))}
                  <button className="btn btn-sm" onClick={() => setForm({ ...form, waypoints: [] })}>{t('resetRoute')}</button>
                </div>
              )}
            </div>
          </div>
          <p className="muted mt">The route is drawn between the two substations; click the map to add intermediate waypoints. When towers are registered on the line, their GPS locations become the route points — the route and length are then rebuilt automatically from the tower positions (tower locations are the transmission-line route points).</p>
        </Modal>
        );
      })()}

      {routeImport && (
        <Modal title="Import a transmission-line route" onClose={() => setRouteImport(null)} wide
          footer={<>
            <button className="btn" onClick={() => setRouteImport(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={routeImport.busy} onClick={async () => {
              try {
                setRouteImport({ ...routeImport, busy: true, error: null });
                const body = { mode: routeImport.mode, format: routeImport.format, content: routeImport.content };
                if (routeImport.mode === 'update') {
                  const lid = importLines.find((l) => l.name === routeImport.lineName);
                  if (!lid) { setRouteImport({ ...routeImport, busy: false, error: 'Choose the line to update' }); return; }
                  body.line_id = lid.id;
                } else {
                  body.name = routeImport.name;
                  body.region_id = routeImport.region_id;
                  body.voltage_kv = routeImport.voltage_kv;
                  body.from_substation_id = routeImport.from_substation_id;
                  body.to_substation_id = routeImport.to_substation_id;
                }
                await api.post('/lines/import-route', body);
                setRouteImport(null);
                load();
              } catch (e) { setRouteImport({ ...routeImport, busy: false, error: e.message }); }
            }}>{routeImport.busy ? 'Importing…' : 'Import route'}</button>
          </>}>
          {routeImport.error && <ErrorNote error={routeImport.error} />}
          <div className="form-grid">
            <div className="field"><label>Mode</label>
              <SearchSelect value={routeImport.mode} onChange={(e) => setRouteImport({ ...routeImport, mode: e.target.value })}>
                <option value="create">Create a new line</option>
                <option value="update">Update an existing line's route</option>
              </SearchSelect></div>
            {routeImport.mode === 'create' && (
              <>
                <div className="field"><label>Name</label><input value={routeImport.name || ''} onChange={(e) => setRouteImport({ ...routeImport, name: e.target.value })} /></div>
                <div className="field"><label>Region</label>
                  <SearchSelect value={routeImport.region_id || ''} onChange={(e) => setRouteImport({ ...routeImport, region_id: Number(e.target.value), from_substation_id: null, to_substation_id: null })}>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>Voltage (kV)</label>
                  <SearchSelect value={routeImport.voltage_kv || 230} onChange={(e) => setRouteImport({ ...routeImport, voltage_kv: Number(e.target.value) })}>
                    {[66, 132, 230, 400, 500].map((kv) => <option key={kv} value={kv}>{kv}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>From substation</label>
                  <SearchSelect value={routeImport.from_substation_id || ''} onChange={(e) => setRouteImport({ ...routeImport, from_substation_id: Number(e.target.value) })}>
                    {routeSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </SearchSelect></div>
                <div className="field"><label>To substation</label>
                  <SearchSelect value={routeImport.to_substation_id || ''} onChange={(e) => setRouteImport({ ...routeImport, to_substation_id: Number(e.target.value) })}>
                    {routeSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </SearchSelect></div>
              </>
            )}
            {routeImport.mode === 'update' && (
              <div className="field full"><label>Line to update</label>
                <SearchSelect value={routeImport.lineName || ''} onChange={(e) => setRouteImport({ ...routeImport, lineName: e.target.value })}>
                  <option value="">Choose line…</option>
                  {importLines.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
                </SearchSelect></div>
            )}
            <div className="field full"><label>Format</label>
              <SearchSelect value={routeImport.format} onChange={(e) => setRouteImport({ ...routeImport, format: e.target.value })}>
                {['geojson', 'kml', 'kmz', 'wkt', 'csv'].map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </SearchSelect></div>
            <div className="field full"><label>Content ({routeImport.format === 'kmz' ? 'base64-encoded KMZ zip' : routeImport.format === 'csv' ? 'lng,lat per line' : routeImport.format === 'wkt' ? 'LINESTRING(lng lat, …)' : 'GeoJSON/KML text'})</label>
              <textarea rows={8} value={routeImport.content} onChange={(e) => setRouteImport({ ...routeImport, content: e.target.value })}
                placeholder={routeImport.format === 'csv' ? '38.0,9.0\n38.5,9.2' : 'Paste file content here…'} /></div>
          </div>
          <p className="muted mt">The route length (km) is computed from the geometry. For create mode the region's two substations anchor the ends. Towers are never auto-generated — use "Convert route points → towers" afterwards if needed.</p>
        </Modal>
      )}

      {showBulkImport && (
        <ImportDialog
          title={t('importLines')}
          endpoint="/infrastructure/import/lines"
          templatePath="/infrastructure/templates/lines"
          templateName="tmms-lines-template.csv"
          regions={regions}
          supportsUpdate
          columns={[
            { key: 'line_id', label: 'Line', mono: true },
            { key: 'name', label: 'Name' },
            { key: 'region_code', label: 'Region' },
            { key: 'voltage_kv', label: 'kV' },
            { key: 'from', label: 'From' },
            { key: 'to', label: 'To' },
            { key: 'tower_count', label: 'Towers' },
            { key: 'route_points', label: 'Route pts' },
          ]}
          onClose={() => setShowBulkImport(false)}
          onDone={() => { load(); api.get('/lines').then(setImportLines).catch(() => {}); }}
        />
      )}
    </>
  );
  if (embedded) return body;
  return (
    <Page title="Transmission Lines" crumbs="TMMS / Infrastructure"
      actions={actions}>
      {body}
    </Page>
  );
}

// Interactive route editor: from/to substations + click-to-add waypoints + live polyline.
function LineRouteMap({ from, to, waypoints, setWaypoints }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const setWpRef = useRef(setWaypoints);
  const wayRef = useRef(waypoints);
  setWpRef.current = setWaypoints;
  wayRef.current = waypoints;

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    const pts = [from, ...waypoints, to].filter(Boolean);
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.3), { maxZoom: 14 });
    else map.setView([9.0, 39.0], 6);
    map.on('click', (e) => {
      setWpRef.current([...wayRef.current, { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }]);
    });
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) layerRef.current.remove();
    const g = L.layerGroup();
    layerRef.current = g;
    const pts = [];
    if (from) {
      pts.push([from.lat, from.lng]);
      L.circleMarker([from.lat, from.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }).bindPopup('From').addTo(g);
    }
    waypoints.forEach((w, i) => {
      pts.push([w.lat, w.lng]);
      L.circleMarker([w.lat, w.lng], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#0ea5e9', fillOpacity: 1 }).bindPopup(`Waypoint ${i + 1}`).addTo(g);
    });
    if (to) {
      pts.push([to.lat, to.lng]);
      L.circleMarker([to.lat, to.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 }).bindPopup('To').addTo(g);
    }
    if (pts.length > 1) L.polyline(pts, { color: '#2563eb', weight: 3, opacity: 0.85 }).addTo(g);
    g.addTo(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, waypoints]);

  return <div ref={elRef} className="line-route-map" style={{ height: 300 }} />;
}
