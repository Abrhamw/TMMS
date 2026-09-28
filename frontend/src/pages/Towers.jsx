import { useEffect, useRef, useState } from 'react';
import { api, asArray } from '../api';
import { Page, Modal, ErrorNote, Loading, CondPill, PrintButton, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, getStoredUser } from '../auth';
import MapPicker from '../components/MapPicker';
import ViewMap from '../components/ViewMap';
import { relatedSegment, entityColor, isEnergized, voltageChip, popupRows } from '../mapFocus';
import { KpiTile } from '../components/InfraVisuals';
import { t } from '../i18n';

const blank = {
  tower_id: '', line_id: null, tower_number: '', km_marker: 0, latitude: null, longitude: null,
  tower_type: 'SUSPENSION', tower_material: 'LATTICE_STEEL', foundation_type: 'PAD', height_m: 30, corrosion_rating: 5, gps_validated: 0,
};

const TYPES = ['SUSPENSION', 'TENSION', 'ANGLE', 'TERMINAL', 'TRANSITION', 'DEAD_END'];
const MATERIALS = ['LATTICE_STEEL', 'TUBULAR_STEEL', 'CONCRETE', 'WOOD', 'COMPOSITE'];
const FOUNDATIONS = ['PAD', 'RAFT', 'PILE', 'ROCK_ANCHOR', 'GRILLAGE', 'MICRO_PILE'];
const COMPONENT_STATUSES = ['INSTALLED', 'SPARE', 'DEFECT_REPORTED', 'REPLACED', 'REMOVED'];

const blankComponent = {
  component_type: 'INSULATOR_STRING', name: '', material: 'GALVANIZED_STEEL',
  quantity: 1, unit: 'pcs', condition_rating: 8, status: 'INSTALLED', notes: '',
};

const IMPORT_TEMPLATE = [
  ['line_id', 'line_code', 'line_name', 'tower_id', 'tower_number', 'km_marker', 'latitude', 'longitude', 'tower_type', 'tower_material', 'height_m', 'corrosion_rating', 'gps_validated'],
  ['1', 'TL-NE-201', 'Northport-Meridian 220kV', 'NE-201-008', '201-008', '48.0', '35.55', '-96.85', 'SUSPENSION', 'LATTICE_STEEL', '38', '7', '1'],
  ['', 'TL-NE-501', '', 'NE-501-009', '501-009', '55.5', '35.15', '-98.20', 'TENSION', 'LATTICE_STEEL', '55', '6', '1'],
].map((r) => r.join(',')).join('\n');

