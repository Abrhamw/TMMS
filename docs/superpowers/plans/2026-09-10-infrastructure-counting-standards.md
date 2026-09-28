# Infrastructure Counting Standards (Sub-project B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make substation bay counts, transmission-line tower counts, tower mirror assets, and per-tower-type standard part sets authoritative, verifiable, and repairable.

**Architecture:** A standards module seeds a full per-type tower part set into a new `tower_component_standard` table; an integrity module owns all sync helpers (`syncSubstationBayCount`, `syncLineTowerCount`, `syncTowerMirror`, `reconcileAll`, `validateIntegrity`, `towerCompliance`). Existing asset/tower CRUD calls the sync helpers, boot runs an idempotent reconcile, and new region-scoped endpoints expose validation/reconcile/reset. The React frontend surfaces derived bay counts, per-tower compliance, line rollups, and an Infrastructure "Data validation" view.

**Tech Stack:** Node.js >= 22.5 (Express 5, CommonJS, `node:sqlite` `DatabaseSync`), React + Vite + Leaflet frontend.

## Global Constraints

- Backend is CommonJS (`require`), Node >= 22.5.0; SQLite via `node:sqlite` `DatabaseSync`; WAL mode; DB path `process.env.TMMS_DB || backend/tmms.db`.
- There is NO test framework. Verify with: `node --check <file>` on touched backend files, a scratch backend on an isolated DB (ports 3011–3013) plus `curl`, and `npm run build` in `frontend/`.
- Never stage or commit runtime files: `backend/tmms.db*`, `backend/uploads/`.
- Follow existing patterns: schema in `initSchema()` (`backend/db.js`), inline migrations via `migrate(table, col, sql)`, region scoping via `isGlobal`/`checkRegion`, audit via `audit(user, action, entity, id, detail)`.
- `cleanRow` (`backend/util.js:39`) drops null/undefined, so clearing a nullable column needs an explicit `UPDATE ... SET col = NULL`.
- Bump `revision` where the existing code does (`updateRow(..., 'revision')`), not otherwise.
- No new frontend dependencies; reuse `Page`, `Modal`, `Pill`, `KpiTile`, `can/getStoredUser`.
- Keep the six tower types exactly: `SUSPENSION`, `TENSION`, `ANGLE`, `TERMINAL`, `TRANSITION`, `DEAD_END`.

## File Structure

Backend:
- `backend/db.js` — add `tower_component_standard` table (Modify).
- `backend/towerStandards.js` — per-type standards + seeding (Create).
- `backend/towerComponents.js` — keep `COMPONENT_CATALOG`; drop `seedDefaultComponents` (Modify).
- `backend/integrity.js` — sync/reconcile/validate/compliance (Create).
- `backend/routes/core.js` — tower/asset counters, reset endpoints, compliance fields (Modify).
- `backend/routes/assets.js` — call `syncSubstationBayCount` on CRUD (Modify).
- `backend/routes/infrastructure.js` — validation/reconcile endpoints + bay breakdown (Modify).
- `backend/seed.js` — per-type seeding in `backfill` (Modify).
- `backend/server.js` — boot seeding + reconcile (Modify).

Frontend:
- `frontend/src/pages/Substations.jsx` — derived bay field, detail bays (Modify).
- `frontend/src/pages/SubstationSummary.jsx` — bay breakdown (Modify).
- `frontend/src/pages/Towers.jsx` — Standard column, detail comparison, reset (Modify).
- `frontend/src/pages/Lines.jsx` — line rollup + reset all (Modify).
- `frontend/src/pages/Infrastructure.jsx` — Data validation manage view (Modify).
- `frontend/src/pages/DataValidation.jsx` — new validation page (Create).

---

### Task 1: Standards table & per-type part sets

**Files:**
- Modify: `backend/db.js` (add table inside `initSchema()` before the closing of the template string near line 495)
- Create: `backend/towerStandards.js`
- Modify: `backend/towerComponents.js` (remove `seedDefaultComponents`, keep `COMPONENT_CATALOG`, update `module.exports`)
- Modify: `backend/routes/core.js:6,634,671,863` (import + call sites)
- Modify: `backend/seed.js:4,724`
- Modify: `backend/server.js:5-7,29-33` (boot seeding)

**Interfaces:**
- Produces: `seedTowerComponentStandards(): void`, `getStandardForType(towerType): Array<{component_type,name,material,default_quantity,unit}>`, `seedStandardComponents(towerId: number, towerType: string): void`, and `STANDARD_SETS: Record<string, Array<...>>`.
- Consumers: Task 2 (`getStandardForType`), Task 3 (`seedStandardComponents` reset), Task 5 (`towerCompliance`).

- [ ] **Step 1: Add the standards table to the schema**

In `backend/db.js`, inside the `db.exec(\`...\`)` template that ends at line 496, add this table just before the closing backtick (after the `asset_catalog` unique index at line 495):

```sql
  CREATE TABLE IF NOT EXISTS tower_component_standard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tower_type TEXT NOT NULL,
    component_type TEXT NOT NULL,
    name TEXT NOT NULL,
    material TEXT NOT NULL,
    default_quantity INTEGER NOT NULL,
    unit TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tower_component_standard_key
    ON tower_component_standard(tower_type, component_type);
```

(Note: `active` is intentionally omitted — the seeded set is fixed for now and the spec defers admin editing.)

- [ ] **Step 2: Create `backend/towerStandards.js`**

