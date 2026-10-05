const express = require('express');
const { db, parseRow, list, get, insertRow, updateRow, safeDelete, withTx } = require('../util');
const { can, isGlobal, audit } = require('../auth');
const { commandScope, regionBoundaryFor, pointInRegionBoundary, lineInRegionBoundary } = require('../authority');
const { polygonFromCenter, haversine } = require('../geo');
const { parseRouteGeometry, coordsToKm } = require('../geoimport');
const { COMPONENT_CATALOG } = require('../towerComponents');
const { seedStandardComponents } = require('../towerStandards');
const { countSubstationBays, substationBayCounts, syncSubstationBayCount, syncLineTowerCount, syncTowerMirror, towerCompliance, towerComplianceSummaryBatch } = require('../integrity');
const { spaceAlongRoute, distanceAlongRoute } = require('../lineGeometry');
const { inspectionForLine } = require('../lineInspection');
const { setLineRoute, batchTowers, bulkTowers, bulkResetComponents } = require('../lineWorkspace');

const router = express.Router();

// Rebuild a transmission line's route from its tower locations: tower
// positions ARE the route points (composite route), ordered by km marker.
function rebuildLineRoute(lineId) {
  const towers = db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(lineId);
  // With fewer than two towers a polyline cannot be formed. Clear any stale
  // route (route_json is NOT NULL, so use the canonical empty array) so a line
  // whose towers were deleted does not keep a phantom route.
  if (towers.length < 2) {
    db.prepare("UPDATE transmission_line SET route_json = '[]', length_km = 0, gps_validated = 0 WHERE id = ?").run(lineId);
    return;
  }
  const route = towers.map((t) => [t.latitude, t.longitude]);
  let length = 0;
  for (let i = 1; i < route.length; i++) {
    length += haversine(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]) / 1000;
  }
  db.prepare('UPDATE transmission_line SET route_json = ?, length_km = ?, gps_validated = ? WHERE id = ?').run(
    JSON.stringify(route), Math.round(length * 10) / 10, 1, lineId
  );
}

// A line's route is drawn from its from/to substations, so its first and last
// vertices are the substation GPS tie-in points — not tower locations. Tower
// generation must skip any route vertex that coincides with either substation,
// leaving the line's own endpoints (first/last tower) as the true line ends.
function lineTieInCoords(line) {
  const out = [];
  for (const id of [line.from_substation_id, line.to_substation_id]) {
    const s = id ? get('substation', id) : null;
    if (s && typeof s.latitude === 'number' && typeof s.longitude === 'number') out.push([s.latitude, s.longitude]);
  }
  return out;
}

function atTieIn(tieIns, lat, lng) {
  return tieIns.some(([tLat, tLng]) => Math.abs(tLat - lat) < 1e-6 && Math.abs(tLng - lng) < 1e-6);
}

function listComponents(towerId) {
  return db.prepare('SELECT * FROM tower_component WHERE tower_id = ? ORDER BY id').all(towerId);
}

// Standard minimum vegetation clearance for overhead conductors by voltage
// class (m), aligned with utility/NESC clearance practice.
function defaultVegClearance(kv) {
  const v = Number(kv) || 0;
  if (v <= 50) return 6.1;
  if (v < 250) return 7.6;
  if (v < 500) return 10.7;
  return 11.9;
}

// Force a scoped user's writes into their own region; reject mismatched regions.
function regionGuard(req, res, body) {
  if (isGlobal(req.user)) return true;
  const rid = body.region_id !== undefined && body.region_id !== null ? Number(body.region_id) : req.user.region_id;
  if (body.region_id !== undefined && body.region_id !== null && rid !== req.user.region_id) {
    res.status(403).json({ error: 'Forbidden: region is outside your scope' });
    return false;
  }
  body.region_id = req.user.region_id;
  return true;
}

// Chain-of-command helpers: infrastructure outside a manager's scope (and
// outside their region) is invisible, while global roles keep the open view.
function infraSet(scope, kind) {
  return { region: scope.regionIds, substation: scope.substationIds, line: scope.lineIds, tower: scope.towerIds, asset: scope.assetIds }[kind];
}

function scopeAllowsInfra(req, kind, id) {
  const scope = commandScope(req.user);
  if (scope.global) return true;
  const set = infraSet(scope, kind);
  return !!set && set.has(Number(id));
}

function checkInfra(req, res, kind, id) {
  if (!scopeAllowsInfra(req, kind, id)) {
    res.status(403).json({ error: 'Forbidden: resource is outside your command scope' });
    return false;
  }
  return true;
}

function scopeList(req, kind, rows) {
  const scope = commandScope(req.user);
  if (scope.global) return rows;
  const set = infraSet(scope, kind);
  if (!set) return [];
  let filtered = rows.filter((r) => set.has(r.id));
  // Substations and lines are also clipped to the viewer's home-region polygon:
  // an administrative region_id can disagree with where a feature actually plots,
  // so a region-bound list must mirror what the map draws.
  const homeRegion = req.user && req.user.region_id != null ? req.user.region_id : null;
  if (homeRegion != null && (kind === 'substation' || kind === 'line')) {
    const boundary = regionBoundaryFor(homeRegion);
    if (boundary) {
      if (kind === 'substation') {
        filtered = filtered.filter((r) => r.region_id === homeRegion && pointInRegionBoundary(boundary, r.latitude, r.longitude));
      } else {
        const coords = new Map(list('substation').map((s) => [s.id, [s.latitude, s.longitude]]));
        filtered = filtered.filter((r) => r.region_id === homeRegion && lineInRegionBoundary(boundary, r.route_json, [coords.get(r.from_substation_id), coords.get(r.to_substation_id)]));
      }
    }
  }
  return filtered;
}

function regionAssetCount(regionId) {
  return db.prepare(
    `SELECT COUNT(DISTINCT a.id) c FROM asset a
     LEFT JOIN substation s ON a.substation_id = s.id
     LEFT JOIN transmission_line l ON a.line_id = l.id
     LEFT JOIN tower t ON a.tower_id = t.id
     LEFT JOIN transmission_line tl ON t.line_id = tl.id
     WHERE s.region_id = ? OR l.region_id = ? OR tl.region_id = ?`
  ).get(regionId, regionId, regionId).c;
}

function regionSummary(region, scope) {
  if (scope && !scope.global) {
    const inRegion = (ids, regionOf) => { let n = 0; for (const id of ids) if (regionOf(id) === region.id) n++; return n; };
    const subRegion = new Map(list('substation').map((s) => [s.id, s.region_id]));
    const lineRegion = new Map(list('transmission_line').map((l) => [l.id, l.region_id]));
    const towerLine = new Map(list('tower').map((t) => [t.id, t.line_id]));
    const crewRegion = new Map(list('crew').map((c) => [c.id, c.region_id]));
    const assetById = new Map(list('asset').map((a) => [a.id, a]));
    const assetRegionOf = (id) => {
      const a = assetById.get(id);
      if (!a) return null;
      if (a.substation_id && subRegion.has(a.substation_id)) return subRegion.get(a.substation_id);
      if (a.line_id && lineRegion.has(a.line_id)) return lineRegion.get(a.line_id);
      if (a.tower_id && towerLine.has(a.tower_id)) return lineRegion.get(towerLine.get(a.tower_id));
      return null;
    };
    const taskById = new Map(list('task').map((t) => [t.id, t]));
    return {
      ...region,
      substation_count: inRegion(scope.substationIds, (id) => subRegion.get(id)),
      line_count: inRegion(scope.lineIds, (id) => lineRegion.get(id)),
      crew_count: inRegion(scope.crewIds, (id) => crewRegion.get(id)),
      asset_count: inRegion(scope.assetIds, assetRegionOf),
      open_task_count: [...scope.taskIds].filter((id) => {
        const t = taskById.get(id);
        return t && t.region_id === region.id && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status);
      }).length,
    };
  }
  const substations = db.prepare('SELECT COUNT(*) c FROM substation WHERE region_id = ?').get(region.id).c;
  const lines = db.prepare('SELECT COUNT(*) c FROM transmission_line WHERE region_id = ?').get(region.id).c;
  const crews = db.prepare('SELECT COUNT(*) c FROM crew WHERE region_id = ?').get(region.id).c;
  const assets = regionAssetCount(region.id);
  const openTasks = db.prepare(
    "SELECT COUNT(*) c FROM task WHERE region_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).get(region.id).c;
  return { ...region, substation_count: substations, line_count: lines, crew_count: crews, asset_count: assets, open_task_count: openTasks };
}

