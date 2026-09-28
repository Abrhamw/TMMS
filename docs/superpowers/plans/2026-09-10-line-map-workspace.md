# Line Map Workspace Implementation Plan (Sub-project B2)

Date: 2026-09-10
Spec: `docs/superpowers/specs/2026-09-10-line-map-workspace-design.md`
Sub-project: B2 of the six-part operations workstream. A (crew status) and B1 (counting
standards) are complete. B2 covers easy tower registration and map-based line/tower
visualization. No schema changes.

## Goal

Add a Line Map Workspace to the Infrastructure hub: select a line, see its route and towers on
an interactive map, auto-space/click/drag towers as a staged preview, save in one batch, edit the
line route (master geometry), inspect a tower panel (details/parts/assets), capture GPS, and
box-select towers for bulk delete/type/material/reset/export.

## Architecture

- **Backend geometry** (`backend/lineGeometry.js`, pure): haversine metres, cumulative route
  distance, nearest point projection, and arc-length spacing.
- **Backend workspace logic** (`backend/lineWorkspace.js`): route write + tower re-projection,
  per-line tower id sequencing, and transactional batch/bulk mutations. It calls no HTTP layer and
  manages no transaction; `core.js` wraps calls in the existing `withTx`.
- **Backend endpoints** (`backend/routes/core.js`): 5 new region-scoped routes.
- **Frontend** (`frontend/src/components/LineWorkspaceMap.jsx` presentational Leaflet map;
  `frontend/src/pages/LineMapWorkspace.jsx` orchestrator) plus a `map` manage view wired into
  `frontend/src/pages/Infrastructure.jsx`.
- Route is master geometry: route writes re-project tower `km_marker`; tower batch save NEVER
  rebuilds the route (does not call `rebuildLineRoute`).

## Tech Stack

Express 5 / CommonJS / Node >=22.5 / `node:sqlite` (no `db.transaction`, use `withTx`).
React + Vite + Leaflet (already present). No new dependencies. No test framework.

## Conventions / invariants

- `withTx` lives at `backend/routes/core.js:33`; wrap every multi-write handler body.
- Tower order is always `ORDER BY km_marker, id`.
- `seedStandardComponents(towerId, towerType)` from `backend/towerStandards.js`.
- `syncLineTowerCount(lineId)`, `syncTowerMirror(towerId)` from `backend/integrity.js`.
- `insertRow`/`updateRow`/`get` from `backend/util.js`; `updateRow(..., revisionCol)` bumps
  `revision` when the caller does not set it.
- Delete of a tower is rejected while it has a task whose status is not one of
  `COMPLETED, CANCELLED, FAILED`, or while any `task`, `maintenance_schedule`, or
  `checklist_execution` row still references it (all three are FKs to `tower(id)` with no
  ON DELETE). The widened guard throws a tower-named error listing each reference count so a
  batch delete fails clearly instead of hitting a raw `FOREIGN KEY constraint failed`.
- Mirror assets use `asset_id = 'TWR-<tower_id>'`; `syncTowerMirror` adopts an existing row.

---

## Task 1: `backend/lineGeometry.js` (pure geometry helpers)

**Files**: create `backend/lineGeometry.js`

**Steps**:

1. Create the file with the following content:

