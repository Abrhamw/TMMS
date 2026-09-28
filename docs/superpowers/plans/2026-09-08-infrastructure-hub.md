# Infrastructure Hub & Scoped Asset Summaries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four flat sidebar entries (Regions / Substations / Lines / Towers) with one **Infrastructure** hub: a drill-down tree (regions → substations/lines) on the left and horizontal Region | Substation | Transmission-line summary tabs inside, driven by one new scoped `GET /api/infrastructure` aggregate. Existing CRUD screens stay reachable as "Manage" views.

**Architecture:** Backend adds a read-only scoped aggregation router (JS classification over the same population rules as `register.js`, so counts reconcile with `/register/tree` and `/assets/summary`). Frontend adds a hub page whose URL params own scope/tab/manage state; the four legacy pages are embedded unchanged inside the hub's Manage mode, and their old URLs redirect into the hub.

**Tech Stack:** Node 22 (`node:sqlite`), Express 5, plain React (Vite), react-router-dom v6. No new npm dependencies, no schema changes, no chart library (CSS bars/donuts only).

## Global Constraints

- No new tables/columns; do NOT run `migrate()`. Endpoint is strictly read-only (no `audit()` calls, no writes).
- Region scoping reuses `isGlobal`/`checkRegion` (`backend/auth.js`). Route is mounted behind the existing `app.use('/api', requireAuth, auditMiddleware)` chain, so a request always carries `req.user`; out-of-scope `region_id` → `403` exactly like `/register/tree`.
- Count reconciliation: for every scope, `region.asset_count` and `region.tower_count` MUST equal `/register/tree` `counts.assets` / `counts.towers` for that region, and the sum across regions MUST equal `/assets/summary` `total_assets`.
- Classification mirrors `register.js:regionPopulation`: population = assets with `lifecycle_status != 'REMOVED'`; a tower-mirror asset (`asset_type IN ('TOWER','POLE')`) with `tower_id` pointing into the scope counts as a tower asset; line-attached assets count as line assets; `asset_types` rollups NEVER include `TOWER`/`POLE`.
- Frontend copy is page-local hard-coded English (like `Value.jsx`/`Reports.jsx`). Only the new sidebar entry label goes through `t()` in `src/i18n.js` (all three of `en`/`es`/`zh`).
- Do NOT `git add -A`. Add only the files a task lists. Never add `Co-authored-by` or other trailers (the repo commit hook appends them). No destructive commands; long-running servers run in a **background terminal** and stop via `background_terminal_kill <id>`.
- Code style: 2-space indent, `const`, terse section comments only. Backend files end `node -c` clean; frontend changes must leave `npm run build` clean.
- All e2e runs against an isolated DB copy on port **3199** using `TMMS_DB=/tmp/opencode/tmms-plan/tmms.db`; the live :3001 stack stays untouched until the final task.
- The live backend user seeds are: global `admin` / `Admin@123`; region user `dir.c1` / `Region@123` (region C1, id 1).

---

### Task 1: Scoped `GET /api/infrastructure` aggregate router

**Files:**
- Create: `backend/routes/infrastructure.js`
- Modify: `backend/server.js` (add one mount line after the `/register` mount)

**Interfaces:**
- Produces route `GET /api/infrastructure` (auth already applied globally). Accepts optional `?region_id=`. Response `{ currency, regions: [], substations: [], lines: [], towers: [] }`.
- EXACT payload field names (authoritative; the spec snippet is illustrative):
  - `regions[i]`: `id, code, name, type, status, center_lat, center_lng, boundary_km, substation_count, line_count, tower_count, circuit_length_km, asset_count, asset_types, avg_condition, condition_bands` where `asset_types` = `{ ASSET_TYPE: n }` (never `TOWER`/`POLE`), `condition_bands` = `{ good, fair, poor }` (rating `>=8` good, `5-7` fair, `<5` poor) and `avg_condition` a float, both computed over the same population as `asset_count`.
  - `substations[i]`: `id, substation_id, name, region_id, region_code, latitude, longitude, operational_status, voltage_levels, bay_count, gps_validated, transformer_count, asset_count, asset_types, incident_lines` where `voltage_levels` = parsed string array, `transformer_count` counts only `asset_type = 'TRANSFORMER'`, `incident_lines` = `[{ id, line_id, name, voltage_kv }]` for lines where the substation is `from_substation_id` or `to_substation_id`.
  - `lines[i]`: `id, line_id, name, region_id, region_code, from_sub, to_sub, voltage_kv, line_type, conductor_type, circuit_count, length_km, tower_count, tower_spacing_km, joint_box_count, conductor_span_count, opgw_span_count, fiber_on_towers, asset_types, operational_status` where `from_sub`/`to_sub` = `{ id, substation_id, name }`, `tower_spacing_km` = `length_km / tower_count` (0 when no towers) rounded to 2dp, `fiber_on_towers` = `{ towers, qty }` (OPGW `tower_component` distinct towers + summed quantity on the line), and `conductor_type` is `null` when the column is empty.
  - `towers[i]`: `id, tower_id, line_id, line_code, km_marker, tower_type, tower_material, height_m, corrosion_rating, gps_validated, component_count`.
- `server.js`: add `app.use('/api', require('./routes/infrastructure'));` after the existing `register` mount (line 67).

- [ ] **Step 1: Write the route module**

Create `backend/routes/infrastructure.js`:

