# Asset Valuation & Maintenance Cost Reporting (B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add benchmark pricing + a register-consistent replacement/condition-adjusted valuation, lightweight maintenance-cost capture, cost reporting, and a dedicated Value & Cost page (Valuation | Maintenance cost | Prices) plus two scoped report types.

**Architecture:** The register population classifier is extracted into `regionPopulation()` in `routes/register.js` so the register tree and the valuation rollup always count the exact same assets (single source of truth for the count invariant). Valuation and cost builders are shared by the live endpoints and the report `switch` cases. Cost capture reuses the existing `asset_maintenance_event.cost` column (no schema change); currency reuses `system_config.currency`. Frontend gains one page (`Value.jsx`) using CSS bars/tables (no chart lib), money formatting via `Intl`, and small additive edits to `RegisterTree`, `Assets`, `TaskDetail`, `Reports`, `App`, `i18n`, `api`.

**Tech Stack:** Node 22 (`node:sqlite`), Express 5, plain React (Vite). No new npm dependencies.

## Global Constraints

- No new tables/columns. Cost rides the existing `asset_maintenance_event.cost` (db.js:147); currency is `system_config.currency` (already seeded `USD`).
- Schema/DDL stays untouched. Do NOT use `migrate()` — nothing here needs it.
- Region scoping reuses `isGlobal`/`checkRegion` (`backend/auth.js`) and the same resolution rules as `routes/register.js` `/register/tree`.
- The register-count invariant: within any scope, the valuation population count MUST equal `register/tree` `counts.assets` and `assets/summary` `total_assets` for the same scope.
- `TOWER_PARTS` catalog rows are vocabulary — never priced, never counted, never shown in the price editor.
- Price writes go through the existing `PUT /asset-catalog/:id` (`asset:write`, admin-only today); UI mirrors with `can(getStoredUser(), 'asset:write')`.
- Frontend copy follows page-local convention: hard-coded English strings inside pages (like `Reports.jsx`/`Assets.jsx`); only `App.jsx` nav labels + group titles go through `t()` — add the new keys to all three of `en`/`es`/`zh` in `src/i18n.js`.
- Every mutating action keeps `insertRow`/`updateRow` + `audit()`.
- Code style: 2-space indent, `const`, terse section comments only, trailing commas consistent with neighbors. No destructive commands; background services stop only via `background_terminal_kill <id>`.
- All e2e runs against an isolated DB copy on port **3199**; live :3001 stays untouched until the final task.
- Files end with `node -c` clean (backend) and `npm run build` clean (frontend) before a task is committed.

---

### Task 1: Benchmark prices (RCN basis) seeded idempotently

**Files:**
- Modify: `backend/assetCatalog.js` (add `PRICES`, `ensureCatalogPrices()`, export)
- Modify: `backend/server.js:6,30-31` (require + call)

**Interfaces:**
- Produces: `backend/assetCatalog.js` exports `ensureCatalogPrices()` — idempotent; sets `default_unit_price` on every catalog row with `family NOT IN ('TOWER_PARTS','UNCLASSIFIED')` and a mapped price, only where currently `NULL`/`0`. Returns count changed.
- Catalog rows keep shape `{ family, family_label, label, asset_type, sub_type, unit_of_measure, location_kind, default_location_type, default_unit_price, active }`. Pricing unit = the row's `unit_of_measure` (EA/PANEL/BANK per unit; KM per kilometre).

- [ ] **Step 1: Add the price map and seeder**

In `backend/assetCatalog.js`, after the `CATALOG` array construction (ends around line 70, before the `COMPONENT_CATALOG` loop) add:

```js
// Benchmark replacement-cost-new (RCN) prices per catalog class, keyed by
// asset_type. KM-priced rows are per-kilometre; everything else per unit.
// TOWER_PARTS and UNCLASSIFIED catch-alls stay unpriced on purpose (gap).
const PRICES = {
  // Control & protection
  PROTECTION_RELAY: 8500, RELAY_PANEL: 24000, METER: 3200, SUBSTATION_CONTROLLER: 45000,
  // SAS / RTU & telecom
  SCADA_RTU: 42000, IED: 6500, NETWORK_SWITCH: 2800, COMMUNICATION_RADIO: 15000, OPTICAL_FIBER: 9000,
  // DC & auxiliary
  BATTERY_BANK: 18000, BATTERY_CHARGER: 6500, DC_DISTRIBUTION_PANEL: 9000, AUXILIARY_TRANSFORMER: 26000, UPS: 16000,
  // MV switchgear
  SWITCHGEAR: 38000, GIS: 120000, MV_CIRCUIT_BREAKER: 30000, MV_DISCONNECTOR: 9500,
  // HV yard & transformation
  TRANSFORMER: 1200000, AUTO_TRANSFORMER: 1800000, HV_CIRCUIT_BREAKER: 210000,
  DISCONNECTOR: 48000, GROUND_SWITCH: 26000, CT: 9000, VT: 8000, LIGHTNING_ARRESTER: 6000,
  BUSBAR: 150000, REACTOR: 550000, CAPACITOR_BANK: 240000, EARTHING_MAT: 38000,
  // Line families
  CONDUCTOR_SPAN: 52000, OPGW_SPAN: 45000, JOINT_BOX: 2500,
  // Tower structure
  TOWER: 95000, POLE: 32000,
};
```

Then add this function before `module.exports` (keep it idempotent for both fresh and existing databases):

```js
// Backfill benchmark prices on every catalog row we have a price for. Only
// fills NULL/0 so an admin's manual edit is never overwritten on reboot.
function ensureCatalogPrices() {
  let changed = 0;
  const rows = db.prepare("SELECT id, family, asset_type FROM asset_catalog").all();
  for (const r of rows) {
    if (r.family === 'TOWER_PARTS' || r.family === 'UNCLASSIFIED') continue;
    const price = PRICES[r.asset_type];
    if (price === undefined) continue;
    const cur = db.prepare('SELECT default_unit_price FROM asset_catalog WHERE id = ?').get(r.id);
    const curPrice = Number(cur && cur.default_unit_price) || 0;
    if (curPrice === 0) {
      db.prepare('UPDATE asset_catalog SET default_unit_price = ? WHERE id = ?').run(price, r.id);
      changed += 1;
    }
  }
  console.log(`[assetCatalog] priced ${changed} catalog row(s)`);
  return changed;
}
```

Update `module.exports` (currently `{ CATALOG, FAMILY_LABEL, findCatalog, ensureAssetCatalog, ensureRegisterDemo }`) to add `PRICES, ensureCatalogPrices`.

- [ ] **Step 2: Boot call**

In `backend/server.js` line 6 change to:
```js
const { ensureAssetCatalog, ensureRegisterDemo, ensureCatalogPrices } = require('./assetCatalog');
```
and after the `ensureRegisterDemo();` call (line 31) insert:
```js
ensureCatalogPrices();
```

- [ ] **Step 3: node -c and isolated-boot verification**

Run: `cd /workspace/backend && node -c assetCatalog.js && node -c server.js && echo OK`.

Snapshot + boot the isolated copy:
```bash
mkdir -p /tmp/opencode/tmms-plan
node -e "const s = require('node:sqlite').DatabaseSync; new s('/workspace/backend/tmms.db').exec(\"VACUUM INTO '/tmp/opencode/tmms-plan/tmms.db'\"); console.log('snapshot ok');"
```
Start on 3199 in a **background terminal** and keep the id:
```bash
cd /workspace/backend && PORT=3199 TMMS_DB=/tmp/opencode/tmms-plan/tmms.db node server.js
```
Expect boot log line `[assetCatalog] priced N catalog row(s)` and `[assetCatalog] seeded 0 catalog row(s)`.

- [ ] **Step 4: Verify prices via API**

```bash
TOK=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:3199/api/asset-catalog -H "Authorization: Bearer $TOK" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const flat=j.families.flatMap(f=>f.types); const priced=flat.filter(t=>Number(t.default_unit_price)>0); const towerParts=flat.filter(t=>t.family==="TOWER_PARTS"); const unpricedMain=flat.filter(t=>t.family!=="TOWER_PARTS"&&t.family!=="UNCLASSIFIED"&&(Number(t.default_unit_price)||0)===0); `total=${flat.length} priced=${priced.length} unpricedMain=${unpricedMain.map(t=>t.asset_type).join(",")||"none"} towerPartsUnpriced=${towerParts.every(t=>(Number(t.default_unit_price)||0)===0)} sample=${priced[0].asset_type+"="+priced[0].default_unit_price}`'
```
Expected: `priced>0`, `unpricedMain=none`, `towerPartsUnpriced=true`.

- [ ] **Step 5: Idempotence check**

Restart the 3199 server (stop with `background_terminal_kill <id>`, re-run the snapshot VACUUM, boot again). Expect `[assetCatalog] priced 0 catalog row(s)` the second time.

- [ ] **Step 6: Commit**

```bash
git add backend/assetCatalog.js backend/server.js
git commit -m "feat(valuation): seed benchmark RCN prices for catalog classes"
```

---

### Task 2: Shared register population + valuation endpoint

**Files:**
- Modify: `backend/routes/register.js` (full rewrite below: extract `regionPopulation`, add `computeRegionValuation`/`mergeValuations`, new route, exports)
- Test: e2e against isolated copy on 3199