// Batched region summaries: grouped SQL counts for the global view, and one
// in-memory pass for region-scoped viewers (who can only see their own slice).
function regionSummaries(regions, scope) {
  const group = (sql) => {
    const m = new Map();
    for (const r of db.prepare(sql).all()) m.set(r.region_id, r.c);
    return m;
  };
  const subs = group('SELECT region_id, COUNT(*) c FROM substation GROUP BY region_id');
  const lines = group('SELECT region_id, COUNT(*) c FROM transmission_line GROUP BY region_id');
  const crews = group('SELECT region_id, COUNT(*) c FROM crew GROUP BY region_id');
  const open = group("SELECT region_id, COUNT(*) c FROM task WHERE status NOT IN ('COMPLETED','CANCELLED','FAILED') GROUP BY region_id");

  if (scope && !scope.global) {
    const subRegion = new Map();
    for (const s of list('substation')) subRegion.set(s.id, s.region_id);
    const lineRegion = new Map();
    for (const l of list('transmission_line')) lineRegion.set(l.id, l.region_id);
    const towerLine = new Map();
    for (const t of list('tower')) towerLine.set(t.id, t.line_id);
    const crewRegion = new Map(list('crew').map((c) => [c.id, c.region_id]));
    const taskById = new Map(list('task').map((t) => [t.id, t]));
    const countIn = (ids, regionOf) => {
      const m = new Map();
      for (const id of ids) { const r = regionOf(id); if (r != null) m.set(r, (m.get(r) || 0) + 1); }
      return m;
    };
    const scopedSubs = countIn(scope.substationIds, (id) => subRegion.get(id));
    const scopedLines = countIn(scope.lineIds, (id) => lineRegion.get(id));
    const scopedCrews = countIn(scope.crewIds, (id) => crewRegion.get(id));
    const assetById = new Map(list('asset').map((a) => [a.id, a]));
    const assetRegionOf = (id) => {
      const a = assetById.get(id);
      if (!a) return null;
      if (a.substation_id && subRegion.has(a.substation_id)) return subRegion.get(a.substation_id);
      if (a.line_id && lineRegion.has(a.line_id)) return lineRegion.get(a.line_id);
      if (a.tower_id && towerLine.has(a.tower_id)) return lineRegion.get(towerLine.get(a.tower_id));
      return null;
    };
    const scopedAssets = countIn(scope.assetIds, assetRegionOf);
    const scopedOpen = new Map();
    for (const id of scope.taskIds) {
      const t = taskById.get(id);
      if (t && t.region_id != null && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status)) {
        scopedOpen.set(t.region_id, (scopedOpen.get(t.region_id) || 0) + 1);
      }
    }
    return regions.map((r) => ({
      ...r,
      substation_count: scopedSubs.get(r.id) || 0,
      line_count: scopedLines.get(r.id) || 0,
      crew_count: scopedCrews.get(r.id) || 0,
      asset_count: scopedAssets.get(r.id) || 0,
      open_task_count: scopedOpen.get(r.id) || 0,
    }));
  }
  // Global asset counts straight from SQL: an asset is counted in every region
  // reachable through its substation/line/tower parent, matching regionAssetCount.
  const assetCounts = new Map();
  const assetRows = db.prepare(
    `SELECT rid, COUNT(DISTINCT aid) c FROM (
       SELECT a.id AS aid, s.region_id AS rid FROM asset a JOIN substation s ON a.substation_id = s.id
       UNION ALL
       SELECT a.id AS aid, l.region_id AS rid FROM asset a JOIN transmission_line l ON a.line_id = l.id
       UNION ALL
       SELECT a.id AS aid, tl.region_id AS rid FROM asset a JOIN tower t ON a.tower_id = t.id JOIN transmission_line tl ON t.line_id = tl.id
     ) WHERE rid IS NOT NULL GROUP BY rid`
  ).all();
  for (const r of assetRows) assetCounts.set(r.rid, r.c);
  return regions.map((r) => ({
    ...r,
    substation_count: subs.get(r.id) || 0,
    line_count: lines.get(r.id) || 0,
    crew_count: crews.get(r.id) || 0,
    asset_count: assetCounts.get(r.id) || 0,
    open_task_count: open.get(r.id) || 0,
  }));
}

// FK-safe deletion of a line-scoped subtree: executions, tasks and their
// children, schedules, assets, towers and lines. Shared by the region,
// substation and line cascades. `scheduleIds` lets a caller add schedules
// discovered through other parents (e.g. region/substation/crew).
function purgeSubtree({ lidList = [], towerIds = [], aList = [], tList = [], scheduleIds = [] }) {
  const execIds = new Set();
  const collectExec = (sql, args) => { for (const e of db.prepare(sql).all(...args)) execIds.add(e.id); };
  if (tList.length) collectExec(`SELECT id FROM checklist_execution WHERE task_id IN (${inClause(tList)})`, tList);
  if (aList.length) collectExec(`SELECT id FROM checklist_execution WHERE asset_id IN (${inClause(aList)})`, aList);
  if (towerIds.length) collectExec(`SELECT id FROM checklist_execution WHERE tower_id IN (${inClause(towerIds)})`, towerIds);
  const eList = [...execIds];
  if (eList.length) {
    const ph = inClause(eList);
    db.prepare(`DELETE FROM checklist_execution_item WHERE execution_id IN (${ph})`).run(...eList);
    db.prepare(`DELETE FROM task_finding WHERE execution_id IN (${ph})`).run(...eList);
    db.prepare(`DELETE FROM attachment WHERE execution_id IN (${ph})`).run(...eList);
    db.prepare(`DELETE FROM checklist_execution WHERE id IN (${ph})`).run(...eList);
  }
  if (tList.length) {
    const ph = inClause(tList);
    db.prepare(`DELETE FROM task_finding WHERE task_id IN (${ph})`).run(...tList);
    db.prepare(`DELETE FROM attachment WHERE task_id IN (${ph})`).run(...tList);
    db.prepare(`DELETE FROM task_work_item WHERE task_id IN (${ph})`).run(...tList);
    db.prepare(`DELETE FROM task_link WHERE task_id IN (${ph}) OR linked_task_id IN (${ph})`).run(...tList, ...tList);
    db.prepare(`DELETE FROM asset_maintenance_event WHERE task_id IN (${ph})`).run(...tList);
    db.prepare(`DELETE FROM gps_validation WHERE linked_task_id IN (${ph})`).run(...tList);
    db.prepare(`DELETE FROM task WHERE id IN (${ph})`).run(...tList);
  }
  if (aList.length) {
    const ph = inClause(aList);
    db.prepare(`DELETE FROM asset_maintenance_event WHERE asset_id IN (${ph})`).run(...aList);
  }

  const schedIds = new Set(scheduleIds);
  const collectSched = (sql, args) => { for (const s of db.prepare(sql).all(...args)) schedIds.add(s.id); };
  if (lidList.length) collectSched(`SELECT id FROM maintenance_schedule WHERE line_id IN (${inClause(lidList)})`, lidList);
  if (aList.length) collectSched(`SELECT id FROM maintenance_schedule WHERE asset_id IN (${inClause(aList)})`, aList);
  if (towerIds.length) collectSched(`SELECT id FROM maintenance_schedule WHERE tower_id IN (${inClause(towerIds)})`, towerIds);
  const sList = [...schedIds];
  if (sList.length) db.prepare(`DELETE FROM maintenance_schedule WHERE id IN (${inClause(sList)})`).run(...sList);

  if (aList.length) {
    const ph = inClause(aList);
    db.prepare(`UPDATE asset SET parent_asset_id = NULL WHERE parent_asset_id IN (${ph}) OR id IN (${ph})`).run(...aList, ...aList);
    db.prepare(`DELETE FROM asset WHERE id IN (${ph})`).run(...aList);
  }
  for (const tid of towerIds) {
    db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(tid);
    db.prepare('DELETE FROM tower WHERE id = ?').run(tid);
  }
  for (const lid of lidList) db.prepare('DELETE FROM transmission_line WHERE id = ?').run(lid);
}