```js
const express = require('express');
const { db } = require('../util');
const { isGlobal } = require('../auth');

const router = express.Router();

// Read-only aggregate for the Infrastructure hub. Classification mirrors
// register.js regionPopulation so counts reconcile with /register/tree and
// /assets/summary. Population = assets with lifecycle_status != 'REMOVED';
// a tower-mirror asset (TOWER/POLE) with tower_id in scope counts as a tower.

function ph(n) { return Array(n).fill('?').join(','); }

function parseVoltageLevels(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch (_) {
    return [];
  }
}

function byTypeRollup(rows) {
  const out = {};
  for (const a of rows) {
    const t = a.asset_type || 'UNSPECIFIED';
    if (t === 'TOWER' || t === 'POLE') continue;
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

function bands(rows) {
  const out = { good: 0, fair: 0, poor: 0 };
  let sum = 0;
  for (const a of rows) {
    const c = Number(a.condition_rating) || 7;
    if (c >= 8) out.good += 1; else if (c >= 5) out.fair += 1; else out.poor += 1;
    sum += c;
  }
  return { bands: out, avg: rows.length ? sum / rows.length : 0 };
}

function buildScope(regionIds) {
  const regionList = db.prepare(`SELECT * FROM region WHERE id IN (${ph(regionIds.length)}) ORDER BY code`).all(...regionIds);
  const subRows = db.prepare(`SELECT * FROM substation WHERE region_id IN (${ph(regionIds.length)}) ORDER BY name`).all(...regionIds);
  const lineRows = db.prepare(`SELECT * FROM transmission_line WHERE region_id IN (${ph(regionIds.length)}) ORDER BY line_id`).all(...regionIds);

  const regionCode = new Map(regionList.map((r) => [r.id, r.code]));
  const regionBySub = new Map(subRows.map((s) => [s.id, s.region_id]));
  const regionByLine = new Map(lineRows.map((l) => [l.id, l.region_id]));
  const lineIds = lineRows.map((l) => l.id);
  const lineIdSet = new Set(lineIds);

  const towers = lineIds.length
    ? db.prepare(
        `SELECT t.*, l.line_id AS line_code FROM tower t JOIN transmission_line l ON l.id = t.line_id WHERE l.id IN (${ph(lineIds.length)}) ORDER BY l.line_id, t.km_marker, t.id`
      ).all(...lineIds)
    : [];
  const towerOfLine = new Map(towers.map((t) => [t.id, t.line_id]));
  const towersByLine = new Map();
  for (const t of towers) {
    if (!towersByLine.has(t.line_id)) towersByLine.set(t.line_id, []);
    towersByLine.get(t.line_id).push(t);
  }

  // OPGW (fiber) presence per line, from tower components.
  const fiberByLine = new Map();
  if (lineIds.length) {
    for (const r of db.prepare(
      `SELECT tw.line_id, COUNT(DISTINCT tw.id) towers, COALESCE(SUM(tc.quantity), 0) qty
         FROM tower_component tc JOIN tower tw ON tw.id = tc.tower_id
        WHERE tc.component_type = 'OPGW' AND tw.line_id IN (${ph(lineIds.length)})
        GROUP BY tw.line_id`
    ).all(...lineIds)) {
      fiberByLine.set(r.line_id, { towers: r.towers, qty: r.qty });
    }
  }
  const towerComponentCounts = new Map();
  if (lineIds.length) {
    for (const r of db.prepare(
      `SELECT tw.line_id, tc.tower_id, COUNT(*) c
         FROM tower_component tc JOIN tower tw ON tw.id = tc.tower_id
        WHERE tw.line_id IN (${ph(lineIds.length)}) GROUP BY tc.tower_id`
    ).all(...lineIds)) {
      towerComponentCounts.set(r.tower_id, r.c);
    }
  }

  // Non-removed assets grouped exactly like register.js: by substation when
  // anchored there, else by tower line when a tower mirror, else by line.
  const assets = db.prepare("SELECT * FROM asset WHERE lifecycle_status != 'REMOVED'").all().map((a) => ({ ...a, metadata: null }));
  const subAssets = new Map();
  const lineAssets = new Map();   // line-level, non-mirror assets
  const towerAssets = new Map();  // tower_id -> mirror asset
  for (const a of assets) {
    if (a.substation_id != null && regionBySub.has(a.substation_id)) {
      if (!subAssets.has(a.substation_id)) subAssets.set(a.substation_id, []);
      subAssets.get(a.substation_id).push(a);
    } else if (a.tower_id != null && towerOfLine.has(a.tower_id)) {
      if (a.asset_type === 'TOWER' || a.asset_type === 'POLE') {
        towerAssets.set(a.tower_id, a);
      } else {
        const lid = towerOfLine.get(a.tower_id);
        if (!lineAssets.has(lid)) lineAssets.set(lid, []);
        lineAssets.get(lid).push(a);
      }
    } else if (a.line_id != null && lineIdSet.has(a.line_id)) {
      if (!lineAssets.has(a.line_id)) lineAssets.set(a.line_id, []);
      lineAssets.get(a.line_id).push(a);
    }
  }

  const regionOut = [];
  for (const r of regionList) {
    const subs = subRows.filter((s) => s.region_id === r.id);
    const lines = lineRows.filter((l) => l.region_id === r.id);
    const towersIn = [];
    const allPop = [];
    for (const l of lines) {
      for (const t of towersByLine.get(l.id) || []) towersIn.push(t);
      for (const a of lineAssets.get(l.id) || []) allPop.push(a);
    }
    for (const s of subs) for (const a of subAssets.get(s.id) || []) allPop.push(a);
    for (const ta of towerAssets.values()) {
      if (towerOfLine.has(ta.tower_id) && regionByLine.get(towerOfLine.get(ta.tower_id)) === r.id) allPop.push(ta);
    }
    const { bands: b, avg } = bands(allPop);
    regionOut.push({
      id: r.id, code: r.code, name: r.name, type: r.type, status: r.status,
      center_lat: r.center_lat, center_lng: r.center_lng, boundary_km: Number(r.boundary) || 0,
      substation_count: subs.length,
      line_count: lines.length,
      tower_count: towersIn.length,
      circuit_length_km: Math.round(lines.reduce((s, l) => s + (Number(l.length_km) || 0), 0) * 10) / 10,
      asset_count: allPop.length,
      asset_types: byTypeRollup(allPop),
      avg_condition: Math.round(avg * 10) / 10,
      condition_bands: b,
    });
  }

  const subOut = [];
  for (const s of subRows) {
    const arr = subAssets.get(s.id) || [];
    const incident = lineRows
      .filter((l) => l.from_substation_id === s.id || l.to_substation_id === s.id)
      .map((l) => ({ id: l.id, line_id: l.line_id, name: l.name, voltage_kv: l.voltage_kv }));
    subOut.push({
      id: s.id, substation_id: s.substation_id, name: s.name,
      region_id: s.region_id, region_code: regionCode.get(s.region_id),
      latitude: s.latitude, longitude: s.longitude, operational_status: s.operational_status,
      voltage_levels: parseVoltageLevels(s.voltage_levels), bay_count: s.bay_count, gps_validated: s.gps_validated,
      transformer_count: arr.filter((a) => a.asset_type === 'TRANSFORMER').length,
      asset_count: arr.length,
      asset_types: byTypeRollup(arr),
      incident_lines: incident,
    });
  }

  const lineOut = [];
  for (const l of lineRows) {
    const arr = lineAssets.get(l.id) || [];
    const n = (type) => arr.filter((a) => a.asset_type === type).length;
    const towersIn = towersByLine.get(l.id) || [];
    const fromSub = subRows.find((s) => s.id === l.from_substation_id);
    const toSub = subRows.find((s) => s.id === l.to_substation_id);
    const len = Number(l.length_km) || 0;
    lineOut.push({
      id: l.id, line_id: l.line_id, name: l.name,
      region_id: l.region_id, region_code: regionCode.get(l.region_id),
      from_sub: fromSub ? { id: fromSub.id, substation_id: fromSub.substation_id, name: fromSub.name } : null,
      to_sub: toSub ? { id: toSub.id, substation_id: toSub.substation_id, name: toSub.name } : null,
      voltage_kv: l.voltage_kv, line_type: l.line_type,
      conductor_type: l.conductor_type || null, circuit_count: l.circuit_count,
      length_km: len, tower_count: towersIn.length,
      tower_spacing_km: towersIn.length ? Math.round((len / towersIn.length) * 100) / 100 : 0,
      joint_box_count: n('JOINT_BOX'),
      conductor_span_count: n('CONDUCTOR_SPAN'),
      opgw_span_count: n('OPGW_SPAN'),
      fiber_on_towers: fiberByLine.get(l.id) || { towers: 0, qty: 0 },
      asset_types: byTypeRollup(arr),
      operational_status: l.operational_status,
    });
  }

  const towerOut = towers.map((t) => ({
    id: t.id, tower_id: t.tower_id, line_id: t.line_id, line_code: t.line_code,
    km_marker: t.km_marker, tower_type: t.tower_type, tower_material: t.tower_material,
    height_m: t.height_m, corrosion_rating: t.corrosion_rating, gps_validated: t.gps_validated,
    component_count: towerComponentCounts.get(t.id) || 0,
  }));

  return { regions: regionOut, substations: subOut, lines: lineOut, towers: towerOut };
}

function currencyCode() {
  const r = db.prepare("SELECT value FROM system_config WHERE key = 'currency'").get();
  return (r && r.value) || 'USD';
}

router.get('/infrastructure', (req, res) => {
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = wanted
    ? [wanted]
    : isGlobal(req.user)
      ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
      : [req.user.region_id];
  res.json({ currency: { code: currencyCode() }, ...buildScope(regionIds) });
});

module.exports = router;
```

