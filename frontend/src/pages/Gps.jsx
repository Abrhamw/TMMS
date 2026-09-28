import { useEffect, useState } from 'react';
import { api, fmtDate, asArray } from '../api';
import { Page, Pill, Modal, ErrorNote, Loading, StatCard, ConfirmButton, SearchField, useSearchFilter } from '../components';
import { can, isGlobal, getStoredUser } from '../auth';
import MapPicker, { getDevicePosition } from '../components/MapPicker';
import PolygonEditor from '../components/PolygonEditor';
import Comments from '../components/Comments';
import { t } from '../i18n';

const blankVal = {
  target_type: 'SUBSTATION', target_id: '', expected_lat: null, expected_lng: null,
  measured_lat: null, measured_lng: null, accuracy_m: 5, validation_method: 'GPS_DEVICE', notes: '',
};

const blankFence = {
  name: '', target_type: 'REGION', target_id: '', center_lat: null, center_lng: null,
  radius_m: 500, tolerance_m: 50, is_active: 1, region_id: '', boundary_json: null,
};

const GEOFENCE_TARGETS = ['REGION', 'SUBSTATION', 'LINE', 'TOWER', 'ASSET'];

const TOLERANCE = 500;

const REVIEW_LABEL = {
  OPEN: 'Open', ACKNOWLEDGED: 'Acknowledged', RESOLVED: 'Resolved', REJECTED: 'Rejected', NOT_REQUIRED: '—',
};

const VIOLATION_LABEL = {
  OUTSIDE_REGION_BOUNDARY: 'Outside region boundary',
  OUTSIDE_SUBSTATION_BOUNDARY: 'Outside substation boundary',
  OUTSIDE_GEOFENCE: 'Outside geofence',
  OUT_OF_TOLERANCE: 'Out of tolerance',
};

const insideLabel = (b) => (b === null || b === undefined ? 'n/a' : b ? 'inside' : 'outside');