**Interfaces:**
- Produces from `backend/routes/register.js`:
  - `regionPopulation(regionId)` → `{ substationIds:Set, lineIds:number[], towerRows, lineOfTower:Map, counted:[{node:'sub'|'line',key,a}], towerAssets:Map<tower_id, asset> }` where every `a` carries `a._fam={family,family_label,cat}` and `a._cat` (full `asset_catalog` row or `null`).
  - `computeRegionValuation(regionId)` → `{ region_id, region:{id,code,name}, count, cond_sum, rcn, current, unpriced_count, avg_condition, by_family:[{family,family_label,count,rcn,current}], by_type:[{asset_type,label,count,rcn,current}], by_location:[{location,label,count,rcn,current}], unpriced_types:[{asset_type,count}] }` (floats; no currency).
  - `mergeValuations(parts)` → merged `{ totals:{count,rcn,current,unpriced_count,avg_condition}, by_family, by_type, by_location, unpriced_types }`.
  - Route `GET /api/register/valuation?region_id=` → `{ currency:{code}, regions:[{region_id,region,count,rcn,current,unpriced_count,avg_condition}], totals, by_family, by_type, by_location, unpriced_types }` scoped exactly like `/register/tree`.
  - Quantity rule: `unit_of_measure === 'KM'` → `km_to - km_from` (guarded: missing/<=0 range counts as 1); all other units → 1. `current = rcn * condition_rating / 10`, default condition 7.

- [ ] **Step 1: Rewrite `backend/routes/register.js`**

Replace the entire file with:

```js
const express = require('express');
const { db, get } = require('../util');
const { isGlobal } = require('../auth');

const router = express.Router();

// ---------------------------------------------------------------- population
// Shared classifier so the register tree and the valuation rollup always
// count the exact same population (count invariant vs /assets/summary).

function catalogMap() {
  const map = new Map();
  // TOWER_PARTS rows are vocabulary for tower-component labeling, not asset
  // classes; excluding them keeps typing unambiguous.
  for (const c of db.prepare("SELECT * FROM asset_catalog WHERE family != 'TOWER_PARTS'").all()) {
    map.set(`${c.asset_type}|${c.sub_type || ''}`, c);
  }
  return map;
}

function famOf(catalog, a) {
  const c = catalog.get(`${a.asset_type}|${a.sub_type || ''}`) || catalog.get(`${a.asset_type}|`);
  return c
    ? { family: c.family, family_label: c.family_label || c.family, cat: c }
    : { family: 'UNCLASSIFIED', family_label: 'Unclassified', cat: null };
}

function regionPopulation(regionId) {
  const substationIds = new Set(db.prepare('SELECT id FROM substation WHERE region_id = ?').all(regionId).map((r) => r.id));
  const lineIds = db.prepare('SELECT id FROM transmission_line WHERE region_id = ? ORDER BY name').all(regionId).map((r) => r.id);
  const lineIdSet = new Set(lineIds);
  const towerRows = db.prepare('SELECT * FROM tower ORDER BY km_marker, id').all();
  const lineOfTower = new Map(towerRows.map((t) => [t.id, t.line_id]));
  const catalog = catalogMap();
  const assetsAll = db.prepare("SELECT * FROM asset WHERE lifecycle_status != 'REMOVED'").all().map((a) => ({ ...a, metadata: null }));
  const counted = [];
  const towerAssets = new Map();
  for (const a of assetsAll) {
    const f = famOf(catalog, a);
    a._fam = f;
    a._cat = f.cat;
    if (a.substation_id != null && substationIds.has(a.substation_id)) {
      counted.push({ node: 'sub', key: `sub:${a.substation_id}`, a });
    } else if (a.tower_id != null && lineIdSet.has(lineOfTower.get(a.tower_id))) {
      if (a.asset_type === 'TOWER' || a.asset_type === 'POLE') towerAssets.set(a.tower_id, a);
      else counted.push({ node: 'line', key: `line:${lineOfTower.get(a.tower_id)}`, a });
    } else if (a.line_id != null && lineIdSet.has(a.line_id)) {
      counted.push({ node: 'line', key: `line:${a.line_id}`, a });
    }
  }
  return { substationIds, lineIds, towerRows, lineOfTower, counted, towerAssets };
}

function groupAssetsBySubstation(assets) {
  const families = new Map();
  for (const a of assets) {
    const fam = (a._fam && a._fam.family) || 'UNCLASSIFIED';
    if (!families.has(fam)) {
      const bayMap = new Map();
      families.set(fam, { family: fam, family_label: (a._fam && a._fam.family_label) || 'Unclassified', bays: bayMap });
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

// Cumulative chainage along a line from its tower km_markers.
function chainagePoints(lineId) {
  const towers = db.prepare('SELECT id, km_marker, latitude, longitude FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId);
  return towers.map((t) => Number(t.km_marker) || 0);
}

function loadTree(regionId) {
  const region = get('region', regionId);
  const regionRow = { id: region.id, code: region.code, name: region.name, center_lat: region.center_lat, center_lng: region.center_lng };
  const lines = db.prepare('SELECT id FROM transmission_line WHERE region_id = ? ORDER BY name').all(regionId).map((r) => get('transmission_line', r.id, ['route_json']));
  const substations = db.prepare('SELECT id FROM substation WHERE region_id = ? ORDER BY name').all(regionId).map((r) => get('substation', r.id));
  const pop = regionPopulation(regionId);

  const subAssetsByKey = new Map();
  const lineSpanAssets = new Map();
  const lineJBAssets = new Map();
  const lineOtherAssets = new Map();
  for (const { node, key, a } of pop.counted) {
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
  });

  const partCounts = db.prepare('SELECT tower_id, COUNT(*) c FROM tower_component GROUP BY tower_id').all();
  const partCountMap = new Map(partCounts.map((r) => [r.tower_id, r.c]));

  const childLines = lines.map((l) => {
    const spanAssets = (lineSpanAssets.get(`line:${l.id}`) || []).sort((x, y) => (Number(x.km_from) || 0) - (Number(y.km_from) || 0));
    const jbAssets = (lineJBAssets.get(`line:${l.id}`) || []).sort((x, y) => (Number(x.km_from) || 0) - (Number(y.km_from) || 0));
    const lineTowers = pop.towerRows.filter((t) => t.line_id === l.id).map((t) => {
      const ta = pop.towerAssets.get(t.id);
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
      assets: pop.counted.length + pop.towerAssets.size,
      towers: pop.towerAssets.size,
    },
    substations: childSubs,
    lines: childLines,
  };
}

// ---------------------------------------------------------------- valuation
const LOC_LABEL = { SUBSTATION: 'Substation', LINE: 'Transmission line', TOWER: 'Tower structure' };

function quantityOf(a) {
  const unit = (a._cat && a._cat.unit_of_measure) || 'EA';
  if (unit === 'KM') {
    const len = Number(a.km_to ?? a.km_from ?? 0) - Number(a.km_from ?? 0);
    return Number.isFinite(len) && len > 0 ? len : 1;
  }
  return 1;
}

function computeRegionValuation(regionId) {
  const pop = regionPopulation(regionId);
  const region = get('region', regionId);
  const byFamily = new Map();
  const byType = new Map();
  const byLocation = {};
  const unpricedTypes = new Map();
  for (const l of ['SUBSTATION', 'LINE', 'TOWER']) byLocation[l] = { location: l, label: LOC_LABEL[l], count: 0, rcn: 0, current: 0 };
  let count = 0;
  let cond_sum = 0;
  let unpriced_count = 0;
  let rcn = 0;
  let current = 0;
  const push = (a, location) => {
    count += 1;
    const cond = Number(a.condition_rating) || 7;
    cond_sum += cond;
    const price = a._cat ? Number(a._cat.default_unit_price) : 0;
    byLocation[location].count += 1;
    if (!a._cat || !price || price <= 0) {
      unpriced_count += 1;
      const type = a.asset_type || 'UNSPECIFIED';
      unpricedTypes.set(type, (unpricedTypes.get(type) || 0) + 1);
      return;
    }
    const value = price * quantityOf(a);
    const cv = (value * cond) / 10;
    rcn += value;
    current += cv;
    byLocation[location].rcn += value;
    byLocation[location].current += cv;
    const fam = a._fam.family;
    const famLabel = a._fam.family_label;
    if (!byFamily.has(fam)) byFamily.set(fam, { family: fam, family_label: famLabel, count: 0, rcn: 0, current: 0 });
    const fr = byFamily.get(fam);
    fr.count += 1;
    fr.rcn += value;
    fr.current += cv;
    const type = a.asset_type || 'UNSPECIFIED';
    const typeLabel = (a._cat && a._cat.label) || type.replace(/_/g, ' ');
    if (!byType.has(type)) byType.set(type, { asset_type: type, label: typeLabel, count: 0, rcn: 0, current: 0 });
    const tr = byType.get(type);
    tr.count += 1;
    tr.rcn += value;
    tr.current += cv;
  };
  for (const { node, a } of pop.counted) push(a, node === 'sub' ? 'SUBSTATION' : 'LINE');
  for (const a of pop.towerAssets.values()) push(a, 'TOWER');
  const sortBy = (arr, key) => [...arr].sort((a, b) => b[key] - a[key]);
  return {
    region_id: regionId,
    region: { id: region.id, code: region.code, name: region.name },
    count,
    cond_sum,
    rcn,
    current,
    unpriced_count,
    avg_condition: count ? cond_sum / count : 0,
    by_family: sortBy([...byFamily.values()], 'current'),
    by_type: sortBy([...byType.values()], 'current'),
    by_location: Object.values(byLocation),
    unpriced_types: sortBy([...unpricedTypes.entries()].map(([asset_type, n]) => ({ asset_type, count: n })), 'count'),
  };
}

function mergeBucket(map, key, part, keys) {
  if (!map.has(key)) {
    map.set(key, { ...part });
  } else {
    const cur = map.get(key);
    for (const k of keys) cur[k] += part[k];
  }
}

function mergeValuations(parts) {
  const totals = { count: 0, cond_sum: 0, rcn: 0, current: 0, unpriced_count: 0 };
  const byFamily = new Map();
  const byType = new Map();
  const byLocation = new Map();
  const unpricedTypes = new Map();
  for (const p of parts) {
    for (const k of ['count', 'cond_sum', 'rcn', 'current', 'unpriced_count']) totals[k] += p[k];
    for (const row of p.by_family) mergeBucket(byFamily, row.family, row, ['count', 'rcn', 'current']);
    for (const row of p.by_type) mergeBucket(byType, row.asset_type, row, ['count', 'rcn', 'current']);
    for (const row of p.by_location) mergeBucket(byLocation, row.location, row, ['count', 'rcn', 'current']);
    for (const row of p.unpriced_types) mergeBucket(unpricedTypes, row.asset_type, row, ['count']);
  }
  const sortBy = (arr, key) => [...arr].sort((a, b) => b[key] - a[key]);
  return {
    totals: {
      count: totals.count,
      rcn: totals.rcn,
      current: totals.current,
      unpriced_count: totals.unpriced_count,
      avg_condition: totals.count ? totals.cond_sum / totals.count : 0,
    },
    by_family: sortBy([...byFamily.values()], 'current'),
    by_type: sortBy([...byType.values()], 'current'),
    by_location: [...byLocation.values()],
    unpriced_types: sortBy([...unpricedTypes.values()], 'count'),
  };
}

function currencyCode() {
  const r = db.prepare("SELECT value FROM system_config WHERE key = 'currency'").get();
  return (r && r.value) || 'USD';
}

function resolveRegionIds(user, wanted) {
  if (wanted) return [wanted];
  return isGlobal(user)
    ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
    : [user.region_id];
}

router.get('/register/tree', (req, res) => {
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = resolveRegionIds(req.user, wanted);
  const regions = [];
  for (const rid of regionIds) regions.push(loadTree(rid));
  res.json({ count: regions.length, regions });
});

router.get('/register/valuation', (req, res) => {
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = resolveRegionIds(req.user, wanted);
  const parts = regionIds.map((rid) => computeRegionValuation(rid));
  const merged = mergeValuations(parts);
  res.json({
    currency: { code: currencyCode() },
    regions: parts.map((p) => ({
      region_id: p.region_id,
      region: p.region,
      count: p.count,
      rcn: p.rcn,
      current: p.current,
      unpriced_count: p.unpriced_count,
      avg_condition: p.avg_condition,
    })),
    totals: merged.totals,
    by_family: merged.by_family,
    by_type: merged.by_type,
    by_location: merged.by_location,
    unpriced_types: merged.unpriced_types,
  });
});

module.exports = router;
module.exports.computeRegionValuation = computeRegionValuation;
module.exports.mergeValuations = mergeValuations;
```