Note: `avg_condition` is `Math.round(avg * 10) / 10` where `avg` comes from the `bands(allPop)` call above.

- [ ] **Step 2: Mount the router**

In `backend/server.js`, after the register mount (line 67 `app.use('/api', require('./routes/register'));`) add:

```js
app.use('/api', require('./routes/infrastructure'));
```

- [ ] **Step 3: Syntax + isolated boot**

Run: `cd /workspace/backend && node -c routes/infrastructure.js && node -c server.js && echo OK`

Snapshot + boot an isolated copy on **3199** in a background terminal and keep its id:

```bash
mkdir -p /tmp/opencode/tmms-plan
node -e "const s=require('node:sqlite').DatabaseSync; new s('/workspace/backend/tmms.db').exec(\"VACUUM INTO '/tmp/opencode/tmms-plan/tmms.db'\"); console.log('snapshot ok');"
```

```bash
cd /workspace/backend && PORT=3199 TMMS_DB=/tmp/opencode/tmms-plan/tmms.db node server.js
```

Expected: server boots and logs the usual seed lines. Then:

```bash
TOK=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:3199/api/infrastructure -H "Authorization: Bearer $TOK" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `regions=${j.regions.length} substations=${j.substations.length} lines=${j.lines.length} towers=${j.towers.length} c1=${j.regions.find(r=>r.code==="C1").asset_count}`'
```

Expected: `regions=13 substations=6 lines=3 towers=126 c1=147`. If the endpoint errors, read the server terminal output file and fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/infrastructure.js backend/server.js
git commit -m "feat(infra): add scoped /api/infrastructure aggregate endpoint"
```

---

### Task 2: E2E reconcile + scoping verification for the endpoint

**Files:** (none — verification only)

**Interfaces:** Consumes `GET /api/infrastructure` from Task 1. Later frontend tasks rely on the Task 1 payload shape.

- [ ] **Step 1: Fetch scoped + global payloads**

Keep the 3199 server from Task 1 running (restart it from the same snapshot if stopped: `background_terminal_kill <id>` then re-run the VACUUM + boot commands). Then:

```bash
TOK=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
CTOK=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:3199/api/infrastructure -H "Authorization: Bearer $TOK" > /tmp/opencode/tmms-plan/infra-admin.json
curl -s http://localhost:3199/api/infrastructure -H "Authorization: Bearer $CTOK" > /tmp/opencode/tmms-plan/infra-c1.json
curl -s http://localhost:3199/api/register/tree -H "Authorization: Bearer $TOK" > /tmp/opencode/tmms-plan/tree.json
curl -s http://localhost:3199/api/assets/summary -H "Authorization: Bearer $TOK" > /tmp/opencode/tmms-plan/assetsummary.json
```

- [ ] **Step 2: Assert reconciliation invariants**

```bash
node -e "
const fs=require('fs'); const rd=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
const a=rd('/tmp/opencode/tmms-plan/infra-admin.json');
const tree=rd('/tmp/opencode/tmms-plan/tree.json');
const sum=rd('/tmp/opencode/tmms-plan/assetsummary.json');
if(a.regions.length!==13) throw new Error('region count '+a.regions.length);
if(a.substations.length!==6) throw new Error('substation count');
if(a.lines.length!==3) throw new Error('line count');
if(a.towers.length!==126) throw new Error('tower count');
const byCode=new Map(a.regions.map(r=>[r.code,r]));
for(const t of tree.regions){
  const r=byCode.get(t.region.code);
  if(!r) throw new Error('missing region '+t.region.code);
  if(r.substation_count!==t.counts.substations) throw new Error('sub mismatch '+t.region.code);
  if(r.line_count!==t.counts.lines) throw new Error('line mismatch '+t.region.code);
  if(r.tower_count!==t.counts.towers) throw new Error('tower mismatch '+t.region.code+' got '+r.tower_count+' want '+t.counts.towers);
  if(r.asset_count!==t.counts.assets) throw new Error('asset mismatch '+t.region.code+' got '+r.asset_count+' want '+t.counts.assets);
}
const totalAssets=a.regions.reduce((s,r)=>s+r.asset_count,0);
if(totalAssets!==sum.total_assets) throw new Error('assets/summary mismatch '+totalAssets+' vs '+sum.total_assets);
const c1=byCode.get('C1');
if(c1.asset_types.TRANSFORMER!==2) throw new Error('c1 transformers '+JSON.stringify(c1.asset_types));
if(c1.avg_condition>10||c1.avg_condition<0) throw new Error('bad avg condition');
const l2=a.lines.find(l=>l.line_id==='TL-C1-002');
if(l2.tower_count!==52||l2.joint_box_count!==4||l2.opgw_span_count!==1||l2.fiber_on_towers.towers!==52) throw new Error('TL-C1-002 aggregates '+JSON.stringify(l2));
const s1=a.substations.find(s=>s.substation_id==='SS-C1-001');
if(s1.transformer_count!==1||s1.incident_lines.length!==2) throw new Error('SS-C1-001 aggregates');
console.log('PASS admin reconcile');
const c=rd('/tmp/opencode/tmms-plan/infra-c1.json');
if(c.regions.length!==1||c.regions[0].code!=='C1') throw new Error('c1 region scope');
if(c.substations.some(s=>s.region_code!=='C1')) throw new Error('c1 sub scope');
if(c.lines.some(l=>l.region_code!=='C1')) throw new Error('c1 line scope');
if(c.towers.some(t=>t.line_code!=='TL-C1-001'&&t.line_code!=='TL-C1-002')) throw new Error('c1 tower scope');
console.log('PASS c1 scope');
"
```

Expected output: `PASS admin reconcile` then `PASS c1 scope`.

- [ ] **Step 3: 403 out-of-scope check**

```bash
CTOK=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -o /tmp/opencode/tmms-plan/out.json -w '%{http_code}' 'http://localhost:3199/api/infrastructure?region_id=2' -H "Authorization: Bearer $CTOK"
```

Expected: `403`.

- [ ] **Step 4: Commit (no file changes — nothing to add)**

Nothing to commit; the endpoint was committed in Task 1. Mark this task done after all three assertions pass.

---

### Task 3: Shared frontend primitives — KpiTile, BarRow, Donut

**Files:**
- Create: `frontend/src/components/InfraVisuals.jsx`

**Interfaces:**
- Produces three named exports used by Tasks 4-8:
  - `KpiTile({ label, value, sub })` → small stat card (no props contract beyond rendering).
  - `BarRow({ label, value, max, sub, color })` → labelled horizontal bar; `color` optional defaulting to `#4338ca`; renders `value` as bold text on the right.
  - `Donut({ good, fair, poor })` → CSS conic-gradient donut (green `#16a34a` / amber `#d97706` / red `#dc2626`); renders an empty ring when all zero.