```js
// Pure line-geometry helpers for the line map workspace. No DB access.
// Route coordinates are [lat, lng] pairs, matching transmission_line.route_json.
const { haversine } = require('./geo');

function haversineKm(aLat, aLng, bLat, bLng) {
  return haversine(aLat, aLng, bLat, bLng) / 1000;
}

function validRoute(route) {
  if (!Array.isArray(route) || route.length < 2) return null;
  const ok = route.every(
    (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  return ok ? route : null;
}

// Cumulative segment lengths: returns { segments: [{ km, startKm }], totalKm }.
function routeSegments(route) {
  const segments = [];
  let totalKm = 0;
  for (let i = 1; i < route.length; i++) {
    const [aLat, aLng] = route[i - 1];
    const [bLat, bLng] = route[i];
    const km = haversineKm(aLat, aLng, bLat, bLng);
    segments.push({ km, startKm: totalKm, from: [aLat, aLng], to: [bLat, bLng] });
    totalKm += km;
  }
  return { segments, totalKm };
}

function distanceAlongRoute(route) {
  const valid = validRoute(route);
  if (!valid) return 0;
  return routeSegments(valid).totalKm;
}

// Interpolate the [lat, lng] at arc distance targetKm along the route.
function interpolate(route, targetKm) {
  if (!Array.isArray(route) || route.length === 0) return null;
  if (targetKm <= 0) return route[0].slice();
  const { segments, totalKm } = routeSegments(route);
  if (targetKm >= totalKm) return route[route.length - 1].slice();
  for (const seg of segments) {
    if (seg.startKm + seg.km >= targetKm && seg.km > 0) {
      const frac = (targetKm - seg.startKm) / seg.km;
      return [seg.from[0] + (seg.to[0] - seg.from[0]) * frac, seg.from[1] + (seg.to[1] - seg.from[1]) * frac];
    }
  }
  return route[route.length - 1].slice();
}

// Nearest point on the polyline to (lat, lng). Uses a local equirectangular
// projection in metres for the perpendicular-distance test, then reports the
// arc distance in km. Returns { km, snappedLat, snappedLng } or null.
function projectPointToRoute(route, lat, lng) {
  const valid = validRoute(route);
  if (!valid || typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const px = lng * mPerDegLng;
  const py = lat * mPerDegLat;
  let best = null;
  let cum = 0;
  for (let i = 1; i < valid.length; i++) {
    const [aLat, aLng] = valid[i - 1];
    const [bLat, bLng] = valid[i];
    const ax = aLng * mPerDegLng;
    const ay = aLat * mPerDegLat;
    const bx = bLng * mPerDegLng;
    const by = bLat * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const dist = (px - cx) ** 2 + (py - cy) ** 2;
    if (!best || dist < best.dist) {
      best = { dist, km: cum + haversineKm(aLat, aLng, bLat, bLng) * t, lat: aLat + (bLat - aLat) * t, lng: aLng + (bLng - aLng) * t };
    }
    cum += haversineKm(aLat, aLng, bLat, bLng);
  }
  if (!best) return null;
  return { km: Math.round(best.km * 10) / 10, snappedLat: +best.lat.toFixed(6), snappedLng: +best.lng.toFixed(6) };
}

// Even arc-length points. `count` N includes both ends (N >= 2).
// `spacingKm` S emits 0, S, 2S ... plus one final point at the far end if the
// last step did not land on it. Returns [{ lat, lng, km }].
function spaceAlongRoute(route, opts) {
  const valid = validRoute(route);
  if (!valid) return [];
  const totalKm = distanceAlongRoute(valid);
  const out = [];
  const push = (km) => {
    const p = interpolate(valid, km);
    if (p) out.push({ lat: +p[0].toFixed(6), lng: +p[1].toFixed(6), km: Math.round(km * 10) / 10 });
  };
  if (opts && opts.count != null) {
    const n = Math.max(2, Math.min(500, Math.floor(Number(opts.count))));
    for (let i = 0; i < n; i++) push(totalKm * (i / (n - 1)));
    return out;
  }
  if (opts && opts.spacingKm != null) {
    const s = Number(opts.spacingKm);
    if (!(s > 0)) return [];
    const MAX_POINTS = 5000;
    for (let km = 0; km < totalKm - 1e-3 && out.length < MAX_POINTS; km += s) push(km);
    push(totalKm);
    return out;
  }
  return [];
}

module.exports = { haversineKm, distanceAlongRoute, projectPointToRoute, spaceAlongRoute, interpolate, routeSegments };
```

2. Syntax check: `node --check backend/lineGeometry.js`
3. Quick sanity (no DB):

```bash
node -e "const g=require('./backend/lineGeometry');console.log(g.spaceAlongRoute([[0,0],[0,1]],{count:3}));console.log(g.projectPointToRoute([[0,0],[0,1]],0.001,0.5));"
```

Expected: 3 points with `km` 0 / ~55.6 / ~111.2; projection `km` near 55.6 with snappedLat ~0.

4. Commit: `feat(backend): add pure line geometry helpers`

---

## Task 2: `backend/lineWorkspace.js` (route + tower batch/bulk logic)

**Files**: create `backend/lineWorkspace.js`

**Steps**:

1. Create the file. It assumes the caller wraps every mutating function in `withTx`:

```js
// Line map workspace logic. All mutating functions run inside a caller-owned
// transaction (core.js withTx) and never call rebuildLineRoute: the line route
// is the master geometry, so saving towers must not overwrite it.
const { db, get, insertRow, updateRow } = require('./util');
const { haversineKm, projectPointToRoute } = require('./lineGeometry');
const { seedStandardComponents } = require('./towerStandards');
const { syncLineTowerCount, syncTowerMirror } = require('./integrity');

function routePrefix(lineId) {
  return String(lineId || '').replace(/^TL-/, '');
}

function parseRoute(routeJson) {
  const route = Array.isArray(routeJson) ? routeJson : [];
  const ok = route.length >= 2 && route.every(
    (p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  return ok ? route : null;
}

function projectKm(route, lat, lng, fallback) {
  const p = projectPointToRoute(route, lat, lng);
  return p ? p.km : fallback;
}

// Next free numeric suffix for a line's tower ids. Line TL-C1 with towers
// C1-001, C1-003 yields { prefix: 'C1', next: 4 }.
function nextTowerSeq(lineId) {
  const line = get('transmission_line', lineId);
  const prefix = routePrefix(line && line.line_id);
  const rows = db.prepare('SELECT tower_id FROM tower WHERE line_id = ?').all(lineId);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '-(\\d+)$');
  let maxN = 0;
  for (const r of rows) {
    const m = re.exec(String(r.tower_id));
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return { prefix, next: maxN + 1 };
}

function reprojectTowers(lineId, route) {
  const towers = db.prepare('SELECT * FROM tower WHERE line_id = ?').all(lineId);
  const upd = db.prepare('UPDATE tower SET km_marker = ? WHERE id = ?');
  for (const t of towers) upd.run(projectKm(route, t.latitude, t.longitude, t.km_marker), t.id);
  return towers.length;
}

// Set the line's route (master geometry), recompute length/gps_validated, and
// re-project every existing tower's km_marker. Positions are left unchanged.
function setLineRoute(lineId, routeJson) {
  const route = parseRoute(routeJson);
  if (!route) throw new Error('Route must be an array of at least two [lat, lng] points');
  let length = 0;
  for (let i = 1; i < route.length; i++) {
    length += haversineKm(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
  }
  db.prepare('UPDATE transmission_line SET route_json = ?, length_km = ?, gps_validated = ? WHERE id = ?')
    .run(JSON.stringify(route), Math.round(length * 10) / 10, 1, lineId);
  reprojectTowers(lineId, route);
  return {
    line: get('transmission_line', lineId, ['route_json']),
    towers: db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId),
  };
}

function assertDeletable(t) {
  const linked = db.prepare(
    "SELECT COUNT(*) c FROM task WHERE tower_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).get(t.id).c;
  if (linked > 0) throw new Error(`Cannot delete ${t.tower_id}: ${linked} open task(s)`);
  const refs = [
    ['task', db.prepare('SELECT COUNT(*) c FROM task WHERE tower_id = ?').get(t.id).c],
    ['maintenance schedule', db.prepare('SELECT COUNT(*) c FROM maintenance_schedule WHERE tower_id = ?').get(t.id).c],
    ['checklist execution', db.prepare('SELECT COUNT(*) c FROM checklist_execution WHERE tower_id = ?').get(t.id).c],
  ].filter(([, n]) => n > 0);
  if (refs.length) {
    const detail = refs.map(([name, n]) => `${n} ${name}${n === 1 ? '' : 's'}`).join(', ');
    throw new Error(`Cannot delete ${t.tower_id}: referenced by ${detail}. Remove the linked records first.`);
  }
}

function deleteTowerRow(t) {
  db.prepare('DELETE FROM asset WHERE tower_id = ?').run(t.id);
  db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
  db.prepare('DELETE FROM tower WHERE id = ?').run(t.id);
}

const TOWER_FIELDS = ['tower_type', 'tower_material', 'foundation_type', 'height_m', 'corrosion_rating', 'gps_validated'];

// Batch create/update/delete staged by the map. Assigns ids/numbers, recomputes
// km_marker, inserts mirror assets, syncs tower_count. Caller wraps in withTx.
function batchTowers(lineId, payload = {}) {
  const line = get('transmission_line', lineId, ['route_json']);
  if (!line) throw new Error('Line not found');
  const route = parseRoute(line.route_json);
  if (!route) throw new Error('Line has no route; draw or import a route before placing towers');
  const creates = Array.isArray(payload.creates) ? payload.creates : [];
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  const deletes = Array.isArray(payload.deletes) ? payload.deletes : [];

  const deleted = [];
  for (const id of deletes) {
    const t = get('tower', Number(id));
    if (!t || t.line_id !== lineId) continue;
    assertDeletable(t);
    deleteTowerRow(t);
    deleted.push(t.id);
  }

  const seq = nextTowerSeq(lineId);
  const used = new Set(db.prepare('SELECT tower_id FROM tower').all().map((r) => r.tower_id));
  const created = [];
  for (const c of creates) {
    if (typeof c.lat !== 'number' || typeof c.lng !== 'number' || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
      throw new Error('Each new tower needs numeric lat and lng');
    }
    let tid;
    do {
      tid = `${seq.prefix}-${String(seq.next).padStart(3, '0')}`;
      seq.next += 1;
    } while (used.has(tid));
    used.add(tid);
    const type = c.tower_type || 'SUSPENSION';
    const id = insertRow('tower', {
      tower_id: tid,
      line_id: lineId,
      tower_number: tid,
      km_marker: projectKm(route, c.lat, c.lng, 0),
      latitude: c.lat,
      longitude: c.lng,
      tower_type: type,
      tower_material: c.tower_material || 'LATTICE_STEEL',
      height_m: c.height_m != null ? c.height_m : (line.voltage_kv >= 500 ? 55 : 38),
      foundation_type: c.foundation_type || 'PAD',
      corrosion_rating: c.corrosion_rating != null ? c.corrosion_rating : 8,
      gps_validated: c.gps_validated != null ? c.gps_validated : 1,
      revision: 1,
    });
    seedStandardComponents(id, type);
    syncTowerMirror(id);
    created.push(get('tower', id));
  }

  const updated = [];
  for (const u of updates) {
    const t = get('tower', Number(u.id));
    if (!t || t.line_id !== lineId) continue;
    const lat = typeof u.lat === 'number' && Number.isFinite(u.lat) ? u.lat : t.latitude;
    const lng = typeof u.lng === 'number' && Number.isFinite(u.lng) ? u.lng : t.longitude;
    const fields = { latitude: lat, longitude: lng, km_marker: projectKm(route, lat, lng, t.km_marker) };
    for (const f of TOWER_FIELDS) if (u[f] !== undefined) fields[f] = u[f];
    updateRow('tower', t.id, fields, [], 'revision');
    syncTowerMirror(t.id);
    updated.push(get('tower', t.id));
  }

  syncLineTowerCount(lineId);
  const lineRow = get('transmission_line', lineId);
  return { created, updated, deleted, line: { id: lineRow.id, tower_count: lineRow.tower_count } };
}

// Box-selection actions: deletes + field patches only. Caller wraps in withTx.
function bulkTowers(lineId, payload = {}) {
  const deletes = Array.isArray(payload.delete) ? payload.delete : [];
  const patches = Array.isArray(payload.patch) ? payload.patch : [];
  const deleted = [];
  for (const id of deletes) {
    const t = get('tower', Number(id));
    if (!t || t.line_id !== lineId) continue;
    assertDeletable(t);
    deleteTowerRow(t);
    deleted.push(t.id);
  }
  const patched = [];
  for (const p of patches) {
    const t = get('tower', Number(p.id));
    if (!t || t.line_id !== lineId) continue;
    const fields = {};
    for (const f of ['tower_type', 'tower_material', 'foundation_type']) if (p[f] != null) fields[f] = p[f];
    if (Object.keys(fields).length === 0) continue;
    updateRow('tower', t.id, fields, [], 'revision');
    syncTowerMirror(t.id);
    patched.push(t.id);
  }
  syncLineTowerCount(lineId);
  return { deleted, patched };
}

// Reset the given towers' components to their type's standard set. Caller wraps.
function bulkResetComponents(lineId, ids = []) {
  let towers_reset = 0;
  let components_written = 0;
  for (const id of ids) {
    const t = get('tower', Number(id));
    if (!t || t.line_id !== lineId) continue;
    db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
    seedStandardComponents(t.id, t.tower_type);
    components_written += db.prepare('SELECT COUNT(*) c FROM tower_component WHERE tower_id = ?').get(t.id).c;
    towers_reset += 1;
  }
  return { towers_reset, components_written };
}

module.exports = { setLineRoute, nextTowerSeq, batchTowers, bulkTowers, bulkResetComponents };
```