```js
const { db } = require('./db');
const { COMPONENT_CATALOG } = require('./towerComponents');

const TOWER_TYPES = ['SUSPENSION', 'TENSION', 'ANGLE', 'TERMINAL', 'TRANSITION', 'DEAD_END'];

// Per-type quantity overrides on top of the master COMPONENT_CATALOG defaults.
// A value of 0 removes that component from the type's standard set.
const TYPE_OVERRIDES = {
  SUSPENSION: { INSULATOR_STRING: 6, CONDUCTOR_CLAMP: 6, DAMPER: 18, SPACER: 0, JOINT_BOX: 0, CROSS_ARM: 3 },
  TENSION: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 12, SPACER: 9, JOINT_BOX: 6, CROSS_ARM: 3 },
  ANGLE: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 12, SPACER: 9, JOINT_BOX: 6, CROSS_ARM: 6, LATTICE_MEMBER: 30 },
  TERMINAL: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 6, SPACER: 6, JOINT_BOX: 9, CROSS_ARM: 6, PEAK_MAST: 1, FOUNDATION: 6 },
  TRANSITION: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 12, SPACER: 9, JOINT_BOX: 6, CROSS_ARM: 4 },
  DEAD_END: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 9, SPACER: 6, JOINT_BOX: 9, CROSS_ARM: 6, PEAK_MAST: 1, FOUNDATION: 6, ANTI_CLIMBING: 4 },
};

const STANDARD_SETS = {};
for (const type of TOWER_TYPES) {
  const overrides = TYPE_OVERRIDES[type] || {};
  STANDARD_SETS[type] = COMPONENT_CATALOG
    .map((c) => {
      const qty = Object.prototype.hasOwnProperty.call(overrides, c.type) ? overrides[c.type] : c.defaultQty;
      return { component_type: c.type, name: c.name, material: c.material, default_quantity: qty, unit: c.unit };
    })
    .filter((c) => c.default_quantity > 0);
}

let seeded = false;

function seedTowerComponentStandards() {
  if (seeded) return;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO tower_component_standard (tower_type, component_type, name, material, default_quantity, unit) VALUES (?,?,?,?,?,?)'
  );
  for (const [type, rows] of Object.entries(STANDARD_SETS)) {
    for (const r of rows) {
      stmt.run(type, r.component_type, r.name, r.material, r.default_quantity, r.unit);
    }
  }
  seeded = true;
}

function getStandardForType(towerType) {
  seedTowerComponentStandards();
  const type = TOWER_TYPES.includes(String(towerType || '').toUpperCase())
    ? String(towerType).toUpperCase()
    : 'SUSPENSION';
  let rows = db.prepare(
    'SELECT component_type, name, material, default_quantity, unit FROM tower_component_standard WHERE tower_type = ? ORDER BY id'
  ).all(type);
  if (rows.length === 0 && type !== 'SUSPENSION') {
    rows = db.prepare(
      'SELECT component_type, name, material, default_quantity, unit FROM tower_component_standard WHERE tower_type = ? ORDER BY id'
    ).all('SUSPENSION');
  }
  return rows;
}

function seedStandardComponents(towerId, towerType) {
  const rows = getStandardForType(towerType);
  const stmt = db.prepare(
    'INSERT INTO tower_component (tower_id, component_type, name, material, quantity, unit, condition_rating, status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  const now = new Date().toISOString();
  for (const r of rows) {
    stmt.run(towerId, r.component_type, r.name, r.material, r.default_quantity, r.unit, 8, 'INSTALLED', null, now);
  }
}

module.exports = { TOWER_TYPES, STANDARD_SETS, seedTowerComponentStandards, getStandardForType, seedStandardComponents };
```

- [ ] **Step 3: Drop `seedDefaultComponents` from `towerComponents.js`**

Replace the `seedDefaultComponents` function and `module.exports` line (`backend/towerComponents.js:31-42`) with:

```js
module.exports = { COMPONENT_CATALOG };
```

- [ ] **Step 4: Repoint call sites to `seedStandardComponents`**

In `backend/routes/core.js`, change the import at line 6 to:

```js
const { COMPONENT_CATALOG } = require('../towerComponents');
const { seedStandardComponents } = require('../towerStandards');
```

Then:
- `core.js:634` (inside `towers-from-route`): `seedStandardComponents(id, 'SUSPENSION');`
- `core.js:671` (POST `/towers`): `seedStandardComponents(id, req.body.tower_type);`
- `core.js:863` (tower import): `seedStandardComponents(tid, body.tower_type);`

In `backend/seed.js`, change line 4 to:

```js
const { seedStandardComponents } = require('./towerStandards');
```

and line 724 to:

```js
if (have === 0) seedStandardComponents(tw.id, tw.tower_type);
```

- [ ] **Step 5: Seed the standards table and reconcile at boot**

In `backend/server.js`, add to the require block near line 7:

```js
const { seedTowerComponentStandards } = require('./towerStandards');
```

and after `ensureCostDemo();` / `ensureCatalogPrices();` (line 33), add:

```js
seedTowerComponentStandards();
```

(Reconcile is added in Task 2.)

- [ ] **Step 6: Verify syntax and boot**

Run:
```bash
node --check backend/towerStandards.js && node --check backend/db.js && node --check backend/routes/core.js && node --check backend/seed.js && node --check backend/server.js
```
Expected: no output (all pass).

- [ ] **Step 7: Verify the table seeds**

