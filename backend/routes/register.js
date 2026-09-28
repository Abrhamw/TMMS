const express = require('express');
const { db, get } = require('../util');
const { commandScope } = require('../authority');

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

function regionPopulation(regionId, scope) {
  const scoped = !!scope && !scope.global;
  let substationIds = new Set(db.prepare('SELECT id FROM substation WHERE region_id = ?').all(regionId).map((r) => r.id));
  let lineIds = db.prepare('SELECT id FROM transmission_line WHERE region_id = ? ORDER BY name').all(regionId).map((r) => r.id);
  if (scoped) {
    substationIds = new Set([...substationIds].filter((id) => scope.substationIds.has(id)));
    lineIds = lineIds.filter((id) => scope.lineIds.has(id));
  }
  const lineIdSet = new Set(lineIds);
  const towerRows = db.prepare('SELECT * FROM tower ORDER BY km_marker, id').all().filter((t) => !scoped || scope.towerIds.has(t.id));
  const lineOfTower = new Map(towerRows.map((t) => [t.id, t.line_id]));
  const catalog = catalogMap();
  const assetsAll = db.prepare("SELECT * FROM asset WHERE lifecycle_status != 'REMOVED'").all().map((a) => ({ ...a, metadata: null }));
  const counted = [];
  const towerAssets = new Map();
  for (const a of assetsAll) {
    if (scoped && !scope.assetIds.has(a.id)) continue;
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

function loadTree(regionId, scope) {
  const scoped = !!scope && !scope.global;
  const region = get('region', regionId);
  const regionRow = { id: region.id, code: region.code, name: region.name, center_lat: region.center_lat, center_lng: region.center_lng };
  let lines = db.prepare('SELECT id FROM transmission_line WHERE region_id = ? ORDER BY name').all(regionId).map((r) => get('transmission_line', r.id, ['route_json']));
  let substations = db.prepare('SELECT id FROM substation WHERE region_id = ? ORDER BY name').all(regionId).map((r) => get('substation', r.id));
  if (scoped) {
    lines = lines.filter((l) => scope.lineIds.has(l.id));
    substations = substations.filter((s) => scope.substationIds.has(s.id));
  }
  const pop = regionPopulation(regionId, scope);

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

function computeRegionValuation(regionId, scope) {
  const pop = regionPopulation(regionId, scope);
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

function resolveRegionIds(scope, wanted) {
  if (wanted) return [wanted];
  return scope.global
    ? db.prepare('SELECT id FROM region ORDER BY code').all().map((r) => r.id)
    : [...scope.regionIds];
}

router.get('/register/tree', (req, res) => {
  const scope = commandScope(req.user);
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !scope.global && !scope.regionIds.has(wanted)) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = resolveRegionIds(scope, wanted);
  const regions = [];
  for (const rid of regionIds) regions.push(loadTree(rid, scope));
  res.json({ count: regions.length, regions });
});

router.get('/register/valuation', (req, res) => {
  const scope = commandScope(req.user);
  const wanted = req.query.region_id ? Number(req.query.region_id) : null;
  if (wanted && !scope.global && !scope.regionIds.has(wanted)) {
    return res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
  }
  const regionIds = resolveRegionIds(scope, wanted);
  const parts = regionIds.map((rid) => computeRegionValuation(rid, scope));
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