- Style hooks consumed: `ktile`, `ktile-label`, `ktile-value`, `ktile-sub`, `bar-row`, `bar-track`, `bar-fill`, `donut`, `donut-hole` (CSS added in Task 8; harmless while absent).

- [ ] **Step 1: Write the component file**

Create `frontend/src/components/InfraVisuals.jsx`:

```jsx
export function KpiTile({ label, value, sub }) {
  return (
    <div className="card card-pad ktile">
      <div className="ktile-label">{label}</div>
      <div className="ktile-value">{value ?? '—'}</div>
      {sub ? <div className="ktile-sub">{sub}</div> : null}
    </div>
  );
}

export function BarRow({ label, value, max, sub, color = '#4338ca' }) {
  const num = Number(value) || 0;
  const hi = Number(max) > 0 ? Number(max) : num;
  const pct = hi > 0 ? Math.max(1.5, Math.min(100, Math.round((num / hi) * 100))) : 0;
  return (
    <div className="bar-row">
      <div className="spread">
        <span>{label}{sub ? <span className="muted"> · {sub}</span> : null}</span>
        <b>{num}</b>
      </div>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

export function Donut({ good, fair, poor }) {
  const total = (Number(good) || 0) + (Number(fair) || 0) + (Number(poor) || 0);
  if (!total) {
    return (
      <div className="donut-wrap">
        <div className="donut" style={{ background: '#e5e7eb' }}><div className="donut-hole" /></div>
        <div className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}>No assessed assets</div>
      </div>
    );
  }
  const stops = [];
  let acc = 0;
  const add = (v, color) => {
    if (!v) return;
    const p = (v / total) * 360;
    stops.push(`${color} ${acc}deg ${acc + p}deg`);
    acc += p;
  };
  add(Number(good) || 0, '#16a34a');
  add(Number(fair) || 0, '#d97706');
  add(Number(poor) || 0, '#dc2626');
  return (
    <div className="donut-wrap">
      <div className="donut" style={{ background: `conic-gradient(${stops.join(', ')})` }}><div className="donut-hole" /></div>
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd /workspace/frontend && npm run build`
Expected: build succeeds (Vite emits no errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/InfraVisuals.jsx
git commit -m "feat(infra): shared KPI tile, bar row and donut primitives"
```

---

### Task 4: Region summary component

**Files:**
- Create: `frontend/src/pages/RegionSummary.jsx`

**Interfaces:**
- Consumes the Task 1 `regions[i]` shape (fields `id, code, name, type, status, substation_count, line_count, tower_count, circuit_length_km, asset_count, asset_types, avg_condition, condition_bands`).
- Produces: default export `RegionSummary({ regions, focusId, onPick })`.
  - When `focusId` is a number, renders the matching region's detail (KPI grid, asset-mix bars, condition donut + legend).
  - Otherwise renders one card per `region`; clicking a card body calls `onPick(region.id)`.
  - Region cards show: code chip, name, type/status, KPI counts, top asset types as compact text chips.

- [ ] **Step 1: Write the component**

Create `frontend/src/pages/RegionSummary.jsx`:

```jsx
import { KpiTile, BarRow, Donut } from '../components/InfraVisuals';

function sortedTypes(assetTypes) {
  return Object.entries(assetTypes || {}).sort((a, b) => b[1] - a[1]);
}

function Chip({ children }) {
  return <span className="infra-chip">{children}</span>;
}

function Legend() {
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
      <span style={{ color: '#16a34a' }}>■</span> Good 8–10&nbsp;&nbsp;
      <span style={{ color: '#d97706' }}>■</span> Fair 5–7&nbsp;&nbsp;
      <span style={{ color: '#dc2626' }}>■</span> Poor &lt;5
    </div>
  );
}