Run a scratch server on an isolated DB (never touch `backend/tmms.db`):
```bash
TMMS_DB=/tmp/b1-task1.db PORT=3011 node backend/server.js &
sleep 2
```
Then query the same DB (note the matching `TMMS_DB`):
```bash
TMMS_DB=/tmp/b1-task1.db node -e "const{db}=require('./backend/db');const r=db.prepare('SELECT tower_type, COUNT(*) c FROM tower_component_standard GROUP BY tower_type ORDER BY tower_type').all();console.log(r)"
```
Expected: six rows, one per tower type, each with `c` > 0 (SUSPENSION has fewer rows than TENSION due to removed components).

Stop the scratch server by its process id (`kill <pid>`), never with `pkill`/`killall`.

- [ ] **Step 8: Commit**

```bash
git add backend/db.js backend/towerStandards.js backend/towerComponents.js backend/routes/core.js backend/seed.js backend/server.js
git commit -m "feat(backend): add per-tower-type standard part sets"
```

---

### Task 2: Integrity module & counter wiring

**Files:**
- Create: `backend/integrity.js`
- Modify: `backend/routes/assets.js` (POST/PUT/DELETE `/assets`)
- Modify: `backend/routes/core.js` (tower CRUD inline `tower_count` updates → helpers)
- Modify: `backend/seed.js` (`backfill` uses sync helpers; drop duplicated loops)
- Modify: `backend/server.js` (boot `reconcileAll()`)

**Interfaces:**
- Consumes: `getStandardForType` (Task 1).
- Produces: `syncSubstationBayCount(substationId)`, `syncLineTowerCount(lineId)`, `syncTowerMirror(towerId): {created,changed}`, `reconcileAll({regionIds}?): {lines_fixed,towers_fixed,mirrors_created,substations_fixed}`, `towerCompliance(towerId): {tower_type,standard_count,recorded_count,missing[],extra[],qty_mismatches[],compliant}`, `validateIntegrity({regionIds}?): report`.
- Consumers: Task 3 endpoints, Task 5 tower UI.

- [ ] **Step 1: Create `backend/integrity.js`**

```js
const { db } = require('./db');
const { getStandardForType } = require('./towerStandards');

function ph(n) { return Array(n).fill('?').join(','); }

function syncSubstationBayCount(substationId) {
  if (substationId == null) return;
  const r = db.prepare(
    "SELECT COUNT(DISTINCT TRIM(bay)) c FROM asset WHERE substation_id = ? AND lifecycle_status != 'REMOVED' AND bay IS NOT NULL AND TRIM(bay) != ''"
  ).get(substationId);
  db.prepare('UPDATE substation SET bay_count = ? WHERE id = ?').run(r.c, substationId);
}

function syncLineTowerCount(lineId) {
  if (lineId == null) return;
  const r = db.prepare('SELECT COUNT(*) c FROM tower WHERE line_id = ?').get(lineId);
  db.prepare('UPDATE transmission_line SET tower_count = ? WHERE id = ?').run(r.c, lineId);
}

function syncTowerMirror(towerId) {
  const t = db.prepare('SELECT * FROM tower WHERE id = ?').get(towerId);
  if (!t) return { created: false, changed: false };
  const mirrors = db.prepare("SELECT * FROM asset WHERE tower_id = ? AND asset_type = 'TOWER'").all(towerId);
  const metadata = JSON.stringify({ source: 'tower', tower_type: t.tower_type, height_m: t.height_m });
  if (mirrors.length === 0) {
    db.prepare(
      `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      `TWR-${t.tower_id}`, 'TOWER', t.line_id, t.id, t.tower_id, t.latitude, t.longitude,
      t.corrosion_rating ?? 8, new Date().toISOString(), 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM',
      t.gps_validated, metadata
    );
    return { created: true, changed: true };
  }
  const m = mirrors[0];
  const changed = m.name !== t.tower_id || m.line_id !== t.line_id || m.latitude !== t.latitude ||
    m.longitude !== t.longitude || (m.condition_rating ?? 8) !== (t.corrosion_rating ?? 8) ||
    m.gps_validated !== t.gps_validated || m.metadata !== metadata;
  if (changed) {
    db.prepare(
      'UPDATE asset SET name = ?, line_id = ?, latitude = ?, longitude = ?, condition_rating = ?, gps_validated = ?, metadata = ? WHERE tower_id = ? AND asset_type = ?'
    ).run(t.tower_id, t.line_id, t.latitude, t.longitude, t.corrosion_rating ?? 8, t.gps_validated, metadata, t.id, 'TOWER');
  }
  return { created: false, changed };
}

function towerCompliance(towerId) {
  const t = db.prepare('SELECT * FROM tower WHERE id = ?').get(towerId);
  if (!t) return null;
  const std = getStandardForType(t.tower_type);
  const actual = db.prepare('SELECT component_type, quantity FROM tower_component WHERE tower_id = ?').all(towerId);
  const actualMap = new Map(actual.map((a) => [a.component_type, a.quantity]));
  const stdMap = new Map(std.map((s) => [s.component_type, s.default_quantity]));
  const missing = [];
  const qty_mismatches = [];
  for (const s of std) {
    if (!actualMap.has(s.component_type)) missing.push(s.component_type);
    else if (Number(actualMap.get(s.component_type)) !== Number(s.default_quantity)) {
      qty_mismatches.push({ component_type: s.component_type, expected: s.default_quantity, actual: actualMap.get(s.component_type) });
    }
  }
  const extra = actual.filter((a) => !stdMap.has(a.component_type)).map((a) => a.component_type);
  return {
    tower_type: t.tower_type,
    standard_count: std.length,
    recorded_count: actual.length,
    missing,
    extra,
    qty_mismatches,
    compliant: missing.length === 0 && extra.length === 0 && qty_mismatches.length === 0,
  };
}