function cascadeDeleteRegion(id) {
  const subIds = idsOf(db.prepare('SELECT id FROM substation WHERE region_id = ?').all(id));
  const lineIds = new Set(idsOf(db.prepare('SELECT id FROM transmission_line WHERE region_id = ?').all(id)));
  if (subIds.length) {
    const ph = inClause(subIds);
    for (const l of db.prepare(`SELECT id FROM transmission_line WHERE from_substation_id IN (${ph}) OR to_substation_id IN (${ph})`).all(...subIds, ...subIds)) lineIds.add(l.id);
  }
  const lidList = [...lineIds];
  const towerIds = lidList.length ? idsOf(db.prepare(`SELECT id FROM tower WHERE line_id IN (${inClause(lidList)})`).all(...lidList)) : [];
  const assetIds = new Set();
  if (subIds.length) for (const a of db.prepare(`SELECT id FROM asset WHERE substation_id IN (${inClause(subIds)})`).all(...subIds)) assetIds.add(a.id);
  if (lidList.length) for (const a of db.prepare(`SELECT id FROM asset WHERE line_id IN (${inClause(lidList)})`).all(...lidList)) assetIds.add(a.id);
  if (towerIds.length) for (const a of db.prepare(`SELECT id FROM asset WHERE tower_id IN (${inClause(towerIds)})`).all(...towerIds)) assetIds.add(a.id);
  const aList = [...assetIds];
  const taskIds = new Set(idsOf(db.prepare('SELECT id FROM task WHERE region_id = ?').all(id)));
  if (subIds.length) for (const t of db.prepare(`SELECT id FROM task WHERE substation_id IN (${inClause(subIds)})`).all(...subIds)) taskIds.add(t.id);
  if (lidList.length) for (const t of db.prepare(`SELECT id FROM task WHERE line_id IN (${inClause(lidList)})`).all(...lidList)) taskIds.add(t.id);
  if (towerIds.length) for (const t of db.prepare(`SELECT id FROM task WHERE tower_id IN (${inClause(towerIds)})`).all(...towerIds)) taskIds.add(t.id);
  if (aList.length) for (const t of db.prepare(`SELECT id FROM task WHERE asset_id IN (${inClause(aList)})`).all(...aList)) taskIds.add(t.id);
  const tList = [...taskIds];
  const crewIds = idsOf(db.prepare('SELECT id FROM crew WHERE region_id = ?').all(id));

  const scheduleIds = idsOf(db.prepare('SELECT id FROM maintenance_schedule WHERE region_id = ?').all(id));
  const collectSched = (sql, args) => { for (const s of db.prepare(sql).all(...args)) scheduleIds.push(s.id); };
  if (subIds.length) collectSched(`SELECT id FROM maintenance_schedule WHERE substation_id IN (${inClause(subIds)})`, subIds);
  if (lidList.length) collectSched(`SELECT id FROM maintenance_schedule WHERE line_id IN (${inClause(lidList)})`, lidList);
  if (aList.length) collectSched(`SELECT id FROM maintenance_schedule WHERE asset_id IN (${inClause(aList)})`, aList);
  if (towerIds.length) collectSched(`SELECT id FROM maintenance_schedule WHERE tower_id IN (${inClause(towerIds)})`, towerIds);
  if (crewIds.length) collectSched(`SELECT id FROM maintenance_schedule WHERE responsible_crew_id IN (${inClause(crewIds)})`, crewIds);

  purgeSubtree({ lidList, towerIds, aList, tList, scheduleIds });

  db.prepare('DELETE FROM geofence WHERE region_id = ?').run(id);
  db.prepare('DELETE FROM report WHERE scope_region_id = ?').run(id);
  db.prepare('UPDATE org_unit SET region_id = NULL WHERE region_id = ?').run(id);
  db.prepare('UPDATE user SET region_id = NULL WHERE region_id = ?').run(id);
  db.prepare('DELETE FROM gps_validation WHERE region_id = ?').run(id);

  if (crewIds.length) {
    const ph = inClause(crewIds);
    db.prepare(`UPDATE asset SET default_crew_id = NULL WHERE default_crew_id IN (${ph})`).run(...crewIds);
    db.prepare(`UPDATE checklist_execution SET crew_id = NULL WHERE crew_id IN (${ph})`).run(...crewIds);
    db.prepare(`UPDATE task SET crew_id = NULL WHERE crew_id IN (${ph})`).run(...crewIds);
    db.prepare(`UPDATE task_finding SET crew_id = NULL WHERE crew_id IN (${ph})`).run(...crewIds);
    db.prepare(`DELETE FROM crew_member WHERE crew_id IN (${ph})`).run(...crewIds);
    db.prepare(`DELETE FROM asset_maintenance_event WHERE crew_id IN (${ph})`).run(...crewIds);
    db.prepare(`DELETE FROM crew WHERE id IN (${ph})`).run(...crewIds);
  }
  for (const sid of subIds) db.prepare('DELETE FROM substation WHERE id = ?').run(sid);
  db.prepare('DELETE FROM region_personnel WHERE region_id = ?').run(id);
}

const idsOf = (rows) => rows.map((r) => r.id);
const inClause = (n) => n.map(() => '?').join(',');

function lineTree(lineId) {
  const lidList = [lineId];
  const towerIds = idsOf(db.prepare('SELECT id FROM tower WHERE line_id = ?').all(lineId));
  const assetIds = new Set(idsOf(db.prepare('SELECT id FROM asset WHERE line_id = ?').all(lineId)));
  if (towerIds.length) for (const a of db.prepare(`SELECT id FROM asset WHERE tower_id IN (${inClause(towerIds)})`).all(...towerIds)) assetIds.add(a.id);
  const aList = [...assetIds];
  const taskIds = new Set(idsOf(db.prepare('SELECT id FROM task WHERE line_id = ?').all(lineId)));
  if (aList.length) for (const t of db.prepare(`SELECT id FROM task WHERE asset_id IN (${inClause(aList)})`).all(...aList)) taskIds.add(t.id);
  if (towerIds.length) for (const t of db.prepare(`SELECT id FROM task WHERE tower_id IN (${inClause(towerIds)})`).all(...towerIds)) taskIds.add(t.id);
  return { lidList, towerIds, aList, tList: [...taskIds] };
}