- [ ] **Step 2: node -c, restart isolated copy, verify count invariant**

Run `cd /workspace/backend && node -c routes/register.js && echo OK`. Stop the 3199 server (Task 1 terminal), re-snapshot with the VACUUM command, boot on 3199 again (background terminal). Login as the C1 region director:
```bash
D=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
A=$(curl -s http://localhost:3199/api/assets/summary -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total_assets')
T=$(curl -s http://localhost:3199/api/register/tree -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).regions[0].counts.assets')
V=$(curl -s http://localhost:3199/api/register/valuation -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const r=j.regions[0]; `valCount=${r.count} rcn=${Math.round(r.rcn)} current=${Math.round(r.current)} unpriced=${r.unpriced_count} avg=${r.avg_condition.toFixed(1)} fams=${j.by_family.length} currency=${j.currency.code}`')
echo "summary=$A tree=$T $V"
```
Expected: `val count` equals the summary total and tree total for the same C1 scope, `rcn > current > 0`, `currency=USD`.

- [ ] **Step 3: Unpriced-gap path (scratch legacy asset)**

Insert an unknown-type asset directly into the isolated DB (no catalog row exists, so it must be reported as unpriced):
```bash
CID=$(curl -s 'http://localhost:3199/api/regions' -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).find(r=>r.code==="C1").id')
SID=$(curl -s 'http://localhost:3199/api/substations?region_id='"$CID" -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
node -e "const {DatabaseSync}=require('node:sqlite'); const s=new DatabaseSync('/tmp/opencode/tmms-plan/tmms.db'); s.prepare(\"INSERT INTO asset (asset_id,name,asset_type,substation_id,condition_rating,lifecycle_status,operational_status,criticality,gps_validated,metadata,revision) VALUES ('LEGACY-X1','Legacy gadget','LEGACY_GADGET',? ,5,'IN_SERVICE','OPERATIONAL','LOW',0,'{}',1)\").run($SID); console.log('inserted');"
```
Then (server holds no cache, reads DB live) re-query valuation:
```bash
curl -s http://localhost:3199/api/register/valuation -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const u=j.unpriced_types.find(x=>x.asset_type==="LEGACY_GADGET"); `unpricedTotal=${j.totals.unpriced_count} legacySeen=${u?u.count:0}`'
```
Expected `unpricedTotal` incremented by 1 and `legacySeen=1`. (Scratch row stays in the isolated copy only; the live DB is never touched.)

- [ ] **Step 4: Cross-region guard**

Run `curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3199/api/register/valuation?region_id=2' -H "Authorization: Bearer $D"` — expected `403`.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/register.js
git commit -m "feat(valuation): shared region population with register-consistent valuation endpoint"
```

---

### Task 3: Maintenance-cost endpoint

**Files:**
- Create: `backend/maintenanceCost.js`
- Modify: `backend/routes/assets.js:1-4,385` (import + route before `module.exports`)
- Modify: `backend/server.js:53` region — no change needed (assets router already mounted); only add a require if needed (not needed).

**Interfaces:**
- Produces: `backend/maintenanceCost.js` exports `maintenanceCostForRegions(regionIds, { from, to, limit=25 })` and `currencyCode()`.
  - Input dates are `'YYYY-MM-DD'` or undefined (undefined → trailing 365 days, inclusive day bounds).
  - Returns `{ currency:{code}, from, to, totals:{spend,count,avg}, by_region:[{region,count,spend}], by_asset_type:[{asset_type,count,spend}], by_event_type:[{event_type,count,spend}], monthly:[{month,count,spend}], recent:[{id,asset_id,asset_name,event_type,performed_at,cost,crew_name}] }`. Spend sums `Number(cost)||0`; rows sorted by spend desc; `recent` sorted newest first.
- New route `GET /api/maintenance-cost?region_id=&from=&to=` in `routes/assets.js`, scoped like `/assets` (region roles see only their region).

- [ ] **Step 1: Create the shared module**

Create `backend/maintenanceCost.js`:

```js
const { db, get } = require('./util');

function currencyCode() {
  const r = db.prepare("SELECT value FROM system_config WHERE key = 'currency'").get();
  return (r && r.value) || 'USD';
}

function assetRegion(a) {
  if (!a) return null;
  if (a.substation_id) return get('substation', a.substation_id)?.region_id ?? null;
  if (a.line_id) return get('transmission_line', a.line_id)?.region_id ?? null;
  if (a.tower_id) {
    const t = get('tower', a.tower_id);
    return t ? get('transmission_line', t.line_id)?.region_id ?? null : null;
  }
  return null;
}