function validateIntegrity({ regionIds } = {}) {
  const scoped = Array.isArray(regionIds) && regionIds.length > 0;
  const subWhere = scoped ? ` WHERE region_id IN (${ph(regionIds.length)})` : '';
  const lineWhere = scoped ? ` WHERE l.region_id IN (${ph(regionIds.length)})` : '';

  const substations = db.prepare(`SELECT * FROM substation${subWhere} ORDER BY substation_id`).all(...(scoped ? regionIds : []));
  const lines = db.prepare(
    `SELECT l.* FROM transmission_line l${lineWhere} ORDER BY l.line_id`
  ).all(...(scoped ? regionIds : []));

  const subOut = [];
  const subIssueIds = new Set();
  for (const s of substations) {
    const actual = db.prepare(
      "SELECT COUNT(DISTINCT TRIM(bay)) c FROM asset WHERE substation_id = ? AND lifecycle_status != 'REMOVED' AND bay IS NOT NULL AND TRIM(bay) != ''"
    ).get(s.id).c;
    subOut.push({ id: s.id, substation_id: s.substation_id, name: s.name, bay_count: s.bay_count, actual_bay_count: actual });
    if (Number(s.bay_count) !== Number(actual)) subIssueIds.add(s.id);
  }

  const lineOut = [];
  const towerOut = [];
  let issues = subIssueIds.size;
  for (const l of lines) {
    const towers = db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY id').all(l.id);
    const actualTower = towers.length;
    const missingMirrors = towers.filter((t) => {
      const m = db.prepare("SELECT COUNT(*) c FROM asset WHERE tower_id = ? AND asset_type = 'TOWER'").get(t.id).c;
      return m !== 1;
    }).length;
    let nonStandard = 0;
    for (const t of towers) {
      const c = towerCompliance(t.id);
      if (c && !c.compliant) {
        nonStandard += 1;
        towerOut.push({ id: t.id, tower_id: t.tower_id, line_id: l.id, ...c });
      }
    }
    const lineIssues = (Number(l.tower_count) !== actualTower ? 1 : 0) + missingMirrors + nonStandard;
    issues += lineIssues;
    lineOut.push({
      id: l.id, line_id: l.line_id, name: l.name,
      tower_count: l.tower_count, actual_tower_count: actualTower,
      missing_mirrors: missingMirrors, non_standard_towers: nonStandard,
    });
  }

  return {
    summary: { lines: lines.length, towers: lineOut.reduce((n, l) => n + l.actual_tower_count, 0), substations: substations.length, issues },
    lines: lineOut,
    towers: towerOut,
    substations: subOut,
  };
}

function reconcileAll({ regionIds } = {}) {
  const summary = { lines_fixed: 0, towers_fixed: 0, mirrors_created: 0, substations_fixed: 0 };
  const scoped = Array.isArray(regionIds) && regionIds.length > 0;
  const subs = scoped
    ? db.prepare(`SELECT * FROM substation WHERE region_id IN (${ph(regionIds.length)})`).all(...regionIds)
    : db.prepare('SELECT * FROM substation').all();
  for (const s of subs) {
    if (Number(s.bay_count) !== Number(
      db.prepare("SELECT COUNT(DISTINCT TRIM(bay)) c FROM asset WHERE substation_id = ? AND lifecycle_status != 'REMOVED' AND bay IS NOT NULL AND TRIM(bay) != ''").get(s.id).c
    )) summary.substations_fixed += 1;
    syncSubstationBayCount(s.id);
  }
  const lines = scoped
    ? db.prepare(`SELECT * FROM transmission_line WHERE region_id IN (${ph(regionIds.length)})`).all(...regionIds)
    : db.prepare('SELECT * FROM transmission_line').all();
  for (const l of lines) {
    if (Number(l.tower_count) !== Number(db.prepare('SELECT COUNT(*) c FROM tower WHERE line_id = ?').get(l.id).c)) summary.lines_fixed += 1;
    syncLineTowerCount(l.id);
  }
  const towers = scoped
    ? db.prepare(`SELECT t.* FROM tower t JOIN transmission_line l ON l.id = t.line_id WHERE l.region_id IN (${ph(regionIds.length)})`).all(...regionIds)
    : db.prepare('SELECT * FROM tower').all();
  for (const t of towers) {
    const r = syncTowerMirror(t.id);
    if (r.created) summary.mirrors_created += 1;
    if (r.changed) summary.towers_fixed += 1;
  }
  return summary;
}