function substationTree(id) {
  const lineIds = new Set(idsOf(db.prepare('SELECT id FROM transmission_line WHERE from_substation_id = ? OR to_substation_id = ?').all(id, id)));
  const lidList = [...lineIds];
  const towerIds = lidList.length ? idsOf(db.prepare(`SELECT id FROM tower WHERE line_id IN (${inClause(lidList)})`).all(...lidList)) : [];
  const assetIds = new Set(idsOf(db.prepare('SELECT id FROM asset WHERE substation_id = ?').all(id)));
  if (lidList.length) for (const a of db.prepare(`SELECT id FROM asset WHERE line_id IN (${inClause(lidList)})`).all(...lidList)) assetIds.add(a.id);
  if (towerIds.length) for (const a of db.prepare(`SELECT id FROM asset WHERE tower_id IN (${inClause(towerIds)})`).all(...towerIds)) assetIds.add(a.id);
  const aList = [...assetIds];
  const taskIds = new Set(idsOf(db.prepare('SELECT id FROM task WHERE substation_id = ?').all(id)));
  if (lidList.length) for (const t of db.prepare(`SELECT id FROM task WHERE line_id IN (${inClause(lidList)})`).all(...lidList)) taskIds.add(t.id);
  if (aList.length) for (const t of db.prepare(`SELECT id FROM task WHERE asset_id IN (${inClause(aList)})`).all(...aList)) taskIds.add(t.id);
  if (towerIds.length) for (const t of db.prepare(`SELECT id FROM task WHERE tower_id IN (${inClause(towerIds)})`).all(...towerIds)) taskIds.add(t.id);
  return { lidList, towerIds, aList, tList: [...taskIds] };
}

function deleteSubtree(tree) {
  purgeSubtree(tree);
}

function cascadeDeleteSubstation(id) {
  const tree = substationTree(id);
  deleteSubtree(tree);
  db.prepare('DELETE FROM maintenance_schedule WHERE substation_id = ?').run(id);
  db.prepare('DELETE FROM gps_validation WHERE target_type = ? AND target_id = ?').run('SUBSTATION', id);
  db.prepare('DELETE FROM substation WHERE id = ?').run(id);
}

function cascadeDeleteLine(id) {
  const tree = lineTree(id);
  deleteSubtree(tree);
  db.prepare('DELETE FROM gps_validation WHERE target_type = ? AND target_id = ?').run('LINE', id);
}

// ---------------- Regions ----------------
router.get('/regions', (req, res) => {
  const rows = scopeList(req, 'region', list('region', ['boundary_json']));
  res.json(regionSummaries(rows, commandScope(req.user)));
});

router.get('/regions/:id', (req, res) => {
  const r = get('region', Number(req.params.id), ['boundary_json']);
  if (!r) return res.status(404).json({ error: 'Region not found' });
  if (!checkInfra(req, res, 'region', r.id)) return;
  r.personnel = list('region_personnel').filter((p) => p.region_id === r.id);
  res.json(regionSummary(r, commandScope(req.user)));
});

