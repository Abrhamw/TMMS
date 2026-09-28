# Geo Route/Asset Import & Asset Default Crew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import transmission-line routes from GeoJSON/KML/KMZ/WKT/CSV with auto `length_km`, import KMZ/KML placemark assets behind a dry-run preview, and add a per-asset `default_crew_id` that pre-fills task creation and takes precedence over the schedule's crew at generation time.

**Architecture:** One new pure Node module `backend/geoimport.js` owns all geometry parsing (GeoJSON/KML text-scan/KMZ-via-adm-zip/WKT/CSV + placemark extraction) and returns `[lat,lng]` pairs matching TMMS's existing `route_json` convention (see `rebuildLineRoute` in `backend/routes/core.js:9-20`). Route import becomes a single ADMIN-gated `POST /lines/import-route` in core.js; asset import is `POST /assets/import-geo/preview` + `POST /assets/import-geo` in assets.js with a short-TTL in-memory token. `default_crew_id` is a schema migration plus serializer enrichment; the schedule runner picks `asset.default_crew_id → schedule.responsible_crew_id → null`.

**Tech Stack:** Node 22 (`node:sqlite`), Express 5, plain React (Vite). One new backend dependency: `adm-zip` (pure JS, for KMZ). No frontend dependencies.

## Global Constraints

- Master-data writes are ADMIN-only in practice because only the ADMIN role holds `line:write`/`asset:write` — gate every new import endpoint with `can(req, 'line:write')` / `can(req, 'asset:write')` and keep the existing `checkRegion` guards.
- `route_json` is stored as an array of `[lat, lng]` pairs — convert every GeoJSON/KML source coordinate (`[lng, lat]`) into `[lat, lng]` before storing.
- `transmission_line.length_km` ALREADY exists (`db.js:79`) — no migration for it. Only migration needed: `asset.default_crew_id`.
- Coordinates must be validated (>= 2 points; each lat in [-90,90], lng in [-180,180]); parse fully before any insert — never partially insert on validation failure.
- Task numbering in the schedule runner must use a robust regex scan (`/^TK-(\d{4})-(\d+)$/`) — the current `parseInt(last.task_number.split('-').pop())` at `backend/routes/schedules.js:150-152` yields `NaN` after legacy `TK-SCRATCH-*` rows.
- All tests run against an isolated copy of the DB on port **3198** so the live DB on :3001 is untouched. Test entities use timestamp-suffixed codes so reruns never collide on `UNIQUE` columns.
- Non-ADMIN import attempts must return 403. Do not run destructive commands; stop background services via `background_terminal_kill <id>`.
- Follow existing code style: 2-space indent, `const`, terse existing-style comments only.

---

### Task 1: `adm-zip` dependency + `asset.default_crew_id` migration + serializer enrichment

**Files:**
- Modify: `backend/package.json` (dependency added by npm)
- Modify: `backend/db.js` (migration)
- Modify: `backend/routes/assets.js` (`enrichAsset`)

**Interfaces:**
- Produces: `asset` rows carry `default_crew_id`; every asset payload from `GET /assets` and `GET /assets/:id` includes `default_crew_id` and resolved `default_crew: { id, name } | null`. Later tasks rely on this.

- [ ] **Step 1: Install adm-zip in the backend project**

Run: `cd /workspace/backend && npm install adm-zip`
Verify: `node -e "console.log(require('adm-zip') ? 'adm-zip ok' : 'missing')"` prints `adm-zip ok`.
(If the registry is unreachable, stop and tell the user the KMZ path needs network access; do not hand-roll a zip parser.)

- [ ] **Step 2: Add the schema migration**

In `backend/db.js`, in the block of `migrate(...)` calls (around lines 468-491, just before the closing `}` of the schema function), add:

```js
  migrate('asset', 'default_crew_id', 'ALTER TABLE asset ADD COLUMN default_crew_id INTEGER REFERENCES crew(id)');
```

- [ ] **Step 3: Enrich the asset serializer**

Edit `backend/routes/assets.js`. Replace the `enrichAsset` function (lines 30-33) with:

```js
function enrichAsset(a) {
  const h = computeHealth(a);
  const out = { ...a, health_index: h.health_index, remaining_useful_life_years: h.remaining_useful_life_years };
  out.default_crew = out.default_crew_id ? get('crew', out.default_crew_id) : null;
  return out;
}
```

- [ ] **Step 4: Syntax check + verify list/detail shape on the isolated instance**

Run: `cd /workspace/backend && node -c db.js && node -c routes/assets.js`

Prepare the isolated instance (reuse from now on):
`cp -f /workspace/backend/tmms.db /tmp/opencode/tmms-g.db`
Create a background terminal (record its id as the "geo verify terminal"; restart it after every code edit in this plan):

```
cd /workspace/backend && TMMS_DB=/tmp/opencode/tmms-g.db PORT=3198 node server.js
```

Wait for `TMMS backend listening on http://localhost:3198`. Then run:

```python
python3 - <<'PY'
import json, urllib.request, urllib.error
BASE = 'http://localhost:3198'
def req(method, path, token=None, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header('Content-Type', 'application/json')
    if token: r.add_header('Authorization', 'Bearer ' + token)
    d = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, d) as resp:
            return resp.status, json.loads(resp.read() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or '{}')
def login(u, p):
    s, r = req('POST', '/api/auth/login', body={'username': u, 'password': p})
    assert s == 200, r
    return r['token']
adm = login('admin', 'Admin@123')
st, assets = req('GET', '/api/assets', token=adm)
assert st == 200 and isinstance(assets, list) and assets, (st, assets[:1])
a = assets[0]
assert 'default_crew_id' in a and ('default_crew' in a), a.keys()
assert a['default_crew'] is None or ('name' in a['default_crew'])
print('OK default_crew fields on', len(assets), 'assets; sample:', a['asset_id'], a['default_crew'])
PY
```

