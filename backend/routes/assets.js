const express = require('express');
const { db, list, get, parseRow, insertRow, updateRow, safeDelete, byClientRef } = require('../util');
const { can, isGlobal, audit } = require('../auth');
const { commandScope } = require('../authority');

const router = express.Router();

const { extractKmzText, extractPlacemarks } = require('../geoimport');
const { findCatalog } = require('../assetCatalog');
const { maintenanceCostForRegions } = require('../maintenanceCost');
const { syncSubstationBayCount, syncTowerFromAsset } = require('../integrity');
const { computeHealth, suggestAssetCondition } = require('../assetCondition');
const { ASSET_TEMPLATE, assetRecords, parseInfra, firstNonEmpty, num } = require('../assetImport');
const { evaluatePerformance, READING_TYPES, EVENT_TYPES, EVENT_SEVERITIES, MODEL_VERSION } = require('../assetPerformance');
const { parseCsv } = require('../infraImport');

// Tower structures live in the tower table; their asset rows are created and
// kept in sync automatically (integrity.syncTowerMirror). Users must not
// create, edit or delete them directly through the asset register — otherwise
// a tower would end up with duplicate or divergent register rows.
const TOWER_MIRROR_TYPES = new Set(['TOWER', 'POLE']);
const TOWER_MIRROR_MSG = 'Tower structures are managed from the tower register. Add or edit them under Infrastructure > Towers.';

// Chain-of-command helpers: a manager only reaches the assets their command is
// responsible for; global roles keep the open (all) view.
function scopeAllowsAsset(scope, id) {
  return scope.global || scope.assetIds.has(id);
}

function anchorInScope(scope, body) {
  if (scope.global) return true;
  if (body.substation_id != null && body.substation_id !== '') return scope.substationIds.has(Number(body.substation_id));
  if (body.line_id != null && body.line_id !== '') return scope.lineIds.has(Number(body.line_id));
  if (body.tower_id != null && body.tower_id !== '') return scope.towerIds.has(Number(body.tower_id));
  return false;
}

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

// Shared lookup maps so list endpoints resolve region/crew/line references in
// memory instead of issuing a query per asset.
function buildAssetLookups() {
  return {
    substations: new Map(list('substation').map((s) => [s.id, s])),
    lines: new Map(list('transmission_line').map((l) => [l.id, l])),
    crews: new Map(list('crew').map((c) => [c.id, c])),
  };
}

function enrichAsset(a, lk) {
  const h = computeHealth(a);
  const out = { ...a, health_index: h.health_index, remaining_useful_life_years: h.remaining_useful_life_years };
  out.default_crew = out.default_crew_id ? (lk ? lk.crews.get(out.default_crew_id) || null : get('crew', out.default_crew_id)) : null;
  return out;
}

// Shape shared by the asset-detail map: a substation with its parsed yard
// boundary plus the line(s) it terminates, so the client can draw the parent
// line route and the substation yard behind a selected asset.
function substationBrief(id) {
  if (id == null) return null;
  const s = get('substation', id, ['boundary_json']);
  if (!s) return null;
  const region = s.region_id != null ? get('region', s.region_id) : null;
  return {
    id: s.id,
    substation_id: s.substation_id,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    elevation_m: s.elevation_m,
    voltage_levels: s.voltage_levels,
    substation_type: s.substation_type,
    operational_status: s.operational_status,
    owner: s.owner,
    fence_radius_m: s.fence_radius_m,
    boundary_json: s.boundary_json,
    region_id: s.region_id,
    region_name: region ? region.name : null,
  };
}

function lineBrief(id) {
  if (id == null) return null;
  const l = get('transmission_line', id, ['route_json']);
  if (!l) return null;
  const region = l.region_id != null ? get('region', l.region_id) : null;
  const from = substationBrief(l.from_substation_id);
  const to = substationBrief(l.to_substation_id);
  return {
    id: l.id,
    line_id: l.line_id,
    name: l.name,
    voltage_kv: l.voltage_kv,
    route_json: l.route_json,
    from_substation_id: l.from_substation_id,
    to_substation_id: l.to_substation_id,
    from_name: from ? from.name : null,
    to_name: to ? to.name : null,
    from,
    to,
    region_id: l.region_id || null,
    region_name: region ? region.name : null,
    length_km: l.length_km,
    conductor_type: l.conductor_type || null,
    circuit_count: l.circuit_count,
    tower_count: l.tower_count,
    operational_status: l.operational_status,
    gps_validated: l.gps_validated,
  };
}

function assetFilter(req) {
  const { substation_id, line_id, tower_id, asset_type, parent_asset_id } = req.query;
  const where = [];
  const args = [];
  if (substation_id) { where.push('substation_id = ?'); args.push(Number(substation_id)); }
  if (line_id) { where.push('line_id = ?'); args.push(Number(line_id)); }
  if (tower_id) { where.push('tower_id = ?'); args.push(Number(tower_id)); }
  if (asset_type) { where.push('asset_type = ?'); args.push(asset_type); }
  if (parent_asset_id) { where.push('parent_asset_id = ?'); args.push(Number(parent_asset_id)); }
  return { where, args };
}