router.post('/regions', (req, res) => {
  if (!can(req, 'region:write')) return res.status(403).json({ error: 'Forbidden: requires region:write' });
  try {
    const body = { ...req.body, revision: 1 };
    if (body.boundary_json && typeof body.boundary_json === 'object') body.boundary_json = JSON.stringify(body.boundary_json);
    if (!body.boundary_json && body.center_lat !== null && body.center_lat !== undefined) {
      body.boundary_json = JSON.stringify(polygonFromCenter(Number(body.center_lat), Number(body.center_lng), Number(body.boundary || 1.5) * 111320, 14));
    }
    const id = insertRow('region', body);
    audit(req.user, 'CREATE', 'region', id, req.body);
    res.status(201).json(get('region', id, ['boundary_json']));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/regions/:id', (req, res) => {
  if (!can(req, 'region:write')) return res.status(403).json({ error: 'Forbidden: requires region:write' });
  const r = get('region', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Region not found' });
  if (!checkInfra(req, res, 'region', r.id)) return;
  const body = { ...req.body, revision: 1 };
  if (body.boundary_json && typeof body.boundary_json === 'object') body.boundary_json = JSON.stringify(body.boundary_json);
  if (!body.boundary_json && body.center_lat !== undefined && body.center_lng !== undefined) {
    body.boundary_json = JSON.stringify(polygonFromCenter(Number(body.center_lat), Number(body.center_lng), Number(body.boundary ?? r.boundary ?? 1.5) * 111320, 14));
  }
  updateRow('region', Number(req.params.id), body, [], 'revision');
  audit(req.user, 'UPDATE', 'region', Number(req.params.id), req.body);
  res.json(get('region', Number(req.params.id), ['boundary_json']));
});

router.delete('/regions/:id', (req, res) => {
  if (!can(req, 'region:write')) return res.status(403).json({ error: 'Forbidden: requires region:write' });
  const id = Number(req.params.id);
  const r = get('region', id);
  if (!r) return res.status(404).json({ error: 'Region not found' });
  if (!checkInfra(req, res, 'region', id)) return;
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;
  const refs = {
    'active substations': count('SELECT COUNT(*) c FROM substation WHERE region_id = ? AND operational_status != ?', id, 'DECOMMISSIONED'),
    substations: count('SELECT COUNT(*) c FROM substation WHERE region_id = ?', id),
    lines: count('SELECT COUNT(*) c FROM transmission_line WHERE region_id = ?', id),
    tasks: count('SELECT COUNT(*) c FROM task WHERE region_id = ?', id),
    crews: count('SELECT COUNT(*) c FROM crew WHERE region_id = ?', id),
    schedules: count('SELECT COUNT(*) c FROM maintenance_schedule WHERE region_id = ?', id),
    geofences: count('SELECT COUNT(*) c FROM geofence WHERE region_id = ?', id),
    reports: count('SELECT COUNT(*) c FROM report WHERE scope_region_id = ?', id),
    'org units': count('SELECT COUNT(*) c FROM org_unit WHERE region_id = ?', id),
    users: count('SELECT COUNT(*) c FROM user WHERE region_id = ?', id),
  };
  const present = Object.entries(refs).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}`);
  if (present.length > 0) {
    if (req.query.force !== '1') {
      return res.status(409).json({ error: `Cannot delete: ${present.join(', ')}` });
    }
  }
  withTx(() => {
    if (req.query.force === '1') {
      cascadeDeleteRegion(id);
    }
    safeDelete('region', id);
  });
  audit(req.user, 'DELETE', 'region', id, {});
  res.json({ ok: true });
});

// ---------------- Substations ----------------
router.get('/substations', (req, res) => {
  let rows = scopeList(req, 'substation', list('substation', ['voltage_levels', 'boundary_json']));
  const { region_id, q } = req.query;
  if (region_id) rows = rows.filter((r) => r.region_id === Number(region_id));
  if (q) rows = rows.filter((r) => (r.name + r.substation_id).toLowerCase().includes(q.toLowerCase()));
  const bays = substationBayCounts();
  res.json(rows.map((r) => ({ ...r, bay_count: bays.get(r.id) || 0 })));
});

router.get('/substations/:id', (req, res) => {
  const r = get('substation', Number(req.params.id), ['voltage_levels', 'boundary_json']);
  if (!r) return res.status(404).json({ error: 'Substation not found' });
  if (!checkInfra(req, res, 'substation', r.id)) return;
  const scope = commandScope(req.user);
  r.bay_count = countSubstationBays(r.id);
  r.region = get('region', r.region_id);
  r.assets = db.prepare('SELECT * FROM asset WHERE substation_id = ?').all(r.id)
    .filter((a) => scope.global || scope.assetIds.has(a.id));
  r.connected_lines = db.prepare(
    'SELECT * FROM transmission_line WHERE from_substation_id = ? OR to_substation_id = ?'
  ).all(r.id, r.id).map((l) => parseRow(l, ['route_json']))
    .filter((l) => scope.global || scope.lineIds.has(l.id));
  res.json(r);
});

router.post('/substations', (req, res) => {
  if (!can(req, 'substation:write')) return res.status(403).json({ error: 'Forbidden: requires substation:write' });
  if (!regionGuard(req, res, req.body)) return;
  try {
    const body = { ...req.body, voltage_levels: req.body.voltage_levels || '[]', revision: 1 };
    delete body.bay_count;
    if (body.boundary_json && typeof body.boundary_json === 'object') body.boundary_json = JSON.stringify(body.boundary_json);
    if (!body.boundary_json && body.latitude !== null && body.latitude !== undefined) {
      const radius = Number(body.fence_radius_m) || 220;
      body.fence_radius_m = radius;
      body.boundary_json = JSON.stringify(polygonFromCenter(Number(body.latitude), Number(body.longitude), radius, 10));
    }
    const id = insertRow('substation', body, ['voltage_levels']);
    syncSubstationBayCount(id);
    audit(req.user, 'CREATE', 'substation', id, req.body);
    res.status(201).json(get('substation', id, ['voltage_levels', 'boundary_json']));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/substations/:id', (req, res) => {
  if (!can(req, 'substation:write')) return res.status(403).json({ error: 'Forbidden: requires substation:write' });
  const r = get('substation', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Substation not found' });
  if (!checkInfra(req, res, 'substation', r.id)) return;
  const body = { ...req.body, revision: 1 };
  if (body.boundary_json && typeof body.boundary_json === 'object') body.boundary_json = JSON.stringify(body.boundary_json);
  if (!body.boundary_json && body.latitude !== undefined && body.longitude !== undefined) {
    const radius = Number(body.fence_radius_m) || Number(r.fence_radius_m) || 220;
    body.fence_radius_m = radius;
    body.boundary_json = JSON.stringify(polygonFromCenter(Number(body.latitude), Number(body.longitude), radius, 10));
  }
  delete body.bay_count;
  updateRow('substation', Number(req.params.id), body, ['voltage_levels'], 'revision');
  syncSubstationBayCount(Number(req.params.id));
  audit(req.user, 'UPDATE', 'substation', Number(req.params.id), req.body);
  res.json(get('substation', Number(req.params.id), ['voltage_levels', 'boundary_json']));
});

router.delete('/substations/:id', (req, res) => {
  if (!can(req, 'substation:write')) return res.status(403).json({ error: 'Forbidden: requires substation:write' });
  const id = Number(req.params.id);
  const r = get('substation', id);
  if (!r) return res.status(404).json({ error: 'Substation not found' });
  if (!checkInfra(req, res, 'substation', r.id)) return;
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;
  const refs = {
    'connected lines': count('SELECT COUNT(*) c FROM transmission_line WHERE from_substation_id = ? OR to_substation_id = ?', id, id),
    assets: count('SELECT COUNT(*) c FROM asset WHERE substation_id = ?', id),
    tasks: count('SELECT COUNT(*) c FROM task WHERE substation_id = ?', id),
    schedules: count('SELECT COUNT(*) c FROM maintenance_schedule WHERE substation_id = ?', id),
  };
  const present = Object.entries(refs).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}`);
  if (present.length > 0) {
    if (req.query.force !== '1') {
      return res.status(409).json({ error: `Cannot delete: ${present.join(', ')}` });
    }
  }
  withTx(() => {
    if (req.query.force === '1') cascadeDeleteSubstation(id);
    safeDelete('substation', id);
  });
  audit(req.user, 'DELETE', 'substation', id, {});
  res.json({ ok: true });
});

// ---------------- Transmission Lines ----------------
router.get('/lines', (req, res) => {
  let rows = scopeList(req, 'line', list('transmission_line', ['route_json']));
  const { region_id, q } = req.query;
  if (region_id) rows = rows.filter((r) => r.region_id === Number(region_id));
  if (q) rows = rows.filter((r) => (r.name + r.line_id).toLowerCase().includes(q.toLowerCase()));
  const substations = new Map(list('substation').map((s) => [s.id, s]));
  for (const l of rows) {
    l.from_substation = substations.get(l.from_substation_id) || null;
    l.to_substation = substations.get(l.to_substation_id) || null;
  }
  res.json(rows);
});

router.get('/lines/:id', (req, res) => {
  const r = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!r) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', r.id)) return;
  const scope = commandScope(req.user);
  r.from_substation = get('substation', r.from_substation_id);
  r.to_substation = get('substation', r.to_substation_id);
  r.region = get('region', r.region_id);
  r.towers = db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker').all(r.id);
  r.assets = db.prepare('SELECT * FROM asset WHERE line_id = ?').all(r.id);
  const lineTasks = db.prepare('SELECT id, task_number, title, status, result, due_date, crew_id FROM task WHERE line_id = ?').all(r.id);
  const towerIds = r.towers.map((t) => t.id);
  const assetIds = r.assets.map((a) => a.id);
  const related = new Map();
  for (const t of lineTasks) related.set(t.id, t);
  if (towerIds.length) {
    const ph = inClause(towerIds);
    for (const t of db.prepare(`SELECT id, task_number, title, status, result, due_date, crew_id FROM task WHERE tower_id IN (${ph})`).all(...towerIds)) related.set(t.id, t);
  }
  if (assetIds.length) {
    const ph = inClause(assetIds);
    for (const t of db.prepare(`SELECT id, task_number, title, status, result, due_date, crew_id FROM task WHERE asset_id IN (${ph})`).all(...assetIds)) related.set(t.id, t);
  }
  r.tasks = [...related.values()]
    .filter((t) => scope.global || scope.taskIds.has(t.id))
    .map((t) => ({ ...t, crew: t.crew_id ? get('crew', t.crew_id) : null }))
    .sort((a, b) => a.id - b.id);
  res.json(r);
});

