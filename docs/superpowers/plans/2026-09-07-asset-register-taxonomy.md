# Asset Register Taxonomy & Hierarchy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give TMMS a controlled asset catalog (families → types → subtypes) and a location-driven register tree (Region → Substation: family → bay → asset; Region → Line: conductor/OPGW spans, 4–5 km joint boxes, towers with part registers), with server-built region-scoped tree counts that the future pricing rollup will reuse.

**Architecture:** One new catalog module + table drives typing everywhere. Schema additions live in the existing `db.js` migrate block. A new `register.js` route builds the region-scoped tree server-side from existing `asset`/`tower`/`tower_component`/`substation`/`transmission_line` tables. JB generation is an action on the line (chainage multiples of `joint_box_interval_km`). Frontend gets a focused `RegisterTree` component; the Assets page's asset-type pickers and filters become catalog-driven. All writes keep using `insertRow`/`updateRow` + `audit` and the existing `scopeRows`/`checkRegion`/`isGlobal` scoping.

**Tech Stack:** Node 22 (`node:sqlite`), Express 5, plain React (Vite). No new npm dependencies.

## Global Constraints

- Schema table/column additions go ONLY through the `migrate()` helper in `backend/db.js` (guard `PRAGMA table_info`, same shape as lines 468–491). Table DDL goes in the `initSchema()` template (add before the closing backtick at `db.js:466`).
- Region scoping reuses `scopeRows`/`checkRegion`/`isGlobal`/`inRegion` from `backend/auth.js`. Every new read endpoint scopes; every write checks region before mutating.
- Master-data writes (assets, catalog, JB generation) stay admin-only in practice — gate new write endpoints with `can(req, 'asset:write')` (catalog) and `can(req, 'line:write')` (JB generation); both are admin-only under the current `ROLE_PERMS`. Frontend mirrors writes with `can(getStoredUser(), 'asset:write')`.
- The register-count invariant: within any scope, the tree's total asset counts (excluding `lifecycle_status='REMOVED'`) equal `GET /api/assets/summary` totals for the same scope.
- Spec deviation (noted): the tower part-register vocabulary stays `COMPONENT_CATALOG` (`backend/towerComponents.js`). `asset_catalog` gains a `TOWER_PARTS` family *derived from* `COMPONENT_CATALOG` at seed time for labeling/reporting only — it does not change tower component CRUD.
- Every tower row must have exactly one corresponding `asset` row with `asset_type='TOWER'`; a backfill in catalog ensure repairs drift so the register never double-counts.
- Keep code style: 2-space indent, `const`, terse section comments only. No destructive commands; background services stop only via `background_terminal_kill <id>`.
- All e2e runs against an isolated DB copy on port **3199**; live :3001 stays untouched until the final task.
- Files end with `node -c` clean (backend) and `npm run build` clean (frontend) before a task is committed.

---

### Task 1: `asset_catalog` table, columns, catalog module, catalog endpoints

**Files:**
- Modify: `backend/db.js:466` (insert table DDL before closing backtick) and `:491` (append migrate calls after line 491, inside `initSchema`)
- Create: `backend/assetCatalog.js`
- Create: `backend/routes/catalog.js`
- Modify: `backend/server.js:5,22-28,58` (require + ensure + mount)

**Interfaces:**
- Produces: `backend/assetCatalog.js` exports `CATALOG` (array of row objects), `ensureAssetCatalog()` (idempotent; seeds catalog, migrates legacy `asset_type` values, backfills tower `TOWER` asset rows), `findCatalog(type, sub)` returns a catalog row or `undefined`. `backend/routes/catalog.js` exports router with `GET /asset-catalog` (any authenticated user), `POST /asset-catalog`, `PUT /asset-catalog/:id` (admin, `asset:write`).
- Catalog row shape: `{ id, family, family_label, label, asset_type, sub_type, unit_of_measure, location_kind, default_location_type, attribute_schema, default_unit_price, active }`.

- [ ] **Step 1: Add the table and columns**

In `backend/db.js`, add before the closing backtick of the big `db.exec(\`...\`)` (currently line 466, right after the `org_unit` table). Replace:

```js
  CREATE TABLE IF NOT EXISTS org_unit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    unit_type TEXT NOT NULL,
    parent_id INTEGER REFERENCES org_unit(id),
    region_id INTEGER REFERENCES region(id),
    manager_person_id INTEGER REFERENCES person(id),
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT
  );
  `);
```

with:

```js
  CREATE TABLE IF NOT EXISTS org_unit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    unit_type TEXT NOT NULL,
    parent_id INTEGER REFERENCES org_unit(id),
    region_id INTEGER REFERENCES region(id),
    manager_person_id INTEGER REFERENCES person(id),
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS asset_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family TEXT NOT NULL,
    family_label TEXT NOT NULL,
    label TEXT,
    asset_type TEXT NOT NULL,
    sub_type TEXT NOT NULL DEFAULT '',
    unit_of_measure TEXT NOT NULL DEFAULT 'EA',
    location_kind TEXT NOT NULL DEFAULT 'ANY',
    default_location_type TEXT,
    attribute_schema TEXT,
    default_unit_price REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_catalog_key ON asset_catalog(family, asset_type, sub_type);
  `);
```

Append after the existing migrate line at `db.js:491` (inside `initSchema`, before the closing `}`):

```js
  migrate('asset', 'km_from', 'ALTER TABLE asset ADD COLUMN km_from REAL');
  migrate('asset', 'km_to', 'ALTER TABLE asset ADD COLUMN km_to REAL');
  migrate('transmission_line', 'joint_box_interval_km', "ALTER TABLE transmission_line ADD COLUMN joint_box_interval_km REAL NOT NULL DEFAULT 5");
```

- [ ] **Step 2: Verify schema boot**

Run: `cd /workspace/backend && node -e "const {db}=require('./db'); console.log(db.prepare('PRAGMA table_info(asset_catalog)').all().map(c=>c.name).join(',')); console.log(db.prepare('PRAGMA table_info(asset)').all().some(c=>c.name==='km_from'))"` and confirm output contains `asset_catalog` columns including `km_from` = `true`. (This mutates the live DB by adding the catalog table + columns — intended and safe; no data change yet.)

- [ ] **Step 3: Write the catalog module**

Create `backend/assetCatalog.js`:

```js
// Controlled asset catalog (families -> types -> subtypes). Single source of
// truth for asset typing; seeded idempotently at every boot.
const { db } = require('./db');
const { insertRow } = require('./util');
const { COMPONENT_CATALOG } = require('./towerComponents');

const FAMILY_LABEL = {
  CONTROL_AND_PROTECTION: 'Control & Protection',
  SAS_RTU_AND_TELECOM: 'SAS / RTU & Telecom',
  DC_AND_AUXILIARY: 'DC System & Auxiliary Supplies',
  MV_SWITCHGEAR: 'MV/LV Switchgear',
  HV_YARD_AND_TRANSFORMATION: 'HV Yard & Transformation',
  CONDUCTOR_AND_OPGW: 'Conductors & OPGW',
  JOINT_BOX: 'Joint Boxes (line splices)',
  TOWER_PARTS: 'Tower Parts (register vocabulary)',
  TOWER_STRUCTURE: 'Tower Structure',
  UNCLASSIFIED: 'Unclassified / legacy',
};

const ROWS = [
  // Substation indoor / yard families
  ['CONTROL_AND_PROTECTION', 'PROTECTION_RELAY', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['CONTROL_AND_PROTECTION', 'RELAY_PANEL', '', 'PANEL', 'SUBSTATION', 'INDOOR'],
  ['CONTROL_AND_PROTECTION', 'METER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['CONTROL_AND_PROTECTION', 'SUBSTATION_CONTROLLER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'SCADA_RTU', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'IED', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'NETWORK_SWITCH', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'COMMUNICATION_RADIO', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'OPTICAL_FIBER', '', 'EA', 'SUBSTATION', 'ANY'],
  ['DC_AND_AUXILIARY', 'BATTERY_BANK', '', 'BANK', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'BATTERY_CHARGER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'DC_DISTRIBUTION_PANEL', '', 'PANEL', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'AUXILIARY_TRANSFORMER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'UPS', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'SWITCHGEAR', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'GIS', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'MV_CIRCUIT_BREAKER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'MV_DISCONNECTOR', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'TRANSFORMER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'AUTO_TRANSFORMER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'HV_CIRCUIT_BREAKER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'DISCONNECTOR', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'GROUND_SWITCH', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'CT', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'VT', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'LIGHTNING_ARRESTER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'BUSBAR', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'REACTOR', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'CAPACITOR_BANK', '', 'BANK', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'EARTHING_MAT', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  // Line families
  ['CONDUCTOR_AND_OPGW', 'CONDUCTOR_SPAN', '', 'KM', 'LINE', null],
  ['CONDUCTOR_AND_OPGW', 'OPGW_SPAN', '', 'KM', 'LINE', null],
  ['JOINT_BOX', 'JOINT_BOX', '', 'EA', 'LINE', null],
  ['TOWER_STRUCTURE', 'TOWER', '', 'EA', 'LINE', null],
  ['TOWER_STRUCTURE', 'POLE', '', 'EA', 'LINE', null],
];

const CATALOG = ROWS.map(([family, asset_type, sub_type, unit_of_measure, location_kind, default_location_type]) => ({
  family,
  family_label: FAMILY_LABEL[family],
  label: asset_type.replace(/_/g, ' '),
  asset_type,
  sub_type,
  unit_of_measure,
  location_kind,
  default_location_type,
  active: 1,
}));

// Tower part vocabulary derived from the existing component catalog.
for (const c of COMPONENT_CATALOG) {
  CATALOG.push({
    family: 'TOWER_PARTS',
    family_label: FAMILY_LABEL.TOWER_PARTS,
    label: c.name,
    asset_type: c.type,
    sub_type: '',
    unit_of_measure: String(c.unit || 'EA').toUpperCase(),
    location_kind: 'TOWER',
    default_location_type: null,
    active: 1,
  });
}

function findCatalog(asset_type, sub_type = '') {
  const s = sub_type == null ? '' : String(sub_type);
  const row = CATALOG.find((c) => c.asset_type === asset_type && (c.sub_type === s || (c.sub_type === '' && s === '')));
  if (row) return row;
  const any = CATALOG.find((c) => c.asset_type === asset_type);
  return any || undefined;
}

// Insert any asset_type still used by the database that is missing from the
// seed, so existing rows stay typable (legacy catch-all family).
function ensureLegacyTypes() {
  const used = db.prepare('SELECT DISTINCT asset_type AS t FROM asset').all();
  let added = 0;
  for (const { t } of used) {
    if (!t) continue;
    if (CATALOG.some((c) => c.asset_type === t)) continue;
    CATALOG.push({
      family: 'UNCLASSIFIED',
      family_label: FAMILY_LABEL.UNCLASSIFIED,
      label: t.replace(/_/g, ' '),
      asset_type: t,
      sub_type: '',
      unit_of_measure: 'EA',
      location_kind: 'ANY',
      default_location_type: null,
      active: 1,
    });
    added++;
  }
  return added;
}

// Every tower row keeps exactly one asset row of type TOWER so the register
// tree and register summary never double-count towers.
function backfillTowerAssets() {
  const missing = db.prepare(
    `SELECT t.id, t.tower_id, t.line_id, t.latitude, t.longitude, t.tower_type, t.tower_material, t.height_m,
            t.corrosion_rating, t.gps_validated
     FROM tower t
     WHERE NOT EXISTS (SELECT 1 FROM asset a WHERE a.tower_id = t.id AND a.asset_type = 'TOWER')`
  ).all();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const t of missing) {
    stmt.run(`TWR-${t.tower_id}`, 'TOWER', t.line_id, t.id, t.tower_id, t.latitude, t.longitude,
      t.corrosion_rating ?? 8, now, 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM', t.gps_validated,
      JSON.stringify({ source: 'tower', tower_type: t.tower_type, height_m: t.height_m, material: t.tower_material }));
  }
  return missing.length;
}

function ensureAssetCatalog() {
  const legacyAdded = ensureLegacyTypes();
  const stmt = db.prepare(
    `INSERT INTO asset_catalog (family, family_label, label, asset_type, sub_type, unit_of_measure, location_kind, default_location_type, active)
     VALUES (?,?,?,?,?,?,?,?,1)
     ON CONFLICT(family, asset_type, sub_type) DO NOTHING`
  );
  let seeded = 0;
  for (const c of CATALOG) {
    const r = stmt.run(c.family, c.family_label, c.label, c.asset_type, c.sub_type, c.unit_of_measure, c.location_kind, c.default_location_type);
    seeded += Number(r.changes);
  }
  const towers = backfillTowerAssets();
  console.log(`[assetCatalog] seeded ${seeded} catalog row(s) (${legacyAdded} legacy type(s) added), backfilled ${towers} tower asset row(s)`);
}

module.exports = { CATALOG, FAMILY_LABEL, findCatalog, ensureAssetCatalog };
```

- [ ] **Step 4: Write the catalog endpoints**

Create `backend/routes/catalog.js`:

```js
const express = require('express');
const { db, list, get, insertRow, updateRow } = require('../util');
const { can, checkRegion, audit } = require('../auth');

const router = express.Router();

const COLS = ['family', 'family_label', 'label', 'asset_type', 'sub_type', 'unit_of_measure', 'location_kind', 'default_location_type', 'attribute_schema', 'default_unit_price', 'active'];

function clean(body) {
  const out = {};
  for (const c of COLS) {
    if (c === 'attribute_schema') {
      if (body[c] != null) out[c] = typeof body[c] === 'string' ? body[c] : JSON.stringify(body[c]);
    } else if (body[c] !== undefined) {
      out[c] = body[c];
    }
  }
  return out;
}

router.get('/asset-catalog', (req, res) => {
  const rows = list('asset_catalog').filter((r) => r.active !== 0)
    .map((r) => ({ id: r.id, family: r.family, family_label: r.family_label, label: r.label, asset_type: r.asset_type, sub_type: r.sub_type, unit_of_measure: r.unit_of_measure, location_kind: r.location_kind, default_location_type: r.default_location_type, default_unit_price: r.default_unit_price }));
  const families = [];
  for (const r of rows) {
    let f = families.find((x) => x.family === r.family);
    if (!f) { f = { family: r.family, family_label: r.family_label, types: [] }; families.push(f); }
    f.types.push(r);
  }
  res.json({ count: rows.length, families });
});

router.post('/asset-catalog', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const { family, asset_type, sub_type = '' } = req.body || {};
  if (!family || !asset_type) return res.status(400).json({ error: 'family and asset_type are required' });
  const dup = db.prepare('SELECT id FROM asset_catalog WHERE family = ? AND asset_type = ? AND sub_type = ?').get(family, asset_type, sub_type);
  if (dup) return res.status(400).json({ error: 'Catalog entry already exists' });
  const body = { family, family_label: req.body.family_label || family.replace(/_/g, ' '), label: req.body.label || asset_type.replace(/_/g, ' '), asset_type, sub_type, unit_of_measure: req.body.unit_of_measure || 'EA', location_kind: req.body.location_kind || 'ANY', active: 1, ...clean(req.body) };
  const id = insertRow('asset_catalog', body);
  audit(req.user, 'CREATE', 'asset_catalog', id, { family, asset_type, sub_type });
  res.status(201).json(get('asset_catalog', id));
});

router.put('/asset-catalog/:id', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const row = get('asset_catalog', Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Catalog entry not found' });
  const body = clean({ ...row, ...req.body });
  if (body.asset_type) delete body.asset_type;
  if (body.family) delete body.family;
  if (body.sub_type !== undefined && body.sub_type === null) body.sub_type = '';
  updateRow('asset_catalog', row.id, body);
  audit(req.user, 'UPDATE', 'asset_catalog', row.id, req.body);
  res.json(get('asset_catalog', row.id));
});

module.exports = router;
```

- [ ] **Step 5: Wire into server boot and mounts**

In `backend/server.js`:
- Replace the seed require line at `server.js:5` `const { seedEep, reconcileSeedData } = require('./seed_eep');` to keep it, and add after it: `const { ensureAssetCatalog } = require('./assetCatalog');`
- After `reconcileSeedData();` (`server.js:28`) add:

```js
ensureAssetCatalog();
```

- In the mount block after `app.use('/api', require('./routes/admin'));` (`server.js:60`) add:

```js
app.use('/api', require('./routes/catalog'));
```

- [ ] **Step 6: Verify boot + endpoint**

Run isolated boot: `cd /workspace/backend && mkdir -p /tmp/opencode/tmms-plan && node -e "const {DatabaseSync}=require('node:sqlite'); const s=new DatabaseSync('/workspace/backend/tmms.db'); s.exec(\"VACUUM INTO '/tmp/opencode/tmms-plan/tmms.db'\"); console.log('snapshot ok');"` then start the copy on 3199 with a background terminal (remember the terminal id):

```bash
cd /workspace/backend && PORT=3199 TMMS_DB=/tmp/opencode/tmms-plan/tmms.db node server.js
```

Wait ~2s, read the boot log, confirm `[assetCatalog] seeded N catalog row(s) ... backfilled M tower asset row(s)`.

