const express = require('express');
const { db, list, insertRow, updateRow, withTx } = require('../util');
const { can, audit } = require('../auth');
const { commandScope } = require('../authority');
const { countSubstationBays, validateIntegrity, reconcileAll, syncSubstationBayCount, syncLineTowerCount, syncTowerMirror } = require('../integrity');
const { polygonFromCenter, haversine } = require('../geo');
const { projectPointToRoute } = require('../lineGeometry');
const { seedStandardComponents } = require('../towerStandards');
const {
  TEMPLATES, parseInfra, substationRecords, lineGroups, pick, num,
  normalizeVoltageLevels, validCoord, parseCoordPairs,
  SUBSTATION_ID_KEYS, SUBSTATION_NAME_KEYS, REGION_CODE_KEYS,
} = require('../infraImport');

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

function buildScope(regionIds, scope) {
  if (!regionIds.length) return { regions: [], substations: [], lines: [], towers: [] };
  const scoped = !!scope && !scope.global;
  const regionList = db.prepare(`SELECT * FROM region WHERE id IN (${ph(regionIds.length)}) ORDER BY code`).all(...regionIds);
  const subRows = db.prepare(`SELECT * FROM substation WHERE region_id IN (${ph(regionIds.length)}) ORDER BY name`).all(...regionIds)
    .filter((s) => !scoped || scope.substationIds.has(s.id));
  const lineRows = db.prepare(`SELECT * FROM transmission_line WHERE region_id IN (${ph(regionIds.length)}) ORDER BY line_id`).all(...regionIds)
    .filter((l) => !scoped || scope.lineIds.has(l.id));

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
  const assets = db.prepare("SELECT * FROM asset WHERE lifecycle_status != 'REMOVED'").all()
    .filter((a) => !scoped || scope.assetIds.has(a.id))
    .map((a) => ({ ...a, metadata: null }));
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
    const bayCounts = new Map();
    for (const a of arr) {
      const b = String(a.bay || '').trim();
      if (!b) continue;
      bayCounts.set(b, (bayCounts.get(b) || 0) + 1);
    }
    const bays = [...bayCounts.entries()].map(([bay, count]) => ({ bay, count })).sort((x, y) => x.bay.localeCompare(y.bay));
    subOut.push({
      id: s.id, substation_id: s.substation_id, name: s.name,
      region_id: s.region_id, region_code: regionCode.get(s.region_id),
      latitude: s.latitude, longitude: s.longitude, operational_status: s.operational_status,
      voltage_levels: parseVoltageLevels(s.voltage_levels), bay_count: countSubstationBays(s.id), gps_validated: s.gps_validated,
      bays,
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
  const scope = commandScope(req.user);
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !scope.global && !scope.regionIds.has(wanted)) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your command scope' });
  }
  const regionIds = wanted
    ? [wanted]
    : scope.global
      ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
      : [...scope.regionIds];
  res.json({ currency: { code: currencyCode() }, ...buildScope(regionIds, scope) });
});

router.get('/infrastructure/validation', (req, res) => {
  const scope = commandScope(req.user);
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !scope.global && !scope.regionIds.has(wanted)) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your command scope' });
  }
  const regionIds = wanted
    ? [wanted]
    : scope.global
      ? db.prepare('SELECT id FROM region').all().map((r) => r.id)
      : [...scope.regionIds];
  const report = validateIntegrity({ regionIds });
  if (!scope.global) {
    report.lines = report.lines.filter((l) => scope.lineIds.has(l.id));
    report.towers = report.towers.filter((t) => scope.towerIds.has(t.id));
    report.substations = report.substations.filter((s) => scope.substationIds.has(s.id));
    report.summary = {
      lines: report.lines.length,
      towers: report.towers.length,
      substations: report.substations.length,
      issues: report.lines.reduce((n, l) => n
        + (Number(l.tower_count) !== Number(l.actual_tower_count) ? 1 : 0)
        + (l.missing_mirrors || 0) + (l.non_standard_towers || 0), 0),
    };
  }
  const lineId = req.query.line_id ? Number(req.query.line_id) : null;
  if (lineId) {
    if (!scope.global && !scope.lineIds.has(lineId)) {
      return res.status(403).json({ error: 'Forbidden: resource is outside your command scope' });
    }
    report.lines = report.lines.filter((l) => l.id === lineId);
    report.towers = report.towers.filter((t) => t.line_id === lineId);
    report.substations = [];
    const issues = report.lines.reduce((n, l) => (
      n + (Number(l.tower_count) !== Number(l.actual_tower_count) ? 1 : 0)
      + l.missing_mirrors + l.non_standard_towers
    ), 0);
    report.summary = {
      lines: report.lines.length,
      towers: report.lines.reduce((n, l) => n + l.actual_tower_count, 0),
      substations: 0,
      issues,
    };
  }
  res.json(report);
});