router.get('/lines/:id/inspection-progress', (req, res) => {
  const r = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!r) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', r.id)) return;
  const route = Array.isArray(r.route_json) ? r.route_json : [];
  res.json(inspectionForLine(r.id, route));
});

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
      if (!checkInfra(req, res, 'line', line.id)) return;
      updateRow('transmission_line', line.id, { route_json: coords, length_km }, ['route_json'], 'revision');
      audit(req.user, 'IMPORT_ROUTE', 'line', line.id, { mode, format, points: coords.length, length_km });
      return res.json(get('transmission_line', line.id, ['route_json']));
    }
    const rid = Number(region_id);
    if (!checkInfra(req, res, 'region', rid)) return;
    if (!get('region', rid)) return res.status(400).json({ error: 'region_id must reference an existing region' });
    if (!name || !voltage_kv || !from_substation_id || !to_substation_id) {
      return res.status(400).json({ error: 'create mode requires name, voltage_kv, from_substation_id, to_substation_id, region_id' });
    }
    const f = get('substation', Number(from_substation_id));
    const t = get('substation', Number(to_substation_id));
    if (!f || !t || f.region_id !== rid || t.region_id !== rid) {
      return res.status(400).json({ error: 'from/to substations must exist in the target region' });
    }
    if (!isGlobal(req.user)) {
      const scope = commandScope(req.user);
      if (!scope.substationIds.has(f.id) || !scope.substationIds.has(t.id)) {
        return res.status(403).json({ error: 'Forbidden: substation is outside your command scope' });
      }
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

router.post('/lines', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  if (!regionGuard(req, res, req.body)) return;
  if (!isGlobal(req.user)) {
    const scope = commandScope(req.user);
    const anchors = [req.body.from_substation_id, req.body.to_substation_id].filter((x) => x != null && x !== '');
    if (anchors.some((x) => !scope.substationIds.has(Number(x)))) {
      return res.status(403).json({ error: 'Forbidden: substation is outside your command scope' });
    }
  }
  try {
    const body = { ...req.body, route_json: req.body.route_json || '[]', revision: 1 };
    if (typeof body.route_json === 'object') body.route_json = JSON.stringify(body.route_json);
    if (body.veg_clearance_m === undefined || body.veg_clearance_m === null || body.veg_clearance_m === '') {
      body.veg_clearance_m = defaultVegClearance(body.voltage_kv);
    }
    const id = insertRow('transmission_line', body);
    audit(req.user, 'CREATE', 'line', id, req.body);
    res.status(201).json(get('transmission_line', id, ['route_json']));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/lines/:id', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const r = get('transmission_line', Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', r.id)) return;
  const body = { ...req.body, revision: 1 };
  if (body.route_json && typeof body.route_json === 'object') body.route_json = JSON.stringify(body.route_json);
  updateRow('transmission_line', Number(req.params.id), body, ['route_json'], 'revision');
  audit(req.user, 'UPDATE', 'line', Number(req.params.id), req.body);
  res.json(get('transmission_line', Number(req.params.id), ['route_json']));
});

router.delete('/lines/:id', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const id = Number(req.params.id);
  const r = get('transmission_line', id);
  if (!r) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', r.id)) return;
  const towers = db.prepare('SELECT COUNT(*) c FROM tower WHERE line_id = ?').get(id).c;
  if (towers > 0) {
    if (req.query.force !== '1') {
      return res.status(409).json({ error: `Cannot delete: ${towers} towers on line` });
    }
  }
  withTx(() => {
    if (req.query.force === '1') cascadeDeleteLine(id);
    safeDelete('transmission_line', id);
  });
  audit(req.user, 'DELETE', 'line', id, {});
  res.json({ ok: true });
});