function downloadTemplate() {
  const blob = new Blob([IMPORT_TEMPLATE], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tower_import_template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function Towers({ embedded }) {
  const canWrite = can(getStoredUser(), 'tower:write');
  const [rows, setRows] = useState(null);
  const [lines, setLines] = useState([]);
  const [lineFilter, setLineFilter] = useState('');
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState('table');
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [lineGeo, setLineGeo] = useState(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [towerTasks, setTowerTasks] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [compForm, setCompForm] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);
  const fileRef = useRef(null);
  const { query, setQuery, results: visibleRows } = useSearchFilter(rows);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const load = () => {
    const q = lineFilter ? `?line_id=${lineFilter}` : '';
    return api.get(`/towers${q}`).then(setRows).catch((e) => setError(e.message));
  };
  useEffect(() => {
    setPage(1);
    api.get('/lines').then((r) => setLines(r)).catch(() => {});
    api.get('/tower-component-types').then((r) => setCatalog(r)).catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineFilter]);

  function suggestId(lineId) {
    const line = lines.find((l) => l.id === Number(lineId));
    if (!line) return '';
    const prefix = String(line.line_id || '').replace(/^TL-/, '');
    const existing = (rows || []).filter((r) => r.line_id === Number(lineId));
    const max = existing.reduce((m, r) => Math.max(m, parseInt(String(r.tower_number).split('-').pop(), 10) || 0), 0);
    return `${prefix}-${String(max + 1).padStart(3, '0')}`;
  }

  async function save() {
    try {
      const body = {
        ...form,
        line_id: Number(form.line_id),
        km_marker: Number(form.km_marker) || 0,
        height_m: Number(form.height_m) || 0,
        corrosion_rating: Number(form.corrosion_rating) || 0,
        gps_validated: (typeof form.latitude === 'number' && typeof form.longitude === 'number' && form.gps_validated) ? 1 : 0,
      };
      if (form.id) await api.put(`/towers/${form.id}`, body);
      else await api.post('/towers', body);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(r) {
    try { await api.del(`/towers/${r.id}`); load(); } catch (e) { setError(e.message); }
  }

  async function openDetail(r) {
    setLineGeo(null);
    try {
      const d = await api.get(`/towers/${r.id}`);
      setDetail(d);
      if (d.line_id) api.get(`/lines/${d.line_id}`).then(setLineGeo).catch(() => {});
      api.get(`/tasks?tower_id=${d.id}`).then(setTowerTasks).catch(() => setTowerTasks([]));
    } catch (e) { setError(e.message); }
  }

  function closeDetail() {
    setDetail(null);
    setLineGeo(null);
  }

  async function saveComponent() {
    try {
      if (compForm.id) await api.put(`/tower-components/${compForm.id}`, compForm);
      else await api.post(`/towers/${detail.id}/components`, compForm);
      setCompForm(null);
      const d = await api.get(`/towers/${detail.id}`);
      setDetail(d);
      load();
    } catch (e) { setError(e.message); }
  }

  async function removeComponent(c) {
    try {
      await api.del(`/tower-components/${c.id}`);
      const d = await api.get(`/towers/${detail.id}`);
      setDetail(d);
      load();
    } catch (e) { setError(e.message); }
  }

  async function runImport() {
    const text = importText.trim();
    if (!text) { setImportError('Paste tower rows from Excel/CSV or choose a file first.'); return; }
    setImportError(null);
    setImportResult(null);
    try {
      const res = await api.post('/towers/import', { csv: text });
      setImportResult(res);
      if (res.errors && res.errors.length === 0) setImportText('');
      load();
    } catch (e) { setImportError(e.message); }
  }

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result || ''));
    reader.readAsText(f);
  }

  if (!rows) return embedded ? <Loading /> : <Page title="Towers"><Loading /></Page>;

  function towerMapProps(d, line) {
    const route = asArray(line && line.route_json);
    const seg = d.latitude != null ? relatedSegment(route, d.latitude, d.longitude) : [];
    const focus = d.latitude != null ? [[d.latitude, d.longitude], ...seg] : null;
    const kv = (d.line && d.line.voltage_kv) ?? (line && line.voltage_kv) ?? null;
    const status = (d.line && d.line.operational_status) || (line && line.operational_status) || 'OPERATIONAL';
    const lineName = (d.line && d.line.name) || (line && line.name) || null;
    const color = entityColor(kv, status);
    const markers = d.latitude != null
      ? [
        {
          lat: d.latitude,
          lng: d.longitude,
          label: d.tower_id,
          flash: true,
          color,
          popup: `<div class="tmms-pop"><b>${d.tower_id}</b> ${voltageChip(kv, { energized: isEnergized(status) })}` +
            `<div class="tmms-pop-sub">${lineName || ''}</div>` +
            popupRows([
              ['Line', lineName],
              ['Type', d.tower_type],
              ['Material', d.tower_material],
              ['km marker', d.km_marker],
              ['Height', d.height_m != null ? `${d.height_m} m` : null],
              ['Status', status],
            ]) + (d.gps_validated ? '' : '<div class="tmms-pop-warn">GPS: unvalidated</div>') + '</div>',
        },
        ...((line && line.towers) || []).filter((x) => x.latitude != null && x.id !== d.id).map((x) => ({
          lat: x.latitude,
          lng: x.longitude,
          label: x.tower_id,
          color,
          radius: 3,
          popup: `<div class="tmms-pop"><b>${x.tower_id}</b> ${voltageChip(kv, { energized: isEnergized(status) })}${popupRows([['Line', lineName], ['km marker', x.km_marker]])}</div>`,
        })),
      ]
      : [];
    const polylines = [
      ...(route.length > 1 ? [{ points: route, label: lineName || 'Related line', color, weight: 2, dashArray: '6 6' }] : []),
      ...(seg.length > 1 ? [{ points: seg, label: 'Tower line section', color: '#0ea5e9', weight: 5, dashArray: '10 6', animate: true }] : []),
    ];
    return { markers, polylines, focus };
  }

  const PAGE_SIZE = 200;
  const allRows = visibleRows;
  const pageCount = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = allRows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const actions = canWrite ? <div className="flex">
    <button className="btn" onClick={() => { setImportOpen(true); setImportText(''); setImportResult(null); setImportError(null); }}>Import (Excel/CSV)</button>{' '}
    <button className="btn btn-primary" onClick={() => {
      const lineId = lineFilter || lines[0]?.id || '';
      const id = lineId ? suggestId(lineId) : '';
      setForm({ ...blank, line_id: lineId ? Number(lineId) : null, tower_id: id, tower_number: lineId ? String(id).split('-').pop() : '' });
    }}>+ Add Tower</button>
  </div> : null;
  const body = (
    <>
      {embedded && actions && <div className="mb">{actions}</div>}
      {error && <ErrorNote error={error} />}
      {Array.isArray(rows) && (
        <div className="grid grid-3 mb">
          <KpiTile label="Towers" value={rows.length} />
          <KpiTile label="GPS validated" value={rows.filter((r) => r.gps_validated).length} />
          <KpiTile label="With condition" value={rows.filter((r) => { const c = Number(r.corrosion_rating); return Number.isFinite(c) && c > 0; }).length} />
        </div>
      )}
      <div className="filters">
        <SearchField value={query} onChange={setQuery} placeholder="Search towers…" />
        <select value={lineFilter} onChange={(e) => setLineFilter(e.target.value)}>
          <option value="">All lines</option>
          {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span className="muted">{allRows.length} towers</span>
        <span className="grow" />
        <button className={`btn btn-sm${viewMode === 'table' ? ' btn-primary' : ''}`} onClick={() => setViewMode('table')}>Table</button>
        <button className={`btn btn-sm${viewMode === 'cards' ? ' btn-primary' : ''}`} onClick={() => setViewMode('cards')}>Cards</button>
      </div>
      {pageCount > 1 && (
        <div className="filters mb">
          <button className="btn btn-sm" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Prev</button>
          <span className="muted">Page {curPage} of {pageCount}</span>
          <button className="btn btn-sm" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>Next</button>
          <span className="grow" />
          <span className="muted">Showing {pageRows.length} of {allRows.length}</span>
        </div>
      )}

      {viewMode === 'table' ? (
        <div className="card">
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>ID</th><th>Line</th><th>Number</th><th>km</th><th>Height</th><th>Type</th><th>Foundation</th><th>Material</th><th>Corrosion</th><th>Standard</th><th>Components</th><th>GPS</th><th></th></tr></thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.tower_id}</td>
                    <td>{r.line?.name || r.line_id}</td>
                    <td className="mono">{r.tower_number}</td>
                    <td>{r.km_marker}</td>
                    <td>{r.height_m} m</td>
                    <td>{r.tower_type}</td>
                    <td>{r.foundation_type || '—'}</td>
                    <td>{r.tower_material}</td>
                    <td><CondPill rating={r.corrosion_rating} /></td>
                    <td>
                      <span style={{ color: r.compliant ? '#15803d' : '#b45309', fontWeight: 600 }}>
                        {r.recorded_count ?? 0}/{r.standard_count ?? 0}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => openDetail(r)}>{r.component_count || 0} parts</button>
                    </td>
                    <td>{r.gps_validated ? <span className="ok">✓ validated</span> : <span className="bad">✗ unvalidated</span>}</td>
                    <td className="td-actions">
                      <button className="btn btn-sm" onClick={() => setForm({ ...r })}>Edit</button>{' '}
                      <ConfirmButton label="Delete" title={`Delete ${r.tower_id}?`} onConfirm={() => remove(r)} />
                    </td>
                  </tr>
                ))}
                {allRows.length === 0 && (
                  <tr><td colSpan="13" className="muted center">No towers found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid">
          {Object.entries(
            pageRows.reduce((acc, r) => {
              const key = r.line_id || 'uncategorized';
              (acc[key] = acc[key] || { name: r.line?.name || `Line #${key}`, list: [] });
              acc[key].list.push(r);
              return acc;
            }, {})
          ).map(([key, group]) => (
            <div key={key}>
              <h3 className="section-title">{group.name} <span className="muted">· {group.list.length} towers</span></h3>
              <div className="grid grid-3">
                {group.list.map((r) => (
                  <div key={r.id} className="card card-pad" style={{ borderLeft: `4px solid ${r.gps_validated ? '#15803d' : '#dc2626'}` }}>
                    <div className="spread">
                      <b className="mono">{r.tower_id}</b>
                      <button className="btn btn-sm btn-ghost" onClick={() => openDetail(r)}>{r.component_count || 0} parts</button>
                    </div>
                    <div className="kv mt" style={{ fontSize: 12, gridTemplateColumns: '110px 1fr' }}>
                      <span className="k">Type</span><span>{r.tower_type} · {r.tower_material}</span>
                      <span className="k">Foundation</span><span>{r.foundation_type || '—'}</span>
                      <span className="k">Height</span><span>{r.height_m} m</span>
                      <span className="k">km marker</span><span>{r.km_marker}</span>
                      <span className="k">Corrosion</span><span><CondPill rating={r.corrosion_rating} /></span>
                      <span className="k">GPS</span><span>{r.gps_validated ? <span className="ok">✓ validated</span> : <span className="bad">✗ unvalidated</span>}</span>
                    </div>
                    {canWrite && (
                      <div className="mt">
                        <button className="btn btn-sm" onClick={() => setForm({ ...r })}>Edit</button>{' '}
                        <ConfirmButton label="Delete" title={`Delete ${r.tower_id}?`} onConfirm={() => remove(r)} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {allRows.length === 0 && <div className="card card-pad muted center">No towers found</div>}
        </div>
      )}

      {form && (
        <Modal title={form.id ? `Edit — ${form.tower_id}` : 'Add Tower'} onClose={() => setForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Tower ID</label><input value={form.tower_id || ''} onChange={(e) => setForm({ ...form, tower_id: e.target.value })} /></div>
            <div className="field"><label>Line</label>
              <select value={form.line_id || ''} onChange={(e) => {
                const lid = Number(e.target.value);
                setForm({ ...form, line_id: lid, tower_id: suggestId(lid), tower_number: String(suggestId(lid)).split('-').pop() });
              }}>
                <option value="">Select line</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
            <div className="field"><label>Number</label><input value={form.tower_number || ''} onChange={(e) => setForm({ ...form, tower_number: e.target.value })} /></div>
            <div className="field"><label>km marker</label><input type="number" step="0.1" value={form.km_marker ?? ''} onChange={(e) => setForm({ ...form, km_marker: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>Height (m)</label><input type="number" step="0.5" value={form.height_m ?? ''} onChange={(e) => setForm({ ...form, height_m: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>Type</label>
              <select value={form.tower_type} onChange={(e) => setForm({ ...form, tower_type: e.target.value })}>
                {TYPES.map((x) => <option key={x}>{x}</option>)}
              </select></div>
            <div className="field"><label>Material</label>
              <select value={form.tower_material} onChange={(e) => setForm({ ...form, tower_material: e.target.value })}>
                {MATERIALS.map((x) => <option key={x}>{x}</option>)}
              </select></div>
            <div className="field"><label>Foundation</label>
              <select value={form.foundation_type || 'PAD'} onChange={(e) => setForm({ ...form, foundation_type: e.target.value })}>
                {FOUNDATIONS.map((x) => <option key={x}>{x}</option>)}
              </select></div>
            <div className="field"><label>Corrosion rating (0-10)</label>
              <input type="number" min="0" max="10" value={form.corrosion_rating ?? ''} onChange={(e) => setForm({ ...form, corrosion_rating: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>{t('latitude')}</label><input type="number" step="0.0001" value={form.latitude ?? ''} onChange={(e) => setForm({ ...form, latitude: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>{t('longitude')}</label><input type="number" step="0.0001" value={form.longitude ?? ''} onChange={(e) => setForm({ ...form, longitude: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field full">
              <label>{t('pickLocation')} — {t('clickMapToSetPoint')}</label>
              <MapPicker
                value={(typeof form.latitude === 'number' && typeof form.longitude === 'number') ? { lat: form.latitude, lng: form.longitude } : null}
                onChange={(p) => setForm({ ...form, latitude: p.lat, longitude: p.lng })}
                radius={50}
                radiusLabel="Tower GPS tolerance"
                zoom={form.id ? 14 : 10}
              />
            </div>
          </div>
          <p className="muted mt">{t('gpsNote')}</p>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.tower_id} — components & parts`} onClose={closeDetail} wide printable
          footer={canWrite ? <>
            <PrintButton />
            <button className="btn" disabled={resetBusy} onClick={async () => {
              setResetBusy(true);
              try {
                await api.post(`/towers/${detail.id}/reset-components`, {});
                setDetail(await api.get(`/towers/${detail.id}`));
                load();
              } catch (e) { setError(e.message); }
              finally { setResetBusy(false); }
            }}>{resetBusy ? 'Resetting…' : 'Reset to standard'}</button>
            <button className="btn" onClick={() => setCompForm({ ...blankComponent })}>+ Add part</button>
            <button className="btn btn-primary" onClick={closeDetail}>Close</button>
          </> : <><PrintButton /><button className="btn btn-primary" onClick={closeDetail}>Close</button></>}>
          {detail.latitude != null && (
            <ViewMap
              height={200}
              center={{ lat: detail.latitude, lng: detail.longitude }}
              focusKey={detail.id}
              {...towerMapProps(detail, lineGeo)}
            />
          )}
          <div className="grid grid-2 mb">
            <div className="kv">
              <span className="k">Line</span><span>{detail.line?.name || detail.line_id}</span>
              <span className="k">Type</span><span>{detail.tower_type} · {detail.tower_material}</span>
              <span className="k">Foundation</span><span>{detail.foundation_type || '—'}</span>
              <span className="k">km marker</span><span>{detail.km_marker}</span>
              <span className="k">Height</span><span>{detail.height_m} m</span>
              <span className="k">Position</span><span className="mono">{detail.latitude}, {detail.longitude}</span>
              <span className="k">Corrosion</span><span><CondPill rating={detail.corrosion_rating} /></span>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              Standard transmission-tower component register. Each tower carries the full set of
              structure, insulation, hardware and fitting parts (per utility practice). Update
              quantities, material, condition and status as parts are inspected or replaced.
            </p>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Part</th><th>Description</th><th>Material</th><th>Qty</th><th>Unit</th><th>Condition</th><th>Status</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {(detail.components || []).map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.component_type}</td>
                    <td>{c.name}</td>
                    <td>{c.material}</td>
                    <td>{c.quantity}</td>
                    <td>{c.unit}</td>
                    <td><CondPill rating={c.condition_rating} /></td>
                    <td>{c.status}</td>
                    <td>{c.notes || '—'}</td>
                    <td className="td-actions">
                      {canWrite && <>
                        <button className="btn btn-sm" onClick={() => setCompForm({ ...c })}>Edit</button>{' '}
                        <ConfirmButton label="Delete" title={`Delete ${c.component_type}?`} onConfirm={() => removeComponent(c)} />
                      </>}
                    </td>
                  </tr>
                ))}
                {(detail.components || []).length === 0 && (
                  <tr><td colSpan="9" className="muted center">No parts recorded for this tower</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {detail.compliance && (
            <>
              <h4 className="section-title mt">Standard parts for {detail.compliance.tower_type}</h4>
              <div className="muted" style={{ fontSize: 13 }}>
                Recorded {detail.compliance.recorded_count} of {detail.compliance.standard_count} standard parts.
                {detail.compliance.compliant ? ' Compliant.' : ''}
              </div>
              {detail.compliance.missing.length > 0 && (
                <div style={{ color: '#b45309', fontSize: 13 }}>Missing: {detail.compliance.missing.join(', ')}</div>
              )}
              {detail.compliance.extra.length > 0 && (
                <div style={{ color: '#b45309', fontSize: 13 }}>Extra: {detail.compliance.extra.join(', ')}</div>
              )}
              {detail.compliance.qty_mismatches.map((m) => (
                <div key={m.component_type} style={{ color: '#b45309', fontSize: 13 }}>
                  {m.component_type}: expected {m.expected}, recorded {m.actual}
                </div>
              ))}
            </>
          )}
          <h4 className="section-title mt">Related tasks <span className="muted">({towerTasks.length})</span></h4>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Task</th><th>Status</th><th>Due</th><th></th></tr></thead>
              <tbody>
                {(towerTasks || []).map((tk) => (
                  <tr key={tk.id}>
                    <td><b>{tk.task_number}</b><br /><span className="muted">{tk.title}</span></td>
                    <td>{tk.status}</td>
                    <td>{tk.due_date ? new Date(tk.due_date).toLocaleDateString() : '—'}</td>
                    <td><a className="btn btn-sm" href={`/tasks/${tk.id}`}>Open</a></td>
                  </tr>
                ))}
                {(towerTasks || []).length === 0 && <tr><td colSpan={4} className="empty">No maintenance tasks target this tower</td></tr>}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {compForm && (
        <Modal title={compForm.id ? `Edit — ${compForm.component_type}` : 'Add part'} onClose={() => setCompForm(null)}
          footer={<>
            <button className="btn" onClick={() => setCompForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveComponent}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Part type</label>
              <select value={compForm.component_type} onChange={(e) => {
                const cat = catalog.find((c) => c.type === e.target.value);
                setCompForm({ ...compForm, component_type: e.target.value, name: cat ? cat.name : compForm.name });
              }}>
                {catalog.map((c) => <option key={c.type} value={c.type}>{c.type} — {c.name}</option>)}
              </select></div>
            <div className="field"><label>Name / description</label><input value={compForm.name || ''} onChange={(e) => setCompForm({ ...compForm, name: e.target.value })} /></div>
            <div className="field"><label>Material</label><input value={compForm.material || ''} onChange={(e) => setCompForm({ ...compForm, material: e.target.value })} /></div>
            <div className="field"><label>Quantity</label><input type="number" min="0" value={compForm.quantity ?? ''} onChange={(e) => setCompForm({ ...compForm, quantity: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>Unit</label><input value={compForm.unit || ''} onChange={(e) => setCompForm({ ...compForm, unit: e.target.value })} /></div>
            <div className="field"><label>Condition (0-10)</label>
              <input type="number" min="0" max="10" value={compForm.condition_rating ?? ''} onChange={(e) => setCompForm({ ...compForm, condition_rating: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>Status</label>
              <select value={compForm.status} onChange={(e) => setCompForm({ ...compForm, status: e.target.value })}>
                {COMPONENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select></div>
            <div className="field full"><label>Notes</label><input value={compForm.notes || ''} onChange={(e) => setCompForm({ ...compForm, notes: e.target.value })} /></div>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title="Import towers from Excel / CSV" onClose={() => setImportOpen(false)} wide
          footer={<>
            <button className="btn" onClick={() => setImportOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={runImport}>Import</button>
          </>}>
          <div className="flex mb" style={{ justifyContent: 'space-between' }}>
            <p className="muted" style={{ margin: 0, maxWidth: 560 }}>
              Standard practice: prepare tower lists offline in Excel (or any spreadsheet),
              then paste the selected cells below or load a CSV file. Tab and comma separated
              data are both accepted. Rows for towers that already exist are updated in place.
            </p>
            <button className="btn" onClick={downloadTemplate}>Download template</button>
          </div>
          <div className="mb">
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: 'none' }} onChange={onFile} />
            <button className="btn" onClick={() => fileRef.current && fileRef.current.click()}>Choose CSV file…</button>
          </div>
          <textarea
            className="mono"
            rows={8}
            placeholder="tower_id,line_id,km_marker,latitude,longitude,tower_type,height_m,corrosion_rating&#10;NE-201-008,1,48.0,35.55,-96.85,SUSPENSION,38,7"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
          />
          <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Supported columns: line_id / line_code / line_name (one required), tower_id, tower_number,
            km_marker (or km), latitude (or lat), longitude (or lng/lon), tower_type, tower_material,
            height_m, corrosion_rating, gps_validated.
          </p>
          {importError && <ErrorNote error={importError} />}
          {importResult && (
            <div className="alert alert-success" style={{ whiteSpace: 'pre-wrap' }}>
              Created {importResult.created} tower(s), updated {importResult.updated}.
              {importResult.errors.length > 0
                ? `\nSkipped ${importResult.errors.length} row(s):\n` + importResult.errors.map((e) => `  row ${e.row}: ${e.error}`).join('\n')
                : ''}
            </div>
          )}
        </Modal>
      )}
    </>
  );
  if (embedded) return body;
  return (
    <Page title="Towers" crumbs="TMMS / Infrastructure"
      actions={actions}>
      {body}
    </Page>
  );
}