router.post('/infrastructure/reconcile', (req, res) => {
  if (!can(req, 'tower:write') && !can(req, 'asset:write')) {
    return res.status(403).json({ error: 'Forbidden: requires tower:write or asset:write' });
  }
  const scope = commandScope(req.user);
  const wanted = req.body && req.body.region_id ? Number(req.body.region_id) : null;
  if (wanted && !scope.global && !scope.regionIds.has(wanted)) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your command scope' });
  }
  const regionIds = wanted ? [wanted] : (scope.global ? null : [...scope.regionIds]);
  res.json(reconcileAll({ regionIds }));
});

// ---------------------------------------------------------------------------
// Bulk import: substations and transmission-line routes (+ towers).
// Two-step: preview parses the file and validates every candidate against the
// live register, returning a short-lived token; commit re-applies the stored
// candidates. Master-data creation stays ADMIN-only, matching the single-record
// endpoints in core.js (substation:write / line:write are not granted to
// management roles). CSV is the documented template; KML/KMZ/GeoJSON are also
// accepted (Point -> substation, LineString -> line, Point with line_id -> tower).
// ---------------------------------------------------------------------------
const pendingImports = new Map();
let importSeq = 1;
const IMPORT_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingImports) if (now - v.at > IMPORT_TTL_MS) pendingImports.delete(k);
}, 5 * 60 * 1000).unref();

function importContext(scope, defaultRegionId) {
  const regions = list('region').filter((r) => scope.global || scope.regionIds.has(r.id));
  const subs = list('substation');
  const subByCode = new Map();
  for (const s of subs) {
    subByCode.set(String(s.substation_id || '').toUpperCase(), s);
    if (s.name) subByCode.set(String(s.name).toUpperCase(), s);
  }
  const lines = list('transmission_line');
  const lineByCode = new Map();
  for (const l of lines) if (l.line_id) lineByCode.set(String(l.line_id).toUpperCase(), l);
  const towerByCode = new Map();
  for (const t of db.prepare('SELECT id, tower_id, line_id FROM tower').all()) {
    if (t.tower_id) towerByCode.set(String(t.tower_id).toUpperCase(), t);
  }
  return {
    scope,
    regionByCode: new Map(regions.map((r) => [String(r.code || '').toUpperCase(), r])),
    regionById: new Map(list('region').map((r) => [r.id, r])),
    subByCode,
    existingSubCodes: new Set(subs.map((s) => String(s.substation_id || '').toUpperCase())),
    existingLineCodes: new Set(lines.map((l) => String(l.line_id || '').toUpperCase())),
    lineByCode,
    towerByCode,
    existingTowerIds: new Set([...towerByCode.keys()]),
    defaultRegionId: defaultRegionId != null && Number.isFinite(Number(defaultRegionId)) ? Number(defaultRegionId) : null,
  };
}

function regionInScope(region, ctx) {
  return !!region && (ctx.scope.global || ctx.scope.regionIds.has(region.id));
}