function maintenanceCostForRegions(regionIds, { from, to, limit = 25 } = {}) {
  const code = currencyCode();
  const regionSet = new Set(regionIds);
  const startMs = from ? new Date(`${from}T00:00:00.000Z`).getTime() : Date.now() - 365 * 864e5;
  const endMs = to ? new Date(`${to}T23:59:59.999Z`).getTime() : Date.now();
  const events = db.prepare('SELECT * FROM asset_maintenance_event ORDER BY performed_at DESC').all().map((e) => {
    const at = new Date(e.performed_at).getTime();
    const asset = e.asset_id ? get('asset', e.asset_id) : null;
    return { ...e, asset, at, cost: Number(e.cost) || 0, rid: assetRegion(asset) };
  }).filter((e) => Number.isFinite(e.at) && e.at >= startMs && e.at <= endMs && regionSet.has(e.rid));
  const byRegion = new Map();
  const byAssetType = new Map();
  const byEventType = new Map();
  const byMonth = new Map();
  let spend = 0;
  for (const e of events) {
    spend += e.cost;
    const rid = e.rid;
    const r = get('region', rid);
    if (!byRegion.has(rid)) byRegion.set(rid, { region: r ? r.name : `#${rid}`, count: 0, spend: 0 });
    byRegion.get(rid).count += 1;
    byRegion.get(rid).spend += e.cost;
    const type = e.asset ? (e.asset.asset_type || 'UNSPECIFIED') : 'UNSPECIFIED';
    if (!byAssetType.has(type)) byAssetType.set(type, { asset_type: type, count: 0, spend: 0 });
    byAssetType.get(type).count += 1;
    byAssetType.get(type).spend += e.cost;
    if (!byEventType.has(e.event_type)) byEventType.set(e.event_type, { event_type: e.event_type, count: 0, spend: 0 });
    byEventType.get(e.event_type).count += 1;
    byEventType.get(e.event_type).spend += e.cost;
    const month = String(e.performed_at || '').slice(0, 7);
    if (month) {
      if (!byMonth.has(month)) byMonth.set(month, { month, count: 0, spend: 0 });
      byMonth.get(month).count += 1;
      byMonth.get(month).spend += e.cost;
    }
  }
  const sortBySpend = (arr) => [...arr].sort((a, b) => b.spend - a.spend);
  return {
    currency: { code },
    from: from || null,
    to: to || null,
    totals: { spend, count: events.length, avg: events.length ? spend / events.length : 0 },
    by_region: sortBySpend([...byRegion.values()]),
    by_asset_type: sortBySpend([...byAssetType.values()]),
    by_event_type: sortBySpend([...byEventType.values()]),
    monthly: [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    recent: events.slice(0, limit).map((e) => ({
      id: e.id,
      asset_id: e.asset ? e.asset.asset_id : null,
      asset_name: e.asset ? e.asset.name : null,
      event_type: e.event_type,
      performed_at: e.performed_at,
      cost: e.cost,
      crew_name: e.crew_id ? get('crew', e.crew_id)?.name || null : null,
    })),
  };
}

module.exports = { maintenanceCostForRegions, currencyCode };
```

- [ ] **Step 2: Add the route in assets.js**

In `backend/routes/assets.js`:
1. Add after the existing `const { findCatalog } = require('../assetCatalog');` (line 8):
```js
const { maintenanceCostForRegions } = require('../maintenanceCost');
```
2. Add the route just before `module.exports = router;` (line 385):
```js
// Maintenance cost rollup (used by the Value & Cost page and the reports).
router.get('/maintenance-cost', (req, res) => {
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !isGlobal(req.user) && wanted !== req.user.region_id) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = wanted ? [wanted]
    : isGlobal(req.user)
      ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
      : [req.user.region_id];
  const data = maintenanceCostForRegions(regionIds, { from: req.query.from, to: req.query.to });
  res.json(data);
});
```

- [ ] **Step 3: node -c and isolated-boot verification**

Run `cd /workspace/backend && node -c maintenanceCost.js && node -c routes/assets.js && echo OK`. Stop/re-snapshot/boot the 3199 copy. Login as C1 director and query with an empty period (expect spend 0) then a wide period:
```bash
D=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s 'http://localhost:3199/api/maintenance-cost?from=2020-01-01&to=2099-12-31' -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `count=${j.totals.count} spend=${Math.round(j.totals.spend)} avg=${j.totals.avg.toFixed(0)} regions=${j.by_region.length} types=${j.by_asset_type.length} recent=${j.recent.length} currency=${j.currency.code}`'
```
Expected (existing seeded event data, no cost column populated yet): `count>0`, `spend=0`, `currency=USD`.

- [ ] **Step 4: Commit**

```bash
git add backend/maintenanceCost.js backend/routes/assets.js
git commit -m "feat(cost): maintenance spend rollup endpoint with region/type/event/month breakdowns"
```

---

### Task 4: Cost capture at task completion (backend)

**Files:**
- Modify: `backend/routes/tasks.js:344-360,363-375`

**Interfaces:**
- Consumes: completion POST body now may carry `cost` (optional number ≥ 0).
- Produces: when a task with an `asset_id` is verified and `cost` is supplied, the auto-created `asset_maintenance_event` stores that cost. Invalid/non-numeric cost is silently ignored (event still created).

- [ ] **Step 1: Thread the cost through the verify action**

In `backend/routes/tasks.js`, replace lines 344–360 block:

```js
  if (action === 'verify') {
    patch.actual_end = now;
    patch.result = req.body.result || t.result || 'PASS';
    patch.completion_summary = req.body.completion_summary || t.completion_summary;
    patch.verified_by = req.body.verified_by || req.user.person_id || t.verified_by;
  }
```

with:

```js
  if (action === 'verify') {
    patch.actual_end = now;
    patch.result = req.body.result || t.result || 'PASS';
    patch.completion_summary = req.body.completion_summary || t.completion_summary;
    patch.verified_by = req.body.verified_by || req.user.person_id || t.verified_by;
  }
  // Optional spend recorded against the maintenance event raised on completion.
  let completionCost = null;
  if (action === 'verify') {
    const c = req.body.cost;
    if (c !== undefined && c !== null && c !== '') {
      const n = Number(c);
      if (Number.isFinite(n) && n >= 0) completionCost = n;
    }
  }
```

Then replace `if (action === 'verify') applyCompletionSideEffects(req, get('task', id));` with:

```js
  if (action === 'verify') applyCompletionSideEffects(req, get('task', id), completionCost);
