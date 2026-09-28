import { useState } from 'react';
import { api } from '../api';
import { Modal, ErrorNote } from '../components';
import BoundaryPicker from './BoundaryPicker';
import RoutePathEditor from './RoutePathEditor';
import { t } from '../i18n';

function detectFormat(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.kmz')) return 'kmz';
  if (n.endsWith('.kml')) return 'kml';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.geojson') || n.endsWith('.json')) return 'geojson';
  return null;
}

function readFile(file, format) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    if (format === 'kmz') {
      reader.onload = () => {
        const s = String(reader.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file);
    }
  });
}

// Fields a reviewer may correct in the preview before committing. Everything
// else still flows through the normal server-side validator.
const EDITABLE = {
  substations: { substation_id: 'text', name: 'text', region_code: 'text', latitude: 'number', longitude: 'number' },
  lines: { line_id: 'text', name: 'text', voltage_kv: 'number' },
};

// Two-step bulk import backed by /infrastructure/import/*. The same dialog
// serves substations and lines; `columns` describes the preview table and
// `endpoint` the API base. Preview is mandatory so every candidate (and the
// reason it would be skipped) is reviewed — and can be corrected inline or via
// the geometry editor — before anything is written.
export default function ImportDialog({ title, endpoint, templatePath, templateName, columns, regions, onClose, onDone }) {
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState('');
  const [content, setContent] = useState(null);
  const [defaultRegionId, setDefaultRegionId] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [edits, setEdits] = useState({});
  const [geoEdit, setGeoEdit] = useState(null);

  const editable = preview ? EDITABLE[preview.kind] || {} : {};

  function setEdit(index, key, value) {
    setEdits((prev) => ({ ...prev, [index]: { ...(prev[index] || {}), [key]: value } }));
  }

  function resetEdits() {
    setEdits({});
  }

  function valueFor(row, key) {
    const e = edits[row.index] || {};
    return e[key] !== undefined ? e[key] : row[key];
  }

  async function pickFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const fmt = detectFormat(file.name);
    setError(null);
    setResult(null);
    setPreview(null);
    setNotice(null);
    setEdits({});
    if (!fmt) {
      setFileName(file.name);
      setFormat('');
      setContent(null);
      setError(t('importHint'));
      return;
    }
    try {
      const text = await readFile(file, fmt);
      setFileName(file.name);
      setFormat(fmt);
      setContent(text);
    } catch (err) {
      setError(err.message);
    }
  }

  async function downloadTemplate() {
    try {
      setError(null);
      await api.download(templatePath, templateName);
    } catch (err) {
      setError(err.message);
    }
  }

  async function runPreview() {
    if (!content || !format) {
      setError(t('importNeedFile'));
      return;
    }
    try {
      setBusy(true);
      setError(null);
      setResult(null);
      setNotice(null);
      setEdits({});
      const body = { format, content };
      if (defaultRegionId !== '') body.default_region_id = Number(defaultRegionId);
      const res = await api.post(`${endpoint}/preview`, body);
      setPreview(res);
      if (!res.will_create) setNotice(res.will_skip ? `${res.will_skip} ${t('importWillSkip')}` : null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    try {
      setBusy(true);
      setError(null);
      const body = { token: preview.token };
      if (Object.keys(edits).length) body.edits = edits;
      const res = await api.post(`${endpoint}/commit`, body);
      setResult(res);
      setPreview(null);
      if (onDone) onDone(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canCommit = !!preview && preview.will_create > 0 && !busy;
  const editedCount = Object.keys(edits).length;

  return (
    <Modal title={title} onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={downloadTemplate}>{t('importDownloadTemplate')}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        {!result && <button className="btn" disabled={busy || !content} onClick={runPreview}>{busy ? '…' : t('importPreview')}</button>}
        {!result && <button className="btn btn-primary" disabled={!canCommit} onClick={commit}>{t('importConfirm')}</button>}
        {result && <button className="btn btn-primary" onClick={onClose}>Close</button>}
      </>}>
      {error && <ErrorNote error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}

      {result ? (
        <div>
          <div className="grid grid-2 mb">
            <div className="card card-pad"><b>{t('importDone')}</b><div className="value" style={{ fontSize: 24 }}>{result.created}</div></div>
            <div className="card card-pad"><b>{t('importSkipped')}</b><div className="value" style={{ fontSize: 24 }}>{(result.skipped || []).length}</div></div>
          </div>
          {result.towers_created != null && <p className="muted">{result.towers_created} tower(s) created.</p>}
          {(result.skipped || []).length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Item</th><th>{t('importReason')}</th></tr></thead>
                <tbody>
                  {result.skipped.map((s, i) => (
                    <tr key={i}><td className="mono">{s.substation_id || s.line_id || '—'}</td><td>{s.reason}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="form-grid">
            <div className="field"><label>{t('importChooseFile')}</label>
              <input type="file" accept=".csv,.kml,.kmz,.geojson,.json" onChange={pickFile} />
              <div className="muted" style={{ fontSize: 12 }}>{fileName || t('importHint')}</div>
            </div>
            {regions && regions.length > 0 && (
              <div className="field"><label>{t('importDefaultRegion')}</label>
                <select value={defaultRegionId} onChange={(e) => { setDefaultRegionId(e.target.value); setPreview(null); setEdits({}); }}>
                  <option value="">—</option>
                  {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {preview && (
            <div className="mt">
              <div className="spread mb" style={{ gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <b>{t('importWillCreate')}: <span className="ok">{preview.will_create}</span></b>
                  {' · '}<b>{t('importWillSkip')}: <span className="bad">{preview.will_skip}</span></b>
                  {editedCount > 0 && <span className="muted"> · {editedCount} edited</span>}
                </div>
                {editedCount > 0 && <button type="button" className="btn btn-sm" onClick={resetEdits}>Reset edits</button>}
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
                Review the rows below. Edit any field inline, or open the geometry editor to adjust coordinates.
                Corrections are re-validated on commit.
              </p>
              <div className="tbl-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => <th key={c.key}>{c.label}</th>)}
                      <th>Geometry</th>
                      <th>{t('importReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.candidates.map((row) => (
                      <tr key={row.index} style={row.will_skip ? { background: '#fef2f2' } : undefined}>
                        {columns.map((c) => (
                          <td key={c.key} className={c.mono ? 'mono' : undefined}>
                            {editable[c.key] ? (
                              <input
                                type={editable[c.key] === 'number' ? 'number' : 'text'}
                                className="inline-edit"
                                value={valueFor(row, c.key) ?? ''}
                                onChange={(e) => setEdit(row.index, c.key, editable[c.key] === 'number' ? e.target.value : e.target.value)}
                              />
                            ) : formatCell(row[c.key])}
                            {edits[row.index] && edits[row.index][c.key] !== undefined && <span className="edit-dot" title="edited" />}
                          </td>
                        ))}
                        <td>
                          <button type="button" className="btn btn-sm" onClick={() => setGeoEdit(row)}>
                            {preview.kind === 'lines' ? 'Route' : 'Boundary'}
                          </button>
                        </td>
                        <td>{row.will_skip ? row.reason : <span className="ok">OK</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {geoEdit && preview && (
        <Modal title={`${geoEdit.line_id || geoEdit.substation_id || geoEdit.name} — geometry`} onClose={() => setGeoEdit(null)} wide
          footer={<button className="btn btn-primary" onClick={() => setGeoEdit(null)}>Done</button>}>
          {preview.kind === 'lines' ? (
            <LineGeometryEditor
              row={geoEdit}
              edit={edits[geoEdit.index] || {}}
              setEdit={(key, value) => setEdit(geoEdit.index, key, value)}
            />
          ) : (
            <SubstationGeometryEditor
              row={geoEdit}
              edit={edits[geoEdit.index] || {}}
              setEdit={(key, value) => setEdit(geoEdit.index, key, value)}
            />
          )}
        </Modal>
      )}
    </Modal>
  );
}

// Substation point + boundary editor.
function SubstationGeometryEditor({ row, edit, setEdit }) {
  const boundary = edit.boundary !== undefined ? edit.boundary : (row.boundary || []);
  const center = row.latitude != null && row.longitude != null ? [row.latitude, row.longitude] : undefined;
  return (
    <div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        Existing boundary: {boundary.length} vertices. Click the map to add a vertex, drag to move, click a marker to remove.
      </p>
      <BoundaryPicker polygon={boundary} onChange={(pts) => setEdit('boundary', pts)} center={center} />
      <div className="form-grid mt">
        <div className="field"><label>Latitude</label>
          <input type="number" value={(edit.latitude !== undefined ? edit.latitude : row.latitude) ?? ''} onChange={(e) => setEdit('latitude', e.target.value)} />
        </div>
        <div className="field"><label>Longitude</label>
          <input type="number" value={(edit.longitude !== undefined ? edit.longitude : row.longitude) ?? ''} onChange={(e) => setEdit('longitude', e.target.value)} />
        </div>
      </div>
    </div>
  );
}

// Line route + tower coordinate editor.
function LineGeometryEditor({ row, edit, setEdit }) {
  const route = edit.route !== undefined ? edit.route : (row.route || []);
  const towers = edit.towers !== undefined ? edit.towers : (row.towers || []);
  const center = route.length ? [route[0][0], route[0][1]] : undefined;

  function setTower(i, key, value) {
    const next = towers.map((tw, j) => (j === i ? { ...tw, [key]: value } : tw));
    setEdit('towers', next);
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        {route.length} route waypoint(s), {towers.length} tower(s) (red dots). Click the map to add waypoints.
      </p>
      <RoutePathEditor route={route} towers={towers} onChange={(pts) => setEdit('route', pts)} center={center} />
      {towers.length > 0 && (
        <div className="tbl-wrap mt" style={{ maxHeight: 220, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>Tower</th><th>Latitude</th><th>Longitude</th></tr></thead>
            <tbody>
              {towers.map((tw, i) => (
                <tr key={i}>
                  <td className="mono">{tw.tower_id || tw.tower_number || i + 1}</td>
                  <td><input type="number" className="inline-edit" value={tw.latitude ?? ''} onChange={(e) => setTower(i, 'latitude', e.target.value)} /></td>
                  <td><input type="number" className="inline-edit" value={tw.longitude ?? ''} onChange={(e) => setTower(i, 'longitude', e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatCell(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}