2. Syntax check: `node --check backend/lineWorkspace.js`
3. Commit: `feat(backend): add line workspace route and tower batch logic`

**Note on writes**: `batchTowers` and `bulkTowers` advance the id sequence against the ids present *after* deletes in the same call, and skip ids already used. If a create fails partway, the caller's `withTx` rolls the whole call back.

---

## Task 3: New endpoints in `backend/routes/core.js`

**Files**: modify `backend/routes/core.js`

**Steps**:

1. Add imports near the existing requires (after line 8):

```js
const { spaceAlongRoute, distanceAlongRoute } = require('../lineGeometry');
const { setLineRoute, batchTowers, bulkTowers, bulkResetComponents } = require('../lineWorkspace');
```

2. Insert the five routes after the existing `POST /lines/:id/towers-from-route` handler (after line 667):

```js
// Preview evenly spaced tower positions along the line's route (nothing written).
router.post('/lines/:id/route/space', (req, res) => {
  const line = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  const route = Array.isArray(line.route_json) ? line.route_json : [];
  if (route.length < 2) return res.status(400).json({ error: 'Line has no route to space towers along' });
  const { count, spacingKm } = req.body || {};
  const points = count != null
    ? spaceAlongRoute(route, { count: Number(count) })
    : spacingKm != null ? spaceAlongRoute(route, { spacingKm: Number(spacingKm) }) : [];
  if (points.length === 0) return res.status(400).json({ error: 'Provide a tower count (>=2) or a positive spacing in km' });
  res.json({ points, line_length_km: Math.round(distanceAlongRoute(route) * 10) / 10 });
});

// Set the line route (master geometry) and re-project existing tower km markers.
router.post('/lines/:id/route', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const line = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  try {
    const result = withTx(() => setLineRoute(line.id, req.body && req.body.route_json));
    audit(req.user, 'UPDATE', 'line', line.id, { route_json: true, points: (result.line.route_json || []).length });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One-transaction create/update/delete of towers staged on the line map.
router.post('/lines/:id/towers/batch', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  try {
    const result = withTx(() => batchTowers(line.id, req.body || {}));
    audit(req.user, 'UPDATE', 'line', line.id, {
      batch_towers: true, created: result.created.length, updated: result.updated.length, deleted: result.deleted.length,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Box-selection actions: bulk delete and/or type/material/foundation patches.
router.post('/lines/:id/towers/bulk', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  try {
    const result = withTx(() => bulkTowers(line.id, req.body || {}));
    audit(req.user, 'UPDATE', 'line', line.id, { bulk_towers: true, deleted: result.deleted.length, patched: result.patched.length });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reset the selected towers' parts to their type's standard set.
router.post('/lines/:id/towers/bulk-reset-components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const result = withTx(() => bulkResetComponents(line.id, ids));
    audit(req.user, 'UPDATE', 'line', line.id, { bulk_reset_components: true, ...result });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

3. Syntax check: `node --check backend/routes/core.js`
4. Commit: `feat(backend): add line route and tower batch/bulk endpoints`

---

## Task 4: `frontend/src/components/LineWorkspaceMap.jsx`

**Files**: create `frontend/src/components/LineWorkspaceMap.jsx`

Interactive presentational map. Parent owns all state; the map reports gestures via callbacks.
Reuses the Leaflet tile/`setTimeout(invalidateSize)` pattern from `LineRouteMap`/`ViewMap`.

**Props**

- `route`: `[[lat,lng], ...]`
- `towers`: `[{ id, tower_id, lat, lng, state }]` where `state` is `existing|new|edited|deleted`
- `selectedId`: number|null
- `bulkSelected`: `Set<number>` (highlighted)
- `routeMode`: boolean (drag/add route waypoints)
- `bulkMode`: boolean (box-select)
- `lineId`: the selected line id (fit is re-run only when this changes)
- `onSelect(id)`, `onMove(id, lat, lng)`, `onAddPoint(lat, lng)`
- `onRouteChange(route)`, `onBoxSelect(ids)`, `onBulkToggle(id)`
- `height`

**Steps**:

1. Create the file:

```jsx
import { useEffect, useRef } from 'react';
import L from 'leaflet';