// Convert a line's drawn route polyline into towers — the reverse of
// rebuildLineRoute: every route point becomes a registered tower (with its
// standard component set and linked asset), so route and towers stay in sync.
// Route vertices that sit on the from/to substation GPS tie-ins are skipped:
// those are substation locations, not towers.
router.post('/lines/:id/towers-from-route', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  const route = Array.isArray(line.route_json) ? line.route_json : [];
  if (route.length < 2) return res.status(400).json({ error: 'Line has no route polyline to convert into towers' });
  const tieIns = lineTieInCoords(line);
  const prefix = String(line.line_id || '').replace(/^TL-/, '');
  const existing = db.prepare('SELECT tower_id, latitude, longitude FROM tower WHERE line_id = ?').all(line.id);
  const used = new Set(existing.map((t) => t.tower_id));
  let maxN = 0;
  for (const t of existing) {
    const m = parseInt(String(t.tower_id).split('-').pop(), 10);
    if (Number.isFinite(m)) maxN = Math.max(maxN, m);
  }
  const atPoint = (lat, lng) => existing.some((t) =>
    t.latitude != null && t.longitude != null &&
    Math.abs(t.latitude - lat) < 1e-6 && Math.abs(t.longitude - lng) < 1e-6
  );
  let lengthKm = 0;
  for (let i = 1; i < route.length; i++) {
    lengthKm += haversine(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]) / 1000;
  }
  const height = line.voltage_kv >= 500 ? 55 : 38;
  const assetStmt = db.prepare(
    `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let created;
  try {
    created = withTx(() => {
      let n = maxN + 1;
      let made = 0;
      for (let i = 0; i < route.length; i++) {
        const [lat, lng] = route[i];
        if (typeof lat !== 'number' || typeof lng !== 'number') continue;
        if (atTieIn(tieIns, lat, lng)) continue;
        if (atPoint(lat, lng)) continue;
        let tid = `${prefix}-${String(n).padStart(3, '0')}`;
        let guard = 0;
        while (used.has(tid) && guard < 1000) { n += 1; tid = `${prefix}-${String(n).padStart(3, '0')}`; guard += 1; }
        if (used.has(tid)) continue;
        used.add(tid);
        const km = route.length > 1 ? Math.round(((i / (route.length - 1)) * lengthKm) * 10) / 10 : 0;
        const id = insertRow('tower', {
          tower_id: tid, line_id: line.id,
          tower_number: `${String(line.line_id || '').split('-')[1]}-${String(n).padStart(3, '0')}`,
          km_marker: km, latitude: lat, longitude: lng, tower_type: 'SUSPENSION', tower_material: 'LATTICE_STEEL',
          height_m: height, foundation_type: 'PAD', corrosion_rating: 8, gps_validated: 1, revision: 1,
        });
        seedStandardComponents(id, 'SUSPENSION');
        assetStmt.run(`TWR-${tid}`, 'TOWER', line.id, id, tid, lat, lng, 8, new Date().toISOString(),
          'IN_SERVICE', 'OPERATIONAL', 'MEDIUM', 1, JSON.stringify({ source: 'tower', tower_type: 'SUSPENSION', height_m: height }));
        n += 1;
        made += 1;
      }
      if (made > 0) {
        syncLineTowerCount(line.id);
        rebuildLineRoute(line.id);
      }
      return made;
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (created === 0) return res.json({ created: 0, message: 'No towers to create — route points are the substation tie-ins or already match existing towers' });
  audit(req.user, 'CREATE', 'tower', null, { from_route: true, line_id: line.id, created });
  res.status(201).json({ created });
});

// Preview evenly spaced tower positions along the line's route (nothing written).
router.post('/lines/:id/route/space', (req, res) => {
  if (!can(req, 'line:read')) return res.status(403).json({ error: 'Forbidden: requires line:read' });
  const line = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  const route = Array.isArray(line.route_json) ? line.route_json : [];
  if (route.length < 2) return res.status(400).json({ error: 'Line has no route to space towers along' });
  const { count, spacingKm } = req.body || {};
  const spaced = count != null
    ? spaceAlongRoute(route, { count: Number(count) })
    : spacingKm != null ? spaceAlongRoute(route, { spacingKm: Number(spacingKm) }) : [];
  if (spaced.length === 0) return res.status(400).json({ error: 'Provide a tower count (>=2) or a positive spacing in km' });
  // Drop points that land on the from/to substation GPS tie-ins: those are
  // substation locations, not tower positions.
  const tieIns = lineTieInCoords(line);
  const points = spaced.filter((p) => !atTieIn(tieIns, p.lat, p.lng));
  if (points.length === 0) return res.status(400).json({ error: 'All spaced points fall on the line\'s substation tie-ins; increase the count or shorten the spacing' });
  res.json({ points, line_length_km: Math.round(distanceAlongRoute(route) * 10) / 10 });
});

// Set the line route (master geometry) and re-project existing tower km markers.
router.post('/lines/:id/route', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const line = get('transmission_line', Number(req.params.id), ['route_json']);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  try {
    const result = withTx(() => setLineRoute(line.id, req.body && req.body.route_json));
    audit(req.user, 'UPDATE', 'line', line.id, { route_json: true, points: (result.line.route_json || []).length });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// One-transaction create/update/delete of towers staged on the line map.
router.post('/lines/:id/towers/batch', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  try {
    const result = withTx(() => batchTowers(line.id, req.body || {}));
    audit(req.user, 'UPDATE', 'line', line.id, {
      batch_towers: true, created: result.created.length, updated: result.updated.length, deleted: result.deleted.length,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Box-selection actions: bulk delete and/or type/material/foundation patches.
router.post('/lines/:id/towers/bulk', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  try {
    const result = withTx(() => bulkTowers(line.id, req.body || {}));
    audit(req.user, 'UPDATE', 'line', line.id, { bulk_towers: true, deleted: result.deleted.length, patched: result.patched.length });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reset the selected towers' parts to their type's standard set.
router.post('/lines/:id/towers/bulk-reset-components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const result = withTx(() => bulkResetComponents(line.id, ids));
    audit(req.user, 'UPDATE', 'line', line.id, { bulk_reset_components: true, ...result });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Towers ----------------
router.get('/towers', (req, res) => {
  const { line_id, brief } = req.query;
  const scope = commandScope(req.user);
  // Dropdown-only callers (task/schedule/GPS target pickers) need just an id,
  // code, parent line and coordinates. The full row set with per-tower
  // compliance is 6 MB on a large register; this projection is a fraction.
  if (brief) {
    let rows = line_id
      ? db.prepare('SELECT id, tower_id, line_id, tower_type, latitude, longitude FROM tower WHERE line_id = ? ORDER BY id').all(Number(line_id))
      : db.prepare('SELECT id, tower_id, line_id, tower_type, latitude, longitude FROM tower ORDER BY id').all();
    if (!scope.global) rows = rows.filter((t) => scope.towerIds.has(t.id));
    return res.json(rows);
  }
  let rows = line_id
    ? db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY id').all(Number(line_id))
    : list('tower');
  if (!scope.global) rows = rows.filter((t) => scope.towerIds.has(t.id));
  const lineMap = new Map();
  for (const l of list('transmission_line')) lineMap.set(l.id, l);
  const compliance = line_id
    ? (rows.length ? towerComplianceSummaryBatch(rows.map((t) => t.id)) : new Map())
    : towerComplianceSummaryBatch();
  for (const t of rows) {
    // Attach only a compact line brief. Embedding the full line (with its
    // route_json) once per tower made this payload tens of MB on large
    // registers, which froze the client on parse.
    const line = lineMap.get(t.line_id);
    t.line = line ? {
      id: line.id, line_id: line.line_id, name: line.name,
      voltage_kv: line.voltage_kv, operational_status: line.operational_status,
      region_id: line.region_id,
    } : null;
    const c = compliance.get(t.id);
    t.component_count = c ? c.recorded_count : 0;
    t.standard_count = c ? c.standard_count : 0;
    t.recorded_count = c ? c.recorded_count : 0;
    t.compliant = c ? c.compliant : true;
  }
  res.json(rows);
});

router.post('/towers', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', req.body.line_id);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  try {
    const t = withTx(() => {
      const id = insertRow('tower', { ...req.body, revision: 1 });
      seedStandardComponents(id, req.body.tower_type);
      syncLineTowerCount(req.body.line_id);
      const tower = get('tower', id);
      db.prepare(
        `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        `TWR-${tower.tower_id}`, 'TOWER', tower.line_id, tower.id, tower.tower_id, tower.latitude, tower.longitude,
        tower.corrosion_rating ?? 8, new Date().toISOString(), 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM', tower.gps_validated,
        JSON.stringify({ source: 'tower', tower_type: tower.tower_type, height_m: tower.height_m })
      );
      syncTowerMirror(id);
      rebuildLineRoute(req.body.line_id);
      return tower;
    });
    audit(req.user, 'CREATE', 'tower', t.id, req.body);
    res.status(201).json(t);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/towers/:id', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'tower', t.id)) return;
  const oldLineId = t.line_id;
  let updated;
  try {
    updated = withTx(() => {
      updateRow('tower', Number(req.params.id), { ...req.body }, [], 'revision');
      const u = get('tower', Number(req.params.id));
      db.prepare(
        'UPDATE asset SET name = ?, line_id = ?, latitude = ?, longitude = ?, condition_rating = ?, gps_validated = ?, metadata = ? WHERE tower_id = ?'
      ).run(
        u.tower_id, u.line_id, u.latitude, u.longitude, u.corrosion_rating ?? 8, u.gps_validated,
        JSON.stringify({ source: 'tower', tower_type: u.tower_type, height_m: u.height_m }), u.id
      );
      syncLineTowerCount(oldLineId);
      syncLineTowerCount(u.line_id);
      syncTowerMirror(u.id);
      rebuildLineRoute(u.line_id);
      if (oldLineId !== u.line_id) rebuildLineRoute(oldLineId);
      return u;
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  audit(req.user, 'UPDATE', 'tower', Number(req.params.id), req.body);
  res.json(updated);
});

router.delete('/towers/:id', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'line', line.id)) return;
  const linked = db.prepare("SELECT COUNT(*) c FROM task WHERE tower_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')").get(t.id).c;
  if (linked > 0) return res.status(409).json({ error: `Cannot delete: ${linked} open task(s) on tower` });
  withTx(() => {
    db.prepare('DELETE FROM asset WHERE tower_id = ?').run(t.id);
    db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
    safeDelete('tower', t.id);
    syncLineTowerCount(t.line_id);
    rebuildLineRoute(t.line_id);
  });
  audit(req.user, 'DELETE', 'tower', t.id, {});
  res.json({ ok: true });
});

router.post('/towers/:id/reset-components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'tower', t.id)) return;
  if (!line) return res.status(404).json({ error: 'Line not found for tower' });
  withTx(() => {
    db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
    seedStandardComponents(t.id, t.tower_type);
  });
  audit(req.user, 'UPDATE', 'tower', t.id, { reset_components: true, tower_type: t.tower_type });
  res.json({ ok: true, compliance: towerCompliance(t.id) });
});

router.post('/lines/:id/reset-tower-components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
  const towers = db.prepare('SELECT * FROM tower WHERE line_id = ?').all(line.id);
  let components_written = 0;
  withTx(() => {
    for (const t of towers) {
      db.prepare('DELETE FROM tower_component WHERE tower_id = ?').run(t.id);
      seedStandardComponents(t.id, t.tower_type);
      components_written += db.prepare('SELECT COUNT(*) c FROM tower_component WHERE tower_id = ?').get(t.id).c;
    }
  });
  audit(req.user, 'UPDATE', 'transmission_line', line.id, { reset_tower_components: true, towers: towers.length });
  res.json({ towers_reset: towers.length, components_written });
});

// ---------------- Tower components ----------------
router.get('/tower-component-types', (req, res) => {
  res.json(COMPONENT_CATALOG);
});

router.get('/towers/:id', (req, res) => {
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'tower', t.id)) return;
  t.line = line;
  t.components = listComponents(t.id);
  t.compliance = towerCompliance(t.id);
  res.json(t);
});

