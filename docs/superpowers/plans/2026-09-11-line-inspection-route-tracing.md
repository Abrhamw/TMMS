# Line-Inspection Route Tracing (Sub-project E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let crews record a GPS breadcrumb while working a line task, and overlay inspected tower/kilometre progress on the planned line route, per task and per line.

**Architecture:** One new `inspection_trace_point` table; a pure `backend/inspectionTrace.js` for point validation and coverage math; two read/append APIs plus a line progress API; optional `LineWorkspaceMap` props to draw the trace and coverage; a recorder hook on TaskDetail.

**Tech Stack:** Express 5 + `node:sqlite` (`DatabaseSync`), React + Vite, Leaflet, existing `lineGeometry.js`.

## Global Constraints

- No destructive DDL: create `inspection_trace_point` with `CREATE TABLE IF NOT EXISTS` and indexes with `IF NOT EXISTS`.
- `transmission_line.route_json` is master geometry; trace code must never call `rebuildLineRoute` or mutate the route.
- Tower ordering everywhere is `ORDER BY km_marker, id`.
- Only `COMPLETED` (verified) tasks count toward coverage.
- Reuse `backend/lineGeometry.js` (`projectPointToRoute`, `distanceAlongRoute`, `interpolate`) and `backend/auth.js` (`taskVisible`/`can`/`checkRegion`); do not duplicate geometry.
- The coverage module is pure: no DB access, no Express.
- No new frontend dependencies; API calls go through `frontend/src/api.js` (base `/api`).
- No test framework exists: verify with `node --check`, plain `/tmp/*.js` scripts, a scratch copied DB on an isolated port, and `npm run build`.
- Never stage runtime files (`backend/tmms.db*`, `backend/uploads/`, `frontend/dist/`).

---

### Task 1: Trace table + pure coverage module

**Files:**
- Modify: `backend/db.js` (schema block ending at line 508)
- Create: `backend/inspectionTrace.js`
- Test: `/tmp/inspection-trace-check.js` (scratch, not committed)

**Interfaces:**
- Consumes: `backend/lineGeometry.js` → `distanceAlongRoute(route)`, `interpolate(route, km)`.
- Produces:
  - `validatePoints(points)` → `[{ lat, lng, accuracy_m, recorded_at }]`; throws `Error` on invalid input.
  - `coverage({ lineId, route, towers, tasks, traceTaskIds })` → `{ line_id, total_towers, inspected_towers, tower_progress, total_km, inspected_km, km_progress, covered_spans, covered_paths, inspected_tower_ids, trace_task_ids }`.

- [ ] **Step 1: Add the table to `backend/db.js`**

Inside the schema `db.exec(...)` block, immediately after the `idx_tower_component_standard_key` index (line 507) and before the closing backtick (line 508), insert:

```sql
  CREATE TABLE IF NOT EXISTS inspection_trace_point (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    line_id INTEGER,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy_m REAL,
    km REAL,
    recorded_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    crew_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_inspection_trace_point_task ON inspection_trace_point(task_id);
  CREATE INDEX IF NOT EXISTS idx_inspection_trace_point_line ON inspection_trace_point(line_id);
```

- [ ] **Step 2: Write the failing pure check**

Create `/tmp/inspection-trace-check.js`:

```js
const assert = require('assert');
const { validatePoints, coverage } = require('/workspace/backend/inspectionTrace');

const route = [[0, 0], [0, 0.01], [0, 0.02]];
const towers = [
  { id: 1, km_marker: 0 },
  { id: 2, km_marker: 1 },
  { id: 3, km_marker: 2 },
];

let r = coverage({ lineId: 9, route, towers, tasks: [], traceTaskIds: [] });
assert.strictEqual(r.total_towers, 3);
assert.strictEqual(r.inspected_towers, 0);
assert.strictEqual(r.tower_progress, 0);
assert.deepStrictEqual(r.covered_spans, []);
assert.strictEqual(r.inspected_km, 0);

r = coverage({ lineId: 9, route, towers, tasks: [{ id: 11, status: 'COMPLETED', tower_id: 2 }], traceTaskIds: [11] });
assert.strictEqual(r.inspected_towers, 1);
assert.deepStrictEqual(r.inspected_tower_ids, [2]);
assert.deepStrictEqual(r.covered_spans, []);
assert.strictEqual(r.inspected_km, 0);
assert.deepStrictEqual(r.trace_task_ids, [11]);

r = coverage({ lineId: 9, route, towers, tasks: [
  { id: 11, status: 'COMPLETED', tower_id: 1 },
  { id: 12, status: 'COMPLETED', tower_id: 2 },
], traceTaskIds: [] });
assert.deepStrictEqual(r.covered_spans, [[0, 1]]);
assert.strictEqual(r.inspected_km, 1);
assert.ok(r.km_progress > 0 && r.km_progress < 1);

r = coverage({ lineId: 9, route, towers, tasks: [{ id: 14, status: 'COMPLETED', tower_id: '2' }], traceTaskIds: [] });
assert.deepStrictEqual(r.inspected_tower_ids, [2]);

r = coverage({ lineId: 9, route, towers, tasks: [{ id: 13, status: 'COMPLETED', tower_id: null }], traceTaskIds: [] });
assert.strictEqual(r.inspected_towers, 3);
assert.strictEqual(r.km_progress, 1);
assert.strictEqual(r.covered_spans.length, 1);
assert.strictEqual(r.covered_paths.length, 1);

assert.throws(() => validatePoints([{ lat: 200, lng: 0 }]), /lat/);
assert.throws(() => validatePoints([]), /1\.\.500/);
const ok = validatePoints([{ lat: 9.1, lng: 38.6, accuracy_m: 5, recorded_at: '2026-09-11T00:00:00Z' }]);
assert.strictEqual(ok[0].lat, 9.1);
assert.strictEqual(ok[0].accuracy_m, 5);

console.log('inspection-trace checks passed');
```

- [ ] **Step 3: Run the check to verify it fails**

Run: `node /tmp/inspection-trace-check.js`
Expected: FAIL — `Cannot find module '/workspace/backend/inspectionTrace'`.

- [ ] **Step 4: Implement `backend/inspectionTrace.js`**