function resolveImportRegion(code, ctx) {
  if (code) {
    const r = ctx.regionByCode.get(String(code).toUpperCase());
    return regionInScope(r, ctx) ? r : null;
  }
  if (ctx.defaultRegionId != null) {
    const r = ctx.regionById.get(ctx.defaultRegionId);
    return regionInScope(r, ctx) ? r : null;
  }
  return null;
}

function normalizeSubstations(records, ctx) {
  return records.map((rec) => {
    const props = rec.props || {};
    const out = { substation_id: '', name: '', region_code: null, latitude: rec.lat, longitude: rec.lng, will_skip: false, reason: null, data: null };
    const name = pick(props, SUBSTATION_NAME_KEYS);
    const sid = pick(props, SUBSTATION_ID_KEYS) || name;
    out.substation_id = sid;
    out.name = name || sid;
    if (!sid) { out.will_skip = true; out.reason = 'missing substation_id'; return out; }
    if (ctx.existingSubCodes.has(sid.toUpperCase())) { out.will_skip = true; out.reason = 'substation_id already exists'; return out; }
    if (!validCoord(rec.lat, rec.lng)) { out.will_skip = true; out.reason = 'invalid or missing latitude/longitude'; return out; }
    const region = resolveImportRegion(pick(props, REGION_CODE_KEYS), ctx);
    if (!region) { out.will_skip = true; out.reason = 'no resolvable region (add region_code or pick a default region)'; return out; }
    out.region_code = region.code;
    const fence = num(pick(props, ['fence_radius_m', 'fence_radius', 'radius_m']));
    let boundary = parseCoordPairs(pick(props, ['boundary', 'boundary_coords', 'fence', 'polygon']));
    if (boundary.length < 3) boundary = [];
    if (boundary.length < 3 && fence > 0) boundary = polygonFromCenter(rec.lat, rec.lng, fence);
    out.data = {
      substation_id: sid,
      name: out.name,
      region_id: region.id,
      latitude: rec.lat,
      longitude: rec.lng,
      elevation_m: num(pick(props, ['elevation_m', 'elevation'])),
      voltage_levels: normalizeVoltageLevels(pick(props, ['voltage_levels', 'voltage', 'voltages', 'voltage_kv'])),
      substation_type: (pick(props, ['substation_type', 'type']) || 'TRANSFORMER').toUpperCase(),
      operational_status: (pick(props, ['operational_status', 'status']) || 'OPERATIONAL').toUpperCase(),
      owner: pick(props, ['owner', 'utility', 'company']) || null,
      commissioned_date: pick(props, ['commissioned_date', 'commissioned']) || null,
      gps_validated: 1,
      revision: 1,
      fence_radius_m: fence != null ? fence : null,
      boundary_json: boundary.length >= 3 ? JSON.stringify(boundary) : null,
    };
    return out;
  });
}