router.get('/towers/:id/components', (req, res) => {
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'tower', t.id)) return;
  res.json(listComponents(t.id));
});

router.post('/towers/:id/components', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const t = get('tower', Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Tower not found' });
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'line', line.id)) return;
  const b = req.body;
  try {
    const cid = insertRow('tower_component', {
      tower_id: t.id,
      component_type: b.component_type || 'OTHER',
      name: b.name || b.component_type || 'Component',
      material: b.material || 'GALVANIZED_STEEL',
      quantity: Number(b.quantity) || 1,
      unit: b.unit || 'pcs',
      condition_rating: Number(b.condition_rating) ?? 8,
      status: b.status || 'INSTALLED',
      notes: b.notes || null,
      created_at: new Date().toISOString(),
    });
    audit(req.user, 'CREATE', 'tower_component', cid, req.body);
    res.status(201).json(get('tower_component', cid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/tower-components/:id', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const c = get('tower_component', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Component not found' });
  const t = get('tower', c.tower_id);
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'line', line.id)) return;
  updateRow('tower_component', Number(req.params.id), req.body);
  audit(req.user, 'UPDATE', 'tower_component', Number(req.params.id), req.body);
  res.json(get('tower_component', Number(req.params.id)));
});

router.delete('/tower-components/:id', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  const c = get('tower_component', Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Component not found' });
  const t = get('tower', c.tower_id);
  const line = get('transmission_line', t.line_id);
  if (!checkInfra(req, res, 'line', line.id)) return;
  safeDelete('tower_component', Number(req.params.id));
  audit(req.user, 'DELETE', 'tower_component', Number(req.params.id), {});
  res.json({ ok: true });
});

// Bulk tower import from an external source (Excel/CSV) — standard practice:
// field crews prepare tower lists offline, then load them in one operation.
router.post('/towers/import', (req, res) => {
  if (!can(req, 'tower:write')) return res.status(403).json({ error: 'Forbidden: requires tower:write' });
  let records = Array.isArray(req.body.records) ? req.body.records : null;
  if (!records && typeof req.body.csv === 'string') {
    records = parseCsvToRecords(req.body.csv);
  }
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Provide records[] or csv with at least one tower row' });
  }
  const results = { created: 0, updated: 0, errors: [] };
  const linesBy = {
    id: new Map(),
    code: new Map(),
    name: new Map(),
  };
  for (const l of list('transmission_line')) {
    linesBy.id.set(l.id, l);
    linesBy.code.set(l.line_id, l);
    linesBy.name.set((l.name || '').toLowerCase(), l);
  }
  const resolveLine = (r) => {
    const id = r.line_id !== undefined && r.line_id !== null && String(r.line_id) !== '' ? Number(r.line_id) : NaN;
    if (Number.isFinite(id) && linesBy.id.has(id)) return linesBy.id.get(id);
    if (r.line_code && linesBy.code.has(r.line_code)) return linesBy.code.get(r.line_code);
    if (r.line && linesBy.code.has(r.line)) return linesBy.code.get(r.line);
    if (r.line_name && linesBy.name.has(String(r.line_name).toLowerCase())) return linesBy.name.get(String(r.line_name).toLowerCase());
    return null;
  };
  // Authorize every target line before writing anything, so a scope violation
  // cannot leave the import partially applied.
  for (const r of records) {
    const line = resolveLine(r);
    if (line && !checkInfra(req, res, 'line', line.id)) return;
  }
  const affectedLines = new Set();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const line = resolveLine(r);
    const towerId = String(r.tower_id || r.towerNumber || '').trim();
    const lat = Number(r.latitude ?? r.lat);
    const lng = Number(r.longitude ?? r.lng ?? r.lon);
    if (!line) { results.errors.push({ row: i + 2, error: 'Unknown line (use line_id number, line code or line name)' }); continue; }
    if (!towerId) { results.errors.push({ row: i + 2, error: 'Missing tower_id' }); continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { results.errors.push({ row: i + 2, error: 'Invalid latitude/longitude' }); continue; }
    const existing = db.prepare('SELECT * FROM tower WHERE tower_id = ?').get(towerId);
    const body = {
      line_id: line.id,
      tower_id: towerId,
      tower_number: String(r.tower_number || r.towerNumber || towerId),
      km_marker: Number(r.km_marker ?? r.km ?? 0),
      latitude: lat,
      longitude: lng,
      tower_type: String(r.tower_type || r.type || 'SUSPENSION').toUpperCase(),
      tower_material: String(r.tower_material || r.material || 'LATTICE_STEEL').toUpperCase(),
      height_m: Number(r.height_m ?? r.height ?? 0),
      corrosion_rating: Number(r.corrosion_rating ?? r.corrosion ?? 8),
      gps_validated: r.gps_validated !== undefined ? (Number(r.gps_validated) ? 1 : 0) : 1,
    };
    try {
      withTx(() => {
        if (existing) {
          updateRow('tower', existing.id, { ...body }, [], 'revision');
          db.prepare(
            'UPDATE asset SET line_id = ?, latitude = ?, longitude = ?, condition_rating = ?, gps_validated = ? WHERE tower_id = ?'
          ).run(body.line_id, body.latitude, body.longitude, body.corrosion_rating, body.gps_validated, existing.id);
          syncTowerMirror(existing.id);
          results.updated += 1;
        } else {
          const tid = insertRow('tower', { ...body, revision: 1 });
          seedStandardComponents(tid, body.tower_type);
          db.prepare(
            `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(
            `TWR-${towerId}`, 'TOWER', line.id, tid, towerId, lat, lng, body.corrosion_rating,
            new Date().toISOString(), 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM', body.gps_validated,
            JSON.stringify({ source: 'tower', tower_type: body.tower_type, height_m: body.height_m })
          );
          syncTowerMirror(tid);
          results.created += 1;
        }
      });
      affectedLines.add(line.id);
    } catch (e) {
      results.errors.push({ row: i + 2, error: e.message });
    }
  }
  // Recompute tower counts and route polylines once per affected line instead
  // of once per imported row (previously O(rows x towers)).
  if (affectedLines.size > 0) {
    withTx(() => {
      for (const lid of affectedLines) {
        syncLineTowerCount(lid);
        rebuildLineRoute(lid);
      }
    });
  }
  audit(req.user, 'CREATE', 'tower', null, { import: true, created: results.created, updated: results.updated, errors: results.errors.length });
  res.status(200).json(results);
});

function parseCsvToRecords(csv) {
  const text = String(csv || '').trim().replace(/^\uFEFF/, '');
  if (!text) return [];
  const delim = text.includes('\t') ? '\t' : ',';
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const parse = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = parse(lines[0]).map((h) => h.replace(/\s+/g, '_').toLowerCase());
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parse(lines[i]);
    const rec = {};
    for (let j = 0; j < headers.length; j++) {
      if (cells[j] !== undefined && cells[j] !== '') rec[headers[j]] = cells[j];
    }
    records.push(rec);
  }
  return records;
}

// Auto-place JOINT_BOX assets along a line at cumulative chainage multiples
// of joint_box_interval_km (default 5). dry_run lists without inserting.
router.post('/lines/:id/generate-joint-boxes', (req, res) => {
  if (!can(req, 'line:write')) return res.status(403).json({ error: 'Forbidden: requires line:write' });
  const line = get('transmission_line', Number(req.params.id));
  if (!line) return res.status(404).json({ error: 'Line not found' });
  if (!checkInfra(req, res, 'line', line.id)) return;
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

module.exports = router;