Expected: `OK default_crew fields on N assets...`.

- [ ] **Step 5: Commit**

```bash
git add backend/db.js backend/routes/assets.js backend/package.json backend/package-lock.json
git commit -m "feat(assets): default_crew_id column, serializer resolution and adm-zip dependency"
```

---

### Task 2: `backend/geoimport.js` parsing module

**Files:**
- Create: `backend/geoimport.js`

**Interfaces:**
- Produces:
  - `parseRouteGeometry(format, content)` → `[ [lat,lng], ... ]` (>= 2 points, validated; throws `Error` with a specific message on any failure). `format ∈ geojson|kml|kmz|wkt|csv`; `content` is text, except `kmz` which is **base64**.
  - `coordsToKm(coords)` → rounded km via chained `haversine` (returns meters; divide by 1000), rounding to 2 dp.
  - `extractKmzText(base64)` → text of the first `.kml` entry inside the KMZ.
  - `extractPlacemarks(kmlText)` → `[{ name, kind: 'Point'|'LineString', lat, lng }]` (first `<coordinates>` tuple per `<Placemark>`; placemarks with no usable coordinates are omitted).
- Consumes: `haversine(aLat, aLng, bLat, bLng)` from `backend/geo.js`, `adm-zip`.

- [ ] **Step 1: Write the module**

Create `backend/geoimport.js`:

```js
const AdmZip = require('adm-zip');
const { haversine } = require('./geo');

function coordsToKm(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    m += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return Math.round((m / 1000) * 100) / 100;
}

function parsePair(str) {
  const p = String(str).split(',').map(Number);
  return p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : null;
}

function kmlToLatLng(text) {
  const blocks = [...String(text).matchAll(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi)];
  if (!blocks.length) throw new Error('KML contains no <coordinates> block');
  const pairs = blocks[0][1].trim().split(/\s+/).map(parsePair).filter(Boolean);
  if (pairs.length < 2) throw new Error('KML coordinates need at least 2 points');
  return pairs.map(([lng, lat]) => [lat, lng]);
}

function geojsonToLatLng(text) {
  const g = JSON.parse(text);
  const feat = g.type === 'FeatureCollection' ? (g.features && g.features[0]) : (g.type === 'Feature' ? g : (g.type ? g : null));
  if (!feat) throw new Error('GeoJSON contains no feature');
  const geom = feat.geometry || feat;
  if (!geom || geom.type !== 'LineString') throw new Error('GeoJSON must contain a LineString');
  const pairs = (geom.coordinates || []).map(parsePair).filter(Boolean);
  if (pairs.length < 2) throw new Error('GeoJSON LineString needs at least 2 points');
  return pairs.map(([lng, lat]) => [lat, lng]);
}

function wktToLatLng(text) {
  const m = String(text).match(/LINESTRING\s*\(\s*([\s\S]*?)\)/i);
  if (!m) throw new Error('WKT must be LINESTRING(lng lat, ...)');
  const pairs = m[1].split(',').map((tok) => {
    const n = tok.trim().split(/\s+/).map(Number);
    return n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1]) ? [n[0], n[1]] : null;
  }).filter(Boolean);
  if (pairs.length < 2) throw new Error('WKT needs at least 2 points');
  return pairs.map(([lng, lat]) => [lat, lng]);
}

function csvToLatLng(text) {
  const rows = String(text).split(/\r?\n/).map((line) => line.split(',').map(Number))
    .filter((r) => r.length >= 2 && r.slice(0, 2).every(Number.isFinite)).map((r) => r.slice(0, 2));
  if (rows.length < 2) throw new Error('CSV needs at least two coordinate rows');
  const latFirst = rows.every(([a]) => Math.abs(a) <= 90) && rows.some(([, b]) => Math.abs(b) > 90);
  return rows.map(([a, b]) => (latFirst ? [a, b] : [b, a]));
}

function extractKmzText(base64) {
  let zip;
  try { zip = new AdmZip(Buffer.from(base64, 'base64')); } catch (e) { throw new Error('Invalid KMZ (base64 zip)'); }
  const entry = zip.getEntries().find((en) => /\.kml$/i.test(en.entryName));
  if (!entry) throw new Error('No .kml entry inside KMZ');
  return entry.getData().toString('utf8');
}

function extractPlacemarks(kmlText) {
  const out = [];
  const marks = String(kmlText).matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi);
  for (const m of marks) {
    const body = m[1];
    const nm = body.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
    const cs = [...body.matchAll(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi)];
    if (!cs.length) continue;
    const pair = parsePair(cs[0][1].trim().split(/\s+/)[0]);
    if (!pair) continue;
    out.push({
      name: (nm ? nm[1].trim() : '') || 'Unnamed',
      kind: /<Point[\s/>]/i.test(body) ? 'Point' : 'LineString',
      lat: pair[1],
      lng: pair[0],
    });
  }
  return out;
}

function parseRouteGeometry(format, content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is required');
  let coords;
  if (format === 'geojson') coords = geojsonToLatLng(content);
  else if (format === 'kml') coords = kmlToLatLng(content);
  else if (format === 'kmz') coords = kmlToLatLng(extractKmzText(content));
  else if (format === 'wkt') coords = wktToLatLng(content);
  else if (format === 'csv') coords = csvToLatLng(content);
  else throw new Error(`Unknown format: ${format}`);
  for (const [lat, lng] of coords) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('Coordinate out of range');
  }
  return coords;
}

module.exports = { parseRouteGeometry, coordsToKm, extractKmzText, extractPlacemarks };
```

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c geoimport.js`

- [ ] **Step 3: Behaviour check with inline fixtures (no server needed)**

Create and run `/tmp/opencode/geoimport.check.cjs`:

```js
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const g = require('/workspace/backend/geoimport.js');