module.exports = {
  syncSubstationBayCount, syncLineTowerCount, syncTowerMirror,
  towerCompliance, validateIntegrity, reconcileAll,
};
```

- [ ] **Step 2: Wire bay-count sync into asset CRUD and make `bay_count` non-writable**

In `backend/routes/assets.js`, add to the requires at the top:

```js
const { syncSubstationBayCount } = require('../integrity');
```

In `router.post('/assets')` after `insertRow` and before `res.status(201)...` (around line 288-290), add:

```js
syncSubstationBayCount(body.substation_id);
```

In `router.put('/assets/:id')` after `updateRow` (line 304) and before `res.json`, add:

```js
syncSubstationBayCount(a.substation_id);
syncSubstationBayCount(body.substation_id);
```

In `router.delete('/assets/:id')` after `safeDelete` (line 320), add:

```js
syncSubstationBayCount(a.substation_id);
```

Then in `backend/routes/core.js`, make the derived counter authoritative on substation writes. In
`router.post('/substations')`, before `insertRow` (line 401) add `delete body.bay_count;` and after
`insertRow` add `syncSubstationBayCount(id);`. In `router.put('/substations/:id')`, before
`updateRow` (line 421) add `delete body.bay_count;` and after `updateRow` add
`syncSubstationBayCount(Number(req.params.id));`. (`syncSubstationBayCount` is imported in Step 3;
move that import here so it is available in both steps.)

- [ ] **Step 3: Replace inline tower_count updates in core.js**

In `backend/routes/core.js`, add to the requires:

```js
const { syncSubstationBayCount, syncLineTowerCount, syncTowerMirror, towerCompliance } = require('../integrity');
```

Replace each inline statement with the helper calls:
- `core.js:641`: `db.prepare('UPDATE transmission_line SET tower_count = ...').run(line.id, line.id);` → `syncLineTowerCount(line.id);`
- `core.js:672`: same statement → `syncLineTowerCount(req.body.line_id);` and after the frontend mirror insert add `syncTowerMirror(id);`
- `core.js:720`: `...run(t.line_id, t.line_id);` → `syncLineTowerCount(t.line_id);`
- `core.js:874` (import loop): `db.prepare('UPDATE transmission_line SET tower_count = ...').run(line.id, line.id);` → `syncLineTowerCount(line.id);` and after the create/update branch add `syncTowerMirror(existing ? existing.id : tid);`

For the POST `/towers` path, also call `syncTowerMirror` after the manual mirror `INSERT` at `core.js:674-681`:
```js
syncTowerMirror(id);
```
(Idempotent — it updates the just-created mirror.)

- [ ] **Step 4: Update `backfill` in seed.js to use the helpers**

In `backend/seed.js`, change the require at line 4 area to also import integrity helpers:

```js
const { seedStandardComponents } = require('./towerStandards');
const { syncLineTowerCount, syncSubstationBayCount } = require('./integrity');
```

In `backfill()`, replace the inline `tower_count` loop (`seed.js:727-733`) with:
```js
const lines = db.prepare('SELECT * FROM transmission_line').all();
for (const l of lines) {
  syncLineTowerCount(l.id);
```
(keep the rest of the existing loop body: veg clearance and route rebuild).

Add, at the end of `backfill()`, before `return`:
```js
for (const s of db.prepare('SELECT id FROM substation').all()) syncSubstationBayCount(s.id);
```

- [ ] **Step 5: Run reconcile at boot**

In `backend/server.js`, update the require near line 7:
```js
const { seedTowerComponentStandards } = require('./towerStandards');
const { reconcileAll } = require('./integrity');
```
and after `seedTowerComponentStandards();` add:
```js
console.log('Reconciled infrastructure counts:', reconcileAll());
```

- [ ] **Step 6: Verify syntax and boot**

```bash
node --check backend/integrity.js && node --check backend/routes/assets.js && node --check backend/routes/core.js && node --check backend/seed.js && node --check backend/server.js
```
Expected: no output.

Boot the scratch server on a fresh DB and confirm the reconcile log appears and the server starts:
```bash
TMMS_DB=/tmp/b1-task2.db PORT=3012 node backend/server.js &
sleep 2
curl -s localhost:3012/api/health
```
Expected: health JSON; console shows `Reconciled infrastructure counts: {...}`. Kill the scratch server by PID.

- [ ] **Step 7: Commit**

```bash
git add backend/integrity.js backend/routes/assets.js backend/routes/core.js backend/seed.js backend/server.js
git commit -m "feat(backend): derive bay/tower counts and reconcile tower mirrors"
```

---

### Task 3: Validation, reconcile & reset endpoints

**Files:**
- Modify: `backend/routes/infrastructure.js` (add validation + reconcile routes; add bay breakdown)
- Modify: `backend/routes/core.js` (add reset endpoints; expose compliance in `GET /towers` and `GET /towers/:id`)

**Interfaces:**
- Consumes: `validateIntegrity`, `reconcileAll`, `towerCompliance` (Task 2); `seedStandardComponents` (Task 1).
- Produces: `GET /api/infrastructure/validation`, `POST /api/infrastructure/reconcile`, `POST /api/towers/:id/reset-components`, `POST /api/lines/:id/reset-tower-components`; `GET /towers` gains `standard_count/recorded_count/compliant`, `GET /towers/:id` gains `compliance`.

- [ ] **Step 1: Add validation + reconcile routes to infrastructure.js**

In `backend/routes/infrastructure.js`, update the requires:
```js
const { isGlobal, can } = require('../auth');
const { validateIntegrity, reconcileAll } = require('../integrity');
```

Append before `module.exports = router;`:

```js
router.get('/infrastructure/validation', (req, res) => {
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = wanted
    ? [wanted]
    : isGlobal(req.user)
      ? db.prepare('SELECT id FROM region').all().map((r) => r.id)
      : [req.user.region_id];
  const report = validateIntegrity({ regionIds });
  const lineId = req.query.line_id ? Number(req.query.line_id) : null;
  if (lineId) {
    report.lines = report.lines.filter((l) => l.id === lineId);
    report.towers = report.towers.filter((t) => t.line_id === lineId);
    report.substations = [];
  }
  res.json(report);
});

router.post('/infrastructure/reconcile', (req, res) => {
  if (!can(req, 'tower:write') && !can(req, 'asset:write')) {
    return res.status(403).json({ error: 'Forbidden: requires tower:write or asset:write' });
  }
  const wanted = req.body && req.body.region_id ? Number(req.body.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = wanted ? [wanted] : (isGlobal(req.user) ? null : [req.user.region_id]);
  res.json(reconcileAll({ regionIds }));
});
```

- [ ] **Step 2: Add the bay breakdown to the substation output**

In `backend/routes/infrastructure.js`, inside the `subOut` loop (around line 145-161), compute bay counts and add `bays`:

```js
    const bayCounts = new Map();
    for (const a of arr) {
      const b = String(a.bay || '').trim();
      if (!b) continue;
      bayCounts.set(b, (bayCounts.get(b) || 0) + 1);
    }
    const bays = [...bayCounts.entries()].map(([bay, count]) => ({ bay, count })).sort((x, y) => x.bay.localeCompare(y.bay));
```
and add `bays,` to the `subOut.push({...})` object (next to `bay_count`).

- [ ] **Step 3: Add reset endpoints + compliance fields in core.js**

In `backend/routes/core.js`, the integrity helpers are already imported in Task 2; also import the standard seeder:
```js
const { seedStandardComponents } = require('../towerStandards');
```
and `towerCompliance` (imported in Task 2).

In `router.get('/towers', ...)` (line 648), after `t.component_count = ...` loop, add compliance summary:
```js
  for (const t of rows) {
    const c = towerCompliance(t.id);
    t.standard_count = c ? c.standard_count : 0;
    t.recorded_count = c ? c.recorded_count : 0;
    t.compliant = c ? c.compliant : true;
  }
```

In `router.get('/towers/:id', ...)` (line 731), after `t.components = listComponents(t.id);` add:
```js
  t.compliance = towerCompliance(t.id);
```

Append the reset endpoints before the tower-components section (after `router.delete('/towers/:id', ...)` at line 724):

```js
router.post('/towers/:id/reset-components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkRegion(req, res, line.region_id)) return;
  db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
  seedStandardComponents(t.id, t.tower_type);
  audit(req.user, 'UPDATE', 'tower', t.id, { reset_components: true, tower_type: t.tower_type });
  res.json({ ok: true, compliance: towerCompliance(t.id) });
});

router.post('/lines/:id/reset-tower-components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  const towers = db.prepare('SELECT * FROM tower WHERE line_id = ?').all(line.id);
  let components_written = 0;
  for (const t of towers) {
    db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
    seedStandardComponents(t.id, t.tower_type);
    components_written += db.prepare('SELECT COUNT(*) c FROM tower_component WHERE tower_id = ?').get(t.id).c;
  }
  audit(req.user, 'UPDATE', 'transmission_line', line.id, { reset_tower_components: true, towers: towers.length });
  res.json({ towers_reset: towers.length, components_written });
});
```

- [ ] **Step 4: Verify syntax**

```bash
node --check backend/routes/infrastructure.js && node --check backend/routes/core.js
```
Expected: no output.

- [ ] **Step 5: Verify endpoints on a scratch server**

```bash
TMMS_DB=/tmp/b1-task3.db PORT=3013 node backend/server.js &
sleep 2
TOKEN=$(curl -s -X POST localhost:3013/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
curl -s localhost:3013/api/infrastructure/validation -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('issues',r.summary.issues,'lines',r.lines.length,'towers',r.towers.length)})"
```
Expected: `issues` > 0 (seeded towers are non-standard), and line/tower arrays populated. Then test reset:
```bash
TID=$(curl -s "localhost:3013/api/towers?limit=1" -H "Authorization: Bearer $TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].id))")
curl -s -X POST localhost:3013/api/towers/$TID/reset-components -H "Authorization: Bearer $TOKEN"
```
Expected: `{ "ok": true, "compliance": { "compliant": true, ... } }`. Kill the scratch server by PID.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/infrastructure.js backend/routes/core.js
git commit -m "feat(backend): add validation, reconcile and standard-reset endpoints"
```