```

- [ ] **Step 2: Accept the cost in the side effect**

Replace `function applyCompletionSideEffects(req, t) {` with `function applyCompletionSideEffects(req, t, cost = null) {`, and inside the `insertRow('asset_maintenance_event', { ... })` object add `cost,` after the `work_summary` line.

- [ ] **Step 3: node -c and behavior check on the isolated copy**

Run `cd /workspace/backend && node -c routes/tasks.js && echo OK`. Stop/re-snapshot/boot 3199. Admin must find a PENDING_VERIFICATION task, complete it with a cost, then read the event:
```bash
ADMIN=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
TID=$(curl -s 'http://localhost:3199/api/tasks' -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const t=j.find(x=>x.status==="PENDING_VERIFICATION" && x.asset_id); t?t.id:""')
```
If `TID` is empty, run Task 5's demo seeding first (it creates tasks is out of scope) — instead fall back to completing any PENDING_VERIFICATION task that has an asset:
```bash
AID=$(curl -s http://localhost:3199/api/tasks/$TID -H "Authorization: Bearer $ADMIN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).asset_id')
curl -s -X POST http://localhost:3199/api/tasks/$TID/state -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"action":"verify","result":"PASS","completion_summary":"plan-verify-with-cost","cost":1234.5}'
curl -s "http://localhost:3199/api/assets/$AID" -H "Authorization: Bearer $ADMIN" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); const e=j.maintenance_events.find(x=>x.task_id); `eventCost=${e?e.cost:"none"}`'
```
Expected: the task is now `COMPLETED` and the newest event on that asset shows `eventCost=1234.5`. (Re-snapshot the isolated DB afterwards so later tasks start from a clean known state.)

- [ ] **Step 4: Commit**

```bash
git add backend/routes/tasks.js
git commit -m "feat(cost): record optional spend against completion maintenance event"
```

---

### Task 5: Idempotent demo cost events (C1)

**Files:**
- Modify: `backend/seed.js` (add `ensureCostDemo`, add to `module.exports` line 412)
- Modify: `backend/server.js:7,31-32` (import + call)

**Interfaces:**
- Produces: `backend/seed.js` exports `ensureCostDemo()` — idempotent; adds cost-carrying `asset_maintenance_event` rows on the C1 demo assets only when they exist; guarded by a `work_summary` marker `'[demo-cost] ...'` so it never duplicates. Returns number added.

- [ ] **Step 1: Add the seeder**

In `backend/seed.js`, after `ensureReportTemplates()` (ends line 662), add:

```js
// Idempotent demo maintenance spend on the C1 demo register assets so the
// maintenance-cost views/reports show believable data in a clean database.
function ensureCostDemo() {
  const demo = db.prepare("SELECT id, asset_id FROM asset WHERE asset_id LIKE 'DEMO-C1-%'").all();
  const byCode = new Map(demo.map((d) => [d.asset_id, d.id]));
  const put = (code, event_type, monthsAgo, cost, summary) => {
    const id = byCode.get(code);
    if (!id) return 0;
    const exists = db.prepare('SELECT id FROM asset_maintenance_event WHERE asset_id = ? AND work_summary = ?').get(id, summary);
    if (exists) return 0;
    insert('asset_maintenance_event', ['asset_id', 'event_type', 'performed_at', 'work_summary', 'cost'], {
      asset_id: id,
      event_type,
      performed_at: new Date(Date.now() - monthsAgo * 30 * 864e5).toISOString(),
      work_summary: summary,
      cost,
    });
    return 1;
  };
  let n = 0;
  n += put('DEMO-C1-HV-01', 'CORRECTIVE', 10, 42000, '[demo-cost] Transformer oil reclamation & gasket replacement');
  n += put('DEMO-C1-HV-01', 'PREVENTIVE', 3, 15000, '[demo-cost] Annual transformer preventive maintenance');
  n += put('DEMO-C1-CP-01', 'PREVENTIVE', 5, 950, '[demo-cost] Relay scheme functional test');
  n += put('DEMO-C1-RTU-01', 'CORRECTIVE', 7, 2200, '[demo-cost] RTU power supply card replacement');
  n += put('DEMO-C1-DC-01', 'CORRECTIVE', 8, 6800, '[demo-cost] Battery bank cell replacement');
  n += put('DEMO-C1-AUX-01', 'PREVENTIVE', 6, 1200, '[demo-cost] Auxiliary transformer servicing');
  n += put('DEMO-C1-MV-01', 'CORRECTIVE', 2, 5400, '[demo-cost] MV switchgear contact overhaul');
  n += put('DEMO-C1-CP-02', 'INSPECTION', 1, 300, '[demo-cost] Metering accuracy verification');
  if (n > 0) console.log(`[costDemo] added ${n} cost-carrying maintenance event(s)`);
  return n;
}
```

Update `module.exports` (line 412) to include `ensureCostDemo`.

- [ ] **Step 2: Boot call**

In `backend/server.js` line 7 add `ensureCostDemo` to the destructure from `'./seed'`, and add `ensureCostDemo();` right after `ensureRegisterDemo();`.

- [ ] **Step 3: node -c, isolated boot, verify sums**

Run `cd /workspace/backend && node -c seed.js && node -c server.js && echo OK`. Stop/re-snapshot/boot 3199 (a fresh snapshot ensures C1 demo assets exist from the register workstream). Expect boot log `[costDemo] added 8 cost-carrying maintenance event(s)`. Then:
```bash
D=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s 'http://localhost:3199/api/maintenance-cost?from=2020-01-01&to=2099-12-31' -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `count=${j.totals.count} spend=${Math.round(j.totals.spend)}`'
```
Expected `spend=73850` (42000+15000+950+2200+6800+1200+5400+300) and `j.monthly.length>=8`. On a second boot the log must NOT repeat (idempotent).

- [ ] **Step 4: Commit**

```bash
git add backend/seed.js backend/server.js
git commit -m "feat(demo): idempotent demo maintenance spend on C1 register assets"
```

---

### Task 6: New scoped report types (backend)

**Files:**
- Modify: `backend/seed.js:650-662` (`ensureReportTemplates` rows)
- Modify: `backend/routes/reports.js:1-6,78-95` (imports + scope helpers) and add two `switch` cases before `default` (line 565)

**Interfaces:**
- Consumes: `computeRegionValuation(regionId)`, `mergeValuations(parts)` from `./register`; `maintenanceCostForRegions`, `currencyCode` from `../maintenanceCost`.
- Produces: `report_template` rows `ASSET_VALUATION` and `MAINTENANCE_COST`; `compute()` cases returning `{ title, rows:[{label,value}], financial:{kind:'valuation'|'cost', ...} }`.

- [ ] **Step 1: Seed templates**

In `backend/seed.js`, inside `ensureReportTemplates()` add to the `rows` array (after the LINE_DETAIL row):

```js
    { name: 'Asset Valuation Report', report_type: 'ASSET_VALUATION', description: 'Replacement cost (RCN) and condition-adjusted value of the registered population, by region, family and type.' },
    { name: 'Maintenance Cost Report', report_type: 'MAINTENANCE_COST', description: 'Recorded maintenance spend over a period, by region, asset and event type.' },
```

- [ ] **Step 2: Imports and money formatting in reports.js**

Add to the top of `backend/routes/reports.js` (after the existing requires):

```js
const { computeRegionValuation, mergeValuations } = require('./register');
const { maintenanceCostForRegions, currencyCode } = require('../maintenanceCost');

function moneyStr(v, code) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(v);
  } catch (_) {
    return `${code} ${Number(v).toLocaleString('en-US')}`;
  }
}
```

- [ ] **Step 3: Scope helper + two cases**

In the `compute(reportType, params, user)` body, right after `const myRegions = () => ...` (line 94), add:

```js
  const reportRegionIds = () => {
    const rid = params.scope_region_id ? Number(params.scope_region_id) : null;
    if (rid) return [rid];
    return isGlobal(user)
      ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
      : [user.region_id];
  };
```

Immediately before the `default:` case (line 565) add:

```js
    case 'ASSET_VALUATION': {
      const parts = reportRegionIds().map((rid) => computeRegionValuation(rid));
      const merged = mergeValuations(parts);
      const t = merged.totals;
      const code = currencyCode();
      const scopeName = parts.length === 1 ? parts[0].region.name : parts.length > 1 ? `${parts.length} regions` : '—';
      return {
        title: `Asset Valuation Report — ${scopeName}`,
        rows: [
          { label: 'Population (assets)', value: t.count },
          { label: 'Replacement cost (RCN)', value: moneyStr(t.rcn, code) },
          { label: 'Condition-adjusted value', value: moneyStr(t.current, code) },
          { label: 'Unpriced assets', value: t.unpriced_count },
          { label: 'Average condition', value: `${Math.round(t.avg_condition * 10) / 10} / 10` },
        ],
        financial: {
          kind: 'valuation',
          currency: code,
          count: t.count,
          rcn: t.rcn,
          current: t.current,
          unpriced_count: t.unpriced_count,
          avg_condition: t.avg_condition,
          by_family: merged.by_family,
          by_type: merged.by_type,
          by_location: merged.by_location,
          unpriced_types: merged.unpriced_types,
        },
      };
    }
    case 'MAINTENANCE_COST': {
      const data = maintenanceCostForRegions(reportRegionIds(), { from: params.period_start, to: params.period_end });
      const code = data.currency.code;
      return {
        title: 'Maintenance Cost Report',
        rows: [
          { label: 'Period', value: `${params.period_start || 'trailing 12 months'} → ${params.period_end || 'today'}` },
          { label: 'Total spend', value: moneyStr(data.totals.spend, code) },
          { label: 'Maintenance events', value: data.totals.count },
          { label: 'Average per event', value: moneyStr(data.totals.avg, code) },
        ],
        financial: { kind: 'cost', ...data },
      };
    }
```

- [ ] **Step 4: node -c, isolated boot, generate both reports**

Run `cd /workspace/backend && node -c routes/reports.js && node -c seed.js && echo OK`. Stop/re-snapshot/boot 3199. As C1 director (has `report:write`):
```bash
D=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s http://localhost:3199/api/report-templates -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.map(t=>t.report_type).sort().join(",")'
```
Expected list includes `ASSET_VALUATION` and `MAINTENANCE_COST`. Then generate both (wide period so demo events count):
```bash
curl -s -X POST http://localhost:3199/api/reports/generate -H "Authorization: Bearer $D" -H 'Content-Type: application/json' -d '{"report_type":"ASSET_VALUATION","period_start":"2020-01-01","period_end":"2099-12-31","format":"HTML"}' | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `type=${j.data.financial.kind} count=${j.data.financial.count} rcn=${Math.round(j.data.financial.rcn)} title=${j.title}`'
curl -s -X POST http://localhost:3199/api/reports/generate -H "Authorization: Bearer $D" -H 'Content-Type: application/json' -d '{"report_type":"MAINTENANCE_COST","period_start":"2020-01-01","period_end":"2099-12-31","format":"HTML"}' | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `type=${j.data.financial.kind} spend=${Math.round(j.data.financial.totals.spend)} events=${j.data.financial.totals.count}`'
```
Expected: valuation `rcn>0`, cost `events>=8`. Both store a `report` row (`GET /reports` shows them).

- [ ] **Step 5: Commit**

```bash
git add backend/seed.js backend/routes/reports.js
git commit -m "feat(reports): asset valuation and maintenance cost report types"
```

---

### Task 7: Frontend money formatting

**Files:**
- Modify: `frontend/src/api.js` (add `fmtMoney`)

**Interfaces:**
- Produces: `frontend/src/api.js` exports `fmtMoney(value, code='USD')` → locale currency string or `'—'` for non-finite; zero-decimal display.

- [ ] **Step 1: Add the helper**

In `frontend/src/api.js`, right after `fmtNum` (line 86), add:

```js
export function fmtMoney(value, code = 'USD') {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  try {
    return v.toLocaleString(currentLocale, { style: 'currency', currency: code, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  } catch (_) {
    return `${code} ${v.toLocaleString(currentLocale)}`;
  }
}
```

- [ ] **Step 2: Build check**

Run `cd /workspace/frontend && npm run build`. Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.js
git commit -m "feat(frontend): fmtMoney locale currency formatter"
```

---

### Task 8: Value & Cost page

**Files:**
- Create: `frontend/src/pages/Value.jsx`
- Modify: `frontend/src/App.jsx` (import, nav group, route)
- Modify: `frontend/src/i18n.js` (nav keys: `managementGroup`, `valueCost` in en/es/zh)

**Interfaces:**
- Consumes: `GET /register/valuation?region_id=`, `GET /maintenance-cost?from=&to=&region_id=`, `GET /asset-catalog`, `PUT /asset-catalog/:id`, `GET /settings`, `GET /regions`.
- Produces: `/value` page with three tabs. CanWrite (admin) gates the Prices tab edits.

- [ ] **Step 1: Create `frontend/src/pages/Value.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtDate } from '../api';
import { Page, Loading, ErrorNote } from '../components';
import { can, getStoredUser } from '../auth';

function Bar({ label, value, currency, max, sub }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div className="mb" style={{ fontSize: 13 }}>
      <div className="spread">
        <span>{label}{sub ? <span className="muted"> · {sub}</span> : null}</span>
        <b>{fmtMoney(value, currency)}</b>
      </div>
      <div style={{ background: '#eef2ff', borderRadius: 4, height: 8, marginTop: 4 }}>
        <div style={{ width: `${pct}%`, background: '#4338ca', height: 8, borderRadius: 4 }} />
      </div>
    </div>
  );
}

function MoneyCard({ label, value, currency, muted }) {
  return (
    <div className="card card-pad">
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtMoney(value, currency)}</div>
      {muted && <div className="muted" style={{ fontSize: 12 }}>{muted}</div>}
    </div>
  );
}

export default function Value() {
  const canWrite = can(getStoredUser(), 'asset:write');
  const [tab, setTab] = useState('valuation');
  const [currency, setCurrency] = useState('USD');
  const [regions, setRegions] = useState([]);
  const [regionId, setRegionId] = useState(null);
  const [val, setVal] = useState(null);
  const [cost, setCost] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);
  const now = new Date();
  const [range, setRange] = useState({
    from: new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  });

  useEffect(() => {
    api.get('/regions').then(setRegions).catch(() => {});
    api.get('/settings').then((s) => { if (s && s.currency) setCurrency(s.currency); }).catch(() => {});
    api.get('/asset-catalog').then(setCatalog).catch((e) => setError(e.message));
  }, []);

  const scopeQ = regionId ? `&region_id=${regionId}` : '';
  const loadVal = () => api.get(`/register/valuation${regionId ? `?region_id=${regionId}` : ''}`).then(setVal).catch((e) => setError(e.message));
  const loadCost = () => api.get(`/maintenance-cost?from=${range.from}&to=${range.to}${scopeQ}`).then(setCost).catch((e) => setError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadVal(); }, [regionId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCost(); }, [regionId, range]);

  async function savePrice(row) {
    try {
      setSaving(row.id);
      await api.put(`/asset-catalog/${row.id}`, { default_unit_price: Number(drafts[row.id]) });
      const res = await api.get('/asset-catalog');
      setCatalog(res);
      const next = { ...drafts };
      delete next[row.id];
      setDrafts(next);
    } catch (e) { setError(e.message); }
    finally { setSaving(null); }
  }

  return (
    <Page title="Value & Cost" crumbs="TMMS / Management">
      {error && <ErrorNote error={error} />}
      <div className="filters">
        <button className={`btn btn-sm${tab === 'valuation' ? ' btn-primary' : ''}`} onClick={() => setTab('valuation')}>Valuation</button>
        <button className={`btn btn-sm${tab === 'cost' ? ' btn-primary' : ''}`} onClick={() => setTab('cost')}>Maintenance cost</button>
        <button className={`btn btn-sm${tab === 'prices' ? ' btn-primary' : ''}`} onClick={() => setTab('prices')}>Prices</button>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>{currency}</span>
        <select value={regionId ?? ''} onChange={(e) => setRegionId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All regions (my scope)</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      {tab === 'valuation' && (
        <div className="mt">
          {!val && <Loading />}
          {val && (
            <>
              <div className="grid grid-4">
                <MoneyCard label="Population (assets)" value={val.totals.count} currency={val.currency.code} muted={`${val.regions.length} region(s) · avg condition ${(val.totals.avg_condition || 0).toFixed(1)}`} />
                <MoneyCard label="Replacement cost (RCN)" value={val.totals.rcn} currency={val.currency.code} muted="benchmark catalog prices × quantity" />
                <MoneyCard label="Condition-adjusted value" value={val.totals.current} currency={val.currency.code} muted="RCN × condition / 10" />
                <MoneyCard label="Unpriced assets" value={val.totals.unpriced_count} currency={val.currency.code} muted={val.unpriced_types.length ? `${val.unpriced_types.length} type(s) without a price` : 'all priced'} />
              </div>
              {val.unpriced_types.length > 0 && (
                <div className="card card-pad mt">
                  <b>Unpriced types</b>
                  <table className="mt">
                    <thead><tr><th>Asset type</th><th>Assets</th></tr></thead>
                    <tbody>
                      {val.unpriced_types.map((u) => (
                        <tr key={u.asset_type}><td className="mono">{u.asset_type}</td><td>{u.count}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Add a price on the Prices tab to include these in value totals.</div>
                </div>
              )}
              <div className="grid grid-2 mt">
                <div className="card card-pad">
                  <h3 className="section-title">By region</h3>
                  {val.regions.map((r) => (
                    <Bar key={r.region_id} label={r.region.name} value={r.current} currency={val.currency.code} max={Math.max(...val.regions.map((x) => x.current), 1)} sub={`${r.count} assets`} />
                  ))}
                </div>
                <div className="card card-pad">
                  <h3 className="section-title">By location</h3>
                  {val.by_location.map((l) => (
                    <Bar key={l.location} label={l.label} value={l.current} currency={val.currency.code} max={Math.max(...val.by_location.map((x) => x.current), 1)} sub={`${l.count} assets`} />
                  ))}
                </div>
              </div>
              <div className="grid grid-2 mt">
                <div className="card card-pad">
                  <h3 className="section-title">By family</h3>
                  {val.by_family.map((f) => (
                    <Bar key={f.family} label={f.family_label} value={f.current} currency={val.currency.code} max={Math.max(...val.by_family.map((x) => x.current), 1)} sub={`${f.count} assets`} />
                  ))}
                </div>
                <div className="card card-pad">
                  <h3 className="section-title">By asset type</h3>
                  <div className="tbl-wrap">
                    <table>
                      <thead><tr><th>Type</th><th>Assets</th><th>RCN</th><th>Current value</th></tr></thead>
                      <tbody>
                        {val.by_type.slice(0, 12).map((t) => (
                          <tr key={t.asset_type}>
                            <td>{t.label}</td>
                            <td>{t.count}</td>
                            <td>{fmtMoney(t.rcn, val.currency.code)}</td>
                            <td><b>{fmtMoney(t.current, val.currency.code)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'cost' && (
        <div className="mt">
          <div className="filters">
            <label style={{ fontSize: 12 }}>From</label>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <label style={{ fontSize: 12 }}>To</label>
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          {!cost && <Loading />}
          {cost && (
            <>
              <div className="grid grid-4">
                <MoneyCard label="Total spend" value={cost.totals.spend} currency={cost.currency.code} muted={`${cost.totals.count} event(s)`} />
                <MoneyCard label="Average per event" value={cost.totals.avg} currency={cost.currency.code} />
                <MoneyCard label="Regions with spend" value={cost.by_region.length} currency={cost.currency.code} />
                <MoneyCard label="Event types" value={cost.by_event_type.length} currency={cost.currency.code} />
              </div>
              <div className="grid grid-2 mt">
                <div className="card card-pad">
                  <h3 className="section-title">Monthly spend</h3>
                  {cost.monthly.map((m) => (
                    <Bar key={m.month} label={m.month} value={m.spend} currency={cost.currency.code} max={Math.max(...cost.monthly.map((x) => x.spend), 1)} sub={`${m.count} event(s)`} />
                  ))}
                  {cost.monthly.length === 0 && <div className="muted">No events in period.</div>}
                </div>
                <div className="card card-pad">
                  <h3 className="section-title">By asset type</h3>
                  <table>
                    <thead><tr><th>Type</th><th>Events</th><th>Spend</th></tr></thead>
                    <tbody>
                      {cost.by_asset_type.map((t) => (
                        <tr key={t.asset_type}><td>{t.asset_type}</td><td>{t.count}</td><td><b>{fmtMoney(t.spend, cost.currency.code)}</b></td></tr>
                      ))}
                      {cost.by_asset_type.length === 0 && <tr><td colSpan={3} className="muted">No data.</td></tr>}
                    </tbody>
                  </table>
                  <h3 className="section-title mt">By event type</h3>
                  <table>
                    <thead><tr><th>Type</th><th>Events</th><th>Spend</th></tr></thead>
                    <tbody>
                      {cost.by_event_type.map((t) => (
                        <tr key={t.event_type}><td>{t.event_type}</td><td>{t.count}</td><td><b>{fmtMoney(t.spend, cost.currency.code)}</b></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="card card-pad mt">
                <h3 className="section-title">Recent events</h3>
                <div className="tbl-wrap">
                  <table>
                    <thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Summary</th><th>Cost</th></tr></thead>
                    <tbody>
                      {cost.recent.map((e) => (
                        <tr key={e.id}>
                          <td className="nowrap">{fmtDate(e.performed_at)}</td>
                          <td>{e.asset_name ? `${e.asset_name} (${e.asset_id})` : '—'}</td>
                          <td>{e.event_type}</td>
                          <td className="muted">{e.crew_name || ''}</td>
                          <td><b>{fmtMoney(e.cost, cost.currency.code)}</b></td>
                        </tr>
                      ))}
                      {cost.recent.length === 0 && <tr><td colSpan={5} className="muted">No events in period.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'prices' && (
        <div className="card card-pad mt">
          <div className="muted mb" style={{ fontSize: 13 }}>
            Benchmark replacement costs (RCN) per catalog class in {currency}. KM rows price the span length (per kilometre); all other units price one unit. Prices are editable by users with asset:write.
          </div>
          {!catalog && <Loading />}
          {catalog && catalog.families.filter((f) => f.family !== 'TOWER_PARTS').map((f) => (
            <div key={f.family} className="mb">
              <b>{f.family_label || f.family}</b>
              <table className="mt">
                <thead><tr><th>Class</th><th>Unit</th><th>Current price</th><th>New price</th><th></th></tr></thead>
                <tbody>
                  {f.types.map((t) => {
                    const dirty = drafts[t.id] !== undefined && String(drafts[t.id]) !== String(t.default_unit_price ?? '');
                    return (
                      <tr key={t.id}>
                        <td>{t.label || t.asset_type}</td>
                        <td className="mono muted">{t.unit_of_measure}</td>
                        <td>{Number(t.default_unit_price) > 0 ? fmtMoney(t.default_unit_price, currency) : <span className="muted">not set</span>}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="100"
                            style={{ width: 130 }}
                            disabled={!canWrite}
                            value={drafts[t.id] ?? t.default_unit_price ?? ''}
                            onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })}
                          />
                        </td>
                        <td>
                          {canWrite && dirty && (
                            <button className="btn btn-sm btn-primary" disabled={saving === t.id} onClick={() => savePrice(t)}>{saving === t.id ? '…' : 'Update'}</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {canWrite && <div className="muted" style={{ fontSize: 12 }}>Save writes go through the standard catalog endpoint (audited).</div>}
        </div>
      )}
    </Page>
  );
}
```

- [ ] **Step 2: Wire nav + route in App.jsx**

At the top of `frontend/src/App.jsx` add `import Value from './pages/Value';` next to the other page imports (line ~7). Add the nav group after the `complianceGroup` group (line 135) by replacing:

```js
    { group: 'complianceGroup', items: [
      { to: '/gps', key: 'gps', ico: '⌘' },
      { to: '/certifications', key: 'certifications', ico: '⊚' },
      { to: '/reports', key: 'reports', ico: '▤' },
      { to: '/settings', key: 'settings', ico: '⚙' },
    ]},
    { group: 'governanceGroup', items: [
```

with:

```js
    { group: 'complianceGroup', items: [
      { to: '/gps', key: 'gps', ico: '⌘' },
      { to: '/certifications', key: 'certifications', ico: '⊚' },
      { to: '/reports', key: 'reports', ico: '▤' },
      { to: '/settings', key: 'settings', ico: '⚙' },
    ]},
    { group: 'managementGroup', items: [
      { to: '/value', key: 'valueCost', ico: '◔' },
    ]},
    { group: 'governanceGroup', items: [
```

Add the route after the `/reports` route (line 174):

```js
          <Route path="/reports" element={<Reports />} />
          <Route path="/value" element={<Value />} />
```

- [ ] **Step 3: i18n keys**

In `frontend/src/i18n.js`:
- en (after `governanceGroup: 'Governance',`): add `managementGroup: 'Management',` and after `settings: 'Settings',` add `valueCost: 'Value & Cost',`.
- es: inside the `es:` block add `managementGroup: 'Gestión',` and `valueCost: 'Valor y costo',` (same insertion points).
- zh: add `managementGroup: '管理',` and `valueCost: '价值与成本',`.

Locate the es/zh block starts by the pattern `es: {` / `zh: {` in `STR`.

- [ ] **Step 4: Build**

Run `cd /workspace/frontend && npm run build`. Fix any error and rebuild until clean.

- [ ] **Step 5: Manual smoke against the live dev server**

Start backend `:3001` and frontend (see `start.sh`); log in as admin, open **Value & Cost**, check Valuation cards populate, Maintenance cost shows the 8 demo events with spend ≈ 74k over the default trailing 12 months, and Prices lists catalog classes with editable inputs.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Value.jsx frontend/src/App.jsx frontend/src/i18n.js
git commit -m "feat(ui): Value & Cost page with valuation, maintenance cost and price tabs"
```

---

### Task 9: Capture + strip UI edits

**Files:**
- Modify: `frontend/src/components/RegisterTree.jsx` (valuation strip)
- Modify: `frontend/src/pages/Assets.jsx` (currency state; history cost column; add-event form)
- Modify: `frontend/src/pages/TaskDetail.jsx` (cost input in verify modal)

**Interfaces:**
- Consumes: `fmtMoney` from `../api`; existing `openDetail`, `detail`, `error`, `api`.
- Produces: cost visible in asset history and recorded via `POST /maintenance-events` and `POST /tasks/:id/state` verify.

- [ ] **Step 1: RegisterTree strip**

In `frontend/src/components/RegisterTree.jsx`:
1. Change line 2 import to `import { api, fmtNum, fmtMoney, condColor } from '../api';`.
2. After `const [jbLine, setJbLine] = useState(null);` add:
```jsx
  const [val, setVal] = useState(null);
```
3. After the existing `useEffect(load, [regionId]);` add:
```jsx
  useEffect(() => {
    const rid = regionId || (tree && tree.regions.length === 1 ? tree.regions[0].region.id : null);
    if (!rid) { setVal(null); return; }
    api.get(`/register/valuation?region_id=${rid}`).then(setVal).catch(() => setVal(null));
  }, [tree, regionId]); // eslint-disable-line react-hooks/exhaustive-deps
```
4. Just before `{tree.regions.map((r) => <RegionNode key={r.region.id} region={r} />)}` (line 168) insert:
```jsx
      {val && (
        <div className="card card-pad mb" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <div className="spread">
            <div><div className="muted" style={{ fontSize: 12 }}>Estimated register value (RCN)</div><div style={{ fontSize: 20, fontWeight: 700 }}>{fmtMoney(val.totals.rcn, val.currency?.code)}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Condition-adjusted</div><div style={{ fontSize: 20, fontWeight: 700 }}>{fmtMoney(val.totals.current, val.currency?.code)}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Assets</div><div style={{ fontSize: 20, fontWeight: 700 }}>{val.totals.count}</div></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Unpriced</div><div style={{ fontSize: 20, fontWeight: 700 }}>{val.totals.unpriced_count}</div></div>
          </div>
        </div>
      )}
```

- [ ] **Step 2: Assets currency + history cost column + add-event**

In `frontend/src/pages/Assets.jsx`:
1. Change line 2 import to `import { api, fmtDate, fmtMoney } from '../api';`.
2. Add state next to `const [document, setDocument] = useState(null);`:
```jsx
  const [currency, setCurrency] = useState('USD');
  const [addEv, setAddEv] = useState(null);
```
3. In the mount `useEffect` (after the `api.get('/crews')...` line) add a settings fetch inside the same effect:
```jsx
    api.get('/settings').then((s) => { if (s && s.currency) setCurrency(s.currency); }).catch(() => {});
```
4. Add an async handler after `openDetail`:
```jsx
  async function addEvent() {
    if (!detail || !addEv) return;
    try {
      await api.post('/maintenance-events', {
        asset_id: detail.id,
        event_type: addEv.event_type,
        performed_at: new Date(addEv.performed_at).toISOString(),
        work_summary: addEv.work_summary,
        cost: addEv.cost === '' ? undefined : Number(addEv.cost),
        ...(addEv.condition_after ? { condition_after: Number(addEv.condition_after) } : {}),
      });
      setAddEv(null);
      openDetail({ id: detail.id });
    } catch (e) { setError(e.message); }
  }
```
5. In the Maintenance History table (lines 260–267) replace the header + row cells to add a Cost column:
```jsx
                <thead><tr><th>Date</th><th>Type</th><th>Summary</th><th>Cost</th></tr></thead>
                <tbody>
                  {(detail.maintenance_events || []).map((e) => (
                    <tr key={e.id}><td className="nowrap">{fmtDate(e.performed_at)}</td><td>{e.event_type}</td><td>{e.work_summary || '—'}</td><td>{e.cost != null ? fmtMoney(e.cost, currency) : '—'}</td></tr>
                  ))}
                  {(detail.maintenance_events || []).length === 0 && <tr><td colSpan={4} className="muted">No maintenance events.</td></tr>}
                </tbody>
```
6. Immediately after that `</table>` (line 267) and before the GPS Validations `<h4>` insert the add-event toggle + form:
```jsx
              {canWrite && (
                <div className="mt">
                  {!addEv && <button className="btn btn-sm" onClick={() => setAddEv({ event_type: 'CORRECTIVE', performed_at: new Date().toISOString().slice(0, 10), work_summary: '', cost: '', condition_after: '' })}>+ Add maintenance event</button>}
                  {addEv && (
                    <div className="card card-pad" style={{ padding: 10 }}>
                      <div className="grid grid-2" style={{ rowGap: 6 }}>
                        <div className="field"><label>Type</label>
                          <select value={addEv.event_type} onChange={(e) => setAddEv({ ...addEv, event_type: e.target.value })}>
                            {['PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'REPAIR', 'REPLACEMENT', 'TESTING'].map((x) => <option key={x} value={x}>{x}</option>)}
                          </select></div>
                        <div className="field"><label>Date</label><input type="date" value={addEv.performed_at} onChange={(e) => setAddEv({ ...addEv, performed_at: e.target.value })} /></div>
                        <div className="field full"><label>Work summary</label><textarea value={addEv.work_summary} onChange={(e) => setAddEv({ ...addEv, work_summary: e.target.value })} /></div>
                        <div className="field"><label>Cost (optional)</label><input type="number" min="0" step="0.01" value={addEv.cost} onChange={(e) => setAddEv({ ...addEv, cost: e.target.value })} /></div>
                        <div className="field"><label>Condition after (1–10)</label><input type="number" min="1" max="10" value={addEv.condition_after} onChange={(e) => setAddEv({ ...addEv, condition_after: e.target.value })} /></div>
                      </div>
                      <div className="mt">
                        <button className="btn btn-sm btn-primary" onClick={addEvent}>Save event</button>{' '}
                        <button className="btn btn-sm" onClick={() => setAddEv(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
```

- [ ] **Step 3: TaskDetail cost input**

In `frontend/src/pages/TaskDetail.jsx`:
1. Change line 39 state to `useState({ result: 'PASS', summary: '', cost: '' })`.
2. Replace the `verify()` body lines 104–109 with:
```jsx
  async function verify() {
    try {
      await act('verify', {
        result: verifyForm.result,
        completion_summary: verifyForm.summary,
        cost: verifyForm.cost === '' ? null : Number(verifyForm.cost),
      });
      setVerifyForm({ result: 'PASS', summary: '', cost: '' });
    } catch (e) { setError(e.message); }
  }
```
3. In the verify modal (line 231 area) add a cost field between the summary textarea and the verify button:
```jsx
                <div className="field"><label>Completion summary</label><textarea value={verifyForm.summary} onChange={(e) => setVerifyForm({ ...verifyForm, summary: e.target.value })} /></div>
                <div className="field"><label>Cost (optional)</label><input type="number" min="0" step="0.01" value={verifyForm.cost ?? ''} onChange={(e) => setVerifyForm({ ...verifyForm, cost: e.target.value })} /></div>
                <button className="btn btn-primary" onClick={verify}>Verify &amp; complete</button>
```

- [ ] **Step 4: Build**

Run `cd /workspace/frontend && npm run build`. Clean.

- [ ] **Step 5: Live smoke**

Against the live stack: as admin, open an asset detail → verify the history shows a Cost column and `+ Add maintenance event` works (cost saved → shows in history and in Value → Maintenance cost). Complete a PENDING_VERIFICATION task via Task Detail with a cost and confirm the event appears on the asset history with that cost.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/RegisterTree.jsx frontend/src/pages/Assets.jsx frontend/src/pages/TaskDetail.jsx
git commit -m "feat(ui): valuation strip, event cost capture in asset detail and task completion"
```

---

### Task 10: Report rendering branch + full verification

**Files:**
- Modify: `frontend/src/pages/Reports.jsx` (financial branch + import)
- Test: isolated-DB full suite, frontend build, live preview

**Interfaces:**
- Consumes: report `data.financial` shapes produced in Task 6.
- Produces: rendered valuation/cost reports in the Reports view modal.

- [ ] **Step 1: ReportView financial branch**

In `frontend/src/pages/Reports.jsx`:
1. Change line 2 import to `import { api, fmtDate, fmtMoney } from '../api';`.
2. Add helper components at the bottom of the file (after `EntityPicker`):
```jsx
function Table({ head, rows }) {
  return (
    <div className="tbl-wrap">
      <table className="mt">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={head.length} className="muted">No data.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function FinancialTables({ f }) {
  const money = (v) => fmtMoney(v, f.currency);
  if (f.kind === 'valuation') {
    return (
      <div>
        <div className="grid grid-4">
          <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>Population</div><div style={{ fontSize: 22, fontWeight: 700 }}>{f.count}</div></div>
          <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>RCN</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(f.rcn)}</div></div>
          <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>Current value</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(f.current)}</div></div>
          <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>Unpriced</div><div style={{ fontSize: 22, fontWeight: 700 }}>{f.unpriced_count}</div></div>
        </div>
        <h4 className="mt">By location</h4>
        <Table head={['Location', 'Assets', 'RCN', 'Current value']} rows={(f.by_location || []).map((r) => [r.label, r.count, money(r.rcn), money(r.current)])} />
        <h4 className="mt">By family</h4>
        <Table head={['Family', 'Assets', 'RCN', 'Current value']} rows={(f.by_family || []).map((r) => [r.family_label, r.count, money(r.rcn), money(r.current)])} />
        <h4 className="mt">By asset type</h4>
        <Table head={['Type', 'Assets', 'RCN', 'Current value']} rows={(f.by_type || []).map((r) => [r.label, r.count, money(r.rcn), money(r.current)])} />
        {(f.unpriced_types || []).length > 0 && (
          <>
            <h4 className="mt">Unpriced types</h4>
            <Table head={['Asset type', 'Assets']} rows={(f.unpriced_types || []).map((r) => [r.asset_type, r.count])} />
          </>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="grid grid-3">
        <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>Total spend</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(f.totals.spend)}</div></div>
        <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>Events</div><div style={{ fontSize: 22, fontWeight: 700 }}>{f.totals.count}</div></div>
        <div className="card card-pad"><div className="muted" style={{ fontSize: 12 }}>Avg / event</div><div style={{ fontSize: 22, fontWeight: 700 }}>{money(f.totals.avg)}</div></div>
      </div>
      <h4 className="mt">By region</h4>
      <Table head={['Region', 'Events', 'Spend']} rows={(f.by_region || []).map((r) => [r.region, r.count, money(r.spend)])} />
      <h4 className="mt">By asset type</h4>
      <Table head={['Type', 'Events', 'Spend']} rows={(f.by_asset_type || []).map((r) => [r.asset_type, r.count, money(r.spend)])} />
      <h4 className="mt">By event type</h4>
      <Table head={['Event type', 'Events', 'Spend']} rows={(f.by_event_type || []).map((r) => [r.event_type, r.count, money(r.spend)])} />
      <h4 className="mt">Monthly spend</h4>
      <Table head={['Month', 'Events', 'Spend']} rows={(f.monthly || []).map((r) => [r.month, r.count, money(r.spend)])} />
      <h4 className="mt">Recent events</h4>
      <Table head={['Date', 'Asset', 'Type', 'Cost']} rows={(f.recent || []).map((r) => [fmtDate(r.performed_at), r.asset_name || '—', r.event_type, money(r.cost)])} />
    </div>
  );
}
```
3. In `ReportView` (line 167), right after the document branch, add:
```jsx
  if (data.financial) return <FinancialTables f={data.financial} />;
```

- [ ] **Step 2: Build**

Run `cd /workspace/frontend && npm run build`. Clean.

- [ ] **Step 3: Full isolated-DB regression**

Stop/re-snapshot/boot the 3199 copy once more with all backend changes. Admin token; then assert the whole surface in one pass:
```bash
ADMIN=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
D=$(curl -s -X POST http://localhost:3199/api/auth/login -H 'Content-Type: application/json' -d '{"username":"dir.c1","password":"Region@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
# count invariant
A=$(curl -s http://localhost:3199/api/assets/summary -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total_assets')
T=$(curl -s http://localhost:3199/api/register/tree -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).regions[0].counts.assets')
V=$(curl -s http://localhost:3199/api/register/valuation -H "Authorization: Bearer $D" | node -pe 'JSON.parse(require("fs").readFileSync(0)).regions[0].count')
echo "invariant summary=$A tree=$T valuation=$V"
# prices reachable
curl -s -X PUT http://localhost:3199/api/asset-catalog/1 -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"default_unit_price":9999}' | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `price=${j.default_unit_price}`'
curl -s -X PUT http://localhost:3199/api/asset-catalog/1 -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"default_unit_price":null}' >/dev/null
# cost endpoint + reports
curl -s 'http://localhost:3199/api/maintenance-cost?from=2020-01-01&to=2099-12-31' -H "Authorization: Bearer $D" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `costCount=${j.totals.count} spend=${Math.round(j.totals.spend)}`'
curl -s -X POST http://localhost:3199/api/reports/generate -H "Authorization: Bearer $D" -H 'Content-Type: application/json' -d '{"report_type":"ASSET_VALUATION","period_start":"2020-01-01","period_end":"2099-12-31"}' | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); `report=${j.report_type} kind=${j.data.financial.kind}`'
```
Expected: all three counts equal; price PUT then restore works; costCount ≥ 8; valuation report kind `valuation`.

- [ ] **Step 4: Live preview + final lint/build pass**

Restart the real `:3001` backend + frontend dev server (see `start.sh`) and preview via `/deploy-website`. Walk: Assets register (value strip on a single region), Value & Cost page (three tabs), Reports (generate both new types, View shows tables). Also run `cd /workspace/frontend && npm run build` and `cd /workspace/backend && for f in routes/register.js routes/assets.js routes/tasks.js routes/reports.js maintenanceCost.js seed.js assetCatalog.js server.js; do node -c $f || exit 1; done && echo ALL-CLEAN`.

- [ ] **Step 5: Commit any remaining changes and finish**

```bash
git add -A
git commit -m "feat(reports): render valuation and cost report financial views"
```

---

## Self-review notes

- Spec coverage: §4 prices/capture → Tasks 1,4,9; §5 endpoints → Tasks 2,3,6; §6 UI → Tasks 7,8,9,10; §8 verification → per-task steps + Task 10 Step 3/4.
- Demo requirement (spec §3.6) → Task 5; report template seeding → Task 6 Step 1.
- Type consistency: `fmtMoney(v, code)` everywhere; `computeRegionValuation(regionId)` + `mergeValuations(parts)` used by both the route and the report case; `maintenanceCostForRegions(regionIds,{from,to})` used by the endpoint and the report case. Response field names (`totals.{count,rcn,current,unpriced_count,avg_condition}`, `by_family`, `by_location`, `monthly`, `recent`) match between backend payloads and the Value page / ReportView consumers.
