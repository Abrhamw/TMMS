import { useEffect, useState } from 'react';
import { api } from '../api';
import { Page, Pill, Modal, ErrorNote, Loading, PrintButton, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import MapPicker from '../components/MapPicker';
import BoundaryPicker from '../components/BoundaryPicker';
import ViewMap from '../components/ViewMap';
import { circleCorners, entityColor, maxVoltageKv, isEnergized, parseVoltageLevels, voltageChip, popupRows } from '../mapFocus';
import { KpiTile } from '../components/InfraVisuals';
import { t } from '../i18n';

const blank = { code: '', name: '', type: 'CUSTOM', status: 'ACTIVE', center_lat: null, center_lng: null, boundary: 1.5, timezone: 'UTC', contact_phone: '', contact_email: '', notes: '', boundary_json: null };

export default function Regions({ embedded }) {
  const canWrite = can(getStoredUser(), 'region:write');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailSubs, setDetailSubs] = useState([]);
  const { query, setQuery, results } = useSearchFilter(rows);

  const load = () => api.get('/regions').then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function openDetail(r) {
    setDetail(r);
    setDetailSubs([]);
    try { setDetailSubs(await api.get(`/substations?region_id=${r.id}`)); } catch (_) { /* non-fatal */ }
  }

  async function save() {
    try {
      const body = { ...form };
      if (Array.isArray(form.boundary_json) && form.boundary_json.length >= 3) {
        body.boundary_json = form.boundary_json;
      } else {
        delete body.boundary_json;
      }
      if (form.id) await api.put(`/regions/${form.id}`, body);
      else await api.post('/regions', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(r) {
    try {
      await api.del(`/regions/${r.id}`);
      load();
    } catch (e) {
      if (String(e.message || '').startsWith('Cannot delete:')) {
        if (window.confirm(`${e.message}.\n\nDelete anyway? This removes the region's substations, lines, towers, assets and unlinks its crews.`)) {
          try {
            await api.del(`/regions/${r.id}?force=1`);
            load();
            setError(null);
          } catch (e2) { setError(e2.message); }
        }
      } else {
        setError(e.message);
      }
    }
  }

  if (!rows) return embedded ? <Loading /> : <Page title="Regions"><Loading /></Page>;

  const actions = canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blank })}>+ Add Region</button> : null;
  const body = (
    <>
      {embedded && actions && <div className="mb">{actions}</div>}
      {error && <ErrorNote error={error} />}
      {Array.isArray(rows) && (
        <div className="grid grid-4 mb">
          <KpiTile label="Regions" value={rows.length} />
          <KpiTile label="Substations" value={rows.reduce((a, r) => a + (Number(r.substation_count) || 0), 0)} />
          <KpiTile label="Lines" value={rows.reduce((a, r) => a + (Number(r.line_count) || 0), 0)} />
          <KpiTile label="Open tasks" value={rows.reduce((a, r) => a + (Number(r.open_task_count) || 0), 0)} />
        </div>
      )}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search regions…" />
        <span className="muted" style={{ fontSize: 12 }}>{results.length} of {rows.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Status</th><th>Substations</th><th>Lines</th><th>Crews</th><th>Open Tasks</th><th></th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><a className="link" href={`/map?region=${r.code}`}>{r.code}</a></td>
                  <td><b>{r.name}</b></td>
                  <td>{r.type}</td>
                  <td><Pill value={r.status} /></td>
                  <td>{r.substation_count}</td>
                  <td>{r.line_count}</td>
                  <td>{r.crew_count}</td>
                  <td>{r.open_task_count}</td>
                  <td className="td-actions">
                    <button className="btn btn-sm" onClick={() => { openDetail(r); }}>View</button>{' '}
                    <button className="btn btn-sm" onClick={() => setForm({ ...r, boundary_json: Array.isArray(r.boundary_json) ? r.boundary_json : null })}>Edit</button>{' '}
                    <ConfirmButton label="Delete" title={`Delete ${r.name}?`} onConfirm={() => remove(r)} />
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan="9" className="muted center">{query ? 'No regions match your search' : 'No regions found'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <Modal title={`Region — ${detail.name}`} onClose={() => setDetail(null)} printable
          footer={<>
            <PrintButton />
            <button className="btn" onClick={() => setDetail(null)}>Close</button>
          </>}>
          <ViewMap
            height={240}
            center={detail.center_lat != null ? { lat: detail.center_lat, lng: detail.center_lng } : null}
            markers={[
              ...(detail.center_lat != null ? [{ lat: detail.center_lat, lng: detail.center_lng, label: detail.name, sub: 'Region center', color: '#14532d', flash: true }] : []),
              ...(detailSubs || []).filter((s) => s.latitude != null).map((s) => ({
                lat: s.latitude,
                lng: s.longitude,
                label: s.name,
                color: entityColor(maxVoltageKv(s.voltage_levels), s.operational_status),
                popup: `<div class="tmms-pop"><b>${s.name}</b> ${voltageChip(maxVoltageKv(s.voltage_levels), { energized: isEnergized(s.operational_status) })}` +
                  `<div class="tmms-pop-sub">${s.substation_id || ''}</div>` +
                  popupRows([
                    ['Voltage', parseVoltageLevels(s.voltage_levels).join(', ') || null],
                    ['Type', s.substation_type],
                    ['Status', s.operational_status],
                  ]) + '</div>',
              })),
            ]}
            polygons={detail.boundary_json?.length ? [{ points: detail.boundary_json, label: `${detail.name} boundary`, color: '#2563eb' }] : []}
            radius={detail.boundary ? Number(detail.boundary) * 111320 : null}
            radiusLatLng={detail.center_lat != null ? { lat: detail.center_lat, lng: detail.center_lng } : null}
            focus={detail.boundary_json?.length
              ? detail.boundary_json
              : circleCorners(detail.center_lat, detail.center_lng, Number(detail.boundary || 0) * 111320)}
            focusKey={detail.id}
          />
          <div className="kv mt">
            <span className="k">Code</span><span className="mono">{detail.code}</span>
            <span className="k">Type</span><span>{detail.type}</span>
            <span className="k">Status</span><span><Pill value={detail.status} /></span>
            <span className="k">Center</span><span className="mono">{detail.center_lat}, {detail.center_lng}</span>
            <span className="k">Boundary</span><span>{detail.boundary}° radius · polygon {Array.isArray(detail.boundary_json) ? `(${detail.boundary_json.length} points)` : '(auto)'}</span>
            <span className="k">Manager</span><span>{detail.region_manager_person_id ? detail.region_manager_person_id : '—'}</span>
            <span className="k">Contact</span><span>{detail.contact_phone || '—'} {detail.contact_email || ''}</span>
            <span className="k">Timezone</span><span>{detail.timezone}</span>
            <span className="k">Notes</span><span>{detail.notes || '—'}</span>
          </div>
        </Modal>
      )}

      {form && (
        <Modal title={form.id ? `Edit Region — ${form.code}` : 'Add Region'} onClose={() => setForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Code</label><input value={form.code || ''} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="NE" /></div>
            <div className="field"><label>Name</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {['NORTHERN', 'SOUTHERN', 'EASTERN', 'WESTERN', 'CENTRAL', 'CUSTOM'].map((t) => <option key={t}>{t}</option>)}
              </select></div>
            <div className="field"><label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {['ACTIVE', 'INACTIVE', 'PLANNING'].map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field"><label>{t('latitude')}</label><input type="number" step="0.0001" value={form.center_lat ?? ''} onChange={(e) => setForm({ ...form, center_lat: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>{t('longitude')}</label><input type="number" step="0.0001" value={form.center_lng ?? ''} onChange={(e) => setForm({ ...form, center_lng: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field full">
              <label>{t('pickLocation')} — {t('clickMapToSetPoint')}</label>
              <MapPicker
                value={(typeof form.center_lat === 'number' && typeof form.center_lng === 'number') ? { lat: form.center_lat, lng: form.center_lng } : null}
                onChange={(p) => setForm({ ...form, center_lat: p.lat, center_lng: p.lng })}
                radius={Number(form.boundary || 0) * 111320}
                radiusLabel={`${t('boundaryRadius')} ≈ ${Math.round(Number(form.boundary || 0) * 111.32)} km`}
                zoom={form.id ? 8 : 6}
              />
            </div>
            <div className="field"><label>Boundary (deg)</label><input type="number" step="0.1" value={form.boundary} onChange={(e) => setForm({ ...form, boundary: Number(e.target.value) })} /></div>
            <div className="field full">
              <label>Geographic boundary (draw) — click map to add vertices, drag to move, click a vertex to remove</label>
              <BoundaryPicker
                polygon={Array.isArray(form.boundary_json) ? form.boundary_json : null}
                onChange={(pts) => setForm({ ...form, boundary_json: pts })}
                center={(typeof form.center_lat === 'number' && typeof form.center_lng === 'number') ? { lat: form.center_lat, lng: form.center_lng } : null}
                zoom={form.id ? 9 : 6}
                height={280}
              />
              <p className="muted" style={{ marginTop: 6 }}>
                Leave empty to auto-generate a polygon from the center and boundary radius above.
              </p>
            </div>
            <div className="field"><label>Timezone</label><input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></div>
            <div className="field"><label>Contact Phone</label><input value={form.contact_phone || ''} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} /></div>
            <div className="field"><label>Contact Email</label><input value={form.contact_email || ''} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} /></div>
            <div className="field full"><label>Notes</label><textarea value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </>
  );
  if (embedded) return body;
  return (
    <Page title="Regions" crumbs="TMMS / Infrastructure"
      actions={actions}>
      {body}
    </Page>
  );
}