---

### Task 4: Substation derived bays UI

**Files:**
- Modify: `frontend/src/pages/Substations.jsx` (remove editable bay field; show derived + bay breakdown)
- Modify: `frontend/src/pages/SubstationSummary.jsx` (bay breakdown in hub)

**Interfaces:**
- Consumes: `GET /infrastructure` now returns `substations[].bays: [{bay,count}]` (Task 3), and `GET /substations/:id` returns `bay_count` (already).

- [ ] **Step 1: Remove the editable Bay Count field and derive it**

Delete the `bay_count: 0` entry from the `blank` object (`Substations.jsx:14`) and delete the entire Bay Count form field (`Substations.jsx:202`). In `save()` (`Substations.jsx:38`), delete `bay_count` from the outgoing body so the server-derived value is never clobbered:
```js
      delete body.bay_count;
```
Replace the existing detail key/value row at `Substations.jsx:148` with a derived, labelled value:
```jsx
                <span className="k">Bays</span><span>{detail.bay_count} <span className="muted">(derived from asset bay labels)</span></span>
```

- [ ] **Step 2: Show the bay breakdown in the substation detail modal**

The `GET /substations/:id` response already includes `assets` (`core.js:383`). In `Substations.jsx`, compute the breakdown from `detail.assets` right before the `return` of the detail modal's right column. Add this `useMemo` at the top of the component (after the `detail` state):
```jsx
  const detailBays = useMemo(() => {
    const m = new Map();
    for (const a of detail?.assets || []) {
      const b = String(a.bay || '').trim();
      if (!b) continue;
      m.set(b, (m.get(b) || 0) + 1);
    }
    return [...m.entries()].map(([bay, count]) => ({ bay, count })).sort((x, y) => x.bay.localeCompare(y.bay));
  }, [detail]);
```
Add `useMemo` to the React import on line 1. Then insert this card at the top of the detail modal's right column (before the Assets heading, `Substations.jsx:160`):
```jsx
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
```

