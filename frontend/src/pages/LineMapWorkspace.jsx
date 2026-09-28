import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, asArray } from '../api';
import { SearchSelect, Page, Loading, ErrorNote, Pill, Modal, ConfirmButton, CondPill } from '../components';
import { KpiTile } from '../components/InfraVisuals';
import LineWorkspaceMap from '../components/LineWorkspaceMap';
import { getDevicePosition } from '../components/MapPicker';
import { can, getStoredUser } from '../auth';

const TOWER_TYPES = ['SUSPENSION', 'TENSION', 'ANGLE', 'TERMINAL', 'TRANSITION', 'DEAD_END'];
const MATERIALS = ['LATTICE_STEEL', 'TUBULAR_STEEL', 'CONCRETE', 'WOOD', 'COMPOSITE'];
const FOUNDATIONS = ['PAD', 'RAFT', 'PILE', 'ROCK_ANCHOR', 'GRILLAGE', 'MICRO_PILE'];
const COMPONENT_STATUSES = ['INSTALLED', 'SPARE', 'DEFECT_REPORTED', 'REPLACED', 'REMOVED'];
const STATE_COLOR = { existing: '#14532d', new: '#16a34a', edited: '#d97706', deleted: '#9ca3af' };
const EMPTY = [];

const DEFAULT_FIELDS = {
  tower_type: 'SUSPENSION',
  tower_material: 'LATTICE_STEEL',
  foundation_type: 'PAD',
  height_m: 38,
  corrosion_rating: 8,
  gps_validated: 1,
};