function findAssetId(req) {
  const { where, args } = assetFilter(req);
  const scope = commandScope(req.user);
  const sql = `SELECT * FROM asset${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  let rows = db.prepare(sql).all(...args).map((r) => parseRow(r, ['metadata']));
  if (!scope.global) rows = rows.filter((a) => scope.assetIds.has(a.id));
  return rows;
}

// Compact rows for dropdowns (task/schedule/GPS target pickers). The full asset
// row set is ~12 MB on a large register and carries fields those pickers never
// read; this projection keeps only the id/name/location/parent/default-crew
// fields they do.
function findAssetBrief(req) {
  const { where, args } = assetFilter(req);
  const scope = commandScope(req.user);
  const sql = `SELECT id, asset_id, name, asset_type, sub_type, latitude, longitude,
      substation_id, line_id, tower_id, operational_status, default_crew_id
    FROM asset${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
  let rows = db.prepare(sql).all(...args);
  if (!scope.global) rows = rows.filter((a) => scope.assetIds.has(a.id));
  const crewNames = new Map(list('crew').map((c) => [c.id, c.name]));
  return rows.map((a) => ({
    ...a,
    default_crew_name: a.default_crew_id != null ? (crewNames.get(a.default_crew_id) ?? null) : null,
  }));
}

router.get('/assets', (req, res) => {
  if (req.query.brief) return res.json(findAssetBrief(req));
  const lk = buildAssetLookups();
  const rows = findAssetId(req).map((a) => enrichAsset(a, lk));
  for (const a of rows) {
    // Compact location briefs. The full substation (boundary_json) and line
    // (route_json) were duplicated on every asset, producing an 80+ MB
    // response on large registers. Detail reads keep the full geometry.
    const s = a.substation_id ? lk.substations.get(a.substation_id) : null;
    a.substation = s ? {
      id: s.id, substation_id: s.substation_id, name: s.name,
      voltage_levels: s.voltage_levels, region_id: s.region_id,
    } : null;
    const l = a.line_id ? lk.lines.get(a.line_id) : null;
    a.line = l ? {
      id: l.id, line_id: l.line_id, name: l.name, voltage_kv: l.voltage_kv,
      operational_status: l.operational_status, region_id: l.region_id,
    } : null;
  }
  res.json(rows);
});

// Register summary — population counts by class (asset_type) and category
// (sub_type), average condition, within the user's regional scope.
router.get('/assets/summary', (req, res) => {
  const scope = commandScope(req.user);
  const scoped = list('asset').filter((a) => a.lifecycle_status !== 'REMOVED')
    .filter((a) => scope.global || scope.assetIds.has(a.id));
  const byClass = {};
  const byCategory = {};
  let total = 0;
  for (const a of scoped) {
    total++;
    const cls = a.asset_type || 'UNSPECIFIED';
    byClass[cls] = byClass[cls] || { asset_type: cls, count: 0, cond_sum: 0 };
    byClass[cls].count++;
    if (a.condition_rating) byClass[cls].cond_sum += a.condition_rating;
    const cat = a.sub_type || 'UNSPECIFIED';
    byCategory[cat] = byCategory[cat] || { category: cat, count: 0 };
    byCategory[cat].count++;
  }
  res.json({
    total_assets: total,
    by_class: Object.values(byClass).map((x) => ({ asset_type: x.asset_type, count: x.count, avg_condition: x.count ? Math.round((x.cond_sum / x.count) * 10) / 10 : 0 })),
    by_category: Object.values(byCategory).sort((a, b) => b.count - a.count),
  });
});

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

// ---- Asset register bulk import (CSV / KML / GeoJSON) --------------------------
// Assets carry no region_id: the structural anchor (substation, line or tower)
// determines the region and therefore the command scope. The CSV template
// references parents by human code, which these maps resolve.
const ASSET_IMPORT_ENUMS = {
  location_type: new Set(['OUTDOOR', 'INDOOR', 'BUILDING', 'CELLAR', 'UNDERGROUND']),
  criticality: new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  lifecycle_status: new Set(['IN_SERVICE', 'OUT_OF_SERVICE', 'RESERVED', 'RETIRED', 'SPARE']),
  operational_status: new Set(['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'UNDER_CONSTRUCTION', 'DECOMMISSIONED']),
};

function upperIndex(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const v = r[key];
    if (v != null && String(v).trim() !== '') m.set(String(v).trim().toUpperCase(), r);
  }
  return m;
}

function buildAssetImportContext() {
  const subs = list('substation');
  const lines = list('transmission_line');
  const towers = list('tower');
  const crews = list('crew');
  return {
    subByCode: upperIndex(subs, 'substation_id'),
    subByName: upperIndex(subs, 'name'),
    lineByCode: upperIndex(lines, 'line_id'),
    towerByCode: upperIndex(towers, 'tower_id'),
    assetByCode: upperIndex(list('asset'), 'asset_id'),
    regionByCode: upperIndex(list('region'), 'code'),
    crewByCode: upperIndex(crews, 'crew_code'),
    crewByName: upperIndex(crews, 'name'),
    lineById: new Map(lines.map((l) => [l.id, l])),
  };
}

function anchorAllowed(scope, { substation_id, line_id, tower_id, region_id }) {
  if (!scope || scope.global) return true;
  if (substation_id && scope.substationIds.has(substation_id)) return true;
  if (line_id && scope.lineIds.has(line_id)) return true;
  if (tower_id && scope.towerIds.has(tower_id)) return true;
  if (region_id && scope.regionIds && scope.regionIds.has(region_id)) return true;
  return false;
}

function assetRegionOf(ctx, { sub, line, tower }) {
  if (sub) return sub.region_id;
  if (line) return line.region_id;
  if (tower) {
    const l = ctx.lineById.get(tower.line_id);
    return l ? l.region_id : null;
  }
  return null;
}

function normalizeAssetRecords(records, ctx, scope, { update }) {
  const out = [];
  records.forEach((r, index) => {
    const rec = r.props || {};
    const cand = { index, will_skip: false, reason: null, update: false };
    const skip = (reason) => { cand.will_skip = true; cand.reason = reason; out.push(cand); };
    const asset_id = firstNonEmpty(rec, ['asset_id', 'asset_code', 'code']);
    const name = firstNonEmpty(rec, ['name', 'asset_name', 'title']);
    const assetType = firstNonEmpty(rec, ['asset_type', 'type']).toUpperCase();
    cand.asset_id = asset_id;
    cand.name = name;
    cand.asset_type = assetType;
    if (!asset_id) return skip('asset_id is required');
    if (!name) return skip('name is required');
    if (!assetType) return skip('asset_type is required');
    if (TOWER_MIRROR_TYPES.has(assetType)) return skip(TOWER_MIRROR_MSG);
    const subType = firstNonEmpty(rec, ['sub_type', 'subtype']);
    if (!findCatalog(assetType, subType)) return skip(`unknown asset_type '${assetType}'`);

    const subCode = firstNonEmpty(rec, ['substation_code', 'substation_id', 'substation']);
    const lineCode = firstNonEmpty(rec, ['line_code', 'line_id', 'line']);
    const towerCode = firstNonEmpty(rec, ['tower_code', 'tower_id', 'tower']);
    const parentCode = firstNonEmpty(rec, ['parent_asset_code', 'parent_asset_id', 'parent']);
    const regionCode = firstNonEmpty(rec, ['region_code', 'region']);

    const sub = subCode ? (ctx.subByCode.get(subCode.toUpperCase()) || ctx.subByName.get(subCode.toUpperCase())) : null;
    if (subCode && !sub) return skip(`unknown substation_code '${subCode}'`);
    let line = lineCode ? ctx.lineByCode.get(lineCode.toUpperCase()) : null;
    if (lineCode && !line) return skip(`unknown line_code '${lineCode}'`);
    const tower = towerCode ? ctx.towerByCode.get(towerCode.toUpperCase()) : null;
    if (towerCode && !tower) return skip(`unknown tower_code '${towerCode}'`);
    if (tower && !line && ctx.lineById.has(tower.line_id)) line = ctx.lineById.get(tower.line_id);
    const parent = parentCode ? ctx.assetByCode.get(parentCode.toUpperCase()) : null;
    if (parentCode && !parent) return skip(`unknown parent_asset_code '${parentCode}'`);

    if (sub && (line || tower)) return skip('a substation asset cannot also anchor to a line or tower');
    if (tower && line && tower.line_id !== line.id) return skip('tower_code belongs to a different line');

    const lat = num(firstNonEmpty(rec, ['latitude', 'lat'])) ?? (r.lat != null ? r.lat : null);
    const lng = num(firstNonEmpty(rec, ['longitude', 'lng', 'lon'])) ?? (r.lng != null ? r.lng : null);
    const kmFromRaw = firstNonEmpty(rec, ['km_from']);
    const kmToRaw = firstNonEmpty(rec, ['km_to']);
    const kmFrom = num(kmFromRaw);
    const kmTo = num(kmToRaw);
    if (kmFromRaw && kmFrom == null) return skip('km_from must be numeric');
    if (kmToRaw && kmTo == null) return skip('km_to must be numeric');
    const hasKm = kmFromRaw !== '' || kmToRaw !== '';
    if (hasKm && !line) return skip('km_from/km_to require a line_code anchor');
    if (hasKm && tower) return skip('km_from/km_to cannot be set on a tower asset');
    if (hasKm && kmFrom != null && kmTo != null && kmTo < kmFrom) return skip('km_to must be >= km_from');

    let region = assetRegionOf(ctx, { sub, line, tower });
    if (regionCode) {
      const reg = ctx.regionByCode.get(regionCode.toUpperCase());
      if (!reg) return skip(`unknown region_code '${regionCode}'`);
      if (region == null) region = reg.id;
    }
    if (!sub && !line && !tower && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
      return skip('standalone assets require latitude and longitude');
    }
    if (!anchorAllowed(scope, { substation_id: sub ? sub.id : null, line_id: line ? line.id : null, tower_id: tower ? tower.id : null, region_id: region })) {
      return skip('asset anchor is outside your command scope');
    }

    const existing = ctx.assetByCode.get(asset_id.toUpperCase());
    let existing_id = null;
    if (existing) {
      if (TOWER_MIRROR_TYPES.has(existing.asset_type)) return skip('asset_id belongs to a tower structure; edit the tower instead');
      if (!update) return skip(`${asset_id} already exists (enable "Update existing" to overwrite it)`);
      cand.update = true;
      existing_id = existing.id;
    }

    for (const [field, set] of Object.entries(ASSET_IMPORT_ENUMS)) {
      const v = firstNonEmpty(rec, [field]).toUpperCase();
      if (v && !set.has(v)) return skip(`${field} '${v}' is not valid`);
    }
    const condRaw = firstNonEmpty(rec, ['condition_rating', 'condition']);
    let condition = 7;
    if (condRaw) {
      const c = Number(condRaw);
      if (!Number.isFinite(c) || c < 1 || c > 10) return skip('condition_rating must be 1-10');
      condition = Math.round(c);
    }
    let metadata = '{}';
    const metaRaw = firstNonEmpty(rec, ['metadata']);
    if (metaRaw) {
      try { JSON.parse(metaRaw); metadata = metaRaw; } catch (_) { return skip('metadata must be valid JSON'); }
    }
    const gpsRaw = firstNonEmpty(rec, ['gps_validated', 'gps']);
    const gps = gpsRaw === '' ? 0 : (/^(1|true|yes|validated)$/i.test(gpsRaw) ? 1 : 0);
    const crewCode = firstNonEmpty(rec, ['default_crew_code', 'default_crew', 'crew_code', 'crew']);
    const crew = crewCode ? (ctx.crewByCode.get(crewCode.toUpperCase()) || ctx.crewByName.get(crewCode.toUpperCase())) : null;
    if (crewCode && !crew) return skip(`unknown crew '${crewCode}'`);

    cand.anchor = sub ? `substation ${sub.substation_id}` : tower ? `tower ${tower.tower_id}` : line ? `line ${line.line_id}` : 'standalone';
    cand.existing_id = existing_id;
    cand.fields = {
      asset_id,
      name,
      asset_type: assetType,
      sub_type: subType || null,
      substation_id: sub ? sub.id : null,
      line_id: line ? line.id : null,
      tower_id: tower ? tower.id : null,
      parent_asset_id: parent ? parent.id : null,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      km_from: kmFrom,
      km_to: kmTo,
      location_type: firstNonEmpty(rec, ['location_type']).toUpperCase() || 'OUTDOOR',
      bay: firstNonEmpty(rec, ['bay']) || null,
      manufacturer: firstNonEmpty(rec, ['manufacturer']) || null,
      model: firstNonEmpty(rec, ['model']) || null,
      serial_number: firstNonEmpty(rec, ['serial_number', 'serial']) || null,
      installation_date: firstNonEmpty(rec, ['installation_date']) || null,
      commissioned_date: firstNonEmpty(rec, ['commissioned_date']) || null,
      condition_rating: condition,
      criticality: firstNonEmpty(rec, ['criticality']).toUpperCase() || 'MEDIUM',
      lifecycle_status: firstNonEmpty(rec, ['lifecycle_status']).toUpperCase() || 'IN_SERVICE',
      operational_status: firstNonEmpty(rec, ['operational_status']).toUpperCase() || 'OPERATIONAL',
      warranty_expiry: firstNonEmpty(rec, ['warranty_expiry']) || null,
      last_maintenance_at: firstNonEmpty(rec, ['last_maintenance_at']) || null,
      next_maintenance_at: firstNonEmpty(rec, ['next_maintenance_at']) || null,
      default_crew_id: crew ? crew.id : null,
      gps_validated: gps,
      metadata,
    };
    out.push(cand);
  });
  return out;
}

router.get('/assets/import/template', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tmms-assets-template.csv"');
  res.send(ASSET_TEMPLATE);
});

router.post('/assets/import/preview', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const { format, content, update } = req.body || {};
  let parsed;
  try { parsed = parseInfra(format || 'csv', content); } catch (e) { return res.status(400).json({ error: e.message }); }
  const records = assetRecords(parsed);
  if (!records.length) return res.status(400).json({ error: 'No asset rows found in the file' });
  const ctx = buildAssetImportContext();
  const candidates = normalizeAssetRecords(records, ctx, commandScope(req.user), { update: !!update });
  const token = `asset${previewSeq++}-${Date.now()}`;
  pendingPreviews.set(token, { at: Date.now(), candidates });
  res.json({
    token,
    kind: 'assets',
    update: !!update,
    count: candidates.length,
    will_create: candidates.filter((c) => !c.will_skip && !c.update).length,
    will_update: candidates.filter((c) => !c.will_skip && c.update).length,
    will_skip: candidates.filter((c) => c.will_skip).length,
    candidates: candidates.map((c) => ({
      index: c.index, asset_id: c.asset_id, name: c.name, asset_type: c.asset_type,
      anchor: c.anchor, update: c.update, will_skip: c.will_skip, reason: c.reason,
    })),
  });
});