const COLORS = {
  existing: '#14532d',
  new: '#16a34a',
  edited: '#d97706',
  deleted: '#9ca3af',
  selected: '#2563eb',
  bulk: '#7c3aed',
  waypoint: '#0ea5e9',
};

function dot(color, size = 14, border = '#fff') {
  return L.divIcon({
    className: 'lw-marker',
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${border};box-shadow:0 0 3px rgba(0,0,0,.55)"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function LineWorkspaceMap({
  route = [],
  towers = [],
  selectedId = null,
  bulkSelected = null,
  routeMode = false,
  bulkMode = false,
  lineId = null,
  onSelect,
  onMove,
  onAddPoint,
  onRouteChange,
  onBoxSelect,
  onBulkToggle,
  height = 520,
}) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const boxRef = useRef(null);
  const dragStart = useRef(null);
  const fittedLine = useRef(null);
  const cbs = useRef({});
  const data = useRef({});
  cbs.current = { onSelect, onMove, onAddPoint, onRouteChange, onBoxSelect, onBulkToggle };
  data.current = { route, towers, routeMode, bulkMode, selectedId };

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false, scrollWheelZoom: true });
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    map.setView([9.0, 39.0], 6);
    setTimeout(() => map.invalidateSize(), 60);
    return () => { map.remove(); mapRef.current = null; layerRef.current = null; };
  }, []);

  // Fit once per line, as soon as that line's route/towers arrive.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lineId == null || fittedLine.current === lineId) return;
    const pts = route.map((p) => [p[0], p[1]])
      .concat(towers.filter((t) => t.lat != null && t.lng != null).map((t) => [t.lat, t.lng]));
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 13 });
    fittedLine.current = lineId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, route, towers]);

  // Rebuild route + tower layers whenever the working set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) layerRef.current.remove();
    const layer = L.layerGroup();
    layerRef.current = layer;

    if (route.length > 1) {
      L.polyline(route, { color: '#2563eb', weight: 3, opacity: 0.85 }).addTo(layer);
    }

    if (routeMode) {
      route.forEach((p, i) => {
        const m = L.marker([p[0], p[1]], { draggable: true, icon: dot(COLORS.waypoint, 12) }).addTo(layer);
        m.on('click', (e) => L.DomEvent.stopPropagation(e));
        m.on('dragend', () => {
          cbs.current.onRouteChange && cbs.current.onRouteChange(
            route.map((q, j) => (j === i ? [m.getLatLng().lat, m.getLatLng().lng] : q))
          );
        });
        m.bindTooltip(`Waypoint ${i + 1} — drag to move, click map to append`, { direction: 'top' });
      });
    } else {
      towers.forEach((t) => {
        if (t.lat == null || t.lng == null) return;
        const isSel = t.id === selectedId;
        const isBulk = bulkSelected && bulkSelected.has(t.id);
        const color = isSel ? COLORS.selected : isBulk ? COLORS.bulk : (COLORS[t.state] || COLORS.existing);
        const m = L.marker([t.lat, t.lng], {
          draggable: t.state !== 'deleted',
          icon: dot(color, isSel || isBulk ? 17 : 14),
          opacity: t.state === 'deleted' ? 0.45 : 1,
        }).addTo(layer);
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (cbs.current.bulkMode) cbs.current.onBulkToggle && cbs.current.onBulkToggle(t.id);
          else cbs.current.onSelect && cbs.current.onSelect(t.id);
        });
        m.on('dragend', () => cbs.current.onMove && cbs.current.onMove(t.id, m.getLatLng().lat, m.getLatLng().lng));
        m.bindTooltip(`${t.tower_id}${t.state && t.state !== 'existing' ? ` · ${t.state}` : ''}`, { direction: 'top' });
      });
    }

    layer.addTo(map);
  }, [route, towers, selectedId, bulkSelected, routeMode, bulkMode]);

  // Click on the map: append a route waypoint (route mode) or stage a new tower.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handler = (e) => {
      if (data.current.bulkMode || data.current.routeMode) {
        if (data.current.routeMode) {
          const lat = +e.latlng.lat.toFixed(6);
          const lng = +e.latlng.lng.toFixed(6);
          cbs.current.onRouteChange && cbs.current.onRouteChange([...data.current.route, [lat, lng]]);
        }
        return;
      }
      cbs.current.onAddPoint && cbs.current.onAddPoint(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6));
    };
    map.on('click', handler);
    return () => map.off('click', handler);
  }, []);

  // Box-select: disable panning and drag a rectangle while bulk mode is on.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!bulkMode) {
      if (boxRef.current) { boxRef.current.remove(); boxRef.current = null; }
      dragStart.current = null;
      return;
    }
    map.dragging.disable();
    const boundsFrom = (a, b) => L.latLngBounds(a, b);
    const onDown = (e) => {
      const target = e.originalEvent && e.originalEvent.target;
      if (target && typeof target.closest === 'function' && target.closest('.lw-marker')) return;
      dragStart.current = e.latlng;
    };
    const onMoveEv = (e) => {
      if (!dragStart.current) return;
      if (boxRef.current) boxRef.current.remove();
      boxRef.current = L.rectangle(boundsFrom(dragStart.current, e.latlng), { color: '#7c3aed', weight: 1, fillOpacity: 0.08 }).addTo(map);
    };
    const onUp = (e) => {
      if (!dragStart.current) return;
      const b = boundsFrom(dragStart.current, e.latlng);
      const ids = data.current.towers
        .filter((t) => t.lat != null && t.lng != null && t.state !== 'deleted' && b.contains([t.lat, t.lng]))
        .map((t) => t.id);
      if (boxRef.current) { boxRef.current.remove(); boxRef.current = null; }
      dragStart.current = null;
      cbs.current.onBoxSelect && cbs.current.onBoxSelect(ids);
    };
    map.on('mousedown', onDown);
    map.on('mousemove', onMoveEv);
    map.on('mouseup', onUp);
    return () => {
      map.off('mousedown', onDown);
      map.off('mousemove', onMoveEv);
      map.off('mouseup', onUp);
      map.dragging.enable();
      if (boxRef.current) { boxRef.current.remove(); boxRef.current = null; }
    };
  }, [bulkMode]);

  return <div ref={elRef} className="line-workspace-map" style={{ height, width: '100%' }} />;
}
```

2. Commit: `feat(frontend): add interactive line workspace map component`

---

## Task 5: `frontend/src/pages/LineMapWorkspace.jsx` (orchestrator)

**Files**: create `frontend/src/pages/LineMapWorkspace.jsx`

Owns the working set (route draft, staged towers, selection, modes) and calls the new endpoints.

**Data flow**

- Load `api.get('/regions')` and `api.get('/lines')` for the rail; read `region`/`line` from
  `useSearchParams` (same keys the hub uses) and `patch` them on selection.
- When a line is selected, `api.get('/lines/'+id)` returns `{ route_json, towers, ... }`; keep
  `detail` as the server baseline and `staged` as the working copy.
- Working tower list = server towers mapped to `state:'existing'` + staged creates (negative temp
  ids, `state:'new'`) overridden by staged edits (`state:'edited'`) and marked deletes
  (`state:'deleted'`). One `save()` posts batch; `reload()` re-fetches.

**Key handlers**

- `addPoint(lat,lng)` → push a staged create with default type/material/foundation (`SUSPENSION`,
  `LATTICE_STEEL`, `PAD`), select it.
- `moveTower(id,lat,lng)` → staged create: update lat/lng; existing: record an update + `edited`.
- `selectTower(id)`, `setMany` type/material/foundation on selection, `bulkDelete`,
  `bulkResetParts`, `exportCsv` (client-side Blob from the current working tower list).
- `autoSpace({count|spacingKm})` → `api.post('/lines/'+id+'/route/space', body)` then stage each
  returned point as a new tower.
- `locateMe()` → `getDevicePosition()` from `MapPicker.jsx`; add at device lat/lng or move the
  selected staged tower; inline error on failure.
- `enterRouteMode()` copies `detail.route_json` into `routeDraft`; map edits update `routeDraft`;
  `saveRoute()` → `api.post('/lines/'+id+'/route', { route_json: routeDraft })` then `reload()`;
  `cancelRoute()` restores `detail.route_json`.
- `save()` → build `{ creates, updates, deletes }` and `api.post('/lines/'+id+'/towers/batch')`,
  then `reload()`. Disabled when nothing is staged, or whenever the line has no usable route
  (fewer than 2 route points) and there are pending changes of any kind, because the batch endpoint
  re-projects `km_marker` and requires a route.
- `reload()` → re-fetch `/lines/:id`, reset staged state, clear selection modes.

**Tower panel** (right column): Details / Parts / Assets tabs.

- Details: fields (`tower_id`, type, material, foundation, height, corrosion, gps_validated, km);
  Save with `tower:write` posts `{ updates: [{ id, ...fields }] }` to the batch endpoint (no route
  rebuild). Delete button uses the staged delete flow.
- Parts: `api.get('/towers/'+id+'/components')` + `api.get('/tower-component-types')`; add via
  `POST /towers/:id/components`, edit via `PUT /tower-components/:id`, remove via
  `DELETE /tower-components/:id`; `tower:write` gated.
- Assets: `api.get('/assets?tower_id='+id)`; "Register asset" shows a compact inline form
  (`asset_id`, `name`, `asset_type`, condition) pre-filled with `line_id`/`tower_id` and the tower
  coordinates, then `POST /assets`; `asset:write` gated.

**Toolbar** (center, above map): Auto-space popover (count | spacing), Draw route (with Save/Cancel
in route mode), Locate me, Bulk select toggle, and the pending tray (`New n · Edited n · Deleted n`,
Discard, Save). Read-only users see the map/rail/panel but none of these controls.

**Left rail**: region line list (from `/lines`, region-scoped) + the selected line's towers in
`ORDER BY km_marker, id`, each row clickable to select/sync; state-colored dot per row.

**Layout**: reuse the hub `.hub` grids; a local CSS class (add to the existing stylesheet used by
`Infrastructure.jsx`/`Lines.jsx`, e.g. `frontend/src/index.css` or the hub stylesheet) for
`.line-workspace-map { border-radius: 8px; overflow: hidden; }` and a 3-column grid
`rail | map | panel` collapsing to one column under ~900px.

**Steps**:

1. Create the page implementing the handlers above. Gate every write button with
   `can(getStoredUser(), ...)` matching the server permission. Handle errors with `ErrorNote` and
   set a `notice` on success.
2. `cd frontend && npm run build` must exit 0.
3. Commit: `feat(frontend): add line map workspace page`

**Note**: do not introduce new dependencies. Reuse `Page`, `Loading`, `ErrorNote`, `Pill`, `Modal`,
`ConfirmButton` from `frontend/src/components.jsx`, `MapPicker`'s `getDevicePosition`, and
`api`/`can`/`getStoredUser`.

---

## Task 6: Wire the `map` manage view into `frontend/src/pages/Infrastructure.jsx`

**Files**: modify `frontend/src/pages/Infrastructure.jsx`

**Steps**:

1. Add the import after line 13:

```js
import LineMapWorkspace from './LineMapWorkspace';
```

2. Extend `MANAGE` (line 20):

```js
const MANAGE = { regions: <Regions embedded />, substations: <Substations embedded />, lines: <Lines embedded />, towers: <Towers embedded />, map: <LineMapWorkspace embedded />, validate: <DataValidation embedded /> };
```

3. Extend the allow-list (line 40):

```js
const manage = ['regions', 'substations', 'lines', 'towers', 'map', 'validate'].includes(sp.get('manage')) ? sp.get('manage') : null;
```

4. Add a toolbar button after the manage buttons loop (after line 96), before the validate button:

```jsx
<button className="btn btn-sm" onClick={() => patch({ manage: 'map' })}>Map workspace</button>
```

5. `cd frontend && npm run build` must exit 0.
6. Commit: `feat(frontend): expose line map workspace in infrastructure hub`

---

## Task 7: Verification (no test framework)

**Files**: none (scratch scripts and curl only)

Repo convention: `node --check` each touched backend file; `npm run build` in `frontend/`; scratch
server on an isolated DB copy on ports 3011–3013, always stopped by PID.

**Steps**:

1. Syntax-check every touched backend file:

```bash
node --check backend/lineGeometry.js
node --check backend/lineWorkspace.js
node --check backend/routes/core.js
```

2. Start a scratch backend against an isolated DB and log in:

```bash
cp backend/tmms.db /tmp/tmms-b2.db
TMMS_DB=/tmp/tmms-b2.db PORT=3011 node backend/server.js > /tmp/b2-server.log 2>&1 &
echo $! > /tmp/b2-server.pid
sleep 1.5
TOKEN=$(curl -s -X POST localhost:3011/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
```

3. Run the curl checks:

```bash
# 1. space by count and by spacing
curl -s -X POST localhost:3011/api/lines/1/route/space -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"count":5}'
curl -s -X POST localhost:3011/api/lines/1/route/space -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"spacingKm":5}'