Then login and read the catalog:

```bash
TOK=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:3199/api/asset-catalog -H "Authorization: Bearer $TOK" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.count + " types across " + j.families.length + " families; first=" + j.families[0].family'
```

Expected: `~45 types across 10 families; first=CONTROL_AND_PROTECTION` (exact counts may vary with legacy types present).

- [ ] **Step 7: Commit**

```bash
cd /workspace && git add backend/db.js backend/assetCatalog.js backend/routes/catalog.js backend/server.js && git commit -m "feat(assets): asset_catalog table, seed module and CRUD endpoints"
```

---

### Task 2: Asset create/update validation (catalog + one-anchor + km rules)

**Files:**
- Modify: `backend/routes/assets.js:222-247` (POST/ PUT `/assets`)

**Interfaces:**
- Consumes: `findCatalog(type, sub)` from `backend/assetCatalog.js` (Task 1).
- Produces: a shared local validator `validateAssetBody(req, res, body, existing)` used by both POST and PUT; returns `false` after writing a `400` response on catalog miss, conflicting anchors, or bad km range.

- [ ] **Step 1: Add the validator + catalog import**

Replace the import block at `backend/routes/assets.js:7-8`:

```js
const { extractKmzText, extractPlacemarks } = require('../geoimport');
```

with:

```js
const { extractKmzText, extractPlacemarks } = require('../geoimport');
const { findCatalog } = require('../assetCatalog');
```

Insert before `router.post('/assets', ...)` at `assets.js:222`:

```js
// Anchor + catalog rules. Exactly one structural home: substation XOR tower
// (line allowed alongside tower for tower assets) XOR line-with-km-range;
// standalone lat/lng remains legal for legacy rows. km_* requires line_id.
function validateAssetBody(req, res, body) {
  const { asset_type, sub_type } = body;
  const cat = asset_type ? findCatalog(asset_type, sub_type) : undefined;
  if (!cat) {
    res.status(400).json({ error: `Unknown asset_type '${asset_type || ''}' — pick a catalog type` });
    return false;
  }
  const hasSub = body.sub_type != null && String(body.sub_type) !== '';
  if (hasSub && !cat.sub_type) {
    res.status(400).json({ error: `asset_type '${asset_type}' has no subtypes — remove sub_type` });
    return false;
  }
  const sub_ids = [body.substation_id, body.tower_id, body.line_id].filter((v) => v != null && v !== '');
  const sid = body.substation_id != null && body.substation_id !== '' ? Number(body.substation_id) : null;
  const tid = body.tower_id != null && body.tower_id !== '' ? Number(body.tower_id) : null;
  const lid = body.line_id != null && body.line_id !== '' ? Number(body.line_id) : null;
  if (sid != null && (tid != null || lid != null)) {
    res.status(400).json({ error: 'Substation asset cannot also anchor to a tower or line' });
    return false;
  }
  const kmFrom = body.km_from;
  const kmTo = body.km_to;
  const hasKm = kmFrom != null && kmFrom !== '' || kmTo != null && kmTo !== '';
  if (hasKm && lid == null) {
    res.status(400).json({ error: 'km_from/km_to require a line_id anchor' });
    return false;
  }
  if (hasKm && tid != null) {
    res.status(400).json({ error: 'km_from/km_to cannot be set on a tower asset' });
    return false;
  }
  if (hasKm) {
    const a = Number(kmFrom);
    const b = Number(kmTo);
    if ((kmFrom != null && kmFrom !== '' && !Number.isFinite(a)) || (kmTo != null && kmTo !== '' && !Number.isFinite(b))) {
      res.status(400).json({ error: 'km_from/km_to must be numeric' });
      return false;
    }
    if (kmFrom != null && kmFrom !== '' && kmTo != null && kmTo !== '' && b < a) {
      res.status(400).json({ error: 'km_to must be >= km_from' });
      return false;
    }
  }
  if (!sid && !tid && !lid) {
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: 'Standalone assets require latitude and longitude' });
      return false;
    }
  }
  return true;
}
```

- [ ] **Step 2: Apply validation in POST and PUT**

In `router.post('/assets', ...)` (`assets.js:222`), after the `try {` line (currently `const body = ...` at line 227), add before building `body`:

```js
    if (!validateAssetBody(req, res, req.body)) return;
```

In `router.put('/assets/:id', ...)` (`assets.js:237`), after the `const body = { ...req.body };` line (244) add:

```js
  if (!validateAssetBody(req, res, { ...a, ...req.body })) return;
```

- [ ] **Step 3: node -c and boot copy on 3199**

Run: `cd /workspace/backend && node -c routes/assets.js && echo OK`. If the isolated 3199 server from Task 1 is still running, stop it (`background_terminal_kill` with its id), re-snapshot with the Task 1 VACUUM command into `/tmp/opencode/tmms-plan/tmms.db`, and boot it again on 3199.

- [ ] **Step 4: Verify API behaviour**

Run against 3199 with the admin token from Task 1 (re-login first if expired):

```bash
ADMIN=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
echo '-- unknown type --'
curl -s -X POST http://localhost:3199/api/assets -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"name":"x","asset_id":"BAD-1","asset_type":"SPACE_LASER","latitude":9.02,"longitude":38.74,"condition_rating":7,"lifecycle_status":"IN_SERVICE","operational_status":"OPERATIONAL","criticality":"LOW"}'
echo; echo '-- substation + line conflict --'
curl -s -X POST http://localhost:3199/api/assets -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"name":"x","asset_id":"BAD-2","asset_type":"PROTECTION_RELAY","substation_id":1,"line_id":1,"latitude":9.02,"longitude":38.74,"condition_rating":7,"lifecycle_status":"IN_SERVICE","operational_status":"OPERATIONAL","criticality":"LOW"}'
echo; echo '-- valid KM span (needs a real line id; list first) --'
curl -s http://localhost:3199/api/lines -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j[0]&&j[0].id'
```

Use the printed line id `L` and create a valid span:

```bash
curl -s -X POST http://localhost:3199/api/assets -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"name":"Demo conductor span","asset_id":"SPAN-DEMO-1","asset_type":"CONDUCTOR_SPAN","line_id":L,"km_from":0,"km_to":12.5,"condition_rating":8,"lifecycle_status":"IN_SERVICE","operational_status":"OPERATIONAL","criticality":"MEDIUM"}'
```