- [ ] **Step 3: Show the bay breakdown in `SubstationSummary.jsx`**

In the focused substation block (`SubstationSummary.jsx:41-59`), add a "Bays" card next to "Asset mix":

```jsx
          <div className="card card-pad">
            <div className="card-head"><h3 className="card-title">Bays</h3></div>
            {(!focused.bays || focused.bays.length === 0) && <div className="muted">No bay labels recorded on this substation's assets yet</div>}
            {(focused.bays || []).map((b) => (
              <div key={b.bay} className="spread" style={{ padding: '4px 0' }}>
                <span>{b.bay}</span>
                <span className="muted" style={{ fontSize: 12 }}>{b.count} asset(s)</span>
              </div>
            ))}
          </div>
```

Change the `grid grid-2` wrapping these two cards (line 41) to `grid grid-3` so the three blocks fit.

- [ ] **Step 4: Verify the frontend builds**

```bash
npm run build
```
Run in `frontend/`. Expected: build succeeds (exit 0).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Substations.jsx frontend/src/pages/SubstationSummary.jsx
git commit -m "feat(ui): show derived substation bay counts and breakdown"
```

---

### Task 5: Towers standard compliance UI

**Files:**
- Modify: `frontend/src/pages/Towers.jsx` (Standard column, detail comparison, reset button)

**Interfaces:**
- Consumes: `GET /towers` now returns `standard_count`, `recorded_count`, `compliant`; `GET /towers/:id` returns `compliance: {standard_count,recorded_count,missing[],extra[],qty_mismatches[],compliant}` (Task 3); `POST /towers/:id/reset-components`.

- [ ] **Step 1: Add the Standard column to the towers table**

In `Towers.jsx`, add a header cell `<th>Standard</th>` before the existing `<th>Components</th>` (`Towers.jsx:185`). In the row, before the parts button cell (`Towers.jsx:198`), add:

```jsx
                    <td>
                      <span style={{ color: r.compliant ? '#15803d' : '#b45309', fontWeight: 600 }}>
                        {r.recorded_count ?? 0}/{r.standard_count ?? 0}
                      </span>
                    </td>
```

Also update the empty-state cell `colSpan="12"` (`Towers.jsx:209`) to `colSpan="13"` since a column was added.

- [ ] **Step 2: Add the expected-vs-recorded section and reset button to the detail modal**

In `Towers.jsx`, in the detail modal after the components table (`Towers.jsx:364`) and before the "Related tasks" heading, add:

```jsx
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
```

In the detail modal footer (`Towers.jsx:309-313`), add a reset button when `canWrite`:

```jsx
            <button className="btn" onClick={async () => {
              try {
                await api.post(`/towers/${detail.id}/reset-components`, {});
                setDetail(await api.get(`/towers/${detail.id}`));
                load();
              } catch (e) { setError(e.message); }
            }}>Reset to standard</button>
```

- [ ] **Step 3: Verify the frontend builds**

```bash
npm run build
```
Run in `frontend/`. Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Towers.jsx
git commit -m "feat(ui): show tower standard compliance and reset action"
```

---

### Task 6: Line rollup & Data validation view

**Files:**
- Modify: `frontend/src/pages/Lines.jsx` (line standards rollup + reset all)
- Modify: `frontend/src/pages/Infrastructure.jsx` (add `validate` manage view)
- Create: `frontend/src/pages/DataValidation.jsx`

**Interfaces:**
- Consumes: `GET /infrastructure/validation?line_id=&region_id=`, `POST /infrastructure/reconcile`, `POST /lines/:id/reset-tower-components`.

- [ ] **Step 1: Create `frontend/src/pages/DataValidation.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Page, Loading, ErrorNote } from '../components';
import { KpiTile } from '../components/InfraVisuals';
import { can, getStoredUser } from '../auth';

export default function DataValidation({ embedded }) {
  const canWrite = can(getStoredUser(), 'tower:write') || can(getStoredUser(), 'asset:write');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/infrastructure/validation').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function reconcile() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.post('/infrastructure/reconcile', {});
      setNotice(`Reconciled: ${r.substations_fixed} substation(s), ${r.lines_fixed} line(s), ${r.mirrors_created} mirror(s) created, ${r.towers_fixed} tower(s) updated.`);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (error) return <ErrorNote error={error} />;
  if (!data) return embedded ? <Loading /> : <Page title="Data validation"><Loading /></Page>;

  const body = (
    <>
      {error && <ErrorNote error={error} />}
      {notice && <div className="alert alert-success">{notice}</div>}
      <div className="grid grid-3 mb">
        <KpiTile label="Issues" value={data.summary.issues} />
        <KpiTile label="Towers" value={data.summary.towers} />
        <KpiTile label="Substations" value={data.summary.substations} />
      </div>
      {canWrite && <div className="mb"><button className="btn btn-primary" disabled={busy} onClick={reconcile}>{busy ? 'Reconciling…' : 'Reconcile counts & mirrors'}</button></div>}

      <div className="card card-pad mb">
        <div className="card-head"><h3 className="card-title">Lines</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Line</th><th>tower_count</th><th>Actual</th><th>Missing mirrors</th><th>Non-standard towers</th></tr></thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td><b>{l.line_id}</b> <span className="muted">{l.name}</span></td>
                  <td>{l.tower_count}</td>
                  <td>{l.actual_tower_count}</td>
                  <td>{l.missing_mirrors}</td>
                  <td>{l.non_standard_towers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad mb">
        <div className="card-head"><h3 className="card-title">Non-standard towers</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Tower</th><th>Type</th><th>Recorded/Standard</th><th>Missing</th><th>Extra</th><th>Qty mismatch</th></tr></thead>
            <tbody>
              {data.towers.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.tower_id}</td>
                  <td>{t.tower_type}</td>
                  <td>{t.recorded_count}/{t.standard_count}</td>
                  <td>{t.missing.join(', ') || '—'}</td>
                  <td>{t.extra.join(', ') || '—'}</td>
                  <td>{t.qty_mismatches.map((m) => `${m.component_type} ${m.actual}≠${m.expected}`).join(', ') || '—'}</td>
                </tr>
              ))}
              {data.towers.length === 0 && <tr><td colSpan="6" className="empty">All towers match their type standard</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-head"><h3 className="card-title">Substation bays</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Substation</th><th>bay_count</th><th>Actual bays</th></tr></thead>
            <tbody>
              {data.substations.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.substation_id}</b> <span className="muted">{s.name}</span></td>
                  <td>{s.bay_count}</td>
                  <td style={{ color: Number(s.bay_count) !== Number(s.actual_bay_count) ? '#b45309' : undefined }}>{s.actual_bay_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );

  if (embedded) return body;
  return <Page title="Data validation" crumbs="TMMS / Infrastructure">{body}</Page>;
}
```

