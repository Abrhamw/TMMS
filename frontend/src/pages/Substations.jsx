import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate } from '../api';
import { Page, Pill, Modal, ErrorNote, Loading, CondPill, PrintButton, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import MapPicker from '../components/MapPicker';
import BoundaryPicker from '../components/BoundaryPicker';
import ImportDialog from '../components/ImportDialog';
import ViewMap from '../components/ViewMap';
import { circleCorners, entityColor, maxVoltageKv, isEnergized, parseVoltageLevels, voltageChip, popupRows } from '../mapFocus';
import { KpiTile } from '../components/InfraVisuals';
import { t } from '../i18n';

const blank = {
  substation_id: '', name: '', region_id: null, voltage_levels: '', latitude: null, longitude: null,
  elevation_m: '', substation_type: 'TRANSFORMER', operational_status: 'OPERATIONAL',
  commissioned_date: '', owner: '', fence_radius_m: 220, boundary_json: null,
};

export default function Substations({ embedded }) {
  const canWrite = can(getStoredUser(), 'substation:write');
  const me = getStoredUser();
  const [rows, setRows] = useState(null);
  const [regions, setRegions] = useState([]);
  const [regionFilter, setRegionFilter] = useState('');
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const { query, setQuery, results } = useSearchFilter(rows);

  const detailBays = useMemo(() => {
    const m = new Map();
    for (const a of detail?.assets || []) {
      const b = String(a.bay || '').trim();
      if (!b) continue;
      m.set(b, (m.get(b) || 0) + 1);
    }
    return [...m.entries()].map(([bay, count]) => ({ bay, count })).sort((x, y) => x.bay.localeCompare(y.bay));
  }, [detail]);

  const load = () => {
    const q = regionFilter ? `?region_id=${regionFilter}` : '';
    return api.get(`/substations${q}`).then(setRows).catch((e) => setError(e.message));
  };
  useEffect(() => {
    api.get('/regions').then((r) => setRegions(r)).catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionFilter]);

  async function save() {
    try {
      const body = { ...form, voltage_levels: Array.isArray(form.voltage_levels) ? form.voltage_levels : String(form.voltage_levels || '').split(',').map((s) => s.trim()).filter(Boolean) };
      delete body.bay_count;
      if (Array.isArray(form.boundary_json) && form.boundary_json.length >= 3) {
        body.boundary_json = form.boundary_json;
      } else {
        delete body.boundary_json;
      }
      if (form.id) await api.put(`/substations/${form.id}`, body);
      else await api.post('/substations', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(s) {
    try {
      await api.del(`/substations/${s.id}`);
      load();
    } catch (e) {
      if (String(e.message || '').startsWith('Cannot delete:')) {
        if (window.confirm(`${e.message}.\n\nDelete anyway? This removes the substation's connected lines, towers, assets and tasks.`)) {
          try {
            await api.del(`/substations/${s.id}?force=1`);
            load();
            setError(null);
          } catch (e2) { setError(e2.message); }
        }
      } else {
        setError(e.message);
      }
    }
  }

  async function openDetail(s) {
    try { setDetail(await api.get(`/substations/${s.id}`)); } catch (e) { setError(e.message); }
  }

  if (!rows) return embedded ? <Loading /> : <Page title="Substations"><Loading /></Page>;

  const actions = canWrite ? (
    <>
      <button className="btn" onClick={() => setImportOpen(true)}>{t('importSubstations')}</button>
      <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: me?.region_id || regions[0]?.id || 1 })}>+ Add Substation</button>
    </>
  ) : null;
  const body = (
    <>
      {embedded && actions && <div className="mb">{actions}</div>}
      {error && <ErrorNote error={error} />}
      {Array.isArray(rows) && (
        <div className="grid grid-3 mb">
          <KpiTile label="Substations" value={rows.length} />
          <KpiTile label="GPS validated" value={rows.filter((s) => s.gps_validated).length} />
          <KpiTile label="Operational" value={rows.filter((s) => s.operational_status === 'OPERATIONAL').length} />
        </div>
      )}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search substations…" />
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
          <option value="">All regions</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>{results.length} of {rows.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Region</th><th>Voltage</th><th>Type</th><th>Status</th><th>GPS</th><th></th></tr></thead>
            <tbody>
              {results.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.substation_id}</td>
                  <td><b>{s.name}</b></td>
                  <td>{s.region_id}</td>
                  <td>{parseVoltageLevels(s.voltage_levels).join(', ')}</td>
                  <td>{s.substation_type}</td>
                  <td><Pill value={s.operational_status} /></td>
                  <td>{s.gps_validated ? <span className="ok">✓ validated</span> : <span className="bad">✗ unvalidated</span>}</td>
                  <td className="td-actions">
                    <button className="btn btn-sm" onClick={() => openDetail(s)}>View</button>{' '}
                    <button className="btn btn-sm" onClick={() => setForm({ ...s, voltage_levels: parseVoltageLevels(s.voltage_levels).join(', '), boundary_json: Array.isArray(s.boundary_json) ? s.boundary_json : null })}>Edit</button>{' '}
                    <ConfirmButton label="Delete" title={`Delete ${s.name}?`} onConfirm={() => remove(s)} />
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan="8" className="muted center">{query ? 'No substations match your search' : 'No substations found'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <Modal title={`${detail.name} — ${detail.substation_id}`} onClose={() => setDetail(null)} wide printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
          </>}>
          <ViewMap
            height={240}
            center={detail.latitude != null ? { lat: detail.latitude, lng: detail.longitude } : null}
            markers={[
              ...(detail.latitude != null ? [{
                lat: detail.latitude,
                lng: detail.longitude,
                label: detail.name,
                flash: true,
                color: entityColor(maxVoltageKv(detail.voltage_levels), detail.operational_status),
                popup: `<div class="tmms-pop"><b>${detail.name}</b> ${voltageChip(maxVoltageKv(detail.voltage_levels), { energized: isEnergized(detail.operational_status) })}` +
                  `<div class="tmms-pop-sub">${detail.substation_id || ''}${detail.substation_type ? ` · ${detail.substation_type}` : ''}</div>` +
                  popupRows([
                    ['Voltage', parseVoltageLevels(detail.voltage_levels).join(', ') || null],
                    ['Region', detail.region?.name],
                    ['Owner', detail.owner],
                    ['Status', detail.operational_status],
                  ]) + '</div>',
              }] : []),
              ...(detail.assets || []).filter((a) => a.latitude != null).map((a) => ({
                lat: a.latitude,
                lng: a.longitude,
                radius: 4,
                label: a.asset_id,
                color: entityColor(maxVoltageKv(detail.voltage_levels), a.operational_status),
                popup: `<div class="tmms-pop"><b>${a.name || a.asset_id}</b> ${voltageChip(maxVoltageKv(detail.voltage_levels), { energized: isEnergized(a.operational_status) })}` +
                  `<div class="tmms-pop-sub">${a.asset_id}${a.sub_type ? ` · ${a.sub_type}` : ''}</div>` +
                  popupRows([
                    ['Type', a.asset_type],
                    ['Condition', a.condition_rating != null ? `${a.condition_rating}/10` : null],
                    ['Criticality', a.criticality],
                    ['Status', a.operational_status],
                  ]) + '</div>',
              })),
            ]}
            polygons={detail.boundary_json?.length ? [{ points: detail.boundary_json, label: `${detail.name} yard`, color: entityColor(maxVoltageKv(detail.voltage_levels), detail.operational_status), popup: `<div class="tmms-pop"><b>${detail.name} yard</b> ${voltageChip(maxVoltageKv(detail.voltage_levels), { energized: isEnergized(detail.operational_status) })}${popupRows([['Boundary', `${detail.boundary_json.length} points`], ['Fence', detail.fence_radius_m ? `${detail.fence_radius_m} m` : null]])}</div>` }] : []}
            radius={detail.fence_radius_m || 220}
            radiusLatLng={detail.latitude != null ? { lat: detail.latitude, lng: detail.longitude } : null}
            focus={detail.boundary_json?.length
              ? detail.boundary_json
              : circleCorners(detail.latitude, detail.longitude, detail.fence_radius_m || 220)}
            focusKey={detail.id}
          />
          <div className="grid grid-2 mt">
            <div>
              <div className="kv">
                <span className="k">Region</span><span>{detail.region?.name}</span>
                <span className="k">Location</span><span className="mono">{detail.latitude.toFixed(4)}, {detail.longitude.toFixed(4)}</span>
                <span className="k">Yard fence</span><span>{detail.fence_radius_m || 220} m radius · {Array.isArray(detail.boundary_json) ? `polygon (${detail.boundary_json.length} points)` : 'auto'}</span>
                <span className="k">Voltage levels</span><span>{parseVoltageLevels(detail.voltage_levels).join(', ')}</span>
                <span className="k">Type</span><span>{detail.substation_type}</span>
                <span className="k">Status</span><span><Pill value={detail.operational_status} /></span>
                <span className="k">Commissioned</span><span>{fmtDate(detail.commissioned_date)}</span>
                <span className="k">Bays</span><span>{detail.bay_count} <span className="muted">(derived from asset bay labels)</span></span>
                <span className="k">Owner</span><span>{detail.owner || '—'}</span>
              </div>
              <div className="card-head mt"><h3 className="card-title">Connected Lines</h3></div>
              {(detail.connected_lines || []).map((l) => (
                <div key={l.id} className="card card-pad mb" style={{ padding: 10 }}>
                  <a className="link" href={`/lines?highlight=${l.id}`}>{l.name}</a>
                  <span className="muted"> · {l.voltage_kv} kV · {l.length_km} km</span>
                </div>
              ))}
            </div>
            <div>
              <div className="card card-pad mb">
                <div className="card-head"><h3 className="card-title">Bays ({detailBays.length})</h3></div>
                {detailBays.length === 0 && <div className="muted">No bay labels on this substation's assets yet</div>}
                {detailBays.map((b) => (
                  <div key={b.bay} className="spread" style={{ padding: '4px 0' }}>
                    <span>{b.bay}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{b.count} asset(s)</span>
                  </div>
                ))}
              </div>
              <div className="card-head"><h3 className="card-title">Assets ({detail.assets?.length || 0})</h3></div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>Asset</th><th>Type</th><th>Condition</th></tr></thead>
                  <tbody>
                    {(detail.assets || []).map((a) => (
                      <tr key={a.id}><td className="mono">{a.asset_id}</td><td>{a.asset_type}</td><td><CondPill rating={a.condition_rating} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {form && (
        <Modal title={form.id ? `Edit — ${form.name}` : 'Add Substation'} onClose={() => setForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Substation ID</label><input value={form.substation_id || ''} onChange={(e) => setForm({ ...form, substation_id: e.target.value })} /></div>
            <div className="field"><label>Name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Region</label>
              <select value={form.region_id || ''} onChange={(e) => setForm({ ...form, region_id: Number(e.target.value) })}>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></div>
            <div className="field"><label>Voltage levels (comma-separated)</label><input value={form.voltage_levels || ''} onChange={(e) => setForm({ ...form, voltage_levels: e.target.value })} placeholder="220kV, 138kV" /></div>
            <div className="field"><label>{t('latitude')}</label><input type="number" step="0.0001" value={form.latitude ?? ''} onChange={(e) => setForm({ ...form, latitude: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>{t('longitude')}</label><input type="number" step="0.0001" value={form.longitude ?? ''} onChange={(e) => setForm({ ...form, longitude: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Elevation (m)</label><input type="number" value={form.elevation_m ?? ''} onChange={(e) => setForm({ ...form, elevation_m: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Type</label>
              <select value={form.substation_type} onChange={(e) => setForm({ ...form, substation_type: e.target.value })}>
                {['TRANSFORMER', 'SWITCHING', 'TRANSFORMER_SWITCHING', 'GAS_INSULATED', 'HVDC_CONVERTER'].map((t) => <option key={t}>{t}</option>)}
              </select></div>
            <div className="field"><label>Status</label>
              <select value={form.operational_status} onChange={(e) => setForm({ ...form, operational_status: e.target.value })}>
                {['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'UNDER_CONSTRUCTION', 'DECOMMISSIONED'].map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>Commissioned Date</label><input type="date" value={form.commissioned_date || ''} onChange={(e) => setForm({ ...form, commissioned_date: e.target.value })} /></div>
            <div className="field"><label>Fence radius (m) — yard geofence</label><input type="number" value={form.fence_radius_m ?? 220} onChange={(e) => setForm({ ...form, fence_radius_m: Number(e.target.value) })} /></div>
            <div className="field full">
              <label>Yard boundary (draw) — click map to add vertices, drag to move, click a vertex to remove</label>
              <BoundaryPicker
                polygon={Array.isArray(form.boundary_json) ? form.boundary_json : null}
                onChange={(pts) => setForm({ ...form, boundary_json: pts })}
                center={(typeof form.latitude === 'number' && typeof form.longitude === 'number') ? { lat: form.latitude, lng: form.longitude } : null}
                zoom={form.id ? 15 : 10}
                height={280}
              />
              <p className="muted" style={{ marginTop: 6 }}>
                Leave empty to auto-generate the yard polygon from the center and fence radius above.
              </p>
            </div>
            <div className="field full"><label>Owner</label><input value={form.owner || ''} onChange={(e) => setForm({ ...form, owner: e.target.value })} /></div>
            <div className="field full">
              <label>{t('pickLocation')} — {t('clickMapToSetPoint')}</label>
              <MapPicker
                value={(typeof form.latitude === 'number' && typeof form.longitude === 'number') ? { lat: form.latitude, lng: form.longitude } : null}
                onChange={(p) => setForm({ ...form, latitude: p.lat, longitude: p.lng })}
                radius={500}
                radiusLabel={t('gpsTolerance500')}
                zoom={form.id ? 13 : 9}
              />
            </div>
          </div>
          <p className="muted mt">{t('gpsNote')}</p>
        </Modal>
      )}

      {importOpen && (
        <ImportDialog
          title={t('importSubstations')}
          endpoint="/infrastructure/import/substations"
          templatePath="/infrastructure/templates/substations"
          templateName="tmms-substations-template.csv"
          regions={regions}
          columns={[
            { key: 'substation_id', label: 'ID', mono: true },
            { key: 'name', label: 'Name' },
            { key: 'region_code', label: 'Region' },
            { key: 'latitude', label: 'Lat' },
            { key: 'longitude', label: 'Lng' },
            { key: 'voltage_levels', label: 'Voltage' },
          ]}
          onClose={() => setImportOpen(false)}
          onDone={() => load()}
        />
      )}
    </>
  );
  if (embedded) return body;
  return (
    <Page title="Substations" crumbs="TMMS / Infrastructure"
      actions={actions}>
      {body}
    </Page>
  );
}