const geojson = '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[38.0,9.0],[38.5,9.2]]}}';
assert.deepStrictEqual(g.parseRouteGeometry('geojson', geojson), [[9.0, 38.0], [9.2, 38.5]]);

const kml = '<Placemark><name>r</name><LineString><coordinates>38.0,9.0,0 38.5,9.2,0</coordinates></LineString></Placemark>';
assert.strictEqual(g.parseRouteGeometry('kml', kml).length, 2);
assert.strictEqual(g.coordsToKm(g.parseRouteGeometry('kml', kml)) > 0, true);

const wkt = 'LINESTRING(38.0 9.0, 38.5 9.2)';
assert.strictEqual(g.parseRouteGeometry('wkt', wkt).length, 2);

const csv = '38.0,9.0\n38.5,9.2\n';
assert.strictEqual(g.parseRouteGeometry('csv', csv).length, 2);

// KMZ round-trip
const zip = new AdmZip();
zip.addFile('doc.kml', Buffer.from(kml));
const b64 = zip.toBuffer().toString('base64');
assert.strictEqual(g.parseRouteGeometry('kmz', b64).length, 2);

// Placemark extraction: one Point and one LineString; a no-coordinates placemark is skipped
const kml2 = '<Placemark><name>A</name><Point><coordinates>38.0,9.1</coordinates></Point></Placemark>'
  + '<Placemark><name>B</name><LineString><coordinates>38.0,9.0 38.2,9.1</coordinates></LineString></Placemark>'
  + '<Placemark><name>C</name><Point></Point></Placemark>';