- [ ] **Step 2: Register the view in Infrastructure.jsx**

In `Infrastructure.jsx`, add the import:
```jsx
import DataValidation from './DataValidation';
```
Extend `MANAGE` (line 19):
```jsx
const MANAGE = { regions: <Regions embedded />, substations: <Substations embedded />, lines: <Lines embedded />, towers: <Towers embedded />, validate: <DataValidation embedded /> };
```
Extend the `manage` allow-list (line 39) to include `'validate'`:
```jsx
const manage = ['regions', 'substations', 'lines', 'towers', 'validate'].includes(sp.get('manage')) ? sp.get('manage') : null;
```
Add a button to the actions array (near line 93-95):
```jsx
        <button className="btn btn-sm" onClick={() => patch({ manage: 'validate' })}>Data validation</button>
```

- [ ] **Step 3: Add the line rollup and reset-all to Lines.jsx**

In `Lines.jsx`, add `const [lineValidation, setLineValidation] = useState(null);` alongside the other `useState` declarations (near line 40), then add the loader after `openDetail` (line 93-100):

```jsx
  async function loadLineValidation(id) {
    try { setLineValidation(await api.get(`/infrastructure/validation?line_id=${id}`)); }
    catch { setLineValidation(null); }
  }
```
Call it inside `openDetail` after `setDetail(d)`:
```jsx
      loadLineValidation(d.id);
```
In the line detail modal, after the Towers table block (around line 226), add:

```jsx
              {lineValidation && lineValidation.lines[0] && (
                <div className="card card-pad mt">
                  <div className="spread">
                    <div>
                      <b>Standards</b>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {lineValidation.lines[0].actual_tower_count} towers · {lineValidation.lines[0].non_standard_towers} non-standard · {lineValidation.lines[0].missing_mirrors} missing mirror(s)
                      </div>
                    </div>
                    {canWrite && lineValidation.lines[0].non_standard_towers > 0 && (
                      <button className="btn btn-sm" onClick={async () => {
                        try {
                          await api.post(`/lines/${detail.id}/reset-tower-components`, {});
                          setDetail(await api.get(`/lines/${detail.id}`));
                          loadLineValidation(detail.id);
                          load();
                        } catch (e) { setError(e.message); }
                      }}>Reset all towers to standard</button>
                    )}
                  </div>
                </div>
              )}
```

- [ ] **Step 4: Verify the frontend builds**

```bash
npm run build
```
Run in `frontend/`. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/DataValidation.jsx frontend/src/pages/Infrastructure.jsx frontend/src/pages/Lines.jsx
git commit -m "feat(ui): add data validation view and line standards rollup"
```

---

## Self-Review

**Spec coverage:**
- §4.1 `tower_component_standard` → Task 1 Step 1-2.
- §4.2 derived `bay_count`/`tower_count` semantics → Task 2.
- §5.1 `towerStandards.js` → Task 1 Step 2.
- §5.2 `integrity.js` → Task 2 Step 1.
- §5.3 wiring + boot → Task 2 Steps 2-5.
- §6.1 validation endpoint → Task 3 Step 1.
- §6.2 reconcile endpoint → Task 3 Step 1.
- §6.3/§6.4 reset endpoints → Task 3 Step 3.
- §7.1 substation bays → Task 4.
- §7.2 towers Standard column → Task 5 Step 1.
- §7.3 tower detail comparison/reset → Task 5 Step 2.
- §7.4 line rollup/reset → Task 6 Step 3.
- §7.5 Data validation view → Task 6 Steps 1-2.
- §8 seed → Task 1 Step 4 (`backfill` type seeding), Task 2 Step 4 (substation bay sync at backfill).
- §9 migration/testing → per-task verify steps.

**Placeholder scan:** No TBD/TODO; every code step contains full code or an exact replacement.

**Type consistency:** `seedStandardComponents(towerId, towerType)`, `syncSubstationBayCount`, `syncLineTowerCount`, `syncTowerMirror`, `towerCompliance`, `validateIntegrity({regionIds})`, `reconcileAll({regionIds})` are used consistently across tasks. `compliance` shape (`standard_count`, `recorded_count`, `missing`, `extra`, `qty_mismatches`, `compliant`) is identical in `integrity.js` and the UI.
