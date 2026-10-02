const express = require('express');
const { db, list } = require('../util');
const { commandScope, regionBoundaryFor, pointInRegionBoundary, lineInRegionBoundary } = require('../authority');
const {
  VOLTAGE_BANDS,
  STATUS_COLOR,
  maxVoltageKv,
  voltageColor,
  entityColor,
} = require('../voltage');

const router = express.Router();

function condColor(rating) {
  if (rating <= 3) return '#ef4444';
  if (rating <= 5) return '#f97316';
  if (rating <= 7) return '#f59e0b';
  return '#22c55e';
}

// Lines only need their endpoints' identity on the map, not the full substation
// row (bays, boundaries, contact data), so keep the payload small.
function briefSub(s) {
  return s ? { id: s.id, substation_id: s.substation_id, name: s.name } : null;
}

router.get('/map/data', (req, res) => {
  const scope = commandScope(req.user);
  const allow = (set, id) => scope.global || (set && set.has(id));
  // The map is always geographically bound to the viewer's home region: crews,
  // department managers and functional (OT) managers alike only ever plot their
  // own region's ground, even when a cross-region task puts foreign assets in
  // their command scope. Global roles (admin) keep the whole country. A region
  // id alone is not enough — a feature must also fall inside the region polygon,
  // because imported data can assign a feature to a region it plots outside of.
  const homeRegion = !scope.global && req.user && req.user.region_id != null ? req.user.region_id : null;
  const homeBoundary = homeRegion != null ? regionBoundaryFor(homeRegion) : null;
  const inHome = (regionId) => homeRegion == null || regionId === homeRegion;
  const pointHome = (regionId, lat, lng) => inHome(regionId) && pointInRegionBoundary(homeBoundary, lat, lng);
  const lineHome = (regionId, routeJson, endpoints) => inHome(regionId) && lineInRegionBoundary(homeBoundary, routeJson, endpoints);

  // Load each table once and resolve references from in-memory maps. The
  // previous version re-listed region/substation/line/tower and issued a
  // `get('substation')` per line plus a `get('region')` per task, which made
  // the map endpoint scale badly once lines and towers were imported.
  const regionRows = list('region', ['boundary_json']);
  const regionById = new Map(regionRows.map((r) => [r.id, r]));
  const substationRows = list('substation', ['voltage_levels', 'boundary_json']);
  const substationById = new Map(substationRows.map((s) => [s.id, s]));
  const subCoord = (id) => { const s = substationById.get(id); return s ? [s.latitude, s.longitude] : null; };
  const lineRows = list('transmission_line', ['route_json']);
  const lineById = new Map(lineRows.map((l) => [l.id, l]));
  const towerRows = list('tower');
  const towerById = new Map(towerRows.map((t) => [t.id, t]));
  const assetRows = list('asset', ['metadata']);
  const assetById = new Map(assetRows.map((a) => [a.id, a]));

  const regions = regionRows.filter((r) => allow(scope.regionIds, r.id) && inHome(r.id)).map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    center: [r.center_lat, r.center_lng],
    boundary: r.boundary,
    boundary_json: r.boundary_json || null,
    status: r.status,
  }));

  const substations = substationRows.filter((s) => allow(scope.substationIds, s.id) && pointHome(s.region_id, s.latitude, s.longitude)).map((s) => {
    const voltageKv = maxVoltageKv(s.voltage_levels);
    return {
      id: s.id,
      name: s.name,
      substation_id: s.substation_id,
      region_id: s.region_id,
      region_name: (regionById.get(s.region_id) || {}).name || null,
      position: [s.latitude, s.longitude],
      voltage_levels: s.voltage_levels,
      voltage_kv: voltageKv,
      voltage_color: voltageColor(voltageKv),
      substation_type: s.substation_type,
      owner: s.owner || null,
      status: s.operational_status,
      status_color: STATUS_COLOR[s.operational_status] || '#6b7280',
      color: entityColor(voltageKv, s.operational_status),
      gps_validated: s.gps_validated,
      boundary_json: s.boundary_json || null,
      fence_radius_m: s.fence_radius_m || null,
    };
  });

  const completedLineIds = new Set();
  const completedTowerIds = new Set();
  for (const t of db.prepare("SELECT line_id, tower_id FROM task WHERE status = 'COMPLETED'").all()) {
    if (t.tower_id != null) completedTowerIds.add(Number(t.tower_id));
    else if (t.line_id != null) completedLineIds.add(t.line_id);
  }
  const towersByLine = new Map();
  for (const t of towerRows) {
    const arr = towersByLine.get(t.line_id);
    if (arr) arr.push(t.id);
    else towersByLine.set(t.line_id, [t.id]);
  }
  const lineInspection = (lineId) => {
    const ids = towersByLine.get(lineId) || [];
    const total = ids.length;
    const inspected = completedLineIds.has(lineId)
      ? total
      : ids.reduce((n, id) => n + (completedTowerIds.has(id) ? 1 : 0), 0);
    return { inspected_towers: inspected, total_towers: total, tower_progress: total ? inspected / total : 0 };
  };

  const lines = lineRows.filter((l) => allow(scope.lineIds, l.id) && lineHome(l.region_id, l.route_json, [subCoord(l.from_substation_id), subCoord(l.to_substation_id)])).map((l) => ({
    id: l.id,
    name: l.name,
    line_id: l.line_id,
    voltage_kv: l.voltage_kv,
    voltage_color: voltageColor(l.voltage_kv),
    route: l.route_json,
    from: briefSub(substationById.get(l.from_substation_id)),
    to: briefSub(substationById.get(l.to_substation_id)),
    from_name: (substationById.get(l.from_substation_id) || {}).name || null,
    to_name: (substationById.get(l.to_substation_id) || {}).name || null,
    length_km: l.length_km,
    conductor_type: l.conductor_type || null,
    circuit_count: l.circuit_count,
    status: l.operational_status,
    status_color: STATUS_COLOR[l.operational_status] || '#6b7280',
    color: entityColor(l.voltage_kv, l.operational_status),
    region_name: (regionById.get(l.region_id) || {}).name || null,
    region_id: l.region_id || null,
    gps_validated: l.gps_validated,
    inspection: lineInspection(l.id),
  }));

  const towers = towerRows.filter((t) => allow(scope.towerIds, t.id) && pointHome(lineById.get(t.line_id) ? lineById.get(t.line_id).region_id : null, t.latitude, t.longitude)).map((t) => {
    const line = lineById.get(t.line_id);
    const lineStatus = line ? line.operational_status : 'OPERATIONAL';
    const voltageKv = line ? line.voltage_kv : null;
    return {
      id: t.id,
      tower_id: t.tower_id,
      line_id: t.line_id,
      line_name: line ? line.name : null,
      voltage_kv: voltageKv,
      voltage_color: voltageColor(voltageKv),
      position: [t.latitude, t.longitude],
      tower_type: t.tower_type || null,
      tower_material: t.tower_material || null,
      km_marker: t.km_marker,
      height_m: t.height_m,
      status: lineStatus,
      status_color: STATUS_COLOR[lineStatus] || '#6b7280',
      color: entityColor(voltageKv, lineStatus),
      region_id: line ? line.region_id : null,
      gps_validated: t.gps_validated,
    };
  });

  const assets = assetRows.filter((a) => allow(scope.assetIds, a.id)).map((a) => {
    const line = a.line_id ? lineById.get(a.line_id) : null;
    const tower = a.tower_id ? towerById.get(a.tower_id) : null;
    const towerLine = tower && !line ? lineById.get(tower.line_id) : null;
    const sub = a.substation_id ? substationById.get(a.substation_id) : null;
    const parentLine = line || towerLine;
    const voltageKv = parentLine && parentLine.voltage_kv != null
      ? parentLine.voltage_kv
      : (sub ? maxVoltageKv(sub.voltage_levels) : null);
    let position = null;
    if (a.latitude !== null && a.latitude !== undefined) position = [a.latitude, a.longitude];
    else if (tower) position = [tower.latitude, tower.longitude];
    else if (sub) position = [sub.latitude + 0.004, sub.longitude];
    return {
      id: a.id,
      asset_id: a.asset_id,
      name: a.name,
      asset_type: a.asset_type,
      sub_type: a.sub_type || null,
      substation_id: a.substation_id,
      substation_name: sub ? sub.name : null,
      line_id: a.line_id,
      line_name: parentLine ? parentLine.name : null,
      tower_id: a.tower_id || null,
      tower_name: tower ? tower.tower_id : null,
      voltage_kv: voltageKv,
      voltage_color: voltageColor(voltageKv),
      condition: a.condition_rating,
      condition_color: condColor(a.condition_rating),
      criticality: a.criticality,
      status: a.operational_status,
      status_color: STATUS_COLOR[a.operational_status] || '#6b7280',
      lifecycle_status: a.lifecycle_status,
      color: entityColor(voltageKv, a.operational_status),
      region_id: parentLine ? parentLine.region_id : (sub ? sub.region_id : null),
      position,
      gps_validated: a.gps_validated,
    };
  }).filter((a) => a.position && pointHome(a.region_id, a.position[0], a.position[1]));

  const geofences = list('geofence', ['boundary_json'])
    .filter((g) => allow(scope.regionIds, g.region_id) && pointHome(g.region_id, g.center_lat, g.center_lng))
    .filter((g) => g.is_active === 1)
    .map((g) => ({
      id: g.id,
      name: g.name,
      target_type: g.target_type,
      target_id: g.target_id ?? null,
      center: [g.center_lat, g.center_lng],
      radius_m: g.radius_m,
      tolerance_m: g.tolerance_m,
      is_active: g.is_active,
      region_id: g.region_id,
      boundary: Array.isArray(g.boundary_json) ? g.boundary_json : null,
    }));

  const validationAlerts = db.prepare(
    "SELECT * FROM gps_validation WHERE result IN ('FAIL','OUT_OF_TOLERANCE') ORDER BY validated_at DESC LIMIT 50"
  ).all().filter((v) => allow(scope.validationIds, v.id) && pointHome(v.region_id, v.measured_lat != null ? v.measured_lat : v.expected_lat, v.measured_lng != null ? v.measured_lng : v.expected_lng));

  const openTasks = db.prepare(
    "SELECT * FROM task WHERE status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).all().filter((t) => scope.global || scope.taskIds.has(t.id)).map((t) => {
    let position = null;
    if (t.asset_id) {
      const a = assetById.get(t.asset_id);
      if (a && a.latitude !== null && a.latitude !== undefined) position = [a.latitude, a.longitude];
    }
    if (!position && t.substation_id) {
      const s = substationById.get(t.substation_id);
      if (s) position = [s.latitude, s.longitude];
    }
    return { ...t, position, region: regionById.get(t.region_id) || null };
  }).filter((t) => t.position && pointHome(t.region_id, t.position[0], t.position[1]));

  res.json({
    regions,
    substations,
    lines,
    towers,
    assets,
    geofences,
    validation_alerts: validationAlerts,
    open_tasks: openTasks,
    legend: { status: STATUS_COLOR, voltage: VOLTAGE_BANDS },
  });
});

module.exports = router;