function normalizeLineGroups(groups, ctx, opts = {}) {
  const allowUpdate = !!(opts && opts.update);
  const seenTowerIds = new Set();
  return groups.map((g) => {
    const header = g.header || {};
    const out = { line_id: '', name: '', region_code: null, voltage_kv: null, from: null, to: null, tower_count: 0, route_points: 0, update: false, existing_id: null, tower_skips: [], will_skip: false, reason: null, data: null };
    const lineId = pick(header, ['line_id', 'line_code', 'line']) || (g.key && g.key !== '__single__' ? g.key : '');
    out.line_id = lineId;
    out.name = pick(header, ['name', 'line_name']) || lineId;
    if (!lineId) { out.will_skip = true; out.reason = 'missing line_id'; return out; }
    const existingLine = ctx.lineByCode ? ctx.lineByCode.get(lineId.toUpperCase()) : null;
    if (existingLine) {
      if (!allowUpdate) {
        out.will_skip = true;
        out.reason = 'line_id already exists (enable "Update existing" to overwrite it)';
        return out;
      }
      out.update = true;
      out.existing_id = existingLine.id;
    }
    const voltage = num(pick(header, ['voltage_kv', 'voltage']));
    if (!(voltage > 0)) { out.will_skip = true; out.reason = 'voltage_kv must be a positive number'; return out; }
    out.voltage_kv = voltage;
    const fromCode = pick(header, ['from_substation_code', 'from_substation', 'from_code', 'from']);
    const toCode = pick(header, ['to_substation_code', 'to_substation', 'to_code', 'to']);
    const from = ctx.subByCode.get(String(fromCode || '').toUpperCase());
    const to = ctx.subByCode.get(String(toCode || '').toUpperCase());
    if (!from || !to) { out.will_skip = true; out.reason = 'from/to substation code not found'; return out; }
    out.from = from.substation_id;
    out.to = to.substation_id;
    const region = resolveImportRegion(pick(header, REGION_CODE_KEYS), ctx) || ctx.regionById.get(from.region_id);
    if (!regionInScope(region, ctx)) { out.will_skip = true; out.reason = 'target region is outside your command scope'; return out; }
    // A transmission line may legitimately span two regions (e.g. Gelan C2 ->
    // Koka R8), so the endpoints only need to be in the caller's scope - not
    // necessarily the same region as the line record itself.
    if (!ctx.scope.global && (!ctx.scope.substationIds.has(from.id) || !ctx.scope.substationIds.has(to.id))) {
      out.will_skip = true; out.reason = 'from/to substation is outside your command scope'; return out;
    }
    out.region_code = region.code;

    let route = (Array.isArray(g.route) ? g.route : []).filter((p) => Array.isArray(p) && validCoord(p[0], p[1]));
    const towers = (g.towers || []).map((t, i) => {
      const tp = t.props || {};
      const prefix = lineId.replace(/^TL-/, '');
      const towerId = pick(tp, ['tower_id', 'tower_code']) || `${prefix}-${String(i + 1).padStart(3, '0')}`;
      return {
        seq: i + 1,
        tower_number: pick(tp, ['tower_number', 'tower_seq', 'sequence', 'seq']) || String(i + 1),
        tower_id: towerId,
        latitude: t.lat,
        longitude: t.lng,
        tower_type: (pick(tp, ['tower_type', 'type']) || 'SUSPENSION').toUpperCase(),
        tower_material: (pick(tp, ['tower_material', 'material']) || 'LATTICE_STEEL').toUpperCase(),
        height_m: num(pick(tp, ['height_m', 'height'])),
        foundation_type: (pick(tp, ['foundation_type', 'foundation']) || 'PAD').toUpperCase(),
        km_marker: num(pick(tp, ['km_marker', 'km', 'chainage'])),
        corrosion_rating: num(pick(tp, ['corrosion_rating', 'corrosion'])) ?? 8,
      };
    });
    // Resolve what happens to each tower. A collision with a tower that lives
    // on this very line is an update (when update mode is on); a collision with
    // a tower on another line only drops that one tower instead of failing the
    // whole line, so a partially-overlapping export still imports.
    for (const t of towers) {
      if (!validCoord(t.latitude, t.longitude)) { out.will_skip = true; out.reason = `tower ${t.tower_id} has invalid coordinates`; return out; }
      const key = t.tower_id.toUpperCase();
      if (seenTowerIds.has(key)) { out.will_skip = true; out.reason = `duplicate tower_id ${t.tower_id} in file`; return out; }
      seenTowerIds.add(key);
      const existingTower = ctx.towerByCode ? ctx.towerByCode.get(key) : null;
      if (!existingTower) { t.action = 'insert'; t.existing_id = null; continue; }
      if (out.update && existingTower.line_id === out.existing_id) {
        t.action = 'update';
        t.existing_id = existingTower.id;
      } else {
        t.action = 'skip';
        t.existing_id = null;
        out.tower_skips.push({
          tower_id: t.tower_id,
          reason: out.update ? 'tower_id belongs to another line' : 'tower_id already exists',
        });
      }
    }
    const importableTowers = towers.filter((t) => t.action !== 'skip');
    if (route.length < 2 && importableTowers.length >= 2) route = importableTowers.map((t) => [t.latitude, t.longitude]);
    if (route.length < 2) { out.will_skip = true; out.reason = 'need a route with at least 2 points (route column or >=2 valid tower coordinates)'; return out; }
    out.tower_count = importableTowers.length;
    out.towers_skipped = out.tower_skips.length;
    out.route_points = route.length;
    out.data = {
      line_id: lineId,
      name: out.name,
      region_id: region.id,
      from_substation_id: from.id,
      to_substation_id: to.id,
      voltage_kv: voltage,
      line_type: (pick(header, ['line_type', 'type']) || 'OVERHEAD').toUpperCase(),
      conductor_type: pick(header, ['conductor_type', 'conductor']) || null,
      circuit_count: num(pick(header, ['circuit_count', 'circuits'])) ?? 1,
      operational_status: (pick(header, ['operational_status', 'status']) || 'ENERGIZED').toUpperCase(),
      commissioned_date: pick(header, ['commissioned_date']) || null,
      route,
      towers,
    };
    return out;
  });
}