# 2. batch create continues the id sequence, projects km, creates mirror assets, syncs tower_count
curl -s -X POST localhost:3011/api/lines/1/towers/batch -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"creates":[{"lat":9.1,"lng":39.1,"tower_type":"TENSION"}]}'

# 3. failing batch rolls back (non-existent update id is ignored; force failure with bad create)
curl -s -X POST localhost:3011/api/lines/1/towers/batch -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"creates":[{"lat":"bad","lng":39.1}]}'

# 4. route save re-projects km and leaves positions unchanged
curl -s -X POST localhost:3011/api/lines/1/route -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"route_json":[[9.0,39.0],[9.2,39.2],[9.5,39.5]]}'

# 5. bulk patch + reset parts
curl -s -X POST localhost:3011/api/lines/1/towers/bulk -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"patch":[]}'
curl -s -X POST localhost:3011/api/lines/1/towers/bulk-reset-components -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ids":[]}'

# 6. permission check: read-only / no token is rejected
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3011/api/lines/1/towers/batch -H 'Content-Type: application/json' -d '{}'
```

4. Stop the scratch server by PID (never by process name):

```bash
kill "$(cat /tmp/b2-server.pid)"
```

5. Frontend build:

```bash
cd frontend && npm run build
```

Expected: exit 0.

6. Manual end-to-end on a copied demo DB: open Infrastructure → Map workspace, select a line,
auto-space, drag a tower, Save, confirm counts; Draw route → Save and confirm towers keep position
with re-projected km; select a tower → Details/Parts/Assets; Bulk select → Delete/Change
type/Reset parts/Export CSV.

7. Commit any plan-fix follow-ups; do not stage `backend/tmms.db*`, `backend/uploads/`, or
`frontend/dist/`.

---

## Rollback / safety

- All new writes are behind existing permissions and region scope.
- Route writes and tower batch/bulk each run in one `withTx`; a failure leaves no partial writes.
- Existing per-tower CRUD/import endpoints are untouched, so their route-rebuild behavior remains.
- No schema migration and no data backfill: the workspace reads/writes existing columns only.