router.post('/assets/import/commit', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const pv = pendingPreviews.get(req.body.token);
  if (!pv) return res.status(400).json({ error: 'Preview token missing or expired — run the preview again' });
  pendingPreviews.delete(req.body.token);
  const edits = req.body.edits || {};
  const created = [];
  const updated = [];
  const skipped = [];
  for (const c of pv.candidates) {
    if (c.will_skip) { skipped.push({ asset_id: c.asset_id, reason: c.reason }); continue; }
    try {
      const fields = { ...c.fields };
      const patch = edits[c.index];
      if (patch) for (const [k, v] of Object.entries(patch)) if (k in fields) fields[k] = v;
      if (c.update && c.existing_id) {
        updateRow('asset', c.existing_id, fields, ['metadata'], 'revision');
        updated.push(get('asset', c.existing_id, ['metadata']));
      } else {
        const id = insertRow('asset', { ...fields, revision: 1 }, ['metadata']);
        created.push(get('asset', id, ['metadata']));
      }
    } catch (e) { skipped.push({ asset_id: c.asset_id, reason: e.message }); }
  }
  audit(req.user, 'IMPORT_ASSETS', 'asset', null, { created: created.length, updated: updated.length, skipped: skipped.length });
  res.status(201).json({ created: created.length, updated: updated.length, skipped, assets: created.concat(updated) });
});