// Merge a reviewer's inline edit into a raw substation record before
// re-normalization. Only fields that can be safely corrected online are applied;
// region/FK resolution still runs through the normal validator afterwards.
function applySubstationEdit(rec, edit) {
  if (!edit || typeof edit !== 'object') return rec;
  const props = { ...(rec.props || {}) };
  if (edit.name !== undefined) props.name = edit.name;
  if (edit.substation_id !== undefined) { props.substation_id = edit.substation_id; props.substation_code = edit.substation_id; }
  if (edit.region_code !== undefined) props.region_code = edit.region_code;
  if (edit.voltage_levels !== undefined) {
    props.voltage_levels = Array.isArray(edit.voltage_levels) ? edit.voltage_levels.join(';') : String(edit.voltage_levels);
  }
  if (edit.substation_type !== undefined) props.substation_type = edit.substation_type;
  if (edit.operational_status !== undefined) props.operational_status = edit.operational_status;
  if (edit.boundary !== undefined) props.boundary = JSON.stringify(edit.boundary);
  const lat = edit.latitude !== undefined ? num(edit.latitude) : rec.lat;
  const lng = edit.longitude !== undefined ? num(edit.longitude) : rec.lng;
  return { ...rec, props, lat, lng };
}

// Merge a reviewer's edit into a line group (header + route + tower coordinates)
// before re-normalization.
function applyLineEdit(g, edit) {
  if (!edit || typeof edit !== 'object') return g;
  const header = { ...(g.header || {}) };
  if (edit.name !== undefined) header.name = edit.name;
  if (edit.line_id !== undefined) { header.line_id = edit.line_id; header.line_code = edit.line_id; }
  if (edit.line_type !== undefined) header.line_type = edit.line_type;
  if (edit.conductor_type !== undefined) header.conductor_type = edit.conductor_type;
  if (edit.circuit_count !== undefined) header.circuit_count = edit.circuit_count;
  if (edit.operational_status !== undefined) header.operational_status = edit.operational_status;
  if (edit.commissioned_date !== undefined) header.commissioned_date = edit.commissioned_date;
  if (edit.voltage_kv !== undefined) { header.voltage_kv = edit.voltage_kv; header.voltage = edit.voltage_kv; }
  if (edit.region_code !== undefined) header.region_code = edit.region_code;
  let route = Array.isArray(g.route) ? g.route : [];
  if (Array.isArray(edit.route)) route = edit.route.filter((p) => Array.isArray(p) && validCoord(p[0], p[1]));
  let towers = Array.isArray(g.towers) ? g.towers : [];
  if (Array.isArray(edit.towers)) {
    towers = towers.map((t, i) => {
      const e = edit.towers[i];
      if (!e) return t;
      return {
        ...t,
        lat: e.latitude !== undefined ? num(e.latitude) : t.lat,
        lng: e.longitude !== undefined ? num(e.longitude) : t.lng,
      };
    });
  }
  return { ...g, header, route, towers };
}