function workingFromDetail(detail) {
  return (detail.towers || []).map((t) => ({
    ...t,
    lat: t.latitude,
    lng: t.longitude,
    state: 'existing',
  }));
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STYLE = `
.lw-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
.lw-rail { max-height: 640px; overflow: auto; padding: 8px; }
.lw-panel { max-height: 640px; overflow: auto; padding: 12px; }
.lw-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.lw-tray { display: flex; gap: 6px; align-items: center; margin-left: auto; }
.lw-list { list-style: none; margin: 0; padding: 0; }
.lw-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.lw-row:hover { background: var(--accent-soft); }
.lw-row.sel { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.lw-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
.lw-pop { position: absolute; top: 110%; left: 0; z-index: 600; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.15); min-width: 220px; }
.line-workspace-map { border-radius: 8px; overflow: hidden; }
@media (max-width: 900px) {
  .lw-grid { grid-template-columns: 1fr; }
  .lw-rail, .lw-panel { max-height: none; }
}
`;

export default function LineMapWorkspace({ embedded }) {
  const user = getStoredUser();
  const canTower = can(user, 'tower:write');
  const canLine = can(user, 'line:write');
  const canAsset = can(user, 'asset:write');

  const [sp, setSp] = useSearchParams();
  const patch = useCallback((obj) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  }, [sp, setSp]);

  const rid = sp.get('region') ? Number(sp.get('region')) : null;
  const lid = sp.get('line') ? Number(sp.get('line')) : null;

  const [regions, setRegions] = useState(null);
  const [lines, setLines] = useState(null);
  const [detail, setDetail] = useState(null);
  const [working, setWorking] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [panelTab, setPanelTab] = useState('details');
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState(() => new Set());
  const [routeMode, setRouteMode] = useState(false);
  const [routeDraft, setRouteDraft] = useState([]);
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [spaceMode, setSpaceMode] = useState('count');
  const [spaceValue, setSpaceValue] = useState('10');
  const [bulkType, setBulkType] = useState('SUSPENSION');
  const [bulkMaterial, setBulkMaterial] = useState('LATTICE_STEEL');
  const [bulkFoundation, setBulkFoundation] = useState('PAD');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [progress, setProgress] = useState(null);
  const tempId = useRef(-1);

  useEffect(() => {
    Promise.all([api.get('/regions'), api.get('/lines')])
      .then(([r, l]) => { setRegions(r); setLines(l); })
      .catch((e) => setError(e.message));
  }, []);

  const resetWorking = useCallback((d) => {
    setDetail(d);
    setWorking(workingFromDetail(d));
    setSelectedId(null);
    setPanelTab('details');
    setBulkMode(false);
    setBulkSelected(new Set());
    setRouteMode(false);
    setRouteDraft([]);
  }, []);

  useEffect(() => {
    if (!lid) { setDetail(null); setWorking([]); setSelectedId(null); return undefined; }
    let alive = true;
    setDetail(null);
    setError(null);
    api.get(`/lines/${lid}`)
      .then((d) => { if (alive) resetWorking(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [lid, resetWorking]);

  useEffect(() => {
    setProgress(null);
    if (!lid || !showProgress) return undefined;
    let alive = true;
    api.get(`/lines/${lid}/inspection-progress`)
      .then((p) => { if (alive) setProgress(p); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [lid, showProgress]);

  const coveredPaths = useMemo(
    () => (showProgress && progress ? progress.covered_paths : EMPTY),
    [showProgress, progress]
  );
  const inspectedIds = useMemo(
    () => (showProgress && progress ? new Set(progress.inspected_tower_ids) : null),
    [showProgress, progress]
  );

  const reload = useCallback(async () => {
    if (!lid) return null;
    const d = await api.get(`/lines/${lid}`);
    resetWorking(d);
    return d;
  }, [lid, resetWorking]);

  const selected = useMemo(() => working.find((t) => t.id === selectedId) || null, [working, selectedId]);
  const counts = useMemo(() => {
    let nw = 0; let ed = 0; let de = 0;
    for (const t of working) {
      if (t.state === 'new') nw += 1;
      else if (t.state === 'edited') ed += 1;
      else if (t.state === 'deleted') de += 1;
    }
    return { nw, ed, de, total: nw + ed + de };
  }, [working]);

  const regionLines = useMemo(() => (lines || []).filter((l) => (rid ? l.region_id === rid : true)), [lines, rid]);
  const railTowers = useMemo(
    () => [...working].sort((a, b) => (Number(a.km_marker) || 0) - (Number(b.km_marker) || 0) || a.id - b.id),
    [working],
  );
  const route = routeMode ? routeDraft : asArray(detail && detail.route_json);
  const hasRoute = asArray(detail && detail.route_json).length >= 2;
  const routeRequired = !hasRoute && counts.total > 0;
  const saveDisabled = !counts.total || routeRequired;
  const saveTitle = routeRequired ? 'A route with 2+ points is required before saving tower changes' : undefined;

  function updateTowerFields(id, fields) {
    setWorking((ws) => ws.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...fields };
      if (t.state === 'existing') next.state = 'edited';
      return next;
    }));
  }

  function addPoint(lat, lng) {
    if (!canTower || !detail) return;
    const id = tempId.current--;
    const tower = { id, tower_id: `NEW-${Math.abs(id)}`, lat, lng, km_marker: 0, ...DEFAULT_FIELDS, state: 'new' };
    setWorking((ws) => [...ws, tower]);
    setSelectedId(id);
    setPanelTab('details');
  }

  function moveTower(id, lat, lng) {
    if (!canTower) return;
    updateTowerFields(id, { lat, lng });
  }

  function selectTower(id) {
    setSelectedId(id);
    setPanelTab('details');
  }

  function stageDelete(id) {
    setWorking((ws) => {
      const next = [];
      for (const t of ws) {
        if (t.id !== id) { next.push(t); continue; }
        if (t.state === 'new') continue;
        next.push({ ...t, state: 'deleted' });
      }
      return next;
    });
    setSelectedId(null);
    setNotice('Marked for deletion. Save to apply.');
  }

  function discard() {
    if (!detail) return;
    setWorking(workingFromDetail(detail));
    setSelectedId(null);
    setBulkSelected(new Set());
    setNotice('Discarded pending changes.');
  }

  async function save() {
    if (!detail || saveDisabled) return;
    const creates = working.filter((t) => t.state === 'new').map((t) => ({
      lat: t.lat, lng: t.lng,
      tower_type: t.tower_type, tower_material: t.tower_material, foundation_type: t.foundation_type,
      height_m: t.height_m, corrosion_rating: t.corrosion_rating, gps_validated: t.gps_validated,
    }));
    const updates = working.filter((t) => t.state === 'edited').map((t) => ({
      id: t.id, lat: t.lat, lng: t.lng,
      tower_type: t.tower_type, tower_material: t.tower_material, foundation_type: t.foundation_type,
      height_m: t.height_m, corrosion_rating: t.corrosion_rating, gps_validated: t.gps_validated,
    }));
    const deletes = working.filter((t) => t.state === 'deleted').map((t) => t.id);
    setSaving(true);
    setError(null);
    try {
      const res = await api.post(`/lines/${detail.id}/towers/batch`, { creates, updates, deletes });
      await reload();
      setNotice(`Saved: ${res.created.length} created, ${res.updated.length} updated, ${res.deleted.length} deleted.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function onBoxSelect(ids) {
    setBulkSelected(new Set(ids));
  }

  function onBulkToggle(id) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const bulkBlocked = counts.total > 0;

  async function bulkDelete() {
    if (!detail || bulkBlocked) return;
    const ids = [...bulkSelected];
    if (!ids.length) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post(`/lines/${detail.id}/towers/bulk`, { delete: ids });
      await reload();
      setNotice(`Deleted ${res.deleted.length} tower(s).`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function setMany(fields, label) {
    if (!detail || bulkBlocked) return;
    const ids = [...bulkSelected];
    if (!ids.length) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post(`/lines/${detail.id}/towers/bulk`, { patch: ids.map((id) => ({ id, ...fields })) });
      await reload();
      setNotice(`Updated ${res.patched.length} tower(s): ${label}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function bulkResetParts() {
    if (!detail || bulkBlocked) return;
    const ids = [...bulkSelected];
    if (!ids.length) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post(`/lines/${detail.id}/towers/bulk-reset-components`, { ids });
      await reload();
      setNotice(`Reset ${res.towers_reset} tower(s); wrote ${res.components_written} standard part(s).`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function exportCsv() {
    const rows = working.filter((t) => t.state !== 'deleted');
    const header = ['tower_id', 'latitude', 'longitude', 'tower_type', 'tower_material', 'foundation_type', 'height_m', 'corrosion_rating', 'km_marker', 'gps_validated', 'state'];
    const body = rows.map((t) => [
      t.tower_id, t.lat, t.lng, t.tower_type, t.tower_material, t.foundation_type,
      t.height_m, t.corrosion_rating, t.km_marker ?? '', t.gps_validated ?? '', t.state,
    ].map(csvCell).join(','));
    const csv = [header.join(','), ...body].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${detail?.line_id || 'line'}-towers.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function applyAutoSpace() {
    if (!detail) return;
    const value = Number(spaceValue);
    if (!Number.isFinite(value) || value <= 0) { setError('Enter a positive number.'); return; }
    const body = spaceMode === 'count' ? { count: value } : { spacingKm: value };
    setError(null);
    try {
      const res = await api.post(`/lines/${detail.id}/route/space`, body);
      const staged = res.points.map((p) => {
        const id = tempId.current--;
        return { id, tower_id: `AUTO-${Math.abs(id)}`, lat: p.lat, lng: p.lng, km_marker: p.km, ...DEFAULT_FIELDS, state: 'new' };
      });
      setWorking((ws) => [...ws, ...staged]);
      setSpaceOpen(false);
      setNotice(`Staged ${staged.length} tower(s) along ${res.line_length_km} km of route.`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function locateMe() {
    setLocating(true);
    setError(null);
    try {
      const p = await getDevicePosition();
      if (selected && selected.state === 'new') {
        moveTower(selected.id, p.lat, p.lng);
        setNotice('Moved the staged tower to the device position.');
      } else {
        addPoint(p.lat, p.lng);
        setNotice('Added a staged tower at the device position.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLocating(false);
    }
  }

  function enterRouteMode() {
    if (!detail) return;
    setRouteDraft(asArray(detail.route_json).map((p) => [p[0], p[1]]));
    setBulkMode(false);
    setBulkSelected(new Set());
    setSelectedId(null);
    setRouteMode(true);
  }

  function cancelRoute() {
    setRouteMode(false);
    setRouteDraft([]);
  }

  async function saveRoute() {
    if (!detail) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/lines/${detail.id}/route`, { route_json: routeDraft });
      await reload();
      setNotice(routeDraft.length === 0 ? 'Route cleared.' : 'Route saved; tower km markers re-projected.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const toolbar = (canTower || canLine) ? (
    <div className="lw-toolbar">
      {canTower && (
        <span style={{ position: 'relative' }}>
          <button
            className="btn btn-sm"
            onClick={() => setSpaceOpen((o) => !o)}
            disabled={!hasRoute}
            title={hasRoute ? 'Evenly space towers along the route' : 'Draw a route with 2+ points first'}
          >
            Auto-space
          </button>
          {spaceOpen && hasRoute && (
            <div className="lw-pop">
              <div className="field">
                <label>Mode</label>
                <SearchSelect value={spaceMode} onChange={(e) => setSpaceMode(e.target.value)}>
                  <option value="count">Tower count</option>
                  <option value="spacingKm">Spacing (km)</option>
                </SearchSelect>
              </div>
              <div className="field mt">
                <label>{spaceMode === 'count' ? 'Count (>= 2)' : 'Spacing km (> 0)'}</label>
                <input type="number" min="1" step={spaceMode === 'count' ? '1' : '0.1'} value={spaceValue} onChange={(e) => setSpaceValue(e.target.value)} />
              </div>
              <button className="btn btn-sm btn-primary mt" onClick={applyAutoSpace}>Apply</button>
            </div>
          )}
        </span>
      )}
      {canLine && (routeMode ? (
        <>
          <button className="btn btn-sm btn-primary" onClick={saveRoute} disabled={saving || routeDraft.length === 1}>
            {routeDraft.length === 0 ? 'Clear route' : 'Save route'}
          </button>
          <button className="btn btn-sm" onClick={cancelRoute} disabled={saving}>Cancel</button>
          <span className="muted" style={{ fontSize: 12 }}>Drag a waypoint to move, click it to remove, or click the map to append; {routeDraft.length} point(s).</span>
        </>
      ) : (
        <button className="btn btn-sm" onClick={enterRouteMode} disabled={!detail}>Draw route</button>
      ))}
      {canTower && (
        <button className="btn btn-sm" onClick={locateMe} disabled={locating || routeMode}>
          {locating ? 'Locating…' : 'Locate me'}
        </button>
      )}
      {canTower && !routeMode && (
        <button
          className={'btn btn-sm' + (bulkMode ? ' btn-primary' : '')}
          onClick={() => { setBulkMode((m) => !m); setBulkSelected(new Set()); }}
        >
          Bulk select
        </button>
      )}
      {canTower && counts.total > 0 && (
        <div className="lw-tray">
          <span className="muted">New {counts.nw} · Edited {counts.ed} · Deleted {counts.de}</span>
          <button className="btn btn-sm" onClick={discard} disabled={saving}>Discard</button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving || saveDisabled} title={saveTitle}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  ) : null;

  const body = (
    <>
      <style>{STYLE}</style>
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorNote error={error} />}
      <div className="grid grid-4 mb">
        <KpiTile label="Towers" value={working.filter((t) => t.state !== 'deleted').length} sub={`${(detail?.towers || []).length} on server`} />
        <KpiTile label="New" value={counts.nw} tone="ok" />
        <KpiTile label="Edited" value={counts.ed} tone="warn" />
        <KpiTile label="Deleted" value={counts.de} tone="bad" />
      </div>

      {toolbar}

      {detail && (
        <div className="lw-toolbar" style={{ marginTop: -4 }}>
          <button
            className={'btn btn-sm' + (showProgress ? ' btn-primary' : '')}
            onClick={() => setShowProgress((v) => !v)}
          >
            Inspection progress
          </button>
          {showProgress && progress && (
            <span className="muted" style={{ fontSize: 12 }}>
              {progress.inspected_towers}/{progress.total_towers} towers ·{' '}
              {progress.inspected_km}/{Math.round((progress.total_km || 0) * 10) / 10} km ·{' '}
              {Math.round((progress.tower_progress || 0) * 100)}%
            </span>
          )}
        </div>
      )}

      {bulkMode && canTower && (
        <div className="card card-pad mb" style={{ padding: 10 }}>
          <div className="lw-toolbar" style={{ marginBottom: 0 }}>
            <b>{bulkSelected.size} selected</b>
            {bulkBlocked && <span className="muted" style={{ fontSize: 12 }}>Save or discard the pending changes before applying bulk actions.</span>}
            <button className="btn btn-sm btn-danger" onClick={bulkDelete} disabled={bulkBlocked || !bulkSelected.size || saving}>Delete</button>
            <SearchSelect value={bulkType} onChange={(e) => setBulkType(e.target.value)} disabled={bulkBlocked}>
              {TOWER_TYPES.map((t) => <option key={t}>{t}</option>)}
            </SearchSelect>
            <button className="btn btn-sm" onClick={() => setMany({ tower_type: bulkType }, 'type')} disabled={bulkBlocked || !bulkSelected.size || saving}>Set type</button>
            <SearchSelect value={bulkMaterial} onChange={(e) => setBulkMaterial(e.target.value)} disabled={bulkBlocked}>
              {MATERIALS.map((m) => <option key={m}>{m}</option>)}
            </SearchSelect>
            <SearchSelect value={bulkFoundation} onChange={(e) => setBulkFoundation(e.target.value)} disabled={bulkBlocked}>
              {FOUNDATIONS.map((f) => <option key={f}>{f}</option>)}
            </SearchSelect>
            <button className="btn btn-sm" onClick={() => setMany({ tower_material: bulkMaterial, foundation_type: bulkFoundation }, 'material/foundation')} disabled={bulkBlocked || !bulkSelected.size || saving}>Set material / foundation</button>
            <button className="btn btn-sm" onClick={bulkResetParts} disabled={bulkBlocked || !bulkSelected.size || saving}>Reset parts to standard</button>
            <button className="btn btn-sm" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>
      )}

      <div className="lw-grid">
        <aside className="card lw-rail">
          <div className="field">
            <label>Region</label>
            <SearchSelect value={rid || ''} onChange={(e) => patch({ region: e.target.value || null, line: null })}>
              <option value="">All regions</option>
              {(regions || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </SearchSelect>
          </div>
          <div className="lw-folder hub-folder">Lines ({regionLines.length})</div>
          <ul className="lw-list">
            {regionLines.map((l) => (
              <li key={l.id} className={'lw-row' + (l.id === lid ? ' sel' : '')} onClick={() => patch({ line: l.id, region: l.region_id })}>
                <span className="lw-dot" style={{ background: l.id === lid ? '#2563eb' : '#94a3b8' }} />
                <span className="hub-row-main">{l.name}</span>
                <span className="muted">{l.voltage_kv} kV</span>
              </li>
            ))}
            {!regionLines.length && <li className="muted" style={{ fontSize: 12, padding: 4 }}>No lines</li>}
          </ul>
          {detail && (
            <>
              <div className="lw-folder hub-folder">Towers ({railTowers.length})</div>
              <ul className="lw-list">
                {railTowers.map((t) => (
                  <li key={t.id} className={'lw-row' + (t.id === selectedId ? ' sel' : '')} onClick={() => selectTower(t.id)}>
                    <span className="lw-dot" style={{ background: STATE_COLOR[t.state] || STATE_COLOR.existing }} />
                    <span className="hub-row-main mono">{t.tower_id}</span>
                    <span className="muted">{Number(t.km_marker) || 0} km</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <section>
          {!detail && lid && !error && <Loading />}
          {!lid && <div className="card card-pad muted center">Select a line to open its map workspace.</div>}
          {detail && (
            <LineWorkspaceMap
              route={route}
              towers={working}
              selectedId={selectedId}
              bulkSelected={bulkMode ? bulkSelected : null}
              routeMode={routeMode}
              bulkMode={bulkMode}
              lineInfo={detail}
              coveredPaths={coveredPaths}
              inspectedIds={inspectedIds}
              lineId={detail.id}
              height={560}
              onSelect={selectTower}
              onMove={canTower ? moveTower : undefined}
              onAddPoint={canTower ? addPoint : undefined}
              onRouteChange={setRouteDraft}
              onBoxSelect={onBoxSelect}
              onBulkToggle={onBulkToggle}
            />
          )}
        </section>

        <aside className="card lw-panel">
          {!selected && <div className="muted" style={{ fontSize: 13 }}>Select a tower on the map or rail to inspect and edit it.</div>}
          {selected && (
            <>
              <div className="card-head">
                <h3 className="card-title mono">{selected.tower_id}</h3>
                <Pill value={selected.state === 'new' ? 'NEW' : selected.state === 'deleted' ? 'OUT_OF_SERVICE' : 'AVAILABLE'}>{selected.state}</Pill>
              </div>
              <div className="tabs">
                {[['details', 'Details'], ['parts', 'Parts'], ['assets', 'Assets']].map(([k, label]) => (
                  <button key={k} className={'tab' + (panelTab === k ? ' active' : '')} onClick={() => setPanelTab(k)}>{label}</button>
                ))}
              </div>

              {panelTab === 'details' && (
                <div className="form-grid">
                  <div className="field"><label>Tower ID</label><input value={selected.tower_id || ''} readOnly /></div>
                  <div className="field"><label>km marker</label><input value={selected.km_marker ?? ''} readOnly /></div>
                  <div className="field"><label>Type</label>
                    <SearchSelect value={selected.tower_type || 'SUSPENSION'} disabled={!canTower} onChange={(e) => updateTowerFields(selected.id, { tower_type: e.target.value })}>
                      {TOWER_TYPES.map((t) => <option key={t}>{t}</option>)}
                    </SearchSelect>
                  </div>
                  <div className="field"><label>Material</label>
                    <SearchSelect value={selected.tower_material || 'LATTICE_STEEL'} disabled={!canTower} onChange={(e) => updateTowerFields(selected.id, { tower_material: e.target.value })}>
                      {MATERIALS.map((m) => <option key={m}>{m}</option>)}
                    </SearchSelect>
                  </div>
                  <div className="field"><label>Foundation</label>
                    <SearchSelect value={selected.foundation_type || 'PAD'} disabled={!canTower} onChange={(e) => updateTowerFields(selected.id, { foundation_type: e.target.value })}>
                      {FOUNDATIONS.map((f) => <option key={f}>{f}</option>)}
                    </SearchSelect>
                  </div>
                  <div className="field"><label>Height (m)</label>
                    <input type="number" step="0.5" disabled={!canTower} value={selected.height_m ?? ''} onChange={(e) => updateTowerFields(selected.id, { height_m: e.target.value === '' ? null : Number(e.target.value) })} />
                  </div>
                  <div className="field"><label>Corrosion (0-10)</label>
                    <input type="number" min="0" max="10" disabled={!canTower} value={selected.corrosion_rating ?? ''} onChange={(e) => updateTowerFields(selected.id, { corrosion_rating: e.target.value === '' ? null : Number(e.target.value) })} />
                  </div>
                  <div className="field"><label>GPS</label>
                    <span className="mono" style={{ fontSize: 12 }}>{selected.lat != null ? `${Number(selected.lat).toFixed(6)}, ${Number(selected.lng).toFixed(6)}` : '—'}</span>
                  </div>
                  <div className="field">
                    <label>Location validated</label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 400 }}>
                      <input type="checkbox" style={{ width: 'auto' }} disabled={!canTower} checked={!!selected.gps_validated} onChange={(e) => updateTowerFields(selected.id, { gps_validated: e.target.checked ? 1 : 0 })} />
                      {selected.gps_validated ? 'Validated' : 'Unvalidated'}
                    </label>
                  </div>
                  {selected.corrosion_rating != null && (
                    <div className="field"><label>Condition</label><CondPill rating={selected.corrosion_rating} /></div>
                  )}
                  {canTower && (
                    <div className="field full">
                      <button className="btn btn-primary" onClick={save} disabled={saving || saveDisabled} title={saveTitle}>{saving ? 'Saving…' : 'Save changes'}</button>{' '}
                      <ConfirmButton label="Delete" title={`Delete ${selected.tower_id}?`} onConfirm={() => stageDelete(selected.id)} />
                    </div>
                  )}
                  <p className="muted full" style={{ fontSize: 12 }}>
                    Changes are staged on the map and written in one transaction when you Save. Deleting is staged too and applies on Save.
                  </p>
                </div>
              )}

              {panelTab === 'parts' && (
                <PartsTab tower={selected} canWrite={canTower} setError={setError} setNotice={setNotice} />
              )}

              {panelTab === 'assets' && (
                <AssetsTab tower={selected} lineId={detail.id} canWrite={canAsset} setError={setError} setNotice={setNotice} />
              )}
            </>
          )}
        </aside>
      </div>

      {routeMode && canLine && (
        <p className="muted mt" style={{ fontSize: 12 }}>
          Route edit mode: drag a waypoint or click the map to append points, then Save route. Existing towers keep their positions and get re-projected km markers.
        </p>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <Page title="Line map workspace" crumbs="TMMS / Infrastructure">
      {body}
    </Page>
  );
}

function PartsTab({ tower, canWrite, setError, setNotice }) {
  const [components, setComponents] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!tower || tower.id < 0) return;
    api.get(`/towers/${tower.id}/components`).then(setComponents).catch((e) => setError(e.message));
  }, [tower.id, setError]);

  useEffect(() => { setComponents(null); setForm(null); load(); }, [load]);
  useEffect(() => { api.get('/tower-component-types').then(setCatalog).catch(() => {}); }, []);

  async function savePart() {
    try {
      setBusy(true);
      if (form.id) await api.put(`/tower-components/${form.id}`, form);
      else await api.post(`/towers/${tower.id}/components`, form);
      setForm(null);
      load();
      setNotice(form.id ? 'Part updated.' : 'Part added.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removePart(c) {
    try {
      await api.del(`/tower-components/${c.id}`);
      load();
      setNotice('Part removed.');
    } catch (e) {
      setError(e.message);
    }
  }

  if (tower.id < 0) return <div className="muted" style={{ fontSize: 13 }}>Save the new tower before managing its parts.</div>;
  if (!components) return <Loading />;

  return (
    <>
      {canWrite && (
        <div className="mb">
          <button className="btn btn-sm btn-primary" onClick={() => setForm({
            component_type: catalog[0]?.type || 'OTHER', name: catalog[0]?.name || '',
            material: catalog[0]?.material || 'GALVANIZED_STEEL', quantity: catalog[0]?.defaultQty || 1,
            unit: catalog[0]?.unit || 'pcs', condition_rating: 8, status: 'INSTALLED', notes: '',
          })}>+ Add part</button>
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Part</th><th>Qty</th><th>Condition</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td><b className="mono">{c.component_type}</b><br /><span className="muted">{c.name}</span></td>
                <td>{c.quantity} {c.unit}</td>
                <td><CondPill rating={c.condition_rating} /></td>
                <td>{c.status}</td>
                <td className="td-actions">
                  {canWrite && <>
                    <button className="btn btn-sm" onClick={() => setForm({ ...c })}>Edit</button>{' '}
                    <ConfirmButton label="Delete" title={`Delete ${c.component_type}?`} onConfirm={() => removePart(c)} />
                  </>}
                </td>
              </tr>
            ))}
            {!components.length && <tr><td colSpan={5} className="empty">No parts recorded</td></tr>}
          </tbody>
        </table>
      </div>

      {form && (
        <Modal title={form.id ? `Edit — ${form.component_type}` : 'Add part'} onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={savePart}>Save</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Part type</label>
              <SearchSelect value={form.component_type} onChange={(e) => {
                const cat = catalog.find((c) => c.type === e.target.value);
                setForm({ ...form, component_type: e.target.value, name: cat ? cat.name : form.name, material: cat ? cat.material : form.material, unit: cat ? cat.unit : form.unit, quantity: cat && cat.defaultQty ? cat.defaultQty : form.quantity });
              }}>
                {catalog.map((c) => <option key={c.type} value={c.type}>{c.type} — {c.name}</option>)}
              </SearchSelect>
            </div>
            <div className="field"><label>Name / description</label><input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field"><label>Material</label><input value={form.material || ''} onChange={(e) => setForm({ ...form, material: e.target.value })} /></div>
            <div className="field"><label>Quantity</label><input type="number" min="0" value={form.quantity ?? ''} onChange={(e) => setForm({ ...form, quantity: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>Unit</label><input value={form.unit || ''} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></div>
            <div className="field"><label>Condition (0-10)</label><input type="number" min="0" max="10" value={form.condition_rating ?? ''} onChange={(e) => setForm({ ...form, condition_rating: e.target.value === '' ? 0 : Number(e.target.value) })} /></div>
            <div className="field"><label>Status</label>
              <SearchSelect value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {COMPONENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
              </SearchSelect>
            </div>
            <div className="field full"><label>Notes</label><input value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </>
  );
}

function AssetsTab({ tower, lineId, canWrite, setError, setNotice }) {
  const [assets, setAssets] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!tower || tower.id < 0) return;
    api.get(`/assets?tower_id=${tower.id}`).then(setAssets).catch((e) => setError(e.message));
  }, [tower.id, setError]);

  useEffect(() => { setAssets(null); setForm(null); load(); }, [load]);
  useEffect(() => { api.get('/asset-catalog').then(setCatalog).catch(() => {}); }, []);

  const types = useMemo(() => {
    const out = [];
    for (const f of catalog?.families || []) for (const t of f.types || []) out.push(t);
    return out;
  }, [catalog]);

  async function saveAsset() {
    try {
      setBusy(true);
      await api.post('/assets', {
        asset_id: form.asset_id,
        name: form.name,
        asset_type: form.asset_type,
        sub_type: form.sub_type || '',
        condition_rating: form.condition_rating === '' || form.condition_rating == null ? 8 : Number(form.condition_rating),
        line_id: lineId,
        tower_id: tower.id,
        latitude: tower.lat,
        longitude: tower.lng,
        lifecycle_status: 'IN_SERVICE',
        operational_status: 'OPERATIONAL',
        criticality: 'MEDIUM',
      });
      setForm(null);
      load();
      setNotice('Asset registered.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (tower.id < 0) return <div className="muted" style={{ fontSize: 13 }}>Save the new tower before registering assets.</div>;
  if (!assets) return <Loading />;

  return (
    <>
      {canWrite && (
        <div className="mb">
          <button className="btn btn-sm btn-primary" onClick={() => setForm({
            asset_id: '', name: tower.tower_id, asset_type: types[0]?.asset_type || '', sub_type: types[0]?.sub_type || '', condition_rating: 8,
          })}>Register asset</button>
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Asset</th><th>Type</th><th>Condition</th><th>Status</th></tr></thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td><b className="mono">{a.asset_id}</b><br /><span className="muted">{a.name}</span></td>
                <td>{a.asset_type}{a.sub_type ? ` / ${a.sub_type}` : ''}</td>
                <td><CondPill rating={a.condition_rating} /></td>
                <td><Pill value={a.operational_status || a.lifecycle_status} /></td>
              </tr>
            ))}
            {!assets.length && <tr><td colSpan={4} className="empty">No assets at this tower</td></tr>}
          </tbody>
        </table>
      </div>

      {form && (
        <Modal title={`Register asset at ${tower.tower_id}`} onClose={() => setForm(null)}
          footer={<>
            <button className="btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={saveAsset}>Register</button>
          </>}>
          <div className="form-grid">
            <div className="field"><label>Asset ID</label><input value={form.asset_id} onChange={(e) => setForm({ ...form, asset_id: e.target.value })} placeholder="AST-..." /></div>
            <div className="field"><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="field full"><label>Asset type</label>
              <SearchSelect value={form.asset_type} onChange={(e) => {
                const t = types.find((x) => x.asset_type === e.target.value);
                setForm({ ...form, asset_type: e.target.value, sub_type: t ? t.sub_type : '' });
              }}>
                {types.map((t) => (
                  <option key={`${t.family}-${t.asset_type}-${t.sub_type}`} value={t.asset_type}>
                    {t.family_label} · {t.label}{t.sub_type ? ` (${t.sub_type})` : ''}
                  </option>
                ))}
              </SearchSelect>
            </div>
            <div className="field"><label>Condition (0-10)</label><input type="number" min="0" max="10" value={form.condition_rating} onChange={(e) => setForm({ ...form, condition_rating: e.target.value })} /></div>
          </div>
          <p className="muted mt" style={{ fontSize: 12 }}>
            Anchored to {tower.tower_id} on this line at {tower.lat != null ? `${Number(tower.lat).toFixed(6)}, ${Number(tower.lng).toFixed(6)}` : 'the tower coordinates'}.
          </p>
        </Modal>
      )}
    </>
  );
}