// Evidence-based condition suggestion (advisory). Available to any user who
// can read the asset; an authorised evaluator confirms it via
// POST /assets/:id/evaluation with `use_suggested: true`.
router.get('/assets/:id/condition-suggestion', (req, res) => {
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  res.json(suggestAssetCondition(a));
});

// Condition evaluation by a region manager/director — persists the derived
// health index and remaining useful life alongside free-text notes. With
// `use_suggested: true` the evidence-based suggestion becomes the stored
// rating; otherwise the supplied (or existing) manual rating is used.
router.post('/assets/:id/evaluation', (req, res) => {
  if (!can(req, 'asset:evaluate')) return res.status(403).json({ error: 'Forbidden: requires asset:evaluate' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const combined = req.body.combined === true || req.body.combined === 'true';
  const suggestion = (req.body.use_suggested || combined) ? suggestAssetCondition(a) : null;
  const rating = suggestion
    ? suggestion.suggested_rating
    : (req.body.condition_rating == null ? a.condition_rating : Number(req.body.condition_rating));
  if (rating == null || Number.isNaN(rating) || rating < 1 || rating > 10) {
    return res.status(400).json({ error: 'condition_rating must be 1-10' });
  }
  const merged = { ...a, condition_rating: rating };
  const health = computeHealth(merged);
  const operational = rating <= 3 ? 'DEGRADED' : 'OPERATIONAL';
  const lifecycle = rating <= 2 ? 'DEFECTIVE' : a.lifecycle_status;
  const now = new Date().toISOString();
  const autoNote = suggestion
    ? `Auto evaluation: suggested ${suggestion.suggested_rating}/10 (${suggestion.recommendation_label}). Evidence: ${suggestion.reasons.join('; ')}.`
    : null;
  updateRow('asset', a.id, {
    condition_rating: rating,
    condition_assessed_at: now,
    health_index: health.health_index,
    remaining_useful_life_years: health.remaining_useful_life_years,
    evaluation_notes: req.body.evaluation_notes || req.body.notes || autoNote || null,
    operational_status: operational,
    lifecycle_status: lifecycle,
  }, [], 'revision');
  audit(req.user, 'EVALUATE', 'asset', a.id, { condition_rating: rating, suggested: !!suggestion, health_index: health.health_index });
  const snapshotComputed = suggestion
    ? {
      combined_rating: rating,
      health_index: health.health_index,
      rul_years: health.remaining_useful_life_years,
      base_rating: suggestion.base_rating,
      performance_delta: suggestion.performance_delta,
      degradation_rate: suggestion.degradation_rate,
      factors: suggestion.factors,
      recommendation: suggestion.recommendation,
      reasons: suggestion.reasons,
      model_version: (suggestion.performance && suggestion.performance.model_version) || MODEL_VERSION,
    }
    : {
      combined_rating: rating,
      health_index: health.health_index,
      rul_years: health.remaining_useful_life_years,
      base_rating: rating,
      performance_delta: 0,
      degradation_rate: 0,
      factors: [],
      recommendation: null,
      reasons: [],
      model_version: MODEL_VERSION,
    };
  writeSnapshot(a, snapshotComputed, 'EVALUATION', req.user.person_id, { condition_rating: a.condition_rating, reasons: suggestion ? suggestion.reasons : [] });
  const updated = enrichAsset(get('asset', a.id, ['metadata']));
  updated.evaluation = suggestion ? { recommendation: suggestion.recommendation, reasons: suggestion.reasons, performance_delta: suggestion.performance_delta } : null;
  res.json(updated);
});


router.get('/assets/:id', (req, res) => {
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  const scope = commandScope(req.user);
  if (!scopeAllowsAsset(scope, a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const enriched = enrichAsset(a);
  const tower = a.tower_id ? get('tower', a.tower_id) : null;
  const lineId = a.line_id || (tower ? tower.line_id : null);
  enriched.substation = a.substation_id ? substationBrief(a.substation_id) : null;
  enriched.line = lineId ? lineBrief(lineId) : null;
  enriched.tower = tower;
  enriched.parent = a.parent_asset_id ? get('asset', a.parent_asset_id) : null;
  enriched.related_lines = enriched.substation
    ? list('transmission_line')
      .filter((l) => l.from_substation_id === enriched.substation.id || l.to_substation_id === enriched.substation.id)
      .map((l) => lineBrief(l.id))
      .filter(Boolean)
    : [];
  enriched.maintenance_events = db.prepare('SELECT * FROM asset_maintenance_event WHERE asset_id = ? ORDER BY performed_at DESC').all(a.id);
  const openTasks = db.prepare(
    "SELECT * FROM task WHERE asset_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).all(a.id);
  enriched.open_tasks = scope.global ? openTasks : openTasks.filter((t) => scope.taskIds.has(t.id));
  const gpsRows = db.prepare('SELECT * FROM gps_validation WHERE target_type = ? AND target_id = ? ORDER BY validated_at DESC')
    .all('ASSET', a.id);
  enriched.gps_validations = scope.global ? gpsRows : gpsRows.filter((v) => scope.validationIds.has(v.id));
  res.json(enriched);
});

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

router.post('/assets', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  if (!anchorInScope(commandScope(req.user), req.body)) {
    return res.status(403).json({ error: 'Forbidden: asset anchor is outside your command scope' });
  }
  if (TOWER_MIRROR_TYPES.has(req.body.asset_type)) {
    return res.status(400).json({ error: TOWER_MIRROR_MSG });
  }
  try {
    if (!validateAssetBody(req, res, req.body)) return;
    const body = { ...req.body, metadata: req.body.metadata || {}, revision: 1 };
    if (typeof body.metadata !== 'string') body.metadata = JSON.stringify(body.metadata);
    const id = insertRow('asset', body, ['metadata']);
    syncSubstationBayCount(body.substation_id);
    audit(req.user, 'CREATE', 'asset', id, req.body);
    res.status(201).json(enrichAsset(get('asset', id, ['metadata'])));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/assets/:id', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const a = get('asset', Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  const scope = commandScope(req.user);
  if (!scopeAllowsAsset(scope, a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  if (TOWER_MIRROR_TYPES.has(a.asset_type) || TOWER_MIRROR_TYPES.has(req.body.asset_type)) {
    return res.status(400).json({ error: TOWER_MIRROR_MSG });
  }
  const body = { ...req.body };
  const anchorTouched = ['substation_id', 'line_id', 'tower_id'].some((k) => body[k] !== undefined && Number(body[k] || 0) !== (a[k] || 0));
  if (anchorTouched && !scope.global) {
    const merged = { substation_id: null, line_id: null, tower_id: null, ...body };
    if (!anchorInScope(scope, merged)) return res.status(403).json({ error: 'Forbidden: asset anchor is outside your command scope' });
  }
  if (!validateAssetBody(req, res, { ...a, ...req.body })) return;
  if (body.metadata && typeof body.metadata === 'object') body.metadata = JSON.stringify(body.metadata);
  updateRow('asset', Number(req.params.id), body, ['metadata'], 'revision');
  syncSubstationBayCount(a.substation_id);
  syncSubstationBayCount(body.substation_id);
  audit(req.user, 'UPDATE', 'asset', Number(req.params.id), req.body);
  res.json(enrichAsset(get('asset', Number(req.params.id), ['metadata'])));
});

router.delete('/assets/:id', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const id = Number(req.params.id);
  const a = get('asset', id);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  if (a.tower_id && TOWER_MIRROR_TYPES.has(a.asset_type)) {
    return res.status(409).json({ error: 'This asset mirrors a tower. Delete the tower under Infrastructure > Towers instead.' });
  }
  const events = db.prepare('SELECT COUNT(*) c FROM asset_maintenance_event WHERE asset_id = ?').get(id).c;
  const children = db.prepare('SELECT COUNT(*) c FROM asset WHERE parent_asset_id = ?').get(id).c;
  if (events > 0 || children > 0) {
    return res.status(409).json({ error: `Cannot delete: ${events} maintenance events, ${children} child assets` });
  }
  safeDelete('asset', id);
  syncSubstationBayCount(a.substation_id);
  audit(req.user, 'DELETE', 'asset', id, {});
  res.json({ ok: true });
});

// Condition assessment — recompute health, update operational status
router.post('/assets/:id/condition', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const rating = Number(req.body.condition_rating);
  if (!rating || rating < 1 || rating > 10) return res.status(400).json({ error: 'condition_rating must be 1-10' });
  const operational = rating <= 3 ? 'DEGRADED' : 'OPERATIONAL';
  const lifecycle = rating <= 2 ? 'DEFECTIVE' : a.lifecycle_status;
  updateRow('asset', a.id, {
    condition_rating: rating,
    condition_assessed_at: new Date().toISOString(),
    operational_status: operational,
    lifecycle_status: lifecycle,
    last_maintenance_at: new Date().toISOString(),
  }, [], 'revision');
  syncTowerFromAsset(a.id);
  audit(req.user, 'ASSESS', 'asset', a.id, { condition_rating: rating });
  const updated = enrichAsset(get('asset', a.id, ['metadata']));
  res.json(updated);
});

// Maintenance events
router.get('/maintenance-events', (req, res) => {
  const { asset_id } = req.query;
  let rows = list('asset_maintenance_event');
  if (asset_id) rows = rows.filter((e) => e.asset_id === Number(asset_id));
  const scope = commandScope(req.user);
  if (!scope.global) rows = rows.filter((e) => scope.assetIds.has(e.asset_id));
  for (const e of rows) {
    e.asset = get('asset', e.asset_id);
    e.crew = e.crew_id ? get('crew', e.crew_id) : null;
    if (e.measured_values) {
      try { e.measured_values = JSON.parse(e.measured_values); } catch (_) { /* ignore */ }
    }
  }
  res.json(rows);
});

router.post('/maintenance-events', (req, res) => {
  if (!can(req, 'task:execute') && !can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden' });
  const a = get('asset', req.body.asset_id);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  try {
    const body = { ...req.body };
    if (body.measured_values && typeof body.measured_values === 'object') body.measured_values = JSON.stringify(body.measured_values);
    if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
      const n = Number(body.cost);
      body.cost = Number.isFinite(n) && n >= 0 ? n : null;
    } else if (body.cost === '') {
      body.cost = null;
    }
    const id = insertRow('asset_maintenance_event', body);
    if (body.condition_after) {
      const asset = get('asset', body.asset_id);
      if (asset) updateRow('asset', asset.id, { condition_rating: body.condition_after, last_maintenance_at: body.performed_at || new Date().toISOString() });
    }
    audit(req.user, 'CREATE', 'maintenance_event', id, body);
    res.status(201).json(get('asset_maintenance_event', id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

function isoOr(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseFactors(value) {
  try {
    const f = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(f) ? f : [];
  } catch (_) { return []; }
}

function loadPerformance(asset) {
  const readings = db.prepare('SELECT * FROM asset_reading WHERE asset_id = ? ORDER BY recorded_at DESC').all(asset.id);
  const events = db.prepare('SELECT * FROM asset_performance_event WHERE asset_id = ? ORDER BY occurred_at DESC').all(asset.id);
  const snapshots = db.prepare('SELECT * FROM asset_health_snapshot WHERE asset_id = ? ORDER BY captured_at DESC, id DESC LIMIT 30').all(asset.id)
    .map((s) => ({ ...s, factors: parseFactors(s.factors_json) }));
  return { readings, events, snapshots };
}

function writeSnapshot(asset, computed, source, userId, extra = {}) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO asset_health_snapshot
       (asset_id, captured_at, condition_rating, suggested_rating, health_index, remaining_useful_life_years, recommendation, source, reasons, base_rating, performance_delta, degradation_rate, factors_json, model_version, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    asset.id, now,
    extra.condition_rating != null ? extra.condition_rating : asset.condition_rating,
    computed.combined_rating != null ? computed.combined_rating : computed.suggested_rating,
    computed.health_index, computed.rul_years != null ? computed.rul_years : computed.remaining_useful_life_years,
    computed.recommendation, source, JSON.stringify(extra.reasons || computed.reasons || []),
    computed.base_rating, computed.performance_delta, computed.degradation_rate,
    JSON.stringify(computed.factors || []), computed.model_version || MODEL_VERSION, userId || null
  );
  return get('asset_health_snapshot', Number(info.lastInsertRowid));
}

function simulateInputs(asset, readings, events, body, now) {
  const clone = { ...asset };
  const rs = readings.slice();
  const es = events.slice();
  const at = new Date(now).toISOString();
  if (body.age_years != null && Number.isFinite(Number(body.age_years))) {
    clone.installation_date = new Date(now - Number(body.age_years) * 365.25 * 864e5).toISOString();
  }
  if (body.months_since_maintenance != null && Number.isFinite(Number(body.months_since_maintenance))) {
    clone.last_maintenance_at = new Date(now - Number(body.months_since_maintenance) * 30.44 * 864e5).toISOString();
  }
  if (body.load_pct != null && Number.isFinite(Number(body.load_pct))) rs.push({ reading_type: 'LOAD_PCT', value_num: Number(body.load_pct), recorded_at: at });
  if (body.ambient_c != null && Number.isFinite(Number(body.ambient_c))) rs.push({ reading_type: 'AMBIENT_C', value_num: Number(body.ambient_c), recorded_at: at });
  if (body.thermal_c != null && Number.isFinite(Number(body.thermal_c))) rs.push({ reading_type: 'TOP_OIL_C', value_num: Number(body.thermal_c), recorded_at: at });
  const faults = Math.max(0, Math.min(20, Number(body.through_faults) || 0));
  for (let i = 0; i < faults; i++) es.push({ event_type: 'THROUGH_FAULT', severity: 'HIGH', occurred_at: at });
  const trips = Math.max(0, Math.min(20, Number(body.trips) || 0));
  for (let i = 0; i < trips; i++) es.push({ event_type: 'TRIP', severity: 'HIGH', occurred_at: at });
  if (body.environment) es.push({ event_type: 'CORROSION_SEVERE', severity: 'MEDIUM', occurred_at: at });
  return { asset: clone, readings: rs, events: es };
}

router.get('/assets/:id/performance', (req, res) => {
  if (!can(req, 'asset:read')) return res.status(403).json({ error: 'Forbidden: requires asset:read' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const data = loadPerformance(a);
  const computed = evaluatePerformance(a, data.readings, data.events);
  res.json({
    asset_id: a.id,
    asset_code: a.asset_id,
    vocab: { reading_types: READING_TYPES, event_types: EVENT_TYPES, severities: EVENT_SEVERITIES },
    readings: data.readings,
    events: data.events,
    snapshots: data.snapshots,
    computed,
  });
});

router.post('/assets/:id/readings', (req, res) => {
  if (!can(req, 'asset:evaluate')) return res.status(403).json({ error: 'Forbidden: requires asset:evaluate' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const type = String(req.body.reading_type || '').toUpperCase();
  if (!READING_TYPES.includes(type)) return res.status(400).json({ error: `reading_type must be one of: ${READING_TYPES.join(', ')}` });
  const value = Number(req.body.value_num);
  if (!Number.isFinite(value)) return res.status(400).json({ error: 'value_num must be numeric' });
  const recorded_at = isoOr(req.body.recorded_at) || new Date().toISOString();
  const ref = req.body.client_ref ? String(req.body.client_ref) : null;
  const existing = byClientRef('asset_reading', ref);
  if (existing) return res.status(200).json(existing);
  const id = insertRow('asset_reading', {
    asset_id: a.id,
    reading_type: type,
    value_num: value,
    unit: req.body.unit || null,
    recorded_at,
    source: req.body.source || 'MANUAL',
    recorded_by: req.user.person_id || null,
    task_id: req.body.task_id || null,
    client_ref: ref,
    notes: req.body.notes || null,
  });
  audit(req.user, 'CREATE', 'asset_reading', id, { asset_id: a.id, reading_type: type, value_num: value });
  res.status(201).json(get('asset_reading', id));
});

router.post('/assets/:id/performance-events', (req, res) => {
  if (!can(req, 'asset:evaluate')) return res.status(403).json({ error: 'Forbidden: requires asset:evaluate' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const type = String(req.body.event_type || '').toUpperCase();
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` });
  const severity = String(req.body.severity || 'MEDIUM').toUpperCase();
  if (!EVENT_SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of: ${EVENT_SEVERITIES.join(', ')}` });
  const occurred_at = isoOr(req.body.occurred_at) || new Date().toISOString();
  const ref = req.body.client_ref ? String(req.body.client_ref) : null;
  const existing = byClientRef('asset_performance_event', ref);
  if (existing) return res.status(200).json(existing);
  const id = insertRow('asset_performance_event', {
    asset_id: a.id,
    event_type: type,
    severity,
    occurred_at,
    magnitude: numOrNull(req.body.magnitude),
    duration_min: numOrNull(req.body.duration_min),
    source: req.body.source || 'MANUAL',
    recorded_by: req.user.person_id || null,
    task_id: req.body.task_id || null,
    client_ref: ref,
    notes: req.body.notes || null,
  });
  audit(req.user, 'CREATE', 'asset_performance_event', id, { asset_id: a.id, event_type: type, severity });
  res.status(201).json(get('asset_performance_event', id));
});

router.post('/assets/:id/performance/simulate', (req, res) => {
  if (!can(req, 'asset:evaluate')) return res.status(403).json({ error: 'Forbidden: requires asset:evaluate' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const data = loadPerformance(a);
  const now = Date.now();
  const { asset, readings, events } = simulateInputs(a, data.readings, data.events, req.body || {}, now);
  const current = evaluatePerformance(a, data.readings, data.events, { now });
  const computed = evaluatePerformance(asset, readings, events, { now });
  res.json({ computed, current, delta_vs_current: Math.round((computed.combined_rating - current.combined_rating) * 10) / 10 });
});

router.post('/assets/:id/performance/snapshots', (req, res) => {
  if (!can(req, 'asset:evaluate')) return res.status(403).json({ error: 'Forbidden: requires asset:evaluate' });
  const a = get('asset', Number(req.params.id), ['metadata']);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  if (!scopeAllowsAsset(commandScope(req.user), a.id)) return res.status(403).json({ error: 'Forbidden: asset is outside your command scope' });
  const source = ['AUTO', 'WHATIF', 'EVALUATION'].includes(String(req.body.source || '').toUpperCase())
    ? String(req.body.source).toUpperCase()
    : 'AUTO';
  const data = loadPerformance(a);
  const computed = evaluatePerformance(a, data.readings, data.events);
  const snap = writeSnapshot(a, computed, source, req.user.person_id);
  audit(req.user, 'SNAPSHOT', 'asset_health_snapshot', snap.id, { asset_id: a.id, source });
  res.status(201).json(snap);
});

router.post('/assets/performance/import', (req, res) => {
  if (!can(req, 'asset:evaluate')) return res.status(403).json({ error: 'Forbidden: requires asset:evaluate' });
  const csv = req.body.csv || req.body.data || '';
  const dry = req.body.dry_run === true || req.body.dry_run === 'true';
  const rows = parseCsv(csv);
  const scope = commandScope(req.user);
  const results = [];
  let created = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const line = i + 2;
    const code = row.asset_code || row.asset_id;
    const kind = String(row.kind || 'READING').toUpperCase();
    const type = String(row.type || '').toUpperCase();
    const asset = code ? db.prepare('SELECT * FROM asset WHERE asset_id = ?').get(code) : null;
    if (!asset) { results.push({ line, status: 'error', reason: `unknown asset: ${code || '(blank)'}` }); continue; }
    if (!scopeAllowsAsset(scope, asset.id)) { results.push({ line, status: 'error', reason: 'asset outside your command scope' }); continue; }
    const when = isoOr(row.occurred_at || row.recorded_at) || new Date().toISOString();
    if (kind === 'EVENT') {
      if (!EVENT_TYPES.includes(type)) { results.push({ line, status: 'error', reason: `unknown event_type: ${type || '(blank)'}` }); continue; }
      const severity = String(row.severity || 'MEDIUM').toUpperCase();
      if (!EVENT_SEVERITIES.includes(severity)) { results.push({ line, status: 'error', reason: `invalid severity: ${severity}` }); continue; }
      const ref = row.client_ref || `import:${code}:EVENT:${type}:${when}`;
      const existing = byClientRef('asset_performance_event', ref);
      if (existing) { results.push({ line, status: 'duplicate', id: existing.id }); continue; }
      if (!dry) {
        const id = insertRow('asset_performance_event', { asset_id: asset.id, event_type: type, severity, occurred_at: when, magnitude: numOrNull(row.magnitude), duration_min: numOrNull(row.duration_min), source: 'IMPORT', recorded_by: req.user.person_id || null, client_ref: ref, notes: row.notes || null });
        results.push({ line, status: 'created', id });
        created += 1;
      } else {
        results.push({ line, status: 'would_create' });
      }
      continue;
    }
    if (!READING_TYPES.includes(type)) { results.push({ line, status: 'error', reason: `unknown reading_type: ${type || '(blank)'}` }); continue; }
    const value = numOrNull(row.value != null ? row.value : row.value_num);
    if (value == null) { results.push({ line, status: 'error', reason: 'value must be numeric' }); continue; }
    const ref = row.client_ref || `import:${code}:READING:${type}:${when}`;
    const existing = byClientRef('asset_reading', ref);
    if (existing) { results.push({ line, status: 'duplicate', id: existing.id }); continue; }
    if (!dry) {
      const id = insertRow('asset_reading', { asset_id: asset.id, reading_type: type, value_num: value, unit: row.unit || null, recorded_at: when, source: 'IMPORT', recorded_by: req.user.person_id || null, client_ref: ref, notes: row.notes || null });
      results.push({ line, status: 'created', id });
      created += 1;
    } else {
      results.push({ line, status: 'would_create' });
    }
  }
  const errors = results.filter((r) => r.status === 'error').length;
  if (!dry) audit(req.user, 'IMPORT', 'asset_performance', null, { created, errors, total: rows.length });
  res.json({ dry_run: dry, total: rows.length, created, errors, results });
});

module.exports = router;