export default function RegionSummary({ regions, focusId, onPick }) {
  const focused = regions.find((r) => r.id === Number(focusId));

  if (focused) {
    const types = sortedTypes(focused.asset_types);
    const max = types.length ? Math.max(...types.map(([, n]) => n)) : 1;
    return (
      <div>
        <div className="spread">
          <div>
            <h2 className="section-title">{focused.name}</h2>
            <div className="mt">
              <Chip>{focused.code}</Chip> <Chip>{focused.type}</Chip> <Chip>{focused.status}</Chip>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => onPick(null)}>Back to all regions</button>
        </div>
        <div className="grid grid-4 mt">
          <KpiTile label="Substations" value={focused.substation_count} />
          <KpiTile label="Transmission lines" value={focused.line_count} />
          <KpiTile label="Towers" value={focused.tower_count} />
          <KpiTile label="Circuit length" value={`${focused.circuit_length_km} km`} />
          <KpiTile label="Assets" value={focused.asset_count} sub={`avg condition ${(focused.avg_condition || 0).toFixed(1)}`} />
        </div>
        <div className="grid grid-2 mt">
          <div className="card card-pad">
            <h3 className="section-title">Asset mix</h3>
            {types.length === 0 && <div className="muted">No categorized assets (towers only)</div>}
            {types.slice(0, 8).map(([type, n]) => (
              <BarRow key={type} label={type.replace(/_/g, ' ')} value={n} max={max} />
            ))}
            {types.length > 8 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>+{types.length - 8} more types</div>}
          </div>
          <div className="card card-pad">
            <h3 className="section-title">Condition</h3>
            <Donut good={focused.condition_bands.good} fair={focused.condition_bands.fair} poor={focused.condition_bands.poor} />
            <Legend />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-2">
      {regions.map((r) => (
        <div key={r.id} className="card card-pad hub-card" onClick={() => onPick(r.id)}>
          <div className="spread">
            <span><Chip>{r.code}</Chip> <b>{r.name}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>{r.status}</span>
          </div>
          <div className="ktile-value" style={{ margin: '8px 0 4px' }}>{r.asset_count}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {r.substation_count} substations · {r.line_count} lines · {r.tower_count} towers · {r.circuit_length_km} km
          </div>
          <div className="mt">
            {sortedTypes(r.asset_types).slice(0, 4).map(([type, n]) => (
              <Chip key={type}>{type.replace(/_/g, ' ')} {n}</Chip>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd /workspace/frontend && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/RegionSummary.jsx
git commit -m "feat(infra): region summary cards and detail view"
```

---

### Task 5: Substation summary component

**Files:**
- Create: `frontend/src/pages/SubstationSummary.jsx`

**Interfaces:**
- Consumes Task 1 `substations[i]` shape (`id, substation_id, name, region_id, region_code, latitude, longitude, operational_status, voltage_levels, bay_count, gps_validated, transformer_count, asset_count, asset_types, incident_lines`).
- Produces default export `SubstationSummary({ substations, focusId, onPick })`.
  - `focusId` set → detail view (voltage chips, transformer/incident-line/bay KPI, asset-mix bars, incident lines table).
  - Otherwise a grid of cards; card click → `onPick(substation.id)`. Cards show voltage-level chips, transformer count, incident lines, asset count.

- [ ] **Step 1: Write the component**

Create `frontend/src/pages/SubstationSummary.jsx`:

```jsx
import { KpiTile, BarRow } from '../components/InfraVisuals';

function Chip({ children }) {
  return <span className="infra-chip">{children}</span>;
}

function sortedTypes(assetTypes) {
  return Object.entries(assetTypes || {}).sort((a, b) => b[1] - a[1]);
}

function voltageChips(levels) {
  return (levels || []).map((v) => <Chip key={v}>{v}</Chip>);
}

export default function SubstationSummary({ substations, focusId, onPick }) {
  const focused = substations.find((s) => s.id === Number(focusId));

  if (focused) {
    const types = sortedTypes(focused.asset_types);
    const max = types.length ? Math.max(...types.map(([, n]) => n)) : 1;
    return (
      <div>
        <div className="spread">
          <div>
            <h2 className="section-title">{focused.name}</h2>
            <div className="mt">
              <Chip>{focused.substation_id}</Chip>
              <Chip>{focused.region_code}</Chip>
              {voltageChips(focused.voltage_levels)}
              <Chip>{focused.operational_status}</Chip>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => onPick(null)}>Back to all substations</button>
        </div>
        <div className="grid grid-4 mt">
          <KpiTile label="Transformers" value={focused.transformer_count} />
          <KpiTile label="Incident lines" value={focused.incident_lines.length} />
          <KpiTile label="Bays" value={focused.bay_count} />
          <KpiTile label="Assets" value={focused.asset_count} />
        </div>
        <div className="grid grid-2 mt">
          <div className="card card-pad">
            <h3 className="section-title">Asset mix</h3>
            {types.length === 0 && <div className="muted">No equipment registered in this substation</div>}
            {types.slice(0, 8).map(([type, n]) => (
              <BarRow key={type} label={type.replace(/_/g, ' ')} value={n} max={max} />
            ))}
          </div>
          <div className="card card-pad">
            <h3 className="section-title">Incident transmission lines</h3>
            {focused.incident_lines.length === 0 && <div className="muted">No lines terminate at this substation</div>}
            {focused.incident_lines.map((l) => (
              <div key={l.id} className="spread" style={{ padding: '4px 0' }}>
                <span><b>{l.line_id}</b> — {l.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{l.voltage_kv} kV</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-2">
      {substations.map((s) => (
        <div key={s.id} className="card card-pad hub-card" onClick={() => onPick(s.id)}>
          <div className="spread">
            <span><Chip>{s.substation_id}</Chip> <b>{s.name}</b></span>
            <span className="muted" style={{ fontSize: 12 }}>{s.region_code}</span>
          </div>
          <div className="mt">{voltageChips(s.voltage_levels)}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {s.transformer_count} transformers · {s.incident_lines.length} lines · {s.bay_count} bays · {s.asset_count} assets
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd /workspace/frontend && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/SubstationSummary.jsx
git commit -m "feat(infra): substation summary cards and detail view"
```

---

### Task 6: Transmission line summary component

**Files:**
- Create: `frontend/src/pages/LineSummary.jsx`

**Interfaces:**
- Consumes Task 1 `lines[i]` and `towers[i]` shapes.
- Produces default export `LineSummary({ lines, towersByLine, focusId, onPick })` where `towersByLine` is a `{ lineId: tower[] }` map (the hub builds it from `data.towers`).
  - `focusId` set → detail: route from→to, KPI (towers, km, spacing, conductor, fiber, JB), asset-mix bars, tower strip table (`tower_id`, km marker, type, height, corrosion, gps, components).
  - Otherwise a table (one row per line): line, route, kV/circuit, km, towers (spacing), conductor, fiber, JB. Row click → `onPick(line.id)`.

- [ ] **Step 1: Write the component**

Create `frontend/src/pages/LineSummary.jsx`:

```jsx
import { KpiTile, BarRow } from '../components/InfraVisuals';

function Chip({ children }) {
  return <span className="infra-chip">{children}</span>;
}

function sortedTypes(assetTypes) {
  return Object.entries(assetTypes || {}).sort((a, b) => b[1] - a[1]);
}

function conductorLabel(c) {
  return c ? c : 'Not recorded';
}

export default function LineSummary({ lines, towersByLine, focusId, onPick }) {
  const focused = lines.find((l) => l.id === Number(focusId));

  if (focused) {
    const types = sortedTypes(focused.asset_types);
    const max = types.length ? Math.max(...types.map(([, n]) => n)) : 1;
    const towers = towersByLine[focused.id] || [];
    const route = `${focused.from_sub ? focused.from_sub.name : '—'} ⇄ ${focused.to_sub ? focused.to_sub.name : '—'}`;
    return (
      <div>
        <div className="spread">
          <div>
            <h2 className="section-title">{focused.name}</h2>
            <div className="mt">
              <Chip>{focused.line_id}</Chip>
              <Chip>{focused.voltage_kv} kV</Chip>
              <Chip>{focused.circuit_count === 2 ? 'Double circuit' : 'Single circuit'}</Chip>
              <Chip>{focused.operational_status}</Chip>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => onPick(null)}>Back to all lines</button>
        </div>
        <div className="muted mt">{route}</div>
        <div className="grid grid-4 mt">
          <KpiTile label="Towers" value={focused.tower_count} sub={`spacing ${focused.tower_spacing_km} km`} />
          <KpiTile label="Length" value={`${focused.length_km} km`} />
          <KpiTile label="Conductor" value={conductorLabel(focused.conductor_type)} />
          <KpiTile label="Joint boxes" value={focused.joint_box_count} />
          <KpiTile label="Fiber (OPGW)" value={focused.fiber_on_towers.towers} sub={`${focused.fiber_on_towers.qty} spans`} />
          <KpiTile label="Conductor spans" value={focused.conductor_span_count} />
        </div>
        <div className="grid grid-2 mt">
          <div className="card card-pad">
            <h3 className="section-title">Line asset mix</h3>
            {types.length === 0 && <div className="muted">No line-level assets (towers carry the line)</div>}
            {types.slice(0, 8).map(([type, n]) => (
              <BarRow key={type} label={type.replace(/_/g, ' ')} value={n} max={max} />
            ))}
          </div>
          <div className="card card-pad">
            <h3 className="section-title">Towers on this line</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Tower</th><th>km</th><th>Type</th><th>Height</th><th>Corrosion</th><th>GPS</th><th>Parts</th></tr></thead>
                <tbody>
                  {towers.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.tower_id}</td>
                      <td>{t.km_marker ?? '—'}</td>
                      <td>{t.tower_type}</td>
                      <td>{t.height_m ? `${t.height_m} m` : '—'}</td>
                      <td>{t.corrosion_rating}</td>
                      <td>{t.gps_validated ? '✓' : '—'}</td>
                      <td>{t.component_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {towers.length === 0 && <div className="muted mt">No towers recorded yet</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Line</th><th>Route</th><th>kV</th><th>Circuit</th><th>km</th><th>Towers</th><th>Conductor</th><th>Fiber</th><th>JB</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} onClick={() => onPick(l.id)} style={{ cursor: 'pointer' }}>
                <td><b>{l.line_id}</b> <span className="muted" style={{ fontSize: 12 }}>{l.name}</span></td>
                <td>{l.from_sub ? l.from_sub.name : '—'} ⇄ {l.to_sub ? l.to_sub.name : '—'}</td>
                <td>{l.voltage_kv}</td>
                <td>{l.circuit_count === 2 ? 'Double' : 'Single'}</td>
                <td>{l.length_km}</td>
                <td>{l.tower_count} <span className="muted">({l.tower_spacing_km}/km)</span></td>
                <td>{conductorLabel(l.conductor_type)}</td>
                <td>{l.fiber_on_towers.towers ? `${l.fiber_on_towers.towers} towers` : '—'}</td>
                <td>{l.joint_box_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length === 0 && <div className="muted" style={{ padding: 12 }}>No transmission lines in this scope</div>}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd /workspace/frontend && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/LineSummary.jsx
git commit -m "feat(infra): transmission line summary table and detail view"
```

---

### Task 7: Drill-down tree component

**Files:**
- Create: `frontend/src/components/InfraTree.jsx`

**Interfaces:**
- Consumes Task 1 `regions[i]`, `substations[i]`, `lines[i]` shapes.
- Produces default export `InfraTree({ regions, substations, lines, selection, onSelect })`:
  - `selection` = `{ region, substation, line }` (ids or `null`); the node matching `selection` for the current focus is highlighted.
  - `onSelect(scope)` where `scope` is one of `{ kind: 'region', id }`, `{ kind: 'substation', id }`, `{ kind: 'line', id }`, or `{ kind: 'all' }`.
  - Root node "All regions" with child badges; each region expandable (chevron), children grouped under **Substations** and **Lines** subfolders; leaves show badge counts; search box filters by name/code.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/InfraTree.jsx`:

```jsx
import { useEffect, useMemo, useState } from 'react';

function Badge({ n }) {
  return n != null && Number(n) > 0 ? <span className="hub-badge">{n}</span> : null;
}

export default function InfraTree({ regions, substations, lines, selection, onSelect }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set());

  const subsByRegion = useMemo(() => {
    const m = {};
    for (const s of substations) (m[s.region_id] = m[s.region_id] || []).push(s);
    return m;
  }, [substations]);
  const linesByRegion = useMemo(() => {
    const m = {};
    for (const l of lines) (m[l.region_id] = m[l.region_id] || []).push(l);
    return m;
  }, [lines]);

  // Auto-open regions that contain the selected entity.
  useEffect(() => {
    if (selection.substation || selection.line) {
      const rid = selection.substation
        ? (substations.find((s) => s.id === Number(selection.substation)) || {}).region_id
        : (lines.find((l) => l.id === Number(selection.line)) || {}).region_id;
      if (rid) setOpen((prev) => new Set(prev).add(rid));
    } else if (selection.region) {
      setOpen((prev) => new Set(prev).add(Number(selection.region)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.region, selection.substation, selection.line]);

  const ql = q.trim().toLowerCase();
  const filteredRegions = ql
    ? regions.filter((r) =>
        r.name.toLowerCase().includes(ql) || r.code.toLowerCase().includes(ql) ||
        (subsByRegion[r.id] || []).some((s) => s.name.toLowerCase().includes(ql) || s.substation_id.toLowerCase().includes(ql)) ||
        (linesByRegion[r.id] || []).some((l) => l.name.toLowerCase().includes(ql) || l.line_id.toLowerCase().includes(ql)))
    : regions;

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const sel = (kind, id) => {
    const row = (kind === 'region' ? { r: regions } : kind === 'substation' ? { r: substations } : { r: lines }).r.find((x) => x.id === Number(id));
    const label = row ? (row.name || row.substation_id || row.line_id) : '';
    onSelect({ kind, id: Number(id), label });
  };

  const cls = (match) => match ? 'hub-node sel' : 'hub-node';

  return (
    <div className="hub-tree-pad">
      <input className="hub-search" placeholder="Search regions, substations, lines…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className={cls(!selection.region && !selection.substation && !selection.line)} onClick={() => onSelect({ kind: 'all', label: 'All regions' })}>
        <span className="ico">▣</span> All regions <Badge n={regions.length} />
      </div>
      {filteredRegions.map((r) => {
        const subs = subsByRegion[r.id] || [];
        const lins = linesByRegion[r.id] || [];
        const isOpen = open.has(r.id) || !!ql;
        return (
          <div key={r.id}>
            <div className={cls(selection.region === r.id && !selection.substation && !selection.line)}>
              <button className="hub-caret" onClick={() => toggle(r.id)}>{isOpen ? '▾' : '▸'}</button>
              <span className="hub-row-main" onClick={() => sel('region', r.id)}>
                {r.code} · <span className="muted">{r.name}</span>
              </span>
              <Badge n={subs.length + lins.length} />
            </div>
            {isOpen && (
              <div className="hub-child">
                {subs.length > 0 && (
                  <>
                    <div className="hub-folder">Substations <Badge n={subs.length} /></div>
                    {subs.map((s) => (
                      <div key={s.id} className={cls(selection.substation === s.id)}>
                        <span className="hub-row-main leaf" onClick={() => sel('substation', s.id)}>{s.name}</span>
                        <Badge n={s.asset_count} />
                      </div>
                    ))}
                  </>
                )}
                {lins.length > 0 && (
                  <>
                    <div className="hub-folder">Lines <Badge n={lins.length} /></div>
                    {lins.map((l) => (
                      <div key={l.id} className={cls(selection.line === l.id)}>
                        <span className="hub-row-main leaf" onClick={() => sel('line', l.id)}>{l.line_id}</span>
                        <Badge n={l.tower_count} />
                      </div>
                    ))}
                  </>
                )}
                {subs.length === 0 && lins.length === 0 && <div className="muted hub-empty">No children</div>}
              </div>
            )}
          </div>
        );
      })}
      {filteredRegions.length === 0 && <div className="muted hub-empty">No matches</div>}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd /workspace/frontend && npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/InfraTree.jsx
git commit -m "feat(infra): searchable infrastructure drill-down tree"
```

---

### Task 8: Infrastructure hub page + navigation + manage panes + CSS

**Files:**
- Create: `frontend/src/pages/Infrastructure.jsx`
- Modify: `frontend/src/App.jsx` (nav + routes)
- Modify: `frontend/src/i18n.js` (three `infrastructure` keys)
- Modify: `frontend/src/styles.css` (append hub styles)

**Interfaces:**
- Consumes: `RegionSummary`, `SubstationSummary`, `LineSummary` (default exports), `InfraTree` (default export), Task 1 endpoint shape. Embeds legacy pages `Regions`, `Substations`, `Lines`, `Towers` (unchanged default exports).
- Produces route `/infrastructure` rendering the hub. URL params: `tab` (`region|substation|line`), `region`, `substation`, `line` (ids), `manage` (`regions|substations|lines|towers`).
- `App.jsx`: sidebar `infrastructureGroup` becomes one entry `{ to: '/infrastructure', key: 'infrastructure', ico: '▣' }` followed by `{ to: '/assets', key: 'assets', ico: '▤' }`. Routes for `/regions`, `/substations`, `/lines`, `/towers` become `<Navigate>` to `/infrastructure?manage=…`; add route `/infrastructure`.

- [ ] **Step 1: Write the hub page**

Create `frontend/src/pages/Infrastructure.jsx`:

```jsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Page, Loading, ErrorNote } from '../components';
import InfraTree from '../components/InfraTree';
import RegionSummary from './RegionSummary';
import SubstationSummary from './SubstationSummary';
import LineSummary from './LineSummary';
import Regions from './Regions';
import Substations from './Substations';
import Lines from './Lines';
import Towers from './Towers';

const TAB_KINDS = [
  { key: 'region', label: 'Regions' },
  { key: 'substation', label: 'Substations' },
  { key: 'line', label: 'Transmission lines' },
];
const MANAGE = { regions: <Regions />, substations: <Substations />, lines: <Lines />, towers: <Towers /> };

export default function Infrastructure() {
  const [sp, setSp] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const patch = useCallback((obj) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  }, [sp, setSp]);

  const tab = TAB_KINDS.some((t) => t.key === sp.get('tab')) ? sp.get('tab') : 'region';
  const rid = sp.get('region') ? Number(sp.get('region')) : null;
  const sid = sp.get('substation') ? Number(sp.get('substation')) : null;
  const lid = sp.get('line') ? Number(sp.get('line')) : null;
  const manage = ['regions', 'substations', 'lines', 'towers'].includes(sp.get('manage')) ? sp.get('manage') : null;

  const load = () => api.get('/infrastructure').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const subById = useMemo(() => new Map((data?.substations || []).map((s) => [s.id, s])), [data]);
  const lineById = useMemo(() => new Map((data?.lines || []).map((l) => [l.id, l])), [data]);
  const towersByLine = useMemo(() => {
    const m = {};
    for (const t of data?.towers || []) (m[t.line_id] = m[t.line_id] || []).push(t);
    return m;
  }, [data]);

  const clearScope = () => patch({ region: null, substation: null, line: null, tab: 'region' });
  const goAll = () => patch({ region: null, substation: null, line: null, tab: null, manage: null });

  function pick(scope) {
    if (scope.kind === 'all') return clearScope();
    if (scope.kind === 'region') return patch({ region: scope.id, substation: null, line: null, tab: 'region' });
    if (scope.kind === 'substation') {
      const s = subById.get(scope.id);
      return patch({ region: s ? s.region_id : rid, substation: scope.id, line: null, tab: 'substation' });
    }
    const l = lineById.get(scope.id);
    return patch({ region: l ? l.region_id : rid, substation: null, line: scope.id, tab: 'line' });
  }

  function focusRegion() {
    if (tab !== 'region') return;
    const rows = data.regions.filter((r) => (rid ? r.id === rid : true));
    return <RegionSummary regions={rows} focusId={rid} onPick={(id) => (id === null ? patch({ region: null }) : pick({ kind: 'region', id }))} />;
  }
  function focusSubstation() {
    const rows = data.substations.filter((s) => (rid ? s.region_id === rid : true));
    return <SubstationSummary substations={rows} focusId={sid} onPick={(id) => (id === null ? patch({ substation: null }) : pick({ kind: 'substation', id }))} />;
  }
  function focusLine() {
    const rows = data.lines.filter((l) => (rid ? l.region_id === rid : true));
    return <LineSummary lines={rows} towersByLine={towersByLine} focusId={lid} onPick={(id) => (id === null ? patch({ line: null }) : pick({ kind: 'line', id }))} />;
  }

  if (manage) {
    return (
      <>
        <div className="filters">
          <button className="btn btn-sm" onClick={goAll}>← Back to Infrastructure summaries</button>
        </div>
        {MANAGE[manage]}
      </>
    );
  }

  const region = rid ? data?.regions.find((r) => r.id === rid) : null;
  const substation = sid ? subById.get(sid) : null;
  const line = lid ? lineById.get(lid) : null;
  const crumbPath = [
    ...(region ? [{ label: region.code, action: () => patch({ region: null, substation: null, line: null }) }] : []),
    ...(substation ? [{ label: substation.substation_id, action: () => patch({ substation: null }) }] : []),
    ...(line ? [{ label: line.line_id, action: () => patch({ line: null }) }] : []),
  ];

  return (
    <Page title="Infrastructure" crumbs="TMMS / Infrastructure"
      actions={<>
        {['regions', 'substations', 'lines', 'towers'].map((m) => (
          <button key={m} className="btn btn-sm" onClick={() => patch({ manage: m })}>Manage {m === 'lines' ? 'lines' : m}</button>
        ))}
      </>}>
      {error && <div><ErrorNote error={error} /><button className="btn btn-sm mt" onClick={load}>Retry</button></div>}
      {!data && !error && <Loading />}
      {data && (
        <div className="hub">
          <div className="card hub-tree">
            <InfraTree regions={data.regions} substations={data.substations} lines={data.lines}
              selection={{ region: rid, substation: sid, line: lid }} onSelect={pick} />
          </div>
          <div className="hub-main">
            <div className="crumbs2">
              <span className={region || substation || line ? 'crumb-link' : 'crumb-cur'} onClick={() => { if (region || substation || line) clearScope(); }}>
                All regions
              </span>
              {crumbPath.map((c, i) => (
                <span key={i} style={{ display: 'flex', gap: 6 }}>
                  <span>/</span>
                  <span className="crumb-link" onClick={c.action}>{c.label}</span>
                </span>
              ))}
              {(substation || line) && (
                <span className="crumb-x" onClick={() => { patch({ substation: null, line: null, tab: 'region' }); }} title="Clear focus">✕</span>
              )}
            </div>
            <div className="tabs">
              {TAB_KINDS.map((t) => (
                <button key={t.key} className={'tab' + (tab === t.key ? ' active' : '')}
                  onClick={() => patch({ tab: t.key })}>
                  {t.label}
                </button>
              ))}
            </div>
            {tab === 'region' && focusRegion()}
            {tab === 'substation' && focusSubstation()}
            {tab === 'line' && focusLine()}
          </div>
        </div>
      )}
    </Page>
  );
}
```

- [ ] **Step 2: App.jsx nav + routes**

In `frontend/src/App.jsx`:
- In `buildNav()`, change the `infrastructureGroup` block to:

```js
{ group: 'infrastructureGroup', items: [
  { to: '/infrastructure', key: 'infrastructure', ico: '▣' },
  { to: '/assets', key: 'assets', ico: '▤' },
]},
```

- Replace the four route lines inside the `<Route element={<RequireAuth><Shell /></RequireAuth>}>` block:

```jsx
<Route path="/regions" element={<Navigate to="/infrastructure?manage=regions" replace />} />
<Route path="/substations" element={<Navigate to="/infrastructure?manage=substations" replace />} />
<Route path="/lines" element={<Navigate to="/infrastructure?manage=lines" replace />} />
<Route path="/towers" element={<Navigate to="/infrastructure?manage=towers" replace />} />
```

and add before the wildcard route:

```jsx
<Route path="/infrastructure" element={<Infrastructure />} />
```

- Add to the import list (near the `Value` import): `import Infrastructure from './pages/Infrastructure';`
- Note: the `import` of the four entity pages in `App.jsx` is no longer needed for routes, but they ARE imported by `Infrastructure.jsx` — in `App.jsx` remove the now-unused `Regions/Substations/Lines/Towers` imports (leave `Value`/`Overview`/etc. as-is).

- [ ] **Step 3: i18n keys**

In `frontend/src/i18n.js` add one line to each of the three locale dictionaries (alphabetical spot near `infrastructureGroup`):
- English (`en`): `infrastructure: 'Infrastructure',`
- Spanish (`es`): `infrastructure: 'Infraestructura',`
- Chinese (`zh`): `infrastructure: '基础设施',`

- [ ] **Step 4: CSS additions**

Append to `frontend/src/styles.css`:

```css
/* ---- Infrastructure hub ---- */
.hub { display: flex; align-items: flex-start; gap: 16px; }
.hub-tree { width: 280px; flex: 0 0 280px; max-height: calc(100vh - 190px); overflow: auto; padding: 8px; }
.hub-main { flex: 1; min-width: 0; }
.hub-search { width: 100%; padding: 7px 9px; border: 1px solid var(--border); border-radius: 7px; font-size: 13px; font-family: inherit; margin-bottom: 8px; }
.hub-node { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.hub-node:hover { background: #eef2ff; }
.hub-node.sel { background: #eef2ff; color: #4338ca; font-weight: 600; }
.hub-caret { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 10px; padding: 2px 4px; }
.hub-row-main { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hub-row-main.leaf { color: #333; }
.hub-badge { margin-left: auto; background: #eef2ff; color: #4338ca; border-radius: 9px; padding: 0 7px; font-size: 11px; font-weight: 600; }
.hub-child { padding-left: 18px; }
.hub-folder { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); padding: 6px 4px 2px; }
.hub-empty { font-size: 12px; padding: 8px 4px; }
.crumbs2 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin-bottom: 10px; }
.crumb-link { cursor: pointer; color: #4338ca; }
.crumb-cur { color: #111; font-weight: 600; }
.crumb-x { cursor: pointer; color: var(--muted); margin-left: 4px; }
.hub-card { cursor: pointer; }
.hub-card:hover { border-color: #c7d2fe; }
.infra-chip { display: inline-block; background: #f1f5f9; border-radius: 999px; padding: 1px 9px; margin: 1px 3px 1px 0; font-size: 12px; color: #334155; }
.ktile .ktile-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.ktile .ktile-value { font-size: 24px; font-weight: 700; margin-top: 4px; line-height: 1.1; }
.ktile .ktile-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
.bar-row { margin-bottom: 10px; font-size: 13px; }
.bar-track { background: #eef2ff; border-radius: 4px; height: 8px; margin-top: 4px; }
.bar-fill { height: 8px; border-radius: 4px; background: #4338ca; }
.donut-wrap { display: flex; flex-direction: column; align-items: center; }
.donut { width: 120px; height: 120px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.donut-hole { width: 66px; height: 66px; background: #fff; border-radius: 50%; }
@media (max-width: 980px) { .hub { flex-direction: column; } .hub-tree { width: 100%; flex: none; max-height: 260px; } }
```

- [ ] **Step 5: Build + route smoke**

Run: `cd /workspace/frontend && npm run build`
Expected: succeeds with no warnings about unused imports.

Then (with the 3199 backend still running from Task 2) the build gate above is the only automated check available (no headless browser). Interactive tab/tree behaviour is exercised manually on the live preview in Task 9. The build output is the acceptance gate for this task.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Infrastructure.jsx frontend/src/App.jsx frontend/src/i18n.js frontend/src/styles.css
git commit -m "feat(infra): infrastructure hub page with tree, tabs and manage panes"
```

---

### Task 9: Full-stack live smoke + cleanup

**Files:** (none — verification only)

- [ ] **Step 1: Restart the live stack from the committed tree**

Stop the isolated 3199 server (`background_terminal_kill <id>`) and the current live backend terminal if it is running from this repo (the live :3001 `term_1788785175744_121` and Vite :5173 `term_1788519864950_72` from earlier work). Then re-deploy the updated code:

```bash
cd /workspace/backend && node -c server.js && node -c routes/infrastructure.js && node -e "const s=require('node:sqlite').DatabaseSync; new s('/workspace/backend/tmms.db').exec(\"VACUUM INTO '/tmp/opencode/tmms-plan/tmms-live-pre.db'\"); console.log('pre snapshot ok');"
```

Start backend on 3001 in a background terminal:
```bash
cd /workspace/backend && PORT=3001 node server.js
```
Start Vite dev on 5173 in a background terminal (if not already running):
```bash
cd /workspace/frontend && npm run dev -- --port 5173
```
Confirm via the preview URL (https://5173-….monkeycode-ai.live) that the SPA loads.

- [ ] **Step 2: Hub smoke**

Login as `admin`/`Admin@123` in the preview. Verify:
1. Sidebar shows a single **Infrastructure** entry under Infrastructure plus Assets; the old flat Regions/Substations/Lines/Towers links are gone.
2. Opening Infrastructure renders the tree (All regions + C1… regions), the horizontal tabs, and the breadcrumb.
3. Region tab shows the 13 region cards; click **C1 Central 1 …** → detail shows KPI tiles, asset-mix bars and condition donut; breadcrumb shows `All regions / C1`.
4. Substation tab lists C1's substations (scope follows); open **Sululta** → detail with voltage chips, transformer count, incident lines.
5. Transmission lines tab lists the two C1 lines; open **TL-C1-002** → detail with towers strip (52 rows), JB=4, fiber towers=52.
6. Manage Substations button opens the legacy CRUD; "← Back to Infrastructure summaries" returns.
7. Visit `/regions` directly in the address bar → redirects to `/infrastructure?manage=regions`.
8. Login as `dir.c1`/`Region@123` → tree shows only C1; region tab shows 1 card; counts match the C1 numbers from Task 2.

- [ ] **Step 3: Regression smoke**

From the same preview as admin: Dashboard, Map, Assets, Tasks, Value & Cost (Valuation tab), Reports all still load and the legacy Manage views' Add/Edit/Delete/import still work as before (spot-check Region detail View map + a Line Manage route import dialog opens).

- [ ] **Step 4: Cleanup**

Stop the temporary 3199 server if still running. Leave the live :3001 + :5173 servers running for the user's preview.

- [ ] **Step 5: Final gate**

Run `cd /workspace/backend && node -c server.js && echo OK` and `cd /workspace/frontend && npm run build` — both clean. Nothing further to commit unless Step 2/3 surfaced a fix, in which case commit it with `git add <files>` and a `fix(infra): …` message.