router.get('/infrastructure/templates/:kind', (req, res) => {
  const kind = req.params.kind === 'line-routes' ? 'lines' : req.params.kind;
  if (!TEMPLATES[kind]) return res.status(404).json({ error: 'Unknown template (use substations or lines)' });
  const perm = kind === 'lines' ? 'line:write' : 'substation:write';
  if (!can(req, perm)) return res.status(403).json({ error: `Forbidden: requires ${perm}` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tmms-${kind}-template.csv"`);
  res.send(TEMPLATES[kind]);
});

router.post('/infrastructure/import/substations/preview', (req, res) => {
  if (!can(req, 'substation:write')) return res.status(403).json({ error: 'Forbidden: requires substation:write' });
  const { format, content, default_region_id } = req.body || {};
  let parsed;
  try { parsed = parseInfra(format, content); } catch (e) { return res.status(400).json({ error: e.message }); }
  const scope = commandScope(req.user);
  const ctx = importContext(scope, default_region_id);
  const records = substationRecords(parsed);
  if (!records.length) return res.status(400).json({ error: 'No substation records found (each needs a Point or a row with latitude/longitude)' });
  const candidates = normalizeSubstations(records, ctx);
  const token = `imp${importSeq++}-${Date.now()}`;
  pendingImports.set(token, { at: Date.now(), kind: 'substations', candidates, records, default_region_id: ctx.defaultRegionId });
  res.json({
    token,
    kind: 'substations',
    count: candidates.length,
    will_create: candidates.filter((c) => !c.will_skip).length,
    will_skip: candidates.filter((c) => c.will_skip).length,
    candidates: candidates.map((c, i) => {
      const props = (records[i] && records[i].props) || {};
      let boundary = [];
      try { boundary = parseCoordPairs(pick(props, ['boundary', 'boundary_coords', 'fence', 'polygon'])); } catch (_) { boundary = []; }
      return {
        index: i,
        substation_id: c.substation_id, name: c.name, region_code: c.region_code,
        latitude: c.latitude, longitude: c.longitude,
        voltage_levels: c.data ? JSON.parse(c.data.voltage_levels) : normalizeVoltageLevels(pick(props, ['voltage_levels', 'voltage', 'voltages', 'voltage_kv'])),
        substation_type: c.data ? c.data.substation_type : (pick(props, ['substation_type', 'type']) || null),
        operational_status: c.data ? c.data.operational_status : (pick(props, ['operational_status', 'status']) || null),
        boundary: boundary.length >= 3 ? boundary : [],
        will_skip: c.will_skip, reason: c.reason,
      };
    }),
  });
});

router.post('/infrastructure/import/substations/commit', (req, res) => {
  if (!can(req, 'substation:write')) return res.status(403).json({ error: 'Forbidden: requires substation:write' });
  const pv = pendingImports.get(req.body && req.body.token);
  if (!pv || pv.kind !== 'substations') return res.status(400).json({ error: 'Preview token missing or expired - run the preview again' });
  pendingImports.delete(req.body.token);
  // Reviewers may correct candidates inline before committing. When edits are
  // supplied the raw records are patched and re-validated so a fixed coordinate
  // or region can turn a would-skip row into a created one.
  const edits = req.body && req.body.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
  let candidates = pv.candidates;
  if (edits && Array.isArray(pv.records)) {
    const ctx = importContext(commandScope(req.user), pv.default_region_id);
    const records = pv.records.map((rec, i) => applySubstationEdit(rec, edits[i]));
    candidates = normalizeSubstations(records, ctx);
  }
  const created = [];
  const skipped = [];
  // One transaction for the whole batch: without it every insert autocommits
  // (one WAL fsync each) and a large substation file crawls.
  withTx(() => {
    for (const c of candidates) {
      if (c.will_skip) { skipped.push({ substation_id: c.substation_id, reason: c.reason }); continue; }
      try {
        const id = insertRow('substation', c.data);
        syncSubstationBayCount(id);
        created.push({ id, substation_id: c.substation_id });
      } catch (e) {
        skipped.push({ substation_id: c.substation_id, reason: e.message });
      }
    }
  });
  audit(req.user, 'IMPORT_SUBSTATIONS', 'substation', null, { attempted: candidates.length, created: created.length, skipped: skipped.length });
  res.status(201).json({ created: created.length, skipped, substations: created });
});

router.post('/infrastructure/import/lines/preview', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const { format, content, default_region_id, update } = req.body || {};
  let parsed;
  try { parsed = parseInfra(format, content); } catch (e) { return res.status(400).json({ error: e.message }); }
  const scope = commandScope(req.user);
  const ctx = importContext(scope, default_region_id);
  const groups = lineGroups(parsed);
  if (!groups.length) return res.status(400).json({ error: 'No line records found (need rows with line_id or LineString features)' });
  const allowUpdate = !!update;
  const candidates = normalizeLineGroups(groups, ctx, { update: allowUpdate });
  const token = `imp${importSeq++}-${Date.now()}`;
  pendingImports.set(token, { at: Date.now(), kind: 'lines', candidates, groups, default_region_id: ctx.defaultRegionId, update: allowUpdate });
  res.json({
    token,
    kind: 'lines',
    update: allowUpdate,
    count: candidates.length,
    will_create: candidates.filter((c) => !c.will_skip && !c.update).length,
    will_update: candidates.filter((c) => !c.will_skip && c.update).length,
    will_skip: candidates.filter((c) => c.will_skip).length,
    towers_skipped: candidates.reduce((n, c) => n + (c.towers_skipped || 0), 0),
    candidates: candidates.map((c, i) => {
      const g = groups[i] || { header: {}, route: [], towers: [] };
      const normalizedTowers = c.data ? c.data.towers : [];
      return {
        index: i,
        line_id: c.line_id, name: c.name, region_code: c.region_code, voltage_kv: c.voltage_kv,
        from: c.from, to: c.to, tower_count: c.tower_count, route_points: c.route_points,
        update: c.update,
        line_type: c.data ? c.data.line_type : null,
        operational_status: c.data ? c.data.operational_status : null,
        route: (g.route || []).map((p) => [p[0], p[1]]),
        towers: (g.towers || []).map((t, ti) => ({
          index: ti,
          tower_id: normalizedTowers[ti] ? normalizedTowers[ti].tower_id : (pick(t.props, ['tower_id', 'tower_code']) || ''),
          tower_number: pick(t.props, ['tower_number', 'tower_seq', 'sequence', 'seq']) || String(ti + 1),
          latitude: t.lat,
          longitude: t.lng,
        })),
        towers_skipped: c.towers_skipped || 0,
        will_skip: c.will_skip, reason: c.reason,
      };
    }),
  });
});

router.post('/infrastructure/import/lines/commit', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const pv = pendingImports.get(req.body && req.body.token);
  if (!pv || pv.kind !== 'lines') return res.status(400).json({ error: 'Preview token missing or expired - run the preview again' });
  pendingImports.delete(req.body.token);
  // Apply any inline reviewer edits to the raw groups and re-validate before
  // writing, so corrected geometry or metadata is what actually lands.
  const edits = req.body && req.body.edits && typeof req.body.edits === 'object' ? req.body.edits : null;
  const allowUpdate = !!pv.update || !!(req.body && req.body.update);
  let candidates = pv.candidates;
  if (edits && Array.isArray(pv.groups)) {
    const ctx = importContext(commandScope(req.user), pv.default_region_id);
    const groups = pv.groups.map((g, i) => applyLineEdit(g, edits[i]));
    candidates = normalizeLineGroups(groups, ctx, { update: allowUpdate });
  }
  const created = [];
  const updatedLines = [];
  const skipped = [];
  let towersCreated = 0;
  let towersUpdated = 0;
  for (const c of candidates) {
    if (c.will_skip) { skipped.push({ line_id: c.line_id, reason: c.reason }); continue; }
    for (const ts of (c.tower_skips || [])) skipped.push({ line_id: c.line_id, tower_id: ts.tower_id, reason: ts.reason });
    const d = c.data;
    const route = d.route.map((p) => [p[0], p[1]]);
    let lengthKm = 0;
    for (let i = 1; i < route.length; i++) {
      lengthKm += haversine(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]) / 1000;
    }
    lengthKm = Math.round(lengthKm * 10) / 10;
    try {
      const result = withTx(() => {
        const fields = {
          name: d.name,
          region_id: d.region_id,
          from_substation_id: d.from_substation_id,
          to_substation_id: d.to_substation_id,
          route_json: JSON.stringify(route),
          voltage_kv: d.voltage_kv,
          line_type: d.line_type,
          conductor_type: d.conductor_type,
          circuit_count: d.circuit_count,
          operational_status: d.operational_status,
          commissioned_date: d.commissioned_date,
          length_km: lengthKm,
          gps_validated: 1,
        };
        let lineId;
        if (c.update && c.existing_id) {
          updateRow('transmission_line', c.existing_id, fields, ['route_json'], 'revision');
          lineId = c.existing_id;
        } else {
          lineId = insertRow('transmission_line', { line_id: d.line_id, ...fields, tower_count: 0, revision: 1 });
        }
        const height = d.voltage_kv >= 500 ? 55 : 38;
        let made = 0;
        let changed = 0;
        for (const t of d.towers) {
          if (t.action === 'skip') continue;
          const proj = t.km_marker == null ? projectPointToRoute(route, t.latitude, t.longitude) : null;
          const km = t.km_marker != null ? t.km_marker : (proj ? proj.km : t.seq);
          const towerFields = {
            tower_id: t.tower_id,
            line_id: lineId,
            tower_number: t.tower_number,
            km_marker: km,
            latitude: t.latitude,
            longitude: t.longitude,
            tower_type: t.tower_type,
            tower_material: t.tower_material,
            height_m: t.height_m != null ? t.height_m : height,
            foundation_type: t.foundation_type,
            corrosion_rating: t.corrosion_rating,
            gps_validated: 1,
          };
          if (t.action === 'update' && t.existing_id) {
            updateRow('tower', t.existing_id, towerFields, [], 'revision');
            changed += 1;
            continue;
          }
          const towerRow = insertRow('tower', { ...towerFields, revision: 1 });
          seedStandardComponents(towerRow, t.tower_type);
          syncTowerMirror(towerRow);
          made += 1;
        }
        syncLineTowerCount(lineId);
        return { id: lineId, towers: made, towersUpdated: changed, updated: !!(c.update && c.existing_id) };
      });
      towersCreated += result.towers;
      towersUpdated += result.towersUpdated;
      if (result.updated) updatedLines.push({ id: result.id, line_id: d.line_id, towers: result.towers, towers_updated: result.towersUpdated, length_km: lengthKm });
      else created.push({ id: result.id, line_id: d.line_id, towers: result.towers, towers_updated: result.towersUpdated, length_km: lengthKm });
    } catch (e) {
      skipped.push({ line_id: c.line_id, reason: e.message });
    }
  }
  audit(req.user, 'IMPORT_LINES', 'transmission_line', null, { attempted: candidates.length, created: created.length, updated: updatedLines.length, towers: towersCreated, towers_updated: towersUpdated, skipped: skipped.length });
  res.status(201).json({ created: created.length, updated: updatedLines.length, towers_created: towersCreated, towers_updated: towersUpdated, skipped, lines: created, updated_lines: updatedLines });
});

module.exports = router;