Expected: the first two return `{"error":"..."}`, the span returns an asset object with `km_from:0` and `km_to:12.5`. Clean the two bad inserts never happened (they 400'd) and the valid span is fine to keep in the isolated copy only.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add backend/routes/assets.js && git commit -m "feat(assets): catalog and one-anchor validation on asset create/update"
```

---

### Task 3: Register tree endpoint (server-built, scoped)

**Files:**
- Create: `backend/routes/register.js`
- Modify: `backend/server.js` (mount)

**Interfaces:**
- Consumes: `db/list/get/insertRow` from `util.js`; `isGlobal`, `checkRegion` from `auth.js`. Catalog endpoint from Task 1 is independent.
- Produces: `GET /register/tree` returns `{ regions: [...] }` — see Step 1 shape. Each substation/line node carries `counts`; the endpoint honors `?region_id=` (non-global users are forced to their own region and get 403 if they pass another).
- Helper `lineCumulativeKm(line)` exported from `backend/routes/core.js` is NOT used here (kept local) to avoid a cycle.

- [ ] **Step 1: Write the route**

Create `backend/routes/register.js`:

```js
const express = require('express');
const { db, list, get } = require('../util');
const { isGlobal, checkRegion } = require('../auth');

const router = express.Router();

// Cumulative chainage along a line from its tower km_markers (towers are the
// route points). Falls back to the stored route length when towers lack km.
function chainagePoints(lineId) {
  const towers = db.prepare('SELECT id, km_marker, latitude, longitude FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId);
  return towers.map((t) => Number(t.km_marker) || 0);
}

function groupAssetsBySubstation(assets) {
  const families = new Map(); // family -> { meta, bays: Map(bay -> {bay, count, assets: []}) }
  for (const a of assets) {
    const fam = a._family_label || 'Unclassified';
    if (!families.has(fam)) {
      const bayMap = new Map();
      families.set(fam, { family: fam, family_label: fam, bays: bayMap });
    }
    const f = families.get(fam);
    const bay = String(a.bay || '').trim() || '(no bay)';
    if (!f.bays.has(bay)) f.bays.set(bay, { bay, count: 0, assets: [] });
    const b = f.bays.get(bay);
    b.count += 1;
    b.assets.push(a);
  }
  return [...families.values()].map((f) => ({
    family: f.family, family_label: f.family_label,
    bays: [...f.bays.values()].sort((x, y) => (x.bay === '(no bay)' ? 1 : y.bay === '(no bay)' ? -1 : x.bay.localeCompare(y.bay))),
  }));
}

function loadTree(regionId) {
  const region = get('region', regionId);
  const regionRow = { id: region.id, code: region.code, name: region.name, center_lat: region.center_lat, center_lng: region.center_lng };

  const lines = db.prepare('SELECT id FROM transmission_line WHERE region_id = ? ORDER BY name').all(regionId).map((r) => get('transmission_line', r.id, ['route_json']));
  const lineIds = lines.map((l) => l.id);
  const substations = db.prepare('SELECT id FROM substation WHERE region_id = ? ORDER BY name').all(regionId).map((r) => get('substation', r.id));

  const catalog = new Map();
  for (const c of db.prepare('SELECT family, family_label, asset_type, sub_type FROM asset_catalog').all()) {
    catalog.set(`${c.asset_type}|${c.sub_type || ''}`, c);
  }
  const famOf = (a) => {
    const c = catalog.get(`${a.asset_type}|${a.sub_type || ''}`) || catalog.get(`${a.asset_type}|`);
    if (c) return { family: c.family, family_label: c.family_label || c.family };
    return { family: 'UNCLASSIFIED', family_label: 'Unclassified' };
  };

  const inSubIds = new Set(substations.map((s) => s.id));
  const towerRows = db.prepare('SELECT * FROM tower ORDER BY km_marker, id').all();
  const lineOfTower = new Map(towerRows.map((t) => [t.id, t.line_id]));
  const towerAssetByTower = new Map();
  const assetsAll = db.prepare("SELECT * FROM asset WHERE lifecycle_status != 'REMOVED'").all().map((a) => ({ ...a, metadata: null }));
  const counted = [];
  for (const a of assetsAll) {
    a._fam = famOf(a);
    if (a.substation_id != null && inSubIds.has(a.substation_id)) counted.push({ node: 'sub', key: `sub:${a.substation_id}`, a });
    else if (a.tower_id != null && lineIds.includes(lineOfTower.get(a.tower_id))) {
      if (a.asset_type === 'TOWER' || a.asset_type === 'POLE') towerAssetByTower.set(a.tower_id, a);
      else counted.push({ node: 'line', key: `line:${lineOfTower.get(a.tower_id)}`, a });
    } else if (a.line_id != null && lineIds.includes(a.line_id)) {
      counted.push({ node: 'line', key: `line:${a.line_id}`, a });
    }
  }
  // Assign line-only families to their line; tower/POLE assets surface via tower nodes.
  const subAssetsByKey = new Map();
  const lineSpanAssets = new Map();   // key line:N
  const lineJBAssets = new Map();     // key line:N
  const lineOtherAssets = new Map();  // key line:N -> any other line-located asset
  for (const { node, key, a } of counted) {
    if (node === 'sub') {
      if (!subAssetsByKey.has(key)) subAssetsByKey.set(key, []);
      subAssetsByKey.get(key).push(a);
    } else {
      const fam = a._fam.family;
      const bucket = fam === 'CONDUCTOR_AND_OPGW' ? lineSpanAssets
        : fam === 'JOINT_BOX' ? lineJBAssets
          : lineOtherAssets;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(a);
    }
  }

  const childSubs = substations.map((s) => {
    const assets = (subAssetsByKey.get(`sub:${s.id}`) || []);
    const familyAgg = {};
    for (const a of assets) {
      familyAgg[a._fam.family] = familyAgg[a._fam.family] || { family: a._fam.family, family_label: a._fam.family_label, count: 0 };
      familyAgg[a._fam.family].count += 1;
    }
    return {
      id: s.id, substation_id: s.substation_id, name: s.name, region_id: s.region_id, latitude: s.latitude, longitude: s.longitude,
      counts: { assets: assets.length, families: Object.keys(familyAgg).length },
      families: groupAssetsBySubstation(assets),
    };
  }).filter((s) => s.counts.assets > 0 || true);

  const partCounts = db.prepare('SELECT tower_id, COUNT(*) c FROM tower_component GROUP BY tower_id').all();
  const partCountMap = new Map(partCounts.map((r) => [r.tower_id, r.c]));

  const childLines = lines.map((l) => {
    const spanAssets = (lineSpanAssets.get(`line:${l.id}`) || []).sort((x, y) => (Number(x.km_from) || 0) - (Number(y.km_from) || 0));
    const jbAssets = (lineJBAssets.get(`line:${l.id}`) || []).sort((x, y) => (Number(x.km_from) || 0) - (Number(y.km_from) || 0));
    const lineTowers = towerRows.filter((t) => t.line_id === l.id).map((t) => {
      const ta = towerAssetByTower.get(t.id);
      return {
        id: t.id, tower_id: t.tower_id, tower_number: t.tower_number, km_marker: t.km_marker, latitude: t.latitude, longitude: t.longitude,
        tower_type: t.tower_type, tower_material: t.tower_material, foundation_type: t.foundation_type, height_m: t.height_m, corrosion_rating: t.corrosion_rating,
        asset_id: ta ? ta.asset_id : null, asset_condition: ta ? ta.condition_rating : t.corrosion_rating,
        part_count: partCountMap.get(t.id) || 0,
        parts: db.prepare('SELECT component_type, name, quantity, unit, condition_rating, status FROM tower_component WHERE tower_id = ? ORDER BY component_type, name').all(t.id),
      };
    });
    return {
      id: l.id, line_id: l.line_id, name: l.name, region_id: l.region_id, voltage_kv: l.voltage_kv, length_km: l.length_km,
      joint_box_interval_km: l.joint_box_interval_km,
      counts: { towers: lineTowers.length, spans: spanAssets.length, joint_boxes: jbAssets.length, assets: spanAssets.length + jbAssets.length + lineTowers.length },
      chainage_km: chainagePoints(l.id),
      spans: spanAssets.map((a) => ({ id: a.id, asset_id: a.asset_id, asset_type: a.asset_type, name: a.name, km_from: a.km_from, km_to: a.km_to, condition_rating: a.condition_rating, lifecycle_status: a.lifecycle_status })),
      joint_boxes: jbAssets.map((a) => ({ id: a.id, asset_id: a.asset_id, name: a.name, km: a.km_from ?? a.km_to, condition_rating: a.condition_rating, lifecycle_status: a.lifecycle_status })),
      towers: lineTowers,
    };
  });

  return {
    region: regionRow,
    counts: {
      substations: substations.length,
      lines: lines.length,
      assets: counted.length + towerAssetByTower.size,
      towers: [...towerAssetByTower.keys()].length,
    },
    substations: childSubs,
    lines: childLines,
  };
}

router.get('/register/tree', (req, res) => {
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = wanted ? [wanted]
    : isGlobal(req.user)
      ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
      : [req.user.region_id];
  const regions = [];
  for (const rid of regionIds) regions.push(loadTree(rid));
  res.json({ count: regions.length, regions });
});

module.exports = router;
```

- [ ] **Step 2: Mount**

In `backend/server.js`, right after the catalog mount added in Task 1 (`app.use('/api', require('./routes/catalog'));`) add:

```js
app.use('/api', require('./routes/register'));
```

- [ ] **Step 3: node -c, restart isolated copy**

Run `cd /workspace/backend && node -c routes/register.js && echo OK`. Stop the 3199 server (Task 1 terminal), re-snapshot via the VACUUM command, boot on 3199 again.

- [ ] **Step 4: Verify structure, scope, and count invariant**

Login as `dir.c1`/`Region@123` (REGION_DIRECTOR of region 1, non-global) and as admin:

```bash
D=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:3199/api/register/tree -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const r=j.regions[0]; `regions=${j.count} code=${r.region.code} subs=${r.substations.length} lines=${r.lines.length} assets=${r.counts.assets} towers=${r.counts.towers}`'
```

Then compare totals with the summary endpoint:

```bash
A=$(curl -s http://localhost:3199/api/assets/summary -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total_assets')
T=$(curl -s http://localhost:3199/api/register/tree -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).regions[0].counts.assets')
echo "summary=$A tree=$T"; test "$A" = "$T" && echo COUNT-INVARIANT-PASS || echo COUNT-INVARIANT-FAIL
```

Also verify the region filter denial for a non-global user passing another region returns 403:

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3199/api/register/tree?region_id=2' -H "Authorization: Bearer $D"
```

Expected `403`. Fix any mismatch: the tree counts assets (excl. REMOVED) reachable under each region via substation / tower / line anchor, exactly like `/assets/summary`; the invariant must hold.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add backend/routes/register.js backend/server.js && git commit -m "feat(register): region-scoped server-built asset register tree with counts"
```

---

### Task 4: Joint-box generation endpoint on lines

**Files:**
- Modify: `backend/routes/core.js` (add handler after the towers/components section, before `module.exports` at `core.js:920`)

**Interfaces:**
- Consumes: `insertRow`/`get` from util; `can`, `checkRegion`, `audit` (already imported at `core.js:2-3`).
- Produces: `POST /api/lines/:id/generate-joint-boxes?dry_run=1` and without `dry_run`. Response `{ dry_run, line_id, interval_km, proposals: [{ km, asset_id, status: 'new'|'existing' }], created }`. `asset_id` uses the `JB-<LINE-CODE>-<seq>` scheme (LINE-CODE = `line.line_id` minus any `TL-` prefix, e.g. `JB-C1-001-01`).

- [ ] **Step 1: Add the handler**

Insert before `module.exports = router;` at `core.js:920`:

```js
// Auto-place JOINT_BOX assets along a line at cumulative chainage multiples
// of joint_box_interval_km (default 5). dry_run lists without inserting.
router.post('/lines/:id/generate-joint-boxes', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkRegion(req, res, line.region_id)) return;
  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
  const interval = Number(line.joint_box_interval_km) || 5;
  if (interval <= 0) return res.status(400).json({ error: 'joint_box_interval_km must be positive' });
  const towers = db.prepare('SELECT km_marker, id FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(line.id);
  const chainage = towers.map((t) => Number(t.km_marker) || 0);
  if (chainage.length < 2) {
    return res.status(400).json({ error: 'Line needs at least 2 towers with km_marker to chainage joint boxes' });
  }
  const end = Math.max(...chainage);
  const prefix = String(line.line_id || `L${line.id}`).replace(/^TL-/, '');
  const existingJB = db.prepare("SELECT id, km_from FROM asset WHERE line_id = ? AND asset_type = 'JOINT_BOX'").all(line.id)
    .map((r) => Number(r.km_from) || Number(r.km_to) || 0);
  const seqStmt = db.prepare("SELECT COUNT(*) c FROM asset WHERE line_id = ? AND asset_type = 'JOINT_BOX'").get(line.id).c;
  const proposals = [];
  let created = 0;
  const now = new Date().toISOString();
  for (let km = interval; km <= end + 1e-9; km += interval) {
    const k = Math.round(km * 100) / 100;
    const near = existingJB.some((e) => Math.abs(e - k) < 0.25);
    if (near) { proposals.push({ km: k, asset_id: null, status: 'existing' }); continue; }
    const seq = seqStmt + (created + 1);
    const asset_id = `JB-${prefix}-${String(seq).padStart(2, '0')}`;
    proposals.push({ km: k, asset_id, status: 'new' });
    if (!dryRun) {
      try {
        insertRow('asset', {
          asset_id, name: `Joint box @ ${k} km`, asset_type: 'JOINT_BOX', line_id: line.id,
          km_from: k, km_to: k, latitude: null, longitude: null, condition_rating: 8,
          condition_assessed_at: now, lifecycle_status: 'IN_SERVICE', operational_status: 'OPERATIONAL',
          criticality: 'MEDIUM', gps_validated: 0, metadata: JSON.stringify({ source: 'joint_box_generator', interval_km: interval }), revision: 1,
        });
        created += 1;
        existingJB.push(k);
      } catch (e) { /* skip duplicates */ }
    }
  }
  if (!dryRun) audit(req.user, 'CREATE', 'asset', null, { line_id: line.id, created, interval_km: interval });
  res.status(dryRun ? 200 : 201).json({ dry_run: dryRun, line_id: line.id, interval_km: interval, proposals, created });
});
```

- [ ] **Step 2: node -c and restart isolated copy**

Run `cd /workspace/backend && node -c routes/core.js && echo OK`; stop/re-snapshot/boot the 3199 copy as before.

- [ ] **Step 3: Verify dry-run then real generation (idempotent)**

Admin token on 3199; pick the first line that has towers from the register tree (line id `L` from Task 2 output or the tree). Then:

```bash
echo '-- dry run --'
curl -s 'http://localhost:3199/api/lines/L/generate-joint-boxes?dry_run=1' -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `proposals=${j.proposals.length} created=${j.created} sample=${j.proposals[0] && (j.proposals[0].asset_id + "@" + j.proposals[0].km + "km")}`'
echo '-- real run --'
curl -s -X POST 'http://localhost:3199/api/lines/L/generate-joint-boxes' -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `created=${j.created}`'
echo '-- rerun (idempotent) --'
curl -s -X POST 'http://localhost:3199/api/lines/L/generate-joint-boxes' -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `created=${j.created} allExisting=${j.proposals.every(p=>p.status==="existing")}`'
```

Expected: dry-run reports proposals with `asset_id` names like `JB-<code>-01`, real run creates the same count, and the rerun creates `0` with every proposal `existing`. If the line has no towers yet this returns the 400 error message — pick a line with towers instead (Task 3 tree shows `lines[].counts.towers`).

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add backend/routes/core.js && git commit -m "feat(lines): chainage joint-box auto-placement endpoint with dry-run"
```

---

### Task 5: Frontend catalog-driven form + km fields + detail km display

**Files:**
- Modify: `frontend/src/pages/Assets.jsx` (constants, form modal, detail modal, filters)

**Interfaces:**
- Consumes: `GET /asset-catalog` (Task 1). 
- Produces: the page now holds `catalog` state as `{ families: [...] }` from the endpoint; type/subtype `<select>`s are driven by it; the form and detail show `km_from`/`km_to` when a line is chosen.

- [ ] **Step 1: Replace the hard-coded type list and load catalog**

In `frontend/src/pages/Assets.jsx` replace the `TYPES` constant (line 11) with a reference list kept only for the filter default:

```js
// Asset type/family vocabulary comes from the backend catalog.
const TYPES = []; // placeholder — replaced by catalog below; kept for legacy references
```

(Then remove every remaining `TYPES` reference as part of the following edits — filters and form select both switch to catalog data.)

Add catalog state next to the other `useState`s (after line 30):

```js
const [catalog, setCatalog] = useState(null);
```

In the `useEffect` body (line 44-47) add a loader:

```js
    api.get('/asset-catalog').then(setCatalog).catch(() => {});
```

- [ ] **Step 2: Helper accessors + catalog-backed type select**

Before `export default function Assets() {` add:

```js
function flattenCatalog(cat) {
  if (!cat) return [];
  const out = [];
  for (const f of cat.families) for (const r of f.types) out.push({ ...r, family_label: f.family_label });
  return out;
}
function typesForFamily(cat, family) {
  return (cat?.families || []).find((f) => f.family === family)?.types || [];
}
function familyOf(cat, type) {
  return flattenCatalog(cat).find((r) => r.asset_type === type && !r.sub_type)?.family || '';
}
```

- [ ] **Step 3: Catalog-backed filter select**

Replace the filter select at `Assets.jsx:83-86` (the `All asset types` option + `TYPES.map`) with:

```jsx
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">All asset types</option>
          {flattenCatalog(catalog).filter((r) => !r.sub_type).map((r) => <option key={r.asset_type} value={r.asset_type}>{r.asset_type}</option>)}
        </select>
```

- [ ] **Step 4: Catalog-driven family/type/subtype selects in the form modal**

Inside the Add/Edit modal, replace the `Asset type` field (`Assets.jsx:267-270`) with:

```jsx
            <div className="field"><label>Family</label>
              <select value={form.asset_type ? familyOf(catalog, form.asset_type) : ''} onChange={(e) => {
                const fam = e.target.value;
                const first = typesForFamily(catalog, fam)[0];
                setForm({ ...form, asset_type: first ? first.asset_type : '', sub_type: '' });
              }}>
                <option value="">— pick family —</option>
                {(catalog?.families || []).filter((f) => f.family !== 'TOWER_PARTS').map((f) => <option key={f.family} value={f.family}>{f.family_label}</option>)}
              </select></div>
            <div className="field"><label>Asset type</label>
              <select value={form.asset_type} onChange={(e) => {
                const t = e.target.value;
                const withSub = typesForFamily(catalog, familyOf(catalog, t));
                setForm({ ...form, asset_type: t, sub_type: withSub.some((r) => r.sub_type) ? (withSub.find((r) => r.sub_type)?.sub_type || '') : '' });
              }}>
                <option value="">— pick type —</option>
                {typesForFamily(catalog, familyOf(catalog, form.asset_type)).filter((r) => !r.sub_type).map((r) => <option key={r.asset_type} value={r.asset_type}>{r.asset_type}</option>)}
              </select></div>
```

The family select only lists non-`TOWER_PARTS` families so users don't create station assets from the tower part vocabulary.

- [ ] **Step 5: km fields in the form + detail rows**

In the form modal, directly after the `Line` field (`Assets.jsx:281-285`), add:

```jsx
            {form.line_id ? (
              <>
                <div className="field"><label>km from</label><input type="number" step="0.01" value={form.km_from ?? ''} onChange={(e) => setForm({ ...form, km_from: e.target.value === '' ? null : Number(e.target.value) })} /></div>
                <div className="field"><label>km to</label><input type="number" step="0.01" value={form.km_to ?? ''} onChange={(e) => setForm({ ...form, km_to: e.target.value === '' ? null : Number(e.target.value) })} /></div>
              </>
            ) : null}
```

In the detail modal `kv` block, after the `Bay` row (`Assets.jsx:196`) add a `Span` row:

```jsx
                <span className="k">Chainage</span><span>{detail.line_id ? (detail.km_from != null || detail.km_to != null ? `${detail.km_from ?? 0} – ${detail.km_to ?? '—'} km` : 'line-located') : (detail.latitude != null ? 'point' : '—')}</span>
```

- [ ] **Step 6: Guard empty catalog while loading**

Because `TYPES` is now empty, make the whole page wait for the catalog when `canWrite` so the form selects have data. In the early-return loading guard (line 73) replace:

```js
  if (!rows) return <Page title="Assets"><Loading /></Page>;
```

with:

```js
  if (!rows || (catalog === null)) return <Page title="Assets"><Loading /></Page>;
```

- [ ] **Step 7: Build**

Run: `cd /workspace/frontend && npm run build` — must succeed (watch for any leftover `TYPES` reference; if one remains, the page currently uses it — grep `TYPES` in the file and remove/replace the last usage).

- [ ] **Step 8: Commit**

```bash
cd /workspace && git add frontend/src/pages/Assets.jsx && git commit -m "feat(assets): catalog-driven family/type selects and km chainage fields"
```

---

### Task 6: RegisterTree component + Assets integration

**Files:**
- Create: `frontend/src/components/RegisterTree.jsx`
- Modify: `frontend/src/pages/Assets.jsx`

**Interfaces:**
- Consumes: `GET /register/tree`, `POST /api/lines/:id/generate-joint-boxes` (Tasks 3, 4).
- Produces: `<RegisterTree canWrite regionId onChangeRegion onSelectAsset onNewAsset lineIdToBoxes />`. Props: `regionId` (number|null = global), `onChangeRegion(id|null)`, `onSelectAsset(assetLeaf)`, `onNewAsset(context)` where context is `{ substation_id?, bay?, line_id?, km? }`. It renders region tabs, expandable substation/line/family/bay nodes, line towers/parts, and (when `canWrite`) a "Joint boxes…" dry-run modal per line.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/RegisterTree.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api, fmtNum, condColor } from '../api';

const green = { color: '#15803d' };

function countBadge(n) {
  return <span className="pill" style={{ background: '#eef2ff', color: '#4338ca', fontSize: 11 }}>{n}</span>;
}

export default function RegisterTree({ canWrite, regionId, onChangeRegion, onSelectAsset, onNewAsset }) {
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState({}); // "sub:3" | "line:4" | "sub:3:CONTROL_AND_PROTECTION" | "line:4:towers" ...
  const [jbLine, setJbLine] = useState(null);   // { line, busy, dry, error }

  const load = () => {
    const q = regionId ? `?region_id=${regionId}` : '';
    api.get(`/register/tree${q}`).then((r) => { setTree(r); setErr(null); }).catch((e) => setErr(e.message));
  };
  useEffect(load, [regionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k) => setExpanded((m) => ({ ...m, [k]: !m[k] }));
  const key = (prefix) => expanded[prefix];

  const runDryRun = async (line, apply) => {
    try {
      setJbLine({ line, busy: true, error: null, dry: null });
      const dry = await api.post(`/lines/${line.id}/generate-joint-boxes?dry_run=${apply ? '0' : '1'}`, {});
      if (apply) {
        setJbLine(null);
        load();
      } else {
        setJbLine({ line, busy: false, error: null, dry });
      }
    } catch (e) {
      setJbLine({ line, busy: false, error: e.message, dry: null });
    }
  };

  if (err) return <div className="card card-pad muted" style={{ color: '#dc2626' }}>{err}</div>;
  if (!tree) return <div className="card card-pad muted">Loading register…</div>;

  const RegionNode = ({ region }) => (
    <div className="mb">
      <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(`r:${region.id}`)}>
        <b>{region.region.name}</b>
        <span>{countBadge(region.counts.assets)}</span>
      </div>
      {expanded[`r:${region.id}`] && (
        <div style={{ marginLeft: 14 }}>
          {region.substations.map((s) => <SubstationNode key={s.id} regionId={region.region.id} s={s} />)}
          {region.lines.map((l) => <LineNode key={l.id} l={l} />)}
        </div>
      )}
    </div>
  );

  const SubstationNode = ({ regionId, s }) => {
    const open = expanded[`sub:${s.id}`];
    return (
      <div>
        <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(`sub:${s.id}`)}>
          <span>■ {s.name} <span className="muted">({s.substation_id})</span></span>
          <span>{countBadge(s.counts.assets)}</span>
        </div>
        {open && (
          <div style={{ marginLeft: 16 }}>
            {s.families.map((f) => {
              const fk = `sub:${s.id}:${f.family}`;
              const fOpen = expanded[fk];
              return (
                <div key={f.family}>
                  <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(fk)}>
                    <span>▸ {f.family_label}</span>
                    <span>{countBadge(f.bays.reduce((n, b) => n + b.count, 0))}</span>
                  </div>
                  {fOpen && (
                    <div style={{ marginLeft: 16 }}>
                      {f.bays.map((bay) => (
                        <div key={bay.bay}>
                          <div className="muted" style={{ fontSize: 12 }}>Bay: {bay.bay} · {bay.count}</div>
                          {bay.assets.map((a) => (
                            <div key={a.id} className="spread" style={{ fontSize: 13, marginLeft: 10 }}>
                              <button className="link" style={{ textAlign: 'left' }} onClick={() => onSelectAsset(a)}>
                                {a.asset_type}: {a.name} <span className="mono muted">{a.asset_id}</span>
                              </button>
                              <span style={{ color: condColor(a.condition_rating) }}>●</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const LineNode = ({ l }) => {
    const open = expanded[`line:${l.id}`];
    return (
      <div>
        <div className="spread" style={{ cursor: 'pointer' }} onClick={() => toggle(`line:${l.id}`)}>
          <span>‖ {l.name} <span className="muted">({l.line_id})</span></span>
          <span>{countBadge(l.counts.assets)}</span>
        </div>
        {open && (
          <div style={{ marginLeft: 16 }}>
            <div className="spread muted" style={{ fontSize: 12 }}>
              <span>{l.voltage_kv ? `${l.voltage_kv} kV` : ''} · {l.length_km ? `${fmtNum(l.length_km)} km` : ''}</span>
              {canWrite && <button className="btn btn-sm" onClick={() => runDryRun(l, false)}>Joint boxes…</button>}
            </div>
            <div style={{ fontSize: 12 }}><span className="muted">Spans</span> {countBadge(l.counts.spans)}</div>
            {expanded[`line:${l.id}:spans`] === true && l.spans.map((sp) => (
              <div key={sp.id} className="spread" style={{ marginLeft: 10 }}>
                <button className="link" onClick={() => onSelectAsset(sp)}>{sp.asset_type} · {sp.name}</button>
                <span className="mono muted">{sp.km_from ?? 0}–{sp.km_to ?? '—'} km</span>
              </div>
            ))}
            {l.counts.spans > 0 && <button className="link muted" style={{ marginLeft: 10 }} onClick={() => toggle(`line:${l.id}:spans`)}>{expanded[`line:${l.id}:spans`] ? 'hide' : 'show'} spans</button>}
            <div style={{ fontSize: 12, marginTop: 6 }}><span className="muted">Joint boxes</span> {countBadge(l.counts.joint_boxes)}</div>
            {expanded[`line:${l.id}:jb`] === true && l.joint_boxes.map((jb) => (
              <div key={jb.id} className="spread" style={{ marginLeft: 10 }}>
                <button className="link" onClick={() => onSelectAsset(jb)}>{jb.name}</button>
                <span className="mono muted">{jb.km} km</span>
              </div>
            ))}
            {l.counts.joint_boxes > 0 && <button className="link muted" style={{ marginLeft: 10 }} onClick={() => toggle(`line:${l.id}:jb`)}>{expanded[`line:${l.id}:jb`] ? 'hide' : 'show'} boxes</button>}
            <div style={{ fontSize: 12, marginTop: 6 }}><span className="muted">Towers</span> {countBadge(l.counts.towers)}</div>
            {expanded[`line:${l.id}:towers`] === true && l.towers.map((t) => (
              <div key={t.id} style={{ marginLeft: 10 }}>
                <div className="spread">
                  <span>{t.tower_id} <span className="muted">· {t.tower_type} · {t.foundation_type}</span></span>
                  <span className="muted mono">{t.km_marker ?? 0} km · {t.part_count} parts</span>
                </div>
                {expanded[`t:${t.id}`] && (
                  <div style={{ marginLeft: 14 }} className="muted">
                    {t.parts.map((p, i) => <div key={i} style={{ fontSize: 12 }}>· {p.name} × {p.quantity} {p.unit}</div>)}
                  </div>
                )}
                <button className="link muted" style={{ marginLeft: 12, fontSize: 12 }} onClick={() => toggle(`t:${t.id}`)}>{expanded[`t:${t.id}`] ? 'hide' : 'show'} parts</button>
              </div>
            ))}
            {l.counts.towers > 0 && <button className="link muted" style={{ marginLeft: 10 }} onClick={() => toggle(`line:${l.id}:towers`)}>{expanded[`line:${l.id}:towers`] ? 'hide' : 'show'} towers</button>}
            {canWrite && (
              <div className="mt">
                <button className="btn btn-sm" onClick={() => onNewAsset({ line_id: l.id })}>+ Add line asset</button>
                <span className="muted" style={{ marginLeft: 8 }}>joint boxes every ~{l.joint_box_interval_km ?? 5} km</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card card-pad">
      {tree.regions.length > 1 && (
        <div className="filters" style={{ marginBottom: 8 }}>
          <select value={regionId ?? ''} onChange={(e) => onChangeRegion(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All regions</option>
            {tree.regions.map((r) => <option key={r.region.id} value={r.region.id}>{r.region.name}</option>)}
          </select>
        </div>
      )}
      {tree.regions.map((r) => <RegionNode key={r.region.id} region={r} />)}
      {jbLine && (
        <div className="card card-pad" style={{ marginTop: 10 }}>
          <b>Joint boxes — {jbLine.line.name}</b>
          {jbLine.error && <div style={{ color: '#dc2626' }}>{jbLine.error}</div>}
          {jbLine.dry && (
            <>
              <div style={{ fontSize: 13 }}>Will create {jbLine.dry.proposals.filter((p) => p.status === 'new').length} box(es):</div>
              <div style={{ margin: '6px 0' }}>
                {jbLine.dry.proposals.filter((p) => p.status === 'new').map((p) => (
                  <span key={p.km} className="pill" style={{ background: '#dcfce7', marginRight: 4 }}>{p.asset_id}@{p.km}km</span>
                ))}
                {jbLine.dry.proposals.filter((p) => p.status === 'existing').length > 0 && <span className="muted" style={{ fontSize: 12 }}>({jbLine.dry.proposals.filter((p) => p.status === 'existing').length} already present)</span>}
              </div>
              <button className="btn btn-sm btn-primary" disabled={jbLine.busy} onClick={() => runDryRun(jbLine.line, true)}>Create boxes</button>
            </>
          )}
          {jbLine.busy && <span className="muted">working…</span>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the component into Assets.jsx**

Imports: add `import RegisterTree from '../components/RegisterTree';` after the `Dossier` import (`Assets.jsx:7`).

State: add after line 30:

```js
const [registerRegion, setRegisterRegion] = useState(null);
```

Default view is the register — change line 30's `const [viewMode, setViewMode] = useState('table');` to:

```js
const [viewMode, setViewMode] = useState('register');
```

Render: insert a register branch first inside the page body right after the `filters` div closes (after `Assets.jsx:95`):

```jsx
      {viewMode === 'register' ? (
        <RegisterTree
          canWrite={canWrite}
          regionId={registerRegion}
          onChangeRegion={setRegisterRegion}
          onSelectAsset={(a) => openDetail({ id: a.id })}
          onNewAsset={(ctx) => {
            const base = { ...blank, ...ctx, latitude: null, longitude: null };
            if (ctx.substation_id) base.location_type = 'INDOOR';
            setForm(base);
            window.scrollTo(0, 0);
          }}
        />
      ) : viewMode === 'table' ? (
        <div className="card">
```

That means the existing `{viewMode === 'table' ? (<div className="card">` line at `Assets.jsx:97` is now consumed by the chain; the old ternary structure `viewMode === 'table' ? (...) : (cards view)` must be rebalanced to a 3-way. Replace the whole conditional start (lines 97-101) accordingly so the shape is:

```jsx
      {viewMode === 'register' ? (
        <RegisterTree … />
      ) : viewMode === 'table' ? (
        <div className="card">
          <div className="tbl-wrap">
```

and keep the existing cards `: (` branch as the else of `viewMode === 'table'` (the register case is handled above, cards are the fallback). Verify by reading the file after edit — the JSX must remain a single balanced ternary chain.

Also add a "Register" toggle button next to Table/Cards at `Assets.jsx:93-94`:

```jsx
        <button className={`btn btn-sm${viewMode === 'register' ? ' btn-primary' : ''}`} onClick={() => setViewMode('register')}>Register</button>
        <button className={`btn btn-sm${viewMode === 'table' ? ' btn-primary' : ''}`} onClick={() => setViewMode('table')}>Table</button>
```

- [ ] **Step 3: Build**

Run: `cd /workspace/frontend && npm run build`. Fix JSX balance issues until clean.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add frontend/src/components/RegisterTree.jsx frontend/src/pages/Assets.jsx && git commit -m "feat(assets): register tree pane with families, bays, spans, joint boxes and towers"
```

---

### Task 7: Demo register data (idempotent seed)

**Files:**
- Modify: `backend/assetCatalog.js` (add `ensureRegisterDemo`), `backend/server.js` (call it)

**Interfaces:**
- Consumes: `ensureAssetCatalog` (Task 1). 
- Produces: `ensureRegisterDemo()` — idempotently ensures one demo substation (region C1, code `C1-DEMO-SUB`) with indoor assets across four families, plus, on the first C1 line that has towers, one `CONDUCTOR_SPAN`, one `OPGW_SPAN` and generated joint boxes.

- [ ] **Step 1: Add the demo seeder**

Append to `backend/assetCatalog.js` before `module.exports`:

```js
function ensureRegisterDemo() {
  const c1 = db.prepare('SELECT id, center_lat, center_lng FROM region WHERE code = ?').get('C1');
  if (!c1) return;
  const now = new Date().toISOString();
  const mkAsset = (asset_id, name, asset_type, substation_id, line_id, bay, location_type, km_from, km_to) => {
    const has = db.prepare('SELECT id FROM asset WHERE asset_id = ?').get(asset_id);
    if (has) return 0;
    insertRow('asset', {
      asset_id, name, asset_type, substation_id, line_id, bay: bay || null,
      location_type, km_from: km_from ?? null, km_to: km_to ?? null,
      latitude: null, longitude: null, condition_rating: 8, condition_assessed_at: now,
      lifecycle_status: 'IN_SERVICE', operational_status: 'OPERATIONAL', criticality: 'MEDIUM',
      gps_validated: 0, metadata: JSON.stringify({ source: 'demo_register' }), revision: 1,
    });
    return 1;
  };

  let subId = db.prepare('SELECT id FROM substation WHERE substation_id = ?').get('C1-DEMO-SUB')?.id;
  if (!subId) {
    subId = insertRow('substation', {
      substation_id: 'C1-DEMO-SUB', name: 'C1 Demo Substation (Indoor Systems)', region_id: c1.id,
      latitude: c1.center_lat, longitude: c1.center_lng, voltage_levels: '["400"]', substation_type: 'TRANSMISSION',
      operational_status: 'OPERATIONAL', revision: 1,
    });
  }
  const indoor = [
    ['DEMO-C1-CP-01', 'Line protection relay P1', 'PROTECTION_RELAY', 'CONTROL_AND_PROTECTION', 'Bay 2'],
    ['DEMO-C1-CP-02', 'Feeder metering panel', 'METER', 'CONTROL_AND_PROTECTION', 'Bay 2'],
    ['DEMO-C1-RTU-01', 'Substation RTU', 'SCADA_RTU', 'SAS_RTU_AND_TELECOM', 'Control room'],
    ['DEMO-C1-RTU-02', 'Bay IED', 'IED', 'SAS_RTU_AND_TELECOM', 'Bay 2'],
    ['DEMO-C1-DC-01', 'Station battery bank', 'BATTERY_BANK', 'DC_AND_AUXILIARY', 'DC room'],
    ['DEMO-C1-DC-02', 'Battery charger', 'BATTERY_CHARGER', 'DC_AND_AUXILIARY', 'DC room'],
    ['DEMO-C1-AUX-01', 'Auxiliary supply transformer', 'AUXILIARY_TRANSFORMER', 'DC_AND_AUXILIARY', 'Annex'],
    ['DEMO-C1-MV-01', 'MV switchgear panel', 'SWITCHGEAR', 'MV_SWITCHGEAR', 'MV room'],
    ['DEMO-C1-MV-02', 'MV circuit breaker', 'MV_CIRCUIT_BREAKER', 'MV_SWITCHGEAR', 'MV room'],
    ['DEMO-C1-HV-01', 'Main power transformer T1', 'TRANSFORMER', 'HV_YARD_AND_TRANSFORMATION', 'Yard'],
  ];
  const bayByFamily = { CONTROL_AND_PROTECTION: 'Bay 2', SAS_RTU_AND_TELECOM: 'Control room', DC_AND_AUXILIARY: 'DC room', MV_SWITCHGEAR: 'MV room', HV_YARD_AND_TRANSFORMATION: 'Yard' };
  const FAMILY = new Map(CATALOG.map((c) => [c.asset_type, c.family]));
  let created = 0;
  for (const [aid, name, type] of indoor) created += mkAsset(aid, name, type, subId, null, bayByFamily[FAMILY.get(type)], 'INDOOR');

  // Line demo: spans + JBs on the first C1 line with towers.
  const line = db.prepare(
    `SELECT l.id FROM transmission_line l JOIN tower t ON t.line_id = l.id WHERE l.region_id = ? GROUP BY l.id ORDER BY COUNT(t.id) DESC LIMIT 1`
  ).get(c1.id);
  if (line) {
    const towers = db.prepare('SELECT km_marker FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(line.id);
    const km = towers.map((t) => Number(t.km_marker) || 0);
    const start = Math.min(...km);
    const end = Math.max(...km);
    created += mkAsset('DEMO-C1-COND-01', 'C1 demo conductor span', 'CONDUCTOR_SPAN', null, line.id, null, null, start, end);
    created += mkAsset('DEMO-C1-OPGW-01', 'C1 demo OPGW span', 'OPGW_SPAN', null, line.id, null, null, start, end);
    const interval = Number(db.prepare('SELECT joint_box_interval_km FROM transmission_line WHERE id = ?').get(line.id).joint_box_interval_km) || 5;
    const seqBase = db.prepare("SELECT COUNT(*) c FROM asset WHERE line_id = ? AND asset_type = 'JOINT_BOX'").get(line.id).c;
    const prefix = String(db.prepare('SELECT line_id FROM transmission_line WHERE id = ?').get(line.id).line_id).replace(/^TL-/, '');
    let seq = seqBase + 1;
    for (let kmPos = interval; kmPos <= end + 1e-9; kmPos += interval) {
      const k = Math.round(kmPos * 100) / 100;
      created += mkAsset(`DEMO-C1-JB-${String(seq).padStart(2, '0')}`, `Joint box @ ${k} km`, 'JOINT_BOX', null, line.id, null, null, k, k);
      seq += 1;
    }
  }
  if (created > 0) console.log(`[assetCatalog] demo register: ${created} asset row(s) added`);
}

module.exports = { CATALOG, FAMILY_LABEL, findCatalog, ensureAssetCatalog, ensureRegisterDemo };
```

Note: the demo `JOINT_BOX` asset_ids are prefixed `DEMO-C1-JB-` to stay idempotent and never collide with the generator's `JB-…` names. The task-4 generator, not this seeder, is what `register` shows under the line node when run by a user.

- [ ] **Step 2: Call it at boot**

In `backend/server.js`, replace the Task 1 require addition `const { ensureAssetCatalog } = require('./assetCatalog');` with:

```js
const { ensureAssetCatalog, ensureRegisterDemo } = require('./assetCatalog');
```

and after the `ensureAssetCatalog();` line add:

```js
ensureRegisterDemo();
```

- [ ] **Step 3: node -c, boot isolated, verify**

Run `cd /workspace/backend && node -c assetCatalog.js && echo OK`. Stop/re-snapshot/boot 3199 copy. Confirm the boot log line `[assetCatalog] demo register: N asset row(s) added`, then with admin token:

```bash
curl -s http://localhost:3199/api/register/tree -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const r=j.regions.find(x=>x.region.code==="C1"); const s=r.substations.find(x=>x.substation_id==="C1-DEMO-SUB"); const l=r.lines.find(x=>x.counts.spans>0); `demo sub families=${s?s.families.map(f=>f.family).join(","):"none"} spans=${l?l.counts.spans:0} jb=${l?l.counts.joint_boxes:0}`'
```

Expected: the demo substation lists the five families, and the C1 line reports ≥1 span and ≥1 joint box. Reboot again and confirm the log does NOT print the demo line again (idempotent).

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add backend/assetCatalog.js backend/server.js && git commit -m "feat(seed): idempotent demo register (indoor families + spans + joint boxes)"
```

---

### Task 8: Full verification, live restart, smoke

**Files:** none committed (temp harness only)

- [ ] **Step 1: Frontend production build**

Run: `cd /workspace/frontend && npm run build` — clean.

- [ ] **Step 2: Isolated e2e sweep**

With the 3199 copy freshly snapshot + booted, run a consolidated sweep (a temp file `/tmp/opencode/verify_register.mjs`):

```js
const BASE = 'http://localhost:3199/api';
async function login(u, p) { const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }); const j = await r.json(); if (!r.ok) throw new Error('login ' + u); return j.token; }
const step = (n, ok, x) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (x ? '  ' + x : '')); if (!ok) process.exitCode = 1; };
const admin = await login('admin', 'Admin@123');
const dir = await login('dir.c1', 'Region@123');
const h = (t) => ({ headers: { Authorization: 'Bearer ' + t } });
const cat = await (await fetch(BASE + '/asset-catalog', h(admin))).json();
step('catalog has families', cat.count > 40 && cat.families.some((f) => f.family === 'CONTROL_AND_PROTECTION'), cat.count + ' types');
const reg = await (await fetch(BASE + '/register/tree', h(dir))).json();
step('director sees single region', reg.count === 1 && reg.regions[0].region.code === 'C1', reg.regions[0] && reg.regions[0].region.code);
const summary = await (await fetch(BASE + '/assets/summary', h(dir))).json();
step('tree == summary invariant', summary.total_assets === reg.regions[0].counts.assets, `summary=${summary.total_assets} tree=${reg.regions[0].counts.assets}`);
const c2 = await fetch(BASE + '/register/tree?region_id=2', h(dir));
step('cross-region tree denied', c2.status === 403, 'status=' + c2.status);
const demo = reg.regions[0].substations.find((s) => s.substation_id === 'C1-DEMO-SUB');
step('demo substation families present', !!demo && demo.families.length >= 5, demo && demo.families.map((f) => f.family).join(','));
const lineW = reg.regions[0].lines.find((l) => l.counts.towers > 0);
if (lineW) {
  step('line node has towers+parts', lineW.towers.length > 0 && lineW.towers.every((t) => Array.isArray(t.parts)), 'towers=' + lineW.towers.length);
}
console.log('done');
```

Run `cd /tmp/opencode && node verify_register.mjs`. All lines must be PASS.

- [ ] **Step 3: Live restart**

Stop the live backend via `background_terminal_kill` for the terminal running `cd /workspace/backend && npm run dev` (find it with `background_terminal_list`), then start a fresh one:

```bash
cd /workspace/backend && npm run dev
```

Read its log: expect `[assetCatalog] seeded …`, `[assetCatalog] demo register: N asset row(s) added` (first boot after this code lands), then `TMMS backend listening on http://localhost:3001`.

- [ ] **Step 4: Live smoke**

Login against :3001 with `admin`/`Admin@123` and confirm:

```bash
curl -s http://localhost:3001/api/register/tree?region_id=1 -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.regions.length + " region; subs=" + j.regions[0].substations.length + " lines=" + j.regions[0].lines.length'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/asset-catalog -H "Authorization: Bearer $ADMIN"
```

Expected: region 1 loads with substations and lines; catalog returns `200`. The Vite dev server (:5173) picks up the frontend changes automatically — hard-refresh the preview to see the Register tree.

- [ ] **Step 5: Mark done**

Verify the working tree contains only intended changes (`cd /workspace && git status --short`), confirm every backend file passes `node -c`, then report completion.