const haversineM = (la1, lo1, la2, lo2) => {
  const R = 6371000;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLng = ((lo2 - lo1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

export default function Gps() {
  const canWrite = can(getStoredUser(), 'gps:write');
  const canManageFence = can(getStoredUser(), 'geofence:write');
  const canReview = can(getStoredUser(), 'gps:review');
  const globalUser = isGlobal(getStoredUser());
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [violations, setViolations] = useState([]);
  const [geofences, setGeofences] = useState(null);
  const [subs, setSubs] = useState([]);
  const [assets, setAssets] = useState([]);
  const [lines, setLines] = useState([]);
  const [towers, setTowers] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [filter, setFilter] = useState('');
  const [vFilter, setVFilter] = useState('');
  const [correct, setCorrect] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsMsg, setGpsMsg] = useState(null);
  const [regions, setRegions] = useState([]);
  const [fenceForm, setFenceForm] = useState(null);
  const [fenceMode, setFenceMode] = useState('circle');
  const [fenceBusy, setFenceBusy] = useState(false);
  const { query: qViol, setQuery: setQViol, results: violRows } = useSearchFilter(violations);
  const { query: qRec, setQuery: setQRec, results: recRows } = useSearchFilter(rows);

  const load = () => {
    const q = filter ? `?result=${filter}` : '';
    api.get(`/gps-validations${q}`).then(setRows).catch((e) => setError(e.message));
    api.get('/gps-summary').then(setSummary).catch(() => {});
    api.get(`/violations${vFilter ? `?review_status=${vFilter}` : ''}`).then(setViolations).catch(() => {});
    api.get('/geofences').then(setGeofences).catch(() => {});
  };
  useEffect(() => {
    load();
    api.get('/substations').then(setSubs).catch(() => {});
    api.get('/assets?brief=1').then(setAssets).catch(() => {});
    api.get('/lines').then(setLines).catch(() => {});
    api.get('/towers?brief=1').then(setTowers).catch(() => {});
    api.get('/regions').then(setRegions).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, vFilter]);

  // Live, server-side feedback for the capture form (identical logic to save).
  useEffect(() => {
    const p = form;
    if (!p || p.target_id === '' || p.expected_lat == null || p.expected_lng == null || p.measured_lat == null || p.measured_lng == null) {
      setPreview(null);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.preview('/gps-validations/preview', {
        target_type: p.target_type,
        target_id: p.target_id,
        expected_lat: Number(p.expected_lat),
        expected_lng: Number(p.expected_lng),
        measured_lat: Number(p.measured_lat),
        measured_lng: Number(p.measured_lng),
        tolerance_m: p.tolerance_m,
      }).then((r) => { if (alive) setPreview(r); }).catch(() => { if (alive) setPreview(null); });
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [form?.target_type, form?.target_id, form?.expected_lat, form?.expected_lng, form?.measured_lat, form?.measured_lng, form?.tolerance_m]);

  async function submit() {
    try {
      await api.post('/gps-validations', form);
      setForm(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function doCorrect() {
    try {
      await api.post('/gps-validations/correct', correct);
      setCorrect(null);
      load();
    } catch (e) { setError(e.message); }
  }

  async function saveFence() {
    setFenceBusy(true);
    try {
      const poly = fenceMode === 'polygon' && Array.isArray(fenceForm.boundary_json) && fenceForm.boundary_json.length >= 3
        ? fenceForm.boundary_json
        : null;
      const body = {
        name: fenceForm.name,
        target_type: fenceForm.target_type,
        target_id: fenceForm.target_type !== 'REGION' && fenceForm.target_id !== '' && fenceForm.target_id != null
          ? Number(fenceForm.target_id) : null,
        boundary_json: poly,
        tolerance_m: Number(fenceForm.tolerance_m),
        is_active: fenceForm.is_active ? 1 : 0,
        region_id: fenceForm.region_id === '' || fenceForm.region_id == null ? null : Number(fenceForm.region_id),
      };
      if (!poly || fenceForm.center_lat != null) {
        body.center_lat = Number(fenceForm.center_lat);
        body.center_lng = Number(fenceForm.center_lng);
      }
      if (!poly || fenceForm.radius_m != null) body.radius_m = Number(fenceForm.radius_m);
      if (fenceForm.id) await api.put(`/geofences/${fenceForm.id}`, body);
      else await api.post('/geofences', body);
      setFenceForm(null);
      load();
    } catch (e) { setError(e.message); }
    finally { setFenceBusy(false); }
  }

  async function doReview(action) {
    setReviewBusy(true);
    try {
      const updated = await api.post(`/gps-validations/${review.id}/review`, { action, note: reviewNote });
      setReview({ ...review, ...updated, reviewer: updated.reviewed_by ? review.reviewer : null });
      setReviewNote('');
      load();
    } catch (e) { setError(e.message); }
    finally { setReviewBusy(false); }
  }

  function openFence(g) {
    const boundary = Array.isArray(g.boundary_json) && g.boundary_json.length >= 3 ? g.boundary_json : null;
    setFenceMode(boundary ? 'polygon' : 'circle');
    setFenceForm({
      id: g.id, name: g.name, target_type: g.target_type, target_id: g.target_id ?? '',
      center_lat: g.center_lat, center_lng: g.center_lng,
      radius_m: g.radius_m, tolerance_m: g.tolerance_m ?? 50,
      is_active: g.is_active ? 1 : 0, region_id: g.region_id ?? '',
      boundary_json: boundary,
    });
  }

  const regionBoundary = (id) => {
    const r = regions.find((x) => x.id === Number(id));
    return Array.isArray(r?.boundary_json) && r.boundary_json.length >= 3 ? r.boundary_json : null;
  };

  async function removeFence(g) {
    try {
      await api.del(`/geofences/${g.id}`);
      load();
    } catch (e) { setError(e.message); }
  }

  const regionName = (id) => (regions.find((r) => r.id === id) || {}).name || (id ? `#${id}` : 'All regions');
  const regionCenter = (id) => {
    const r = regions.find((x) => x.id === Number(id));
    return r && r.center_lat != null && r.center_lng != null ? { lat: r.center_lat, lng: r.center_lng } : { lat: 9.0, lng: 39.0 };
  };
  const newFence = () => {
    setFenceMode('circle');
    setFenceForm({
      ...blankFence,
      region_id: !globalUser && regions.length ? String(regions[0].id) : '',
    });
  };

  const targetLabel = (type, id) => {
    if (id == null) return '—';
    const o = optionsFor(type).find((x) => x.id === Number(id));
    return o ? o.name : `#${id}`;
  };

  const optionsFor = (t) => {
    if (t === 'SUBSTATION') return subs.map((s) => ({ id: s.id, name: s.name, lat: s.latitude, lng: s.longitude }));
    if (t === 'ASSET') return assets.filter((a) => a.latitude !== null && a.latitude !== undefined).map((a) => ({ id: a.id, name: a.name, lat: a.latitude, lng: a.longitude }));
    if (t === 'TOWER') return towers.map((x) => ({ id: x.id, name: x.tower_id, lat: x.latitude, lng: x.longitude }));
    if (t === 'LINE') return lines.map((l) => {
      const route = asArray(l.route_json);
      const mid = route.length ? route[Math.floor(route.length / 2)] : (l.from_substation ? [l.from_substation.latitude, l.from_substation.longitude] : null);
      return { id: l.id, name: l.name, lat: mid ? mid[0] : null, lng: mid ? mid[1] : null };
    }).filter((x) => x.lat !== null && x.lat !== undefined);
    return [];
  };

  async function captureDevice() {
    setGpsBusy(true);
    setGpsMsg(null);
    try {
      const p = await getDevicePosition();
      setForm((f) => ({ ...f, measured_lat: p.lat, measured_lng: p.lng, accuracy_m: p.accuracy || 5 }));
      setGpsMsg({ ok: true, text: `${t('coordinates')}: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} · ${t('accuracy')}: ${p.accuracy || '?'} m` });
    } catch (e) {
      setGpsMsg({ ok: false, text: e.message });
    } finally {
      setGpsBusy(false);
    }
  }

  if (!rows || !summary) return <Page title="GPS Validation"><Loading /></Page>;

  return (
    <Page title="GPS Validation" crumbs="TMMS / Validation & Compliance"
      actions={canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blankVal })}>+ Record Validation</button> : null}>
      {error && <ErrorNote error={error} />}

      <div className="grid grid-4">
        <StatCard label="Total Validations" value={summary.total_validations} />
        <StatCard label="Pass Rate" value={`${summary.pass_rate}%`} color="#16a34a" />
        <StatCard label="Asset Coverage" value={(() => { const a = summary.by_type?.find((x) => x.target_type === 'ASSET'); return a ? `${a.coverage}%` : '—'; })()} sub="of assets GPS-validated" />
        <StatCard label="Open Violations" value={summary.reviews?.open ?? violations.length} color={summary.reviews?.open ? '#dc2626' : undefined} sub={`${geofences?.length || 0} geofences`} />
      </div>

      <div className="grid grid-2 mt">
        <div className="card card-pad">
          <div className="card-head"><h3 className="card-title">Coverage by Target Type</h3></div>
          {(summary.by_type || []).map((t) => (
            <div key={t.target_type} className="mb">
              <div className="flex space-b" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <span>{t.target_type}</span><b>{t.validated}/{t.total} · {t.coverage}%</b>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${t.coverage}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="card card-pad">
          <div className="card-head"><h3 className="card-title">Coverage by Region</h3></div>
          {(summary.by_region || []).map((r) => (
            <div key={r.region} className="mb">
              <div className="flex space-b" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <span>{r.region}</span><b>{r.validated}/{r.total} · {r.coverage}%</b>
              </div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${r.coverage}%` }} /></div>
            </div>
          ))}
        </div>
      </div>

      <h3 className="section-title">Violations <span className="muted">— never-missed GPS violations surfaced for review</span></h3>
      <div className="filters">
        <SearchField value={qViol} onChange={setQViol} placeholder="Search violations…" />
        <select value={vFilter} onChange={(e) => setVFilter(e.target.value)}>
          <option value="">All review states</option>
          <option value="OPEN">Open</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="RESOLVED">Resolved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <span className="muted" style={{ fontSize: 12 }}>{violRows.length} of {violations.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Target</th><th>Violation</th><th>Distance</th><th>Geofence</th><th>Review</th><th>Region</th><th>Linked task</th><th></th></tr></thead>
            <tbody>
              {violRows.map((v) => (
                <tr key={v.id}>
                  <td className="nowrap">{fmtDate(v.validated_at)}</td>
                  <td>{v.target_type}: <b>{v.target?.name || v.target?.asset_id || v.target?.tower_id || v.target_id}</b></td>
                  <td>{VIOLATION_LABEL[v.violation] || <Pill value={v.result} />}</td>
                  <td className="mono">{Math.round(v.distance_m)} m <span className="muted">/ tol {v.tolerance_m} m</span></td>
                  <td>{v.inside_geofence === 1 ? <span className="ok">✓</span> : v.inside_geofence === 0 ? <span className="bad">✗ out</span> : '—'}</td>
                  <td><span className={`review-badge review-${v.review_status || 'NOT_REQUIRED'}`}>{REVIEW_LABEL[v.review_status] || '—'}</span></td>
                  <td>{v.region?.code || '—'}</td>
                  <td>{v.linked_task_id ? <a href={`/tasks/${v.linked_task_id}`} className="link">TK-{v.linked_task_id}</a> : '—'}</td>
                  <td className="nowrap"><button className="btn btn-sm" onClick={() => { setReview(v); setReviewNote(v.review_note || ''); }}>{canReview ? 'Review' : 'Details'}</button></td>
                </tr>
              ))}
              {violRows.length === 0 && <tr><td colSpan="9" className="muted center">{qViol ? 'No violations match your search.' : 'No violations on record.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <h3 className="section-title">Validation Records</h3>
      <div className="filters">
        <SearchField value={qRec} onChange={setQRec} placeholder="Search validation records…" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All results</option>
          <option value="PASS">PASS</option>
          <option value="FAIL">FAIL</option>
          <option value="MANUAL_REVIEW">MANUAL_REVIEW</option>
        </select>
        <span className="muted" style={{ fontSize: 12 }}>{recRows.length} of {rows.length}</span>
      </div>
      <div className="card">
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Target</th><th>Result</th><th>Distance</th><th>Tolerance</th><th>Method</th><th>Validator</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {recRows.map((v) => (
                <tr key={v.id}>
                  <td className="nowrap">{fmtDate(v.validated_at)}</td>
                  <td>{v.target_type}: <b>{v.target?.name || v.target?.substation_id || v.target?.line_id || v.target_id}</b></td>
                  <td><Pill value={v.result} /></td>
                  <td className="mono">{v.distance_m} m</td>
                  <td className="mono">{v.tolerance_m} m</td>
                  <td>{v.validation_method}</td>
                  <td>{v.validator ? `${v.validator.first_name} ${v.validator.last_name}` : '—'}</td>
                  <td className="muted">{v.notes || '—'}</td>
                  <td>{v.result === 'FAIL' && v.target ? (
                    <button className="btn btn-sm" onClick={() => setCorrect({ target_type: v.target_type, target_id: v.target_id, name: v.target?.name || v.target?.substation_id || v.target_id, lat: v.target.latitude, lng: v.target.longitude, new_lat: v.measured_lat, new_lng: v.measured_lng })}>Correct</button>
                  ) : null}</td>
                </tr>
              ))}
              {recRows.length === 0 && <tr><td colSpan="9" className="muted center">{qRec ? 'No records match your search.' : 'No validation records.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="spread" style={{ alignItems: 'baseline' }}>
        <h3 className="section-title">Geofences <span className="muted">— circle, polygon or route-corridor fences evaluated on every GPS validation</span></h3>
        {canManageFence && (
          <button className="btn btn-primary" onClick={newFence}>+ New Geofence</button>
        )}
      </div>
      <div className="card">
        <div className="tbl-wrap">
        <table>
          <thead><tr><th>Name</th><th>Boundary</th><th>Applies to</th><th>Tolerance</th><th>Region</th><th>Active</th>{canManageFence && <th></th>}</tr></thead>
          <tbody>
            {(geofences || []).map((g) => (
              <tr key={g.id}>
                <td><b>{g.name}</b></td>
                <td>{Array.isArray(g.boundary_json) && g.boundary_json.length >= 3 ? `Polygon (${g.boundary_json.length} pts)` : g.target_type === 'LINE' && g.target_id == null ? `Route corridor · ${g.radius_m} m` : `Circle · ${g.radius_m} m`}</td>
                <td>{g.target_type}{g.target_type !== 'REGION' ? ` · ${targetLabel(g.target_type, g.target_id)}` : ' (all targets)'}</td>
                <td>{g.tolerance_m} m</td>
                <td>{regionName(g.region_id)}</td>
                <td><Pill value={g.is_active ? 'ACTIVE' : 'INACTIVE'} /></td>
                {canManageFence && (
                  <td className="nowrap">
                    <button className="btn btn-sm" onClick={() => openFence(g)}>Edit</button>{' '}
                    <ConfirmButton label="Delete" onConfirm={() => removeFence(g)} title={`Delete geofence ${g.name}?`} />
                  </td>
                )}
              </tr>
            ))}
            {(geofences || []).length === 0 && <tr><td colSpan={canManageFence ? 7 : 6} className="muted center">No geofences defined.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>

      {form && (
        <Modal title="Record GPS Validation" onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={submit}>Submit</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Target type</label>
              <select value={form.target_type} onChange={(e) => setForm({ ...form, target_type: e.target.value })}>
                {['SUBSTATION', 'ASSET', 'TOWER', 'LINE'].map((t) => <option key={t}>{t}</option>)}
              </select></div>
            <div className="field"><label>Target</label>
              <select value={form.target_id} onChange={(e) => {
                const o = optionsFor(form.target_type).find((x) => x.id === Number(e.target.value));
                setForm({ ...form, target_id: Number(e.target.value), expected_lat: o?.lat || form.expected_lat, expected_lng: o?.lng || form.expected_lng });
              }}>
                {optionsFor(form.target_type).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select></div>
            <div className="field"><label>Expected lat</label><input type="number" step="0.0001" value={form.expected_lat ?? ''} onChange={(e) => setForm({ ...form, expected_lat: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Expected lng</label><input type="number" step="0.0001" value={form.expected_lng ?? ''} onChange={(e) => setForm({ ...form, expected_lng: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Measured lat</label><input type="number" step="0.0001" value={form.measured_lat ?? ''} onChange={(e) => setForm({ ...form, measured_lat: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Measured lng</label><input type="number" step="0.0001" value={form.measured_lng ?? ''} onChange={(e) => setForm({ ...form, measured_lng: e.target.value === '' ? null : Number(e.target.value) })} /></div>
            <div className="field"><label>Accuracy (m)</label><input type="number" value={form.accuracy_m} onChange={(e) => setForm({ ...form, accuracy_m: Number(e.target.value) })} /></div>
            <div className="field"><label>Method</label>
              <select value={form.validation_method} onChange={(e) => setForm({ ...form, validation_method: e.target.value })}>
                {['GPS_DEVICE', 'SURVEY', 'APP_CAPTURE', 'AERIAL_SURVEY', 'MANUAL_ENTRY'].map((m) => <option key={m}>{m}</option>)}
              </select></div>
            <div className="field full">
              <label>Capture measured point from map or device</label>
              <MapPicker
                value={typeof form.measured_lat === 'number' && typeof form.measured_lng === 'number' ? { lat: form.measured_lat, lng: form.measured_lng } : null}
                onChange={(p) => setForm({ ...form, measured_lat: p.lat, measured_lng: p.lng })}
                radius={500}
                radiusLabel="Measured point validation radius"
                zoom={10}
              />
              <div className="actions mt">
                <button className="btn btn-sm" onClick={captureDevice} disabled={gpsBusy}>{gpsBusy ? 'Acquiring...' : 'Use device GPS'}</button>
                {gpsMsg && <span className={gpsMsg.ok ? 'muted' : 'alert alert-error'}>{gpsMsg.text}</span>}
              </div>
            </div>
          </div>
          {form.measured_lat != null && form.measured_lng != null && form.target_id !== '' && (
            preview ? (
              <div className={`gps-preview mt ${preview.will_validate ? 'gps-preview-ok' : preview.violation ? 'gps-preview-bad' : 'gps-preview-wait'}`}>
                <div className="gps-preview-head">
                  {preview.will_validate
                    ? <span className="ok">✓ Will validate</span>
                    : preview.violation
                      ? <span className="bad">✗ Will be flagged — {VIOLATION_LABEL[preview.violation] || preview.violation}</span>
                      : <span>⚠ Outside tolerance — recorded for review</span>}
                </div>
                <div>Distance <b>{preview.distance_m} m</b> of {preview.tolerance_m} m tolerance</div>
                <div>Region boundary: {insideLabel(preview.in_region)}
                  {preview.in_substation !== null ? ` · Yard: ${insideLabel(preview.in_substation)}` : ''}
                  {` · Geofence: ${preview.applicable_fences ? insideLabel(preview.in_geofence) : 'no fence applies'}`}
                </div>
                {preview.matched_fence && <div className="muted">Matched fence: {preview.matched_fence.name}</div>}
              </div>
            ) : <div className="gps-preview gps-preview-wait mt muted">Checking the point against region, yard and geofences…</div>
          )}
          <p className="muted mt">Distance is computed server-side against the expected position; tolerance defaults by target type and must stay within 500m.</p>
        </Modal>
      )}

      {review && (
        <Modal title={`Review Violation — ${review.target_type} #${review.target_id}`} onClose={() => setReview(null)}
          footer={<>
            <button className="btn" onClick={() => setReview(null)}>Close</button>
            {canReview && <>
              <button className="btn" onClick={() => doReview('REJECT')} disabled={reviewBusy}>Reject (false alarm)</button>
              <button className="btn" onClick={() => doReview('ACKNOWLEDGE')} disabled={reviewBusy}>Acknowledge</button>
              <button className="btn btn-primary" onClick={() => doReview('RESOLVE')} disabled={reviewBusy}>{reviewBusy ? 'Saving…' : 'Resolve'}</button>
            </>}
          </>}>
          <div className="kv">
            <span className="k">Date</span><span>{fmtDate(review.validated_at)}</span>
            <span className="k">Target</span><span>{review.target?.name || review.target?.asset_id || review.target?.tower_id || review.target_id}</span>
            <span className="k">Violation</span><span>{VIOLATION_LABEL[review.violation] || <Pill value={review.result} />}</span>
            <span className="k">Distance</span><span className="mono">{Math.round(review.distance_m)} m (tol {review.tolerance_m} m)</span>
            <span className="k">Review state</span><span><span className={`review-badge review-${review.review_status || 'NOT_REQUIRED'}`}>{REVIEW_LABEL[review.review_status] || '—'}</span></span>
            {review.geofence && <span className="k">Matched fence</span>}
            {review.geofence && <span>{review.geofence.name}</span>}
          </div>
          {review.reviewed_at && (
            <p className="muted mt">Last reviewed {fmtDate(review.reviewed_at)}{review.reviewer ? ` by ${review.reviewer.first_name || ''} ${review.reviewer.last_name || ''}`.trimEnd() : ''}.</p>
          )}
          <div className="field mt">
            <label>Review note</label>
            <textarea rows={3} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} disabled={!canReview} placeholder={canReview ? 'What was checked and decided…' : 'No review permission'} />
          </div>
          <div className="mt">
            <Comments entityType="gps_validation" entityId={review.id} />
          </div>
        </Modal>
      )}

      {correct && (
        <Modal title="Apply Coordinate Correction (survey)" onClose={() => setCorrect(null)}
          footer={<>
            <button className="btn" onClick={() => setCorrect(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doCorrect}>Apply &amp; re-validate</button>
          </>}>
          <div className="kv">
            <span className="k">Target</span><span>{correct.name}</span>
            <span className="k">Current position</span><span className="mono">{correct.lat}, {correct.lng}</span>
          </div>
          <div className="form-grid mt">
            <div className="field"><label>New latitude</label><input type="number" step="0.0001" value={correct.new_lat ?? ''} onChange={(e) => setCorrect({ ...correct, new_lat: Number(e.target.value) })} /></div>
            <div className="field"><label>New longitude</label><input type="number" step="0.0001" value={correct.new_lng ?? ''} onChange={(e) => setCorrect({ ...correct, new_lng: Number(e.target.value) })} /></div>
          </div>
        </Modal>
      )}
      {fenceForm && (
        <Modal title={fenceForm.id ? `Edit Geofence — ${fenceForm.name}` : 'New Geofence'} onClose={() => setFenceForm(null)} wide
          footer={<>
            <button className="btn" onClick={() => setFenceForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={saveFence} disabled={fenceBusy}>{fenceBusy ? 'Saving…' : 'Save'}</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Name</label><input value={fenceForm.name} onChange={(e) => setFenceForm({ ...fenceForm, name: e.target.value })} placeholder="Yard perimeter" /></div>
            <div className="field"><label>Applies to target type</label>
              <select value={fenceForm.target_type} onChange={(e) => setFenceForm({ ...fenceForm, target_type: e.target.value, target_id: '' })}>
                {GEOFENCE_TARGETS.map((x) => <option key={x} value={x}>{x}{x === 'REGION' ? ' (all targets in region)' : ''}</option>)}
              </select></div>
            <div className="field"><label>Region</label>
              <select value={fenceForm.region_id ?? ''} onChange={(e) => setFenceForm({ ...fenceForm, region_id: e.target.value })}>
                {globalUser && <option value="">All regions</option>}
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></div>
            {fenceForm.target_type !== 'REGION' && (
              <div className="field"><label>Specific target (optional)</label>
                <select value={fenceForm.target_id ?? ''} onChange={(e) => setFenceForm({ ...fenceForm, target_id: e.target.value })}>
                  <option value="">All {fenceForm.target_type} in region</option>
                  {optionsFor(fenceForm.target_type).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select></div>
            )}
            <div className="field"><label>Boundary shape</label>
              <select value={fenceMode} onChange={(e) => setFenceMode(e.target.value)}>
                <option value="circle">{fenceForm.target_type === 'LINE' ? 'Route corridor (radius)' : 'Circle (center + radius)'}</option>
                <option value="polygon">Polygon</option>
              </select></div>
            <div className="field"><label>Tolerance (m)</label><input type="number" min="0" value={fenceForm.tolerance_m ?? ''} onChange={(e) => setFenceForm({ ...fenceForm, tolerance_m: e.target.value })} /></div>
            <div className="field"><label>Active</label>
              <select value={fenceForm.is_active ? '1' : '0'} onChange={(e) => setFenceForm({ ...fenceForm, is_active: e.target.value === '1' })}>
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select></div>
            {fenceMode === 'circle' ? (
              <>
                <div className="field"><label>{fenceForm.target_type === 'LINE' && fenceForm.target_id === '' ? 'Corridor width (m, half-width)' : 'Radius (m)'}</label>
                  <input type="number" min="1" value={fenceForm.radius_m ?? ''} onChange={(e) => setFenceForm({ ...fenceForm, radius_m: e.target.value })} /></div>
                <div className="field full">
                  <label>{t('pickLocation')} — {t('clickMapToSetPoint')}</label>
                  <MapPicker
                    value={typeof fenceForm.center_lat === 'number' && typeof fenceForm.center_lng === 'number' ? { lat: fenceForm.center_lat, lng: fenceForm.center_lng } : null}
                    onChange={(p) => setFenceForm({ ...fenceForm, center_lat: p.lat, center_lng: p.lng })}
                    center={regionCenter(fenceForm.region_id)}
                    zoom={fenceForm.center_lat != null ? 12 : 6}
                    radius={Number(fenceForm.radius_m) > 0 ? Number(fenceForm.radius_m) : null}
                    radiusLabel="Geofence radius"
                  />
                </div>
              </>
            ) : (
              <div className="field full">
                <label>Polygon boundary — click the map to add each corner; drag a point to adjust</label>
                <div className="actions mb">
                  <button type="button" className="btn btn-sm" disabled={!regionBoundary(fenceForm.region_id)}
                    onClick={() => setFenceForm({ ...fenceForm, boundary_json: regionBoundary(fenceForm.region_id) })}>
                    Use region boundary
                  </button>
                  {!regionBoundary(fenceForm.region_id) && <span className="muted">No region boundary defined</span>}
                </div>
                <PolygonEditor
                  value={fenceForm.boundary_json || []}
                  onChange={(poly) => setFenceForm({ ...fenceForm, boundary_json: poly })}
                  center={regionCenter(fenceForm.region_id)}
                  zoom={regionBoundary(fenceForm.region_id) ? 6 : 12}
                />
              </div>
            )}
          </div>
          <p className="muted mt" style={{ fontSize: 12 }}>
            A fence applies to GPS validations whose target type matches (optionally narrowed to one target), or to every target when the type is REGION.
            LINE fences follow the transmission route corridor; region-bound fences only apply to targets inside that region.
            A point outside all applicable fences is recorded as OUTSIDE_GEOFENCE.
          </p>
        </Modal>
      )}
    </Page>
  );
}