```js
// Pure inspection-trace helpers. No DB access, no Express.
const { distanceAlongRoute, interpolate } = require('./lineGeometry');

const MAX_POINTS = 500;

function validatePoints(points) {
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS) {
    throw new Error(`points must be an array of 1..${MAX_POINTS} entries`);
  }
  return points.map((p, i) => {
    const n = i + 1;
    if (!p || typeof p !== 'object') throw new Error(`point ${n} is invalid`);
    if (p.lat == null || p.lat === '' || p.lng == null || p.lng === '') {
      throw new Error(`point ${n}: lat and lng are required`);
    }
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`point ${n}: lat must be -90..90`);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error(`point ${n}: lng must be -180..180`);
    let accuracy_m = null;
    if (p.accuracy_m != null && p.accuracy_m !== '') {
      const a = Number(p.accuracy_m);
      if (!Number.isFinite(a) || a < 0) throw new Error(`point ${n}: accuracy_m must be >= 0`);
      accuracy_m = a;
    }
    let recorded_at = null;
    if (p.recorded_at != null && p.recorded_at !== '') {
      const d = new Date(p.recorded_at);
      if (Number.isNaN(d.getTime())) throw new Error(`point ${n}: recorded_at must be an ISO date`);
      recorded_at = d.toISOString();
    }
    return { lat, lng, accuracy_m, recorded_at };
  });
}

function emptyCoverage(lineId) {
  return {
    line_id: lineId, total_towers: 0, inspected_towers: 0, tower_progress: 0,
    total_km: 0, inspected_km: 0, km_progress: 0,
    covered_spans: [], covered_paths: [], inspected_tower_ids: [], trace_task_ids: [],
  };
}

function pathForSpan(route, fromKm, toKm) {
  const n = Math.max(2, Math.min(100, Math.ceil(toKm - fromKm) * 2 || 2));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const p = interpolate(route, fromKm + ((toKm - fromKm) * i) / n);
    if (p) pts.push([+p[0].toFixed(6), +p[1].toFixed(6)]);
  }
  return pts;
}

function coverage({ lineId, route, towers, tasks, traceTaskIds }) {
  const out = emptyCoverage(lineId);
  const ordered = [...(towers || [])].sort(
    (a, b) => (Number(a.km_marker) || 0) - (Number(b.km_marker) || 0) || a.id - b.id
  );
  out.total_towers = ordered.length;
  const list = tasks || [];
  const lineComplete = list.some((t) => t.status === 'COMPLETED' && t.tower_id == null);
  const completedTowers = new Set(
    list.filter((t) => t.status === 'COMPLETED' && t.tower_id != null).map((t) => Number(t.tower_id))
  );
  const inspected = new Set();
  for (const tw of ordered) {
    if (lineComplete || completedTowers.has(Number(tw.id))) inspected.add(tw.id);
  }
  out.inspected_tower_ids = ordered.filter((tw) => inspected.has(tw.id)).map((tw) => tw.id);
  out.inspected_towers = out.inspected_tower_ids.length;
  out.tower_progress = out.total_towers ? out.inspected_towers / out.total_towers : 0;
  out.trace_task_ids = [...new Set(traceTaskIds || [])];

  const validRoute = Array.isArray(route) && route.length >= 2;
  out.total_km = validRoute ? distanceAlongRoute(route) : 0;

  let spans = [];
  if (lineComplete && validRoute) {
    spans = [[0, out.total_km]];
  } else {
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (!inspected.has(a.id) || !inspected.has(b.id)) continue;
      const ka = Number(a.km_marker) || 0;
      const kb = Number(b.km_marker) || 0;
      if (kb > ka) spans.push([ka, kb]);
    }
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(s[0] - last[1]) < 1e-6) last[1] = s[1];
      else merged.push([s[0], s[1]]);
    }
    spans = merged;
  }
  out.covered_spans = spans.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
  const rawInspectedKm = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  out.inspected_km = Math.round(rawInspectedKm * 10) / 10;
  out.km_progress = lineComplete && validRoute
    ? 1
    : (out.total_km ? Math.min(1, rawInspectedKm / out.total_km) : 0);
  out.covered_paths = validRoute ? spans.map(([a, b]) => pathForSpan(route, a, b)) : [];
  return out;
}

module.exports = { validatePoints, coverage };
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `node /tmp/inspection-trace-check.js`
Expected: `inspection-trace checks passed`

- [ ] **Step 6: Verify DB loads and syntax**

Run: `node --check backend/inspectionTrace.js && node --check backend/db.js && TMMS_DB=/tmp/tmms-e1.db node -e "require('./backend/db')"`
Expected: no output, exit 0. (The `TMMS_DB` override keeps the real `backend/tmms.db` untouched.)

- [ ] **Step 7: Commit**

```bash
git add backend/db.js backend/inspectionTrace.js
git commit -m "feat(trace): add inspection_trace_point table and pure coverage module"
```

---

### Task 2: Trace append/read endpoints

**Files:**
- Modify: `backend/routes/tasks.js` (imports; add routes after line 795, before `module.exports` at line 956)

**Interfaces:**
- Consumes: `validatePoints`, `coverage` from Task 1; `projectPointToRoute` from `backend/lineGeometry.js`; `taskVisible`, `can`, `isCrewUser`, `audit` from `backend/auth.js`; `get`, `insertRow` from `backend/util.js`.
- Produces:
  - `POST /tasks/:id/trace` → `201 { inserted }`
  - `GET /tasks/:id/trace` → `{ points: [{ lat, lng, km, accuracy_m, recorded_at }], coverage: <summary|null> }`

- [ ] **Step 1: Add imports and a task-trace helper**

At the top of `backend/routes/tasks.js`, after line 9 (`const recurrence = require('../recurrence');`), add:

```js
const { validatePoints, coverage } = require('../inspectionTrace');
const { projectPointToRoute } = require('../lineGeometry');
```

Then add this helper immediately before `module.exports = router;` at the end of the file:

```js
function lineCoverageFor(lineId, route) {
  const towers = db.prepare('SELECT id, km_marker, latitude, longitude FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId);
  const tasks = db.prepare('SELECT id, status, tower_id FROM task WHERE line_id = ? OR tower_id IN (SELECT id FROM tower WHERE line_id = ?)').all(lineId, lineId);
  const traceTaskIds = db.prepare('SELECT DISTINCT task_id FROM inspection_trace_point WHERE line_id = ?').all(lineId).map((r) => r.task_id);
  return coverage({ lineId, route, towers, tasks, traceTaskIds });
}
```

- [ ] **Step 2: Add the append endpoint**

Insert before `module.exports = router;` at the end of the file:

```js
router.post('/tasks/:id/trace', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (!can(req, 'task:execute')) return res.status(403).json({ error: 'Forbidden: requires task:execute' });
  if (isCrewUser(req.user) && !(t.crew_id && t.crew_id === req.user.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  if (!t.line_id) return res.status(400).json({ error: 'Task is not associated with a transmission line' });
  let points;
  try { points = validatePoints(req.body.points); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const line = get('transmission_line', t.line_id, ['route_json']);
  const route = line && Array.isArray(line.route_json) ? line.route_json : [];
  const now = new Date().toISOString();
  const crewId = req.body.crew_id || t.crew_id || null;
  let inserted = 0;
  for (const p of points) {
    const proj = route.length >= 2 ? projectPointToRoute(route, p.lat, p.lng) : null;
    insertRow('inspection_trace_point', {
      task_id: t.id,
      line_id: t.line_id,
      lat: p.lat,
      lng: p.lng,
      accuracy_m: p.accuracy_m,
      km: proj ? proj.km : null,
      recorded_at: p.recorded_at || now,
      created_at: now,
      crew_id: crewId,
    });
    inserted += 1;
  }
  audit(req.user, 'TRACE', 'task', t.id, { inserted });
  res.status(201).json({ inserted });
});
```

- [ ] **Step 3: Add the read endpoint**

Insert immediately after the append endpoint:

```js
router.get('/tasks/:id/trace', (req, res) => {
  const t = get('task', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!taskVisible(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const points = db.prepare(
    'SELECT lat, lng, km, accuracy_m, recorded_at FROM inspection_trace_point WHERE task_id = ? ORDER BY recorded_at, id'
  ).all(t.id);
  let cov = null;
  if (t.line_id) {
    const line = get('transmission_line', t.line_id, ['route_json']);
    const route = line && Array.isArray(line.route_json) ? line.route_json : [];
    cov = lineCoverageFor(t.line_id, route);
  }
  res.json({ points, coverage: cov });
});
```

- [ ] **Step 4: Verify syntax**

Run: `node --check backend/routes/tasks.js`
Expected: exit 0.

- [ ] **Step 5: Manual smoke on a scratch DB**

```bash
cp backend/tmms.db /tmp/tmms-e2.db
TMMS_DB=/tmp/tmms-e2.db PORT=3018 node backend/server.js
```

In a second shell, log in and exercise the endpoints (replace `<pid>` with an existing line task id, e.g. 6):

```bash
TOKEN=$(curl -s -X POST localhost:3018/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
curl -s -X POST localhost:3018/api/tasks/6/trace -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"points":[{"lat":9.1374,"lng":38.6670,"accuracy_m":5}]}'
curl -s localhost:3018/api/tasks/6/trace -H "Authorization: Bearer $TOKEN"
```

Expected: append returns `{"inserted":1}`; read returns `points` with a numeric `km` and a `coverage` object. Stop the scratch server by its PID.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(trace): append and read task inspection trace endpoints"
```

---

### Task 3: Line inspection-progress endpoint

**Files:**
- Modify: `backend/routes/core.js` (import at line 9-10 area; route after `GET /lines/:id` ending line 512)

**Interfaces:**
- Consumes: `coverage` from Task 1; `get`, `db`, `checkRegion` already imported.
- Produces: `GET /lines/:id/inspection-progress` → coverage summary object.

- [ ] **Step 1: Add the import**

In `backend/routes/core.js` after line 9 (`const { spaceAlongRoute, distanceAlongRoute } = require('../lineGeometry');`), add:

```js
const { coverage } = require('../inspectionTrace');
```

- [ ] **Step 2: Add the endpoint**

Insert immediately after the `GET /lines/:id` handler (after line 512):

```js
router.get('/lines/:id/inspection-progress', (req, res) => {
  const r = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!r) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, r.region_id)) return;
  const route = Array.isArray(r.route_json) ? r.route_json : [];
  const towers = db.prepare('SELECT id, km_marker, latitude, longitude FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(r.id);
  const tasks = db.prepare('SELECT id, status, tower_id FROM task WHERE line_id = ? OR tower_id IN (SELECT id FROM tower WHERE line_id = ?)').all(r.id, r.id);
  const traceTaskIds = db.prepare('SELECT DISTINCT task_id FROM inspection_trace_point WHERE line_id = ?').all(r.id).map((x) => x.task_id);
  res.json(coverage({ lineId: r.id, route, towers, tasks, traceTaskIds }));
});
```

- [ ] **Step 3: Verify syntax and smoke**

Run: `node --check backend/routes/core.js`
Expected: exit 0.

On the scratch server from Task 2:

```bash
curl -s localhost:3018/api/lines/1/inspection-progress -H "Authorization: Bearer $TOKEN"
```

Expected: JSON with `total_towers`, `inspected_towers`, `tower_progress`, `total_km`, `inspected_km`, `km_progress`, `covered_spans`, `covered_paths`, `inspected_tower_ids`, `trace_task_ids`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/core.js
git commit -m "feat(trace): line inspection-progress endpoint"
```

---

### Task 4: LineWorkspaceMap trace/coverage props

**Files:**
- Modify: `frontend/src/components/LineWorkspaceMap.jsx`

**Interfaces:**
- Consumes: `route`, `towers` (existing).
- Produces: optional props `tracePoints: [lat,lng][]`, `coveredPaths: [[[lat,lng],...]]`, `inspectedIds: Set<number>|null`. Existing callers are unaffected.

- [ ] **Step 1: Add colors and props**

Replace the `COLORS` object (lines 4-12) with:

```js
const COLORS = {
  existing: '#14532d',
  new: '#16a34a',
  edited: '#d97706',
  deleted: '#9ca3af',
  selected: '#2563eb',
  bulk: '#7c3aed',
  waypoint: '#0ea5e9',
  trace: '#ea580c',
  covered: '#16a34a',
  inspected: '#0d9488',
  remaining: '#94a3b8',
};
```

In the component signature, after `height = 520,` add:

```js
  tracePoints = EMPTY,
  coveredPaths = EMPTY,
  inspectedIds = null,
```

Also add a module-level stable empty array next to `COLORS` (so omitting these props does not change deps identity every render):

```js
const EMPTY = [];
```

- [ ] **Step 2: Track the new data in refs**

Replace the `data.current = ...` line (line 48) with:

```js
  data.current = { route, towers, routeMode, bulkMode, selectedId, inspectedIds };
```

- [ ] **Step 3: Render coverage, planned route, and trace**

In the rebuild effect, replace the route-drawing block (lines 82-84):

```js
    if (route.length > 1) {
      L.polyline(route, { color: '#2563eb', weight: 3, opacity: 0.85 }).addTo(layer);
    }
```

with:

```js
    coveredPaths.forEach((path) => {
      if (Array.isArray(path) && path.length > 1) {
        L.polyline(path, { color: COLORS.covered, weight: 6, opacity: 0.35 }).addTo(layer);
      }
    });
    if (route.length > 1) {
      L.polyline(route, { color: '#2563eb', weight: 3, opacity: 0.85 }).addTo(layer);
    }
    if (tracePoints.length > 1) {
      L.polyline(tracePoints, { color: COLORS.trace, weight: 3, opacity: 0.9 }).addTo(layer);
    }
```

- [ ] **Step 4: Color towers by inspection when provided**

In the tower loop, replace the color line (line 102):

```js
        const color = isSel ? COLORS.selected : isBulk ? COLORS.bulk : (COLORS[t.state] || COLORS.existing);
```

with:

```js
        const inspection = inspectedIds instanceof Set;
        const isInspected = inspection && inspectedIds.has(t.id);
        const color = inspection
          ? (isInspected ? COLORS.inspected : COLORS.remaining)
          : (isSel ? COLORS.selected : isBulk ? COLORS.bulk : (COLORS[t.state] || COLORS.existing));
```

And replace the tooltip line (line 114):

```js
        m.bindTooltip(`${t.tower_id}${t.state && t.state !== 'existing' ? ` · ${t.state}` : ''}`, { direction: 'top' });
```

with:

```js
        m.bindTooltip(
          `${t.tower_id}${isInspected ? ' · inspected' : ''}${t.state && t.state !== 'existing' ? ` · ${t.state}` : ''}`,
          { direction: 'top' }
        );
```

- [ ] **Step 5: Add the new values to the effect dependency array**

Replace line 119:

```js
  }, [route, towers, selectedId, bulkSelected, routeMode, bulkMode]);
```

with:

```js
  }, [route, towers, selectedId, bulkSelected, routeMode, bulkMode, tracePoints, coveredPaths, inspectedIds]);
```

- [ ] **Step 6: Verify build**

Run: `cd frontend && npm run build`
Expected: exit 0 (pre-existing chunk-size warning acceptable).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/LineWorkspaceMap.jsx
git commit -m "feat(trace): optional trace and coverage layers on the line map"
```

---

### Task 5: Recorder hook + TaskDetail route map

**Files:**
- Create: `frontend/src/useRouteRecorder.js`
- Modify: `frontend/src/pages/TaskDetail.jsx`

**Interfaces:**
- Consumes: `api` (`frontend/src/api.js`); `LineWorkspaceMap` props from Task 4.
- Produces: `useRouteRecorder(taskId, onSaved)` → `{ recording, count, accuracy, error, start, stop }`.

- [ ] **Step 1: Create the hook**

Create `frontend/src/useRouteRecorder.js`:

```js
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

const MIN_MOVE_M = 10;
const FLUSH_EVERY = 25;
const FLUSH_MS = 15000;

function metersBetween(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export default function useRouteRecorder(taskId, onSaved) {
  const [recording, setRecording] = useState(false);
  const [count, setCount] = useState(0);
  const [accuracy, setAccuracy] = useState(null);
  const [error, setError] = useState(null);
  const watchRef = useRef(null);
  const timerRef = useRef(null);
  const bufferRef = useRef([]);
  const lastRef = useRef(null);
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const flush = useCallback(async () => {
    const points = bufferRef.current;
    if (!points.length) return;
    bufferRef.current = [];
    try {
      await api.post(`/tasks/${taskId}/trace`, { points });
    } catch (e) {
      bufferRef.current = points.concat(bufferRef.current);
      setError(e.message);
    }
  }, [taskId]);

  const stop = useCallback(async () => {
    if (watchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setRecording(false);
    await flush();
    if (savedRef.current) savedRef.current();
  }, [flush]);

  const start = useCallback(() => {
    if (watchRef.current != null) return;
    setError(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Geolocation is unavailable. The app must be served over HTTPS.');
      return;
    }
    lastRef.current = null;
    setCount(0);
    setRecording(true);
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Math.round(pos.coords.accuracy || 0),
          recorded_at: new Date().toISOString(),
        };
        setAccuracy(p.accuracy_m);
        if (lastRef.current && metersBetween(lastRef.current, p) < MIN_MOVE_M) return;
        lastRef.current = p;
        bufferRef.current.push(p);
        setCount((c) => c + 1);
        if (bufferRef.current.length >= FLUSH_EVERY) flush();
      },
      (err) => {
        setError(err && err.code === 1 ? 'Location access was denied.' : 'Could not determine device location.');
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    timerRef.current = setInterval(flush, FLUSH_MS);
  }, [flush]);

  useEffect(() => () => {
    if (watchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  return { recording, count, accuracy, error, start, stop, flush };
}
```

- [ ] **Step 2: Import and state in TaskDetail**

In `frontend/src/pages/TaskDetail.jsx`, after line 10 (`import ViewMap from '../components/ViewMap';`) add:

```js
import LineWorkspaceMap from '../components/LineWorkspaceMap';
import useRouteRecorder from '../useRouteRecorder';
```

After line 47 (`const [fuTemplate, setFuTemplate] = useState({});`) add:

```js
  const [trace, setTrace] = useState(null);
  const [lineDetail, setLineDetail] = useState(null);
```

- [ ] **Step 3: Load trace and line detail; create the recorder**

After the `useEffect` ending at line 57 and before `async function fetchChecklist()` (line 59), add:

```js
  const lineId = task && task.line_id;
  const loadTrace = () => {
    if (!lineId) { setTrace(null); return; }
    api.get(`/tasks/${id}/trace`).then(setTrace).catch(() => setTrace(null));
  };

  useEffect(() => {
    if (!lineId) { setTrace(null); setLineDetail(null); return; }
    loadTrace();
    api.get(`/lines/${lineId}`).then(setLineDetail).catch(() => setLineDetail(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, id]);

  const recorder = useRouteRecorder(id, loadTrace);
```

- [ ] **Step 4: Replace the map block**

Replace the `{targetPos && ( ... )}` block (lines 191-201) with:

```jsx
      {t.line_id ? (
        <>
          <div className="lw-toolbar">
            {t.status !== 'COMPLETED' && canExecute && (
              <button className="btn btn-sm" onClick={() => (recorder.recording ? recorder.stop() : recorder.start())}>
                {recorder.recording ? 'Stop route' : 'Record route'}
              </button>
            )}
            {recorder.recording && (
              <span className="muted">
                Recording · {recorder.count} points{recorder.accuracy != null ? ` · ±${recorder.accuracy} m` : ''}
              </span>
            )}
            {recorder.error && <span className="error">{recorder.error}</span>}
          </div>
          <LineWorkspaceMap
            route={(lineDetail && lineDetail.route_json) || t.line?.route_json || []}
            towers={((lineDetail && lineDetail.towers) || []).map((tw) => ({ ...tw, lat: tw.latitude, lng: tw.longitude, state: 'existing' }))}
            inspectedIds={trace && trace.coverage ? new Set(trace.coverage.inspected_tower_ids) : null}
            coveredPaths={(trace && trace.coverage && trace.coverage.covered_paths) || []}
            tracePoints={((trace && trace.points) || []).map((p) => [p.lat, p.lng])}
            lineId={t.line_id}
            height={260}
          />
          {trace && trace.coverage && (
            <div className="muted" style={{ fontSize: 13 }}>
              Inspected {trace.coverage.inspected_towers}/{trace.coverage.total_towers} towers ·{' '}
              {trace.coverage.inspected_km}/{Math.round((trace.coverage.total_km || 0) * 10) / 10} km ·{' '}
              {Math.round((trace.coverage.tower_progress || 0) * 100)}%
            </div>
          )}
        </>
      ) : targetPos && (
        <ViewMap
          height={200}
          center={targetPos}
          markers={[{ lat: targetPos.lat, lng: targetPos.lng, label: targetPos.label, sub: 'Work target', color: '#dc2626', radius: 7 }]}
          radius={GPS_TOLERANCE}
          radiusLatLng={{ lat: targetPos.lat, lng: targetPos.lng }}
          zoom={12}
          fit={false}
        />
      )}
```

- [ ] **Step 5: Verify build**

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/useRouteRecorder.js frontend/src/pages/TaskDetail.jsx
git commit -m "feat(trace): route recorder and per-task trace map"
```

---

### Task 6: Line workspace inspection-progress overlay

**Files:**
- Modify: `frontend/src/pages/LineMapWorkspace.jsx`

**Interfaces:**
- Consumes: `GET /lines/:id/inspection-progress` (Task 3); `LineWorkspaceMap` props (Task 4).
- Produces: a read-only overlay; no change to tower/route editing behavior.

- [ ] **Step 1: Add state**

After line 95 (`const [locating, setLocating] = useState(false);`) add:

```js
  const [showProgress, setShowProgress] = useState(false);
  const [progress, setProgress] = useState(null);
```

- [ ] **Step 2: Load progress when toggled**

After the line-detail effect ending at line 125, add:

```js
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
```

Add `const EMPTY = [];` at module scope next to `STATE_COLOR` so the toggled-off
value is reference-stable.

- [ ] **Step 3: Add the toggle in the body**

In the `body` JSX, immediately after `{toolbar}` (line 459), add:

```jsx
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
```

- [ ] **Step 4: Pass the overlay to the map**

In the `<LineWorkspaceMap ... />` element (lines 524-539), add these props after `bulkMode={bulkMode}`:

```jsx
              coveredPaths={coveredPaths}
              inspectedIds={inspectedIds}
```

- [ ] **Step 5: Verify build**

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/LineMapWorkspace.jsx
git commit -m "feat(trace): inspection-progress overlay in the line workspace"
```

---

### Task 7: End-to-end verification (no commit)

**Files:** none (verification only).

- [ ] **Step 1: Syntax sweep**

Run:

```bash
node --check backend/inspectionTrace.js
node --check backend/db.js
node --check backend/routes/tasks.js
node --check backend/routes/core.js
node /tmp/inspection-trace-check.js
```

Expected: all exit 0; `inspection-trace checks passed`.

- [ ] **Step 2: Fresh scratch DB and server**

```bash
cp backend/tmms.db /tmp/tmms-e3.db
TMMS_DB=/tmp/tmms-e3.db PORT=3019 node backend/server.js
```

(backup `-wal`/`-shm` if present). Log in as `admin`/`Admin@123`.

- [ ] **Step 3: Verify the full flow on an isolated region**

Use line 1 (`TL-C1-001`) and two adjacent tower task ids on it. Append a trace to a line task, read it back, verify `km` is numeric, then complete tasks and check progress:

```bash
# append
curl -s -X POST localhost:3019/api/tasks/<T1>/trace -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"points":[{"lat":9.1374,"lng":38.6670,"accuracy_m":5},{"lat":9.1380,"lng":38.6676,"accuracy_m":6}]}'
# read
curl -s localhost:3019/api/tasks/<T1>/trace -H "Authorization: Bearer $TOKEN"
# progress
curl -s localhost:3019/api/lines/1/inspection-progress -H "Authorization: Bearer $TOKEN"
```

Expected: `{"inserted":2}`; points carry numeric `km`; progress shows `total_towers=40` and a populated `trace_task_ids`.

- [ ] **Step 4: Confirm coverage increases only on COMPLETED**

Complete a tower task via `POST /tasks/<T1>/state` with `{"action":"verify","result":"PASS"}` (requires its status to allow verify and, if the template requires GPS, an existing `gps_validation`; pick a template that does not require GPS, or submit the checklist with `finish_gps` first). Re-fetch progress and confirm `inspected_towers` increases by one and the tower id appears in `inspected_tower_ids`. Then verify a second adjacent tower task and confirm `covered_spans` becomes non-empty and `km_progress > 0`.

A completed LINE-scope task (a task on line 1 with no `tower_id`) must make `km_progress = 1` and `inspected_towers = total_towers`.

- [ ] **Step 5: Frontend build**

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 6: Cleanup and status**

Stop the scratch server by PID; confirm the real `backend/tmms.db` is untouched (`git status --porcelain` shows no tracked DB change) and that `frontend/dist/` and `backend/uploads/` are not staged.