assert.deepStrictEqual(g.extractPlacemarks(kml2).map((p) => p.name), ['A', 'B']);
assert.throws(() => g.parseRouteGeometry('geojson', '{"type":"LineString","coordinates":[[38,9]]}'));
console.log('geoimport checks OK');
```

Run: `node /tmp/opencode/geoimport.check.cjs` — expected `geoimport checks OK`.

- [ ] **Step 4: Commit**

```bash
git add backend/geoimport.js
git commit -m "feat(geoimport): geometry parsing module for geojson/kml/kmz/wkt/csv"
```

---

### Task 3: `POST /lines/import-route`

**Files:**
- Modify: `backend/routes/core.js`

**Interfaces:**
- Consumes: `parseRouteGeometry`, `coordsToKm` (Task 2); existing `can/checkRegion/audit/get/insertRow/updateRow`.
- Produces: `POST /lines/import-route` → `201 {line row}` (create) or `200 {line row}` (update). Body `{ mode, line_id?, name?, region_id?, voltage_kv?, from_substation_id?, to_substation_id?, format, content }`.

- [ ] **Step 1: Add the require and the route**

Edit `backend/routes/core.js`. After line 3 (`const { polygonFromCenter, haversine } = require('../geo');`) add:

```js
const { parseRouteGeometry, coordsToKm } = require('../geoimport');
```

Insert this route immediately **before** the existing `router.post('/lines', ...)` (line 489):

```js
// Import a line route from GeoJSON/KML/KMZ/WKT/CSV and auto-compute length.
// create mode needs the NOT NULL transmission_line columns (name, region,
// voltage_kv, from/to substation); update mode only replaces route + length.
router.post('/lines/import-route', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const { mode = 'create', line_id, name, region_id, voltage_kv, from_substation_id, to_substation_id, format, content } = req.body;
  if (!format || typeof content !== 'string') return res.status(400).json({ error: 'format and content are required' });
  let coords;
  try { coords = parseRouteGeometry(format, content); } catch (e) { return res.status(400).json({ error: e.message }); }
  const length_km = coordsToKm(coords);
  try {
    if (mode === 'update') {
      const line = get('transmission_line', Number(line_id));
      if (!line) return res.status(404).json({ error: 'Line not found' });
      if (!checkRegion(req, res, line.region_id)) return;
      updateRow('transmission_line', line.id, { route_json: JSON.stringify(coords), length_km, revision: 1 }, ['route_json'], 'revision');
      audit(req.user, 'IMPORT_ROUTE', 'line', line.id, { mode, format, points: coords.length, length_km });
      return res.json(get('transmission_line', line.id, ['route_json']));
    }
    const rid = Number(region_id);
    if (!get('region', rid)) return res.status(400).json({ error: 'region_id must reference an existing region' });
    if (!name || !voltage_kv || !from_substation_id || !to_substation_id) {
      return res.status(400).json({ error: 'create mode requires name, voltage_kv, from_substation_id, to_substation_id, region_id' });
    }
    const f = get('substation', Number(from_substation_id));
    const t = get('substation', Number(to_substation_id));
    if (!f || !t || f.region_id !== rid || t.region_id !== rid) {
      return res.status(400).json({ error: 'from/to substations must exist in the target region' });
    }
    const id = insertRow('transmission_line', {
      line_id: `LN-${Date.now()}`,
      name,
      region_id: rid,
      voltage_kv: Number(voltage_kv),
      from_substation_id: f.id,
      to_substation_id: t.id,
      route_json: JSON.stringify(coords),
      length_km,
      tower_count: 0,
      revision: 1,
    });
    audit(req.user, 'IMPORT_ROUTE', 'line', id, { mode, format, points: coords.length, length_km });
    res.status(201).json(get('transmission_line', id, ['route_json']));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c routes/core.js`

- [ ] **Step 3: Restart the geo verify terminal, then run the route-import checks**

Restart the geo verify terminal (Task 1 command). Run:

```python
python3 - <<'PY'
import json, urllib.request, urllib.error, time
BASE = 'http://localhost:3198'
def req(method, path, token=None, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header('Content-Type', 'application/json')
    if token: r.add_header('Authorization', 'Bearer ' + token)
    d = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, d) as resp:
            return resp.status, json.loads(resp.read() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or '{}')
def login(u, p):
    s, r = req('POST', '/api/auth/login', body={'username': u, 'password': p})
    assert s == 200, r
    return r['token']
adm = login('admin', 'Admin@123')
# pick two substations of region 1
st, subs = req('GET', '/api/substations', token=adm)
r1 = [s for s in subs if s['region_id'] == 1]
assert len(r1) >= 2
a, b = r1[0]['id'], r1[1]['id']
suffix = int(time.time() * 1000)
gj = '{"type":"Feature","geometry":{"type":"LineString","coordinates":[[38.0,9.0],[38.6,9.15],[39.1,9.3]]}}'
st, created = req('POST', '/api/lines/import-route', token=adm, body={
    'mode': 'create', 'name': f'VFY-GEO-{suffix}', 'region_id': 1, 'voltage_kv': 230,
    'from_substation_id': a, 'to_substation_id': b, 'format': 'geojson', 'content': gj})
assert st == 201, (st, created)
assert len(created['route_json']) == 3 and created['length_km'] > 0, created
# length_km sanity: >= straight-line distance over the same points
from math import radians, sin, cos, asin, sqrt
def hav(la1, lo1, la2, lo2):
    dlat = radians(la2-la1); dlon = radians(lo2-lo1)
    h = sin(dlat/2)**2 + cos(radians(la1))*cos(radians(la2))*sin(dlon/2)**2
    return 2*6371*asin(sqrt(h))
pts = [(9.0,38.0),(9.15,38.6),(9.3,39.1)]
expected = sum(hav(pts[i-1][0],pts[i-1][1],p[0],p[1]) for i,p in enumerate(pts) if i)
assert abs(created['length_km'] - expected) < 0.3, (created['length_km'], expected)
# update an existing line's route via kml text
kml = f'<Placemark><LineString><coordinates>38.0,9.0 39.2,9.4</coordinates></LineString></Placemark>'
st, upd = req('POST', '/api/lines/import-route', token=adm, body={'mode': 'update', 'line_id': created['id'], 'format': 'kml', 'content': kml})
assert st == 200 and len(upd['route_json']) == 2 and upd['length_km'] > 0, (st, upd)
# wrong format -> 400, manager -> 403
st, bad = req('POST', '/api/lines/import-route', token=adm, body={'mode': 'create', 'format': 'nonsense', 'content': 'x'})
assert st == 400, st
mgr = login('mgr.c1.tlom', 'Manager@123')
st, denied = req('POST', '/api/lines/import-route', token=mgr, body={'mode': 'create', 'format': 'geojson', 'content': gj})
assert st == 403, st
print('OK line import; geojson line id', created['id'], 'length_km', created['length_km'])
PY
```

Expected: `OK line import; geojson line id <id> length_km <km>`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/core.js
git commit -m "feat(lines): import route geometry with auto length and audit"
```

---

### Task 4: Asset geo import (preview + confirm)

**Files:**
- Modify: `backend/routes/assets.js`

**Interfaces:**
- Consumes: `extractKmzText`, `extractPlacemarks` (Task 2).
- Produces: `POST /assets/import-geo/preview` → `{ token, count, candidates:[{name, asset_type, kind, lat, lng, will_skip, reason}] }`; `POST /assets/import-geo` (body `{ token, default_region_id?, substation_id?, transmission_line_id? }`) → `{ created, skipped:[{name, reason}] }`. Both gated by `asset:write`; preview tokens are in-memory with a 30-minute TTL.

- [ ] **Step 1: Add module-level state and the two routes**

Edit `backend/routes/assets.js`. After line 5 (`const router = express.Router();`) add:

```js
const { extractKmzText, extractPlacemarks } = require('../geoimport');

const pendingPreviews = new Map();
let previewSeq = 1;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPreviews) if (now - v.at > PREVIEW_TTL_MS) pendingPreviews.delete(k);
}, 5 * 60 * 1000).unref();

function guessAssetType(name) {
  const n = String(name || '').toUpperCase();
  const map = [['TRANSFORMER', 'TRANSFORMER'], ['CIRCUIT BREAKER', 'CIRCUIT_BREAKER'], ['BREAKER', 'CIRCUIT_BREAKER'],
    ['DISCONNECTOR', 'DISCONNECTOR'], ['CT ', 'CT'], ['VT ', 'VT'], ['RELAY', 'PROTECTION_RELAY'], ['BATTERY', 'BATTERY_BANK'],
    ['RTU', 'SCADA_RTU'], ['REACTOR', 'REACTOR'], ['CAPACITOR', 'CAPACITOR_BANK'], ['BUSBAR', 'BUSBAR'], ['GIS', 'GIS'],
    ['ARRESTER', 'LIGHTNING_ARRESTER'], ['INSULATOR', 'INSULATOR_STRING'], ['METER', 'METER']];
  for (const [needle, type] of map) if (n.includes(needle)) return type;
  return 'OTHER';
}
```

Insert the two routes just after the existing `GET /assets/summary` route (after line 79) and before `POST /assets/:id/evaluation`:

```js
// Dry-run: parse a KMZ/KML placemark set and echo what would be imported.
router.post('/assets/import-geo/preview', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const { format, content, default_region_id, substation_id, transmission_line_id } = req.body;
  let marks;
  try {
    const text = format === 'kmz' ? extractKmzText(content) : content;
    marks = extractPlacemarks(text);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!marks.length) return res.status(400).json({ error: 'No usable placemarks found (each needs a name + coordinates)' });
  const deriveRegion = () => {
    if (default_region_id) return Number(default_region_id);
    if (substation_id) return get('substation', Number(substation_id))?.region_id ?? null;
    if (transmission_line_id) return get('transmission_line', Number(transmission_line_id))?.region_id ?? null;
    return null;
  };
  const region_id = deriveRegion();
  const token = `geo${previewSeq++}-${Date.now()}`;
  const candidates = marks.map((m) => {
    const will_skip = !region_id;
    return {
      name: m.name, asset_type: guessAssetType(m.name), kind: m.kind,
      lat: m.lat, lng: m.lng, will_skip, reason: will_skip ? 'no resolvable region (supply default_region_id or a substation/line parent)' : null,
    };
  });
  pendingPreviews.set(token, { at: Date.now(), region_id, substation_id: substation_id ? Number(substation_id) : null, transmission_line_id: transmission_line_id ? Number(transmission_line_id) : null, marks, candidates });
  res.json({ token, count: candidates.length, candidates });
});

// Confirm: insert the previously previewed candidates, skipping invalid ones.
router.post('/assets/import-geo', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const pv = pendingPreviews.get(req.body.token);
  if (!pv) return res.status(400).json({ error: 'Preview token missing or expired — run the preview again' });
  pendingPreviews.delete(req.body.token);
  const created = [];
  const skipped = [];
  const now = new Date().toISOString();
  pv.marks.forEach((m, i) => {
    if (!pv.region_id) { skipped.push({ name: m.name, reason: 'no resolvable region' }); return; }
    if (m.lat == null || m.lng == null || m.lat < -90 || m.lat > 90 || m.lng < -180 || m.lng > 180) {
      skipped.push({ name: m.name, reason: 'invalid coordinates' });
      return;
    }
    try {
      const id = insertRow('asset', {
        asset_id: `AST-${Date.now()}-${i}`,
        name: m.name || `Imported ${i}`,
        asset_type: guessAssetType(m.name),
        substation_id: pv.substation_id,
        line_id: pv.transmission_line_id,
        latitude: m.lat,
        longitude: m.lng,
        condition_rating: 7,
        lifecycle_status: 'IN_SERVICE',
        operational_status: 'OPERATIONAL',
        criticality: 'MEDIUM',
        gps_validated: m.kind === 'Point' ? 0 : 1,
        metadata: JSON.stringify({ source: 'geo_import', placemark_kind: m.kind }),
        revision: 1,
      });
      created.push(get('asset', id, ['metadata']));
    } catch (e) {
      skipped.push({ name: m.name, reason: e.message });
    }
  });
  audit(req.user, 'IMPORT_ASSETS', 'asset', null, { attempted: pv.marks.length, created: created.length, skipped: skipped.length });
  res.status(201).json({ created: created.length, skipped, assets: created });
});
```

- [ ] **Step 2: Syntax check**

Run: `cd /workspace/backend && node -c routes/assets.js`

- [ ] **Step 3: Restart geo verify terminal and run KMZ preview → confirm checks**

Restart the geo verify terminal. Run:

```python
python3 - <<'PY'
import json, urllib.request, urllib.error, zipfile, io, base64, time
BASE = 'http://localhost:3198'
def req(method, path, token=None, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header('Content-Type', 'application/json')
    if token: r.add_header('Authorization', 'Bearer ' + token)
    d = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, d) as resp:
            return resp.status, json.loads(resp.read() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or '{}')
def login(u, p):
    s, r = req('POST', '/api/auth/login', body={'username': u, 'password': p})
    assert s == 200, r
    return r['token']
adm = login('admin', 'Admin@123')
kml = ('<Document>'
  '<Placemark><name>TR-100MVA-A</name><Point><coordinates>38.76,9.01</coordinates></Point></Placemark>'
  '<Placemark><name>Line Conductor Bay 1</name><LineString><coordinates>38.76,9.01 38.78,9.03</coordinates></LineString></Placemark>'
  '<Placemark><name>NoCoord</name><Point></Point></Placemark>'
  '</Document>')
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as z:
    z.writestr('doc.kml', kml)
kmz_b64 = base64.b64encode(buf.getvalue()).decode()
# substation of region 1 to anchor the import
st, subs = req('GET', '/api/substations', token=adm)
s1 = [s for s in subs if s['region_id'] == 1][0]
st, prev = req('POST', '/api/assets/import-geo/preview', token=adm, body={'format': 'kmz', 'content': kmz_b64, 'substation_id': s1['id']})
assert st == 200, (st, prev)
assert prev['count'] == 2, prev  # NoCoord placemark is dropped at parse time
assert all(not c['will_skip'] for c in prev['candidates']), prev
st, done = req('POST', '/api/assets/import-geo', token=adm, body={'token': prev['token']})
assert st == 201 and done['created'] == 2 and done['skipped'] == [], (st, done)
# reusing a consumed token must 400
st, again = req('POST', '/api/assets/import-geo', token=adm, body={'token': prev['token']})
assert st == 400, st
# manager cannot import
mgr = login('mgr.c1.tlom', 'Manager@123')
st, denied = req('POST', '/api/assets/import-geo/preview', token=mgr, body={'format': 'kml', 'content': kml})
assert st == 403, st
print('OK kmz import created', done['created'], 'skipped', done['skipped'])
PY
```

Expected: `OK kmz import created 2 skipped []`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/assets.js
git commit -m "feat(assets): KMZ/KML geo import with dry-run preview and audit"
```

---

### Task 5: Schedule runner — asset default crew precedence + robust numbering

**Files:**
- Modify: `backend/routes/schedules.js`

**Interfaces:**
- Consumes: nothing new. Produces: at `POST /schedules/run`, generated tasks get `crew_id = target.default_crew_id || s.responsible_crew_id || null` and `task_number` always matches `/^TK-2026-\d{6}$/`.

- [ ] **Step 1: Add a robust numbering helper**

Edit `backend/routes/schedules.js`. After the `OPEN_STATUSES` constant (line 10) add:

```js
// Scan existing task numbers instead of parsing the newest row: legacy rows
// like TK-SCRATCH-CAP must not poison the next number.
function robustTaskNumber() {
  let max = 0;
  for (const t of db.prepare('SELECT task_number FROM task').all()) {
    const m = String(t.task_number).match(/^TK-(\d{4})-(\d+)$/);
    if (m) max = Math.max(max, Number(m[2]));
  }
  return `TK-2026-${String(max + 1).padStart(6, '0')}`;
}
```

- [ ] **Step 2: Use it and apply crew precedence in the run handler**

In `POST /schedules/run`, replace the last-number lookup block (lines 150-152):

```js
      const last = db.prepare("SELECT task_number FROM task ORDER BY task_number DESC LIMIT 1").get();
      const n = last ? parseInt(last.task_number.split('-').pop(), 10) + 1 : 1;
      const taskNumber = `TK-2026-${String(n).padStart(6, '0')}`;
```

with:

```js
      const taskNumber = robustTaskNumber();
```

In the same handler, replace the `crew_id` line (line 171):

```js
        crew_id: s.responsible_crew_id || null,
```

with:

```js
        crew_id: (target.asset_type ? target.default_crew_id || s.responsible_crew_id : s.responsible_crew_id) || null,
```

- [ ] **Step 3: Syntax check**

Run: `cd /workspace/backend && node -c routes/schedules.js`

- [ ] **Step 4: Restart geo verify terminal and prove precedence**

Restart the geo verify terminal. Run:

```python
python3 - <<'PY'
import json, urllib.request, urllib.error, time
BASE = 'http://localhost:3198'
def req(method, path, token=None, body=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header('Content-Type', 'application/json')
    if token: r.add_header('Authorization', 'Bearer ' + token)
    d = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, d) as resp:
            return resp.status, json.loads(resp.read() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or '{}')
def login(u, p):
    s, r = req('POST', '/api/auth/login', body={'username': u, 'password': p})
    assert s == 200, r
    return r['token']
adm = login('admin', 'Admin@123')
st, crews = req('GET', '/api/crews', token=adm)
c1, c2 = crews[0]['id'], crews[1]['id']
assert c1 != c2
st, subs = req('GET', '/api/substations', token=adm)
s1 = [s for s in subs if s['region_id'] == 1][0]
suffix = int(time.time() * 1000)
# standalone asset with default crew c2
st, a = req('POST', '/api/assets', token=adm, body={
    'asset_id': f'VFY-AST-{suffix}', 'asset_type': 'TRANSFORMER', 'name': f'VFY-ASSET-{suffix}',
    'substation_id': s1['id'], 'condition_rating': 7, 'lifecycle_status': 'IN_SERVICE',
    'operational_status': 'OPERATIONAL', 'criticality': 'MEDIUM', 'default_crew_id': c2})
assert st == 201 and a['default_crew'] and a['default_crew']['id'] == c2, (st, a)
# list endpoint resolves it too
st, assets = req('GET', '/api/assets', token=adm)
row = [x for x in assets if x['id'] == a['id']][0]
assert row['default_crew'] and row['default_crew']['id'] == c2
# update flow accepts default_crew_id change
st, a2 = req('PUT', f"/api/assets/{a['id']}", token=adm, body={'default_crew_id': c1})
assert st == 200 and a2['default_crew']['id'] == c1, (st, a2)
# schedule on that asset, schedule responsible crew c2, but asset default c1 must win
yday = (int(time.time()) - 86400) * 1000
st, sch = req('POST', '/api/schedules', token=adm, body={
    'schedule_name': f'VFY-SCH-{suffix}', 'schedule_code': f'VSCH{suffix}',
    'scope_type': 'ASSET', 'asset_id': a['id'], 'region_id': 1,
    'frequency': 'WEEKLY', 'frequency_config': '{}', 'next_due_date': yday,
    'checklist_template_id': None, 'responsible_crew_id': c2,
    'priority': 'MEDIUM', 'task_type': 'PREVENTIVE', 'lead_time_days': 7, 'is_active': 1})
assert st == 201, (st, sch)
st, run = req('POST', '/api/schedules/run', token=adm, body={'schedule_id': sch['id']})
assert st == 200 and run['generated'] == 1, (st, run)
gen = run['tasks'][0]
assert gen['crew_id'] == c1, (gen, c1, c2)
import re
assert re.match(r'^TK-2026-\d{6}$', gen['task_number']), gen['task_number']
print('OK precedence crew', gen['crew_id'], 'task', gen['task_number'])
PY
```

Expected: `OK precedence crew <c1-id> task TK-2026-....` where the generated crew equals the asset's default crew (`c1`), not the schedule's crew (`c2`).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/schedules.js
git commit -m "feat(schedules): asset default crew precedence and robust task numbering"
```

---

### Task 6: Assets page — default-crew select + import modal with preview

**Files:**
- Modify: `frontend/src/pages/Assets.jsx`

**Interfaces:**
- Consumes: `default_crew`/`default_crew_id` on asset payloads (Task 1); `POST /assets/import-geo/preview` and `POST /assets/import-geo` (Task 4).
- Produces: "Default crew" select in the add/edit modal (options = crews of the asset's region), an "Import KMZ/KML" button (visible when `canWrite`) that opens a modal with a file picker, dry-run preview table and a confirm step.

- [ ] **Step 1: Load crews and add import state**

In `Assets.jsx`, after `const [lines, setLines] = useState([]);` (line 25) add:

```jsx
  const [crews, setCrews] = useState([]);
  const [geo, setGeo] = useState(null);       // { format, fileName, preview, confirmToken, busy, error }
```

In the mount effect (lines 41-46), after the `/lines` fetch add:

```jsx
    api.get('/crews').then(setCrews).catch(() => {});
```

- [ ] **Step 2: Add the "Default crew" field to the add/edit modal**

Replace the "Lifecycle" field block (lines 289-292) and the "Operational status" field block (293-296) with the same two fields plus a new default-crew select between them:

```jsx
            <div className="field"><label>Lifecycle</label>
              <select value={form.lifecycle_status} onChange={(e) => setForm({ ...form, lifecycle_status: e.target.value })}>
                {['IN_SERVICE', 'OUT_OF_SERVICE', 'RESERVED', 'RETIRED', 'SPARE'].map((c) => <option key={c}>{c}</option>)}
              </select></div>
            <div className="field"><label>Default crew</label>
              <select value={form.default_crew_id || ''} onChange={(e) => setForm({ ...form, default_crew_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— none —</option>
                {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>Prefills new tasks; overrides a schedule's crew at generation.</p></div>
            <div className="field"><label>Operational status</label>
              <select value={form.operational_status} onChange={(e) => setForm({ ...form, operational_status: e.target.value })}>
                {['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'UNDER_CONSTRUCTION', 'DECOMMISSIONED'].map((c) => <option key={c}>{c}</option>)}
              </select></div>
```

- [ ] **Step 3: Add the import entry point next to "+ Add Asset"**

Replace the `<Page ...>` actions prop (line 73-74) with:

```jsx
      actions={<>
        {canWrite && <button className="btn" onClick={() => setGeo({ format: 'kmz', fileName: '', preview: null, busy: false, error: null })}>Import KMZ/KML</button>}
        {canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blank })}>+ Add Asset</button> : null}
      </>}
```

- [ ] **Step 4: Add the import modal with preview→confirm**

Insert immediately before the closing `</Page>` (after the edit `form` modal block ends, before line 316 `</Page>`) the following modal:

```jsx
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
```

- [ ] **Step 5: Add the `fileToBase64` helper**

Append to the bottom of `Assets.jsx` (after the component closes):

```jsx
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const b64 = r.result.split(',')[1]; if (b64) resolve(b64); else reject(new Error('Could not read file')); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
```

- [ ] **Step 6: Build check**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Assets.jsx
git commit -m "feat(assets): default crew select and KMZ/KML import with preview"
```

---

### Task 7: Lines page — route import modal

**Files:**
- Modify: `frontend/src/pages/Lines.jsx`

**Interfaces:**
- Consumes: `POST /lines/import-route` (Task 3).
- Produces: an "Import route" button (visible when `canWrite`) opening a modal: choose mode (new line / update existing), pick format, paste content, then call the API and reload the list.

- [ ] **Step 1: Add route-import state**

In `Lines.jsx`, after `const [reportBusy, setReportBusy] = useState(false);` (line 40) add:

```jsx
  const [routeImport, setRouteImport] = useState(null); // { mode, format, content, error, busy }
  const [importLines, setImportLines] = useState([]);
```

In the mount effect (lines 43-47) add `api.get('/lines').then(setImportLines).catch(() => {});` after the existing `/substations` fetch.

- [ ] **Step 2: Add the entry button**

Replace the `<Page ...>` actions prop (line 123-124) with:

```jsx
      actions={<>
        {canWrite && <button className="btn" onClick={() => setRouteImport({ mode: 'create', format: 'geojson', content: '', error: null, busy: false })}>Import route file</button>}
        {canWrite ? <button className="btn btn-primary" onClick={() => setForm({ ...blank, region_id: me?.region_id || regions[0]?.id || 1, from_substation_id: subs[0]?.id, to_substation_id: subs[1]?.id || subs[0]?.id })}>+ Add Line</button> : null}
      </>}
```

- [ ] **Step 3: Add the import modal**

Insert before the closing `</Page>` (after the `{form && ...}` block, before line 325 `</Page>`) the following:

```jsx
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
              <select value={routeImport.mode} onChange={(e) => setRouteImport({ ...routeImport, mode: e.target.value })}>
                <option value="create">Create a new line</option>
                <option value="update">Update an existing line's route</option>
              </select></div>
            {routeImport.mode === 'create' && (
              <>
                <div className="field"><label>Region</label>
                  <select value={routeImport.region_id || ''} onChange={(e) => setRouteImport({ ...routeImport, region_id: Number(e.target.value) })}>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select></div>
                <div className="field"><label>Voltage (kV)</label>
                  <select value={routeImport.voltage_kv || 230} onChange={(e) => setRouteImport({ ...routeImport, voltage_kv: Number(e.target.value) })}>
                    {[66, 132, 230, 400, 500].map((kv) => <option key={kv} value={kv}>{kv}</option>)}
                  </select></div>
                <div className="field"><label>From substation</label>
                  <select value={routeImport.from_substation_id || ''} onChange={(e) => setRouteImport({ ...routeImport, from_substation_id: Number(e.target.value) })}>
                    {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select></div>
                <div className="field"><label>To substation</label>
                  <select value={routeImport.to_substation_id || ''} onChange={(e) => setRouteImport({ ...routeImport, to_substation_id: Number(e.target.value) })}>
                    {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select></div>
              </>
            )}
            {routeImport.mode === 'update' && (
              <div className="field full"><label>Line to update</label>
                <select value={routeImport.lineName || ''} onChange={(e) => setRouteImport({ ...routeImport, lineName: e.target.value })}>
                  <option value="">Choose line…</option>
                  {importLines.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
                </select></div>
            )}
            <div className="field full"><label>Format</label>
              <select value={routeImport.format} onChange={(e) => setRouteImport({ ...routeImport, format: e.target.value })}>
                {['geojson', 'kml', 'kmz', 'wkt', 'csv'].map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select></div>
            <div className="field full"><label>Content ({routeImport.format === 'kmz' ? 'base64-encoded KMZ zip' : routeImport.format === 'csv' ? 'lng,lat per line' : routeImport.format === 'wkt' ? 'LINESTRING(lng lat, …)' : 'GeoJSON/KML text'})</label>
              <textarea rows={8} value={routeImport.content} onChange={(e) => setRouteImport({ ...routeImport, content: e.target.value })}
                placeholder={routeImport.format === 'csv' ? '38.0,9.0\n38.5,9.2' : 'Paste file content here…'} /></div>
          </div>
          <p className="muted mt">The route length (km) is computed from the geometry. For create mode the region's two substations anchor the ends. Towers are never auto-generated — use "Convert route points → towers" afterwards if needed.</p>
        </Modal>
      )}
```

- [ ] **Step 4: Build check**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Lines.jsx
git commit -m "feat(lines): route import modal (create/update, five formats)"
```

---

### Task 8: Tasks page — auto-fill crew from the chosen asset

**Files:**
- Modify: `frontend/src/pages/Tasks.jsx`

**Interfaces:**
- Consumes: `asset.default_crew_id` on `GET /assets` rows (Task 1).
- Produces: when the operator changes "Target asset" in the New Task modal and has not picked a crew yet, `crew_id` pre-fills from `asset.default_crew_id`.

- [ ] **Step 1: Add the auto-fill to the asset select**

Edit `frontend/src/pages/Tasks.jsx`. Replace the "Target asset" field (lines 196-200) with:

```jsx
            <div className="field"><label>Target asset</label>
              <select value={form.asset_id || ''} onChange={(e) => {
                const aid = e.target.value ? Number(e.target.value) : null;
                const asset = assets.find((a) => a.id === aid);
                setForm({
                  ...form,
                  asset_id: aid,
                  crew_id: asset?.default_crew_id ? asset.default_crew_id : form.crew_id,
                });
              }}>
                <option value="">— none —</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.name} {a.default_crew ? `(${a.default_crew.name})` : ''}</option>)}
              </select></div>
```

- [ ] **Step 2: Build check**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Tasks.jsx
git commit -m "feat(tasks): prefill crew from the selected asset default crew"
```

---

### Task 9: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Backend syntax + frontend build**

Run: `cd /workspace/backend && for f in db.js geoimport.js routes/core.js routes/assets.js routes/schedules.js; do node -c "$f" || exit 1; done`
Run: `cd /workspace/frontend && npm run build`

- [ ] **Step 2: Full e2e against the isolated instance**

Restart the geo verify terminal (Task 1 command). Re-run the python heredocs from Tasks 1, 3, 4, 5 — all must print `OK`.

- [ ] **Step 3: Restart the live backend on :3001**

Kill the running :3001 dev backend terminal and start it again with its original command (`npm run dev` inside `/workspace/backend`). Confirm `TMMS backend listening on http://localhost:3001` and the Vite app on :5173 still proxies. The migration runs at startup, so `asset.default_crew_id` is live immediately.

- [ ] **Step 4: Final report to the user**

Summarize: new endpoints, `default_crew_id` column + UI select, auto-fill and schedule precedence behavior, and that test data lives only in `/tmp/opencode/tmms-g.db` (never the live DB). Do not delete the temp DB — if cleanup is desired, ask the user first.
