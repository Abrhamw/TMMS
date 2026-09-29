const { db } = require('./db');
const { isGlobal, isCrewUser, userCrewIds } = require('./auth');
const { boundaryContains } = require('./geo');
const {
  ASSET_TYPE_DOMAIN, DOMAIN_CREW_TYPES, UNIT_DOMAINS,
  FUNCTIONAL_CREW_TYPES, OT_UNIT_TYPES, domainLabel,
} = require('./otModel');

const LEGACY_MANAGER_ROLES = new Set(['SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER']);
// Roles that behave as a department head. OT_MANAGER is the explicit role of
// the Operational Technology department and its child departments.
const MANAGER_ROLES = new Set(['REGION_MANAGER', 'OT_MANAGER', ...LEGACY_MANAGER_ROLES]);

function isManager(user) {
  return !!user && MANAGER_ROLES.has(user.role);
}

function unitSubtree(rootId) {
  if (!rootId) return [];
  return db.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM org_unit WHERE id = ?
       UNION
       SELECT o.id FROM org_unit o JOIN sub s ON o.parent_id = s.id
     ) SELECT id FROM sub`
  ).all(Number(rootId)).map((r) => r.id);
}

// The units a person is explicitly recorded as the manager of. This is the
// authoritative management link: it is exactly what the Organization tree
// renders, so command authority and the org view can never disagree.
function managedUnitIds(personId) {
  if (!personId) return [];
  return db.prepare('SELECT id FROM org_unit WHERE manager_person_id = ? ORDER BY id').all(Number(personId)).map((r) => r.id);
}

// A person may head more than one unit; command follows the topmost one (a head
// commands a unit's whole subtree, so the shallower unit already covers the
// deeper one). Returns null when the person heads nothing.
function headedUnitId(personId) {
  const headed = managedUnitIds(personId);
  if (headed.length === 0) return null;
  if (headed.length === 1) return headed[0];
  const set = new Set(headed);
  const rows = db.prepare(
    `SELECT id, parent_id FROM org_unit WHERE id IN (${headed.map(() => '?').join(',')})`
  ).all(...headed);
  const top = rows.find((r) => r.parent_id == null || !set.has(r.parent_id));
  return (top || rows[0]).id;
}

// The org unit that anchors a user's command. The unit a person is *named*
// manager on wins over their home-unit membership, so authority matches the
// Organization tree and cannot drift from a nullable membership column. Falls
// back to the person's home unit, then the crew's unit.
function userUnitId(user) {
  if (!user) return null;
  if (user.person_id) {
    const headed = headedUnitId(user.person_id);
    if (headed) return headed;
    const p = db.prepare('SELECT org_unit_id FROM person WHERE id = ?').get(user.person_id);
    if (p && p.org_unit_id) return p.org_unit_id;
  }
  if (user.crew_id) {
    const c = db.prepare('SELECT org_unit_id FROM crew WHERE id = ?').get(user.crew_id);
    if (c && c.org_unit_id) return c.org_unit_id;
  }
  return null;
}

// Keep the two management links in step: a person's home unit and the unit that
// names them as manager. The named-manager link is authoritative (see
// `userUnitId`); this repairs drift on boot without ever stealing a unit from
// another person (it fills a null manager or a manager's null membership only).
function reconcileOrgAuthority() {
  let moved = 0;
  let named = 0;
  // A unit that names a manager anchors that person's membership on the unit
  // (the topmost one they head, matching `userUnitId`). This direction is
  // role-agnostic: whoever the tree shows as head gets a membership that agrees.
  const heads = db.prepare('SELECT DISTINCT manager_person_id AS pid FROM org_unit WHERE manager_person_id IS NOT NULL').all();
  for (const { pid } of heads) {
    const target = headedUnitId(pid);
    const p = db.prepare('SELECT org_unit_id FROM person WHERE id = ?').get(pid);
    if (!target || !p) continue;
    if (p.org_unit_id !== target) {
      db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(target, pid);
      moved++;
    }
  }
  // The reverse, only for real manager logins: a manager whose home unit names
  // no head adopts that unit, but never steals one already named.
  const managerRoles = [...MANAGER_ROLES];
  const managers = db.prepare(
    `SELECT DISTINCT p.id, p.org_unit_id FROM user u JOIN person p ON p.id = u.person_id
     WHERE u.role IN (${managerRoles.map(() => '?').join(',')}) AND p.org_unit_id IS NOT NULL`
  ).all(...managerRoles);
  for (const p of managers) {
    if (headedUnitId(p.id)) continue;
    const unit = db.prepare('SELECT id, manager_person_id FROM org_unit WHERE id = ?').get(p.org_unit_id);
    if (unit && !unit.manager_person_id) {
      db.prepare('UPDATE org_unit SET manager_person_id = ? WHERE id = ? AND manager_person_id IS NULL').run(p.id, unit.id);
      named++;
    }
  }
  if (moved || named) console.log(`[authority] reconciled org authority: ${moved} membership(s), ${named} manager name(s)`);
  return { moved, named };
}

// File a crew under its department when the crew code names a unit directly.
// Crews created through the API can carry a null org unit, which hides their
// work from the department that commands them and leaves them floating in the
// Organization tree. A matching unit code (same region when both declare one) is
// unambiguous, so link it; anything less certain is left for a human to place.
function reconcileCrewOrgUnits() {
  const orphans = db.prepare('SELECT id, crew_code, region_id FROM crew WHERE org_unit_id IS NULL AND crew_code IS NOT NULL').all();
  let linked = 0;
  for (const c of orphans) {
    const unit = db.prepare('SELECT id, region_id FROM org_unit WHERE unit_code = ?').get(c.crew_code);
    if (!unit) continue;
    if (c.region_id != null && unit.region_id != null && c.region_id !== unit.region_id) continue;
    linked += db.prepare('UPDATE crew SET org_unit_id = ? WHERE id = ? AND org_unit_id IS NULL').run(unit.id, c.id).changes;
  }
  if (linked) console.log(`[authority] reconciled ${linked} crew org-unit link(s)`);
  return { linked };
}

function isFunctionalCrew(crew) {
  return !!crew && FUNCTIONAL_CREW_TYPES.has(crew.crew_type);
}

function userHasFunctionalScope(user) {
  if (!isManager(user)) return false;
  const unitId = userUnitId(user);
  if (!unitId) return false;
  const u = db.prepare('SELECT unit_type, parent_id FROM org_unit WHERE id = ?').get(unitId);
  if (!u || !OT_UNIT_TYPES.has(u.unit_type)) return false;
  // A child OT department under another OT unit is scoped to its own subtree
  // and domain; only the root OT unit keeps cross-region functional authority.
  if (u.parent_id) {
    const parent = db.prepare('SELECT unit_type FROM org_unit WHERE id = ?').get(u.parent_id);
    if (parent && OT_UNIT_TYPES.has(parent.unit_type)) return false;
  }
  return true;
}

function allCrews() {
  return db.prepare('SELECT id, region_id, org_unit_id, crew_type FROM crew').all();
}

// Crews a person is personally tied to, whether as the named leader or as an
// active roster member. Mirrors `getUserCrew` in auth.js so a manager who also
// stands watch on a crew commands exactly the crew the field surfaces give them.
function crewsForPerson(personId) {
  if (!personId) return new Set();
  const ids = new Set();
  for (const r of db.prepare('SELECT id FROM crew WHERE leader_person_id = ?').all(personId)) ids.add(r.id);
  for (const r of db.prepare('SELECT crew_id FROM crew_member WHERE person_id = ? AND active = 1').all(personId)) ids.add(r.crew_id);
  return ids;
}

function authorizedCrewIds(user) {
  if (!user) return new Set();
  const all = allCrews();
  if (isGlobal(user)) return new Set(all.map((c) => c.id));
  if (isCrewUser(user)) return new Set(userCrewIds(user));
  if (isManager(user)) {
    const ids = new Set();
    const unitId = userUnitId(user);
    if (unitId) {
      const subtree = new Set(unitSubtree(unitId));
      for (const c of all) if (c.org_unit_id && subtree.has(c.org_unit_id)) ids.add(c.id);
    }
    // A manager who also leads or serves on a crew commands that crew even
    // before it is filed under a department, so an unset org_unit column cannot
    // hide the crew's own work from its lead.
    for (const id of crewsForPerson(user.person_id)) ids.add(id);
    if (userHasFunctionalScope(user)) {
      for (const c of all) if (isFunctionalCrew(c)) ids.add(c.id);
    }
    return ids;
  }
  return new Set(all.filter((c) => c.region_id === user.region_id).map((c) => c.id));
}

function canAssignCrew(user, crewId) {
  if (crewId === null || crewId === undefined) return false;
  return authorizedCrewIds(user).has(Number(crewId));
}

// Who reads the whole region's directories and map. A region director always
// does; a region manager does too for the *reading* surfaces (crews, people,
// certifications, org tree, infrastructure and the map). Their *work* — tasks
// and schedules — is separate and stays with their department (see
// `taskVisible` and `managerDepartmentScope`).
function regionWideRead(user) {
  if (!user) return false;
  if (user.role === 'REGION_DIRECTOR') return true;
  if (user.role === 'REGION_MANAGER' || user.role === 'OT_MANAGER') {
    return !isCrewUser(user) && !userHasFunctionalScope(user);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Operational Technology domains
//
// Every asset resolves to one domain (see otModel.js). A department's domains
// come from the crews under its command and from its org-unit type, so a
// Protection & Control department owns OT_PROTECTION, the parent OT department
// owns all four OT domains, and a Substation/Line department owns its own.
// ---------------------------------------------------------------------------

function assetDomainOf(a, assetById) {
  if (!a) return null;
  const direct = ASSET_TYPE_DOMAIN[a.asset_type];
  if (direct) return direct;
  if (a.parent_asset_id && assetById) {
    const parent = assetById.get(a.parent_asset_id);
    if (parent) return assetDomainOf(parent, assetById);
  }
  if (a.line_id || a.tower_id) return 'LINE';
  if (a.substation_id) return 'SUBSTATION';
  return null;
}

let _assetSummaryStmt = null;
function assetSummary(id) {
  if (!_assetSummaryStmt) {
    _assetSummaryStmt = db.prepare('SELECT asset_type, substation_id, line_id, tower_id, parent_asset_id FROM asset WHERE id = ?');
  }
  const a = _assetSummaryStmt.get(id);
  if (!a) return a;
  if (a.parent_asset_id && !ASSET_TYPE_DOMAIN[a.asset_type]) {
    const parent = _assetSummaryStmt.get(a.parent_asset_id);
    if (parent) return { ...a, asset_type: parent.asset_type, substation_id: a.substation_id ?? parent.substation_id, line_id: a.line_id ?? parent.line_id, tower_id: a.tower_id ?? parent.tower_id };
  }
  return a;
}

// Which department domain a task belongs to, independent of any assignment.
// The task's own asset wins over the line/substation it happens to sit on, so
// a fiber asset (OPGW span / joint box) on a line is still OT, not LINE.
function taskDomain(t) {
  if (!t) return null;
  if (t.asset_id) {
    const a = assetSummary(t.asset_id);
    if (a) return assetDomainOf(a);
  }
  if (t.tower_id || t.line_id) return 'LINE';
  if (t.substation_id) return 'SUBSTATION';
  return null;
}

// The domains a manager's department owns, inferred from the crew types under
// their command plus their org-unit type (so a child department owns its slice
// even before a crew is raised).
function managerDomains(user) {
  const auth = authorizedCrewIds(user);
  const domains = new Set();
  for (const c of allCrews()) {
    if (!auth.has(c.id)) continue;
    const d = DOMAIN_CREW_TYPES[c.crew_type];
    if (d) domains.add(d);
  }
  const unitId = userUnitId(user);
  if (unitId) {
    const u = db.prepare('SELECT unit_type FROM org_unit WHERE id = ?').get(unitId);
    for (const d of (u && UNIT_DOMAINS[u.unit_type]) || []) domains.add(d);
  }
  return domains;
}

function regionCrewIds(regionId) {
  return new Set(db.prepare('SELECT id FROM crew WHERE region_id = ?').all(regionId).map((c) => c.id));
}

// Crews visible for *reading* (lists, documents, KPIs). Region managers see every
// crew in their region; everyone else falls back to the command set, so this
// never widens assignment authority (that stays `authorizedCrewIds`).
function readCrewIds(user) {
  if (!user) return new Set();
  if (isGlobal(user)) return new Set(allCrews().map((c) => c.id));
  if (isCrewUser(user)) return new Set(userCrewIds(user));
  if (regionWideRead(user)) return regionCrewIds(user.region_id);
  return authorizedCrewIds(user);
}

function canViewCrew(user, crew) {
  if (!crew || !user) return false;
  if (isGlobal(user)) return true;
  if (isCrewUser(user)) return userCrewIds(user).has(crew.id);
  if (regionWideRead(user)) return crew.region_id === user.region_id;
  if (isManager(user)) return authorizedCrewIds(user).has(crew.id);
  return crew.region_id === user.region_id;
}

function canManageUnit(user, unitId) {
  if (!user || unitId === null || unitId === undefined) return false;
  if (isGlobal(user)) return true;
  if (!isManager(user)) return false;
  const mine = userUnitId(user);
  if (!mine) return false;
  return new Set(unitSubtree(mine)).has(Number(unitId));
}

function taskVisible(user, t) {
  if (!t || !user) return false;
  if (isGlobal(user)) return true;
  if (isCrewUser(user)) return !!t.crew_id && userCrewIds(user).has(t.crew_id);
  // A region director (a non-manager region role) reads the whole region; it
  // falls through to the region match at the bottom. Department managers do
  // NOT short-circuit on `regionWideRead`: their directory/map read is region
  // wide, but their *work* is scoped to the department that owns the task's
  // infrastructure (see below).
  if (user.role === 'REGION_DIRECTOR') return t.region_id === user.region_id;
  if (isManager(user)) {
    if (t.crew_id && authorizedCrewIds(user).has(t.crew_id)) return true;
    // A department manager's reach is their command: work assigned to crews
    // within their unit subtree (or functional scope) plus tasks they raised
    // themselves. Unassigned work is visible when its target belongs to the
    // department's infrastructure domain, so planning/dispatch work reaches the
    // right department without leaking into another department's list.
    if (t.created_by && user.person_id && t.created_by === user.person_id) return true;
    if (t.crew_id) return false;
    const domain = taskDomain(t);
    return !!domain && managerDomains(user).has(domain);
  }
  return t.region_id === user.region_id;
}

// ---------------------------------------------------------------------------
// Command scope
//
// A single, memoized universe per request that every operational surface
// (tasks, schedules, GPS validations, compliance reports, checklists,
// infrastructure, map) can filter against. For global roles it is open; for
// managers and field crews it is the chain of command (crews they command and
// the work/infrastructure those crews are responsible for); for the remaining
// region roles it degrades to the pre-existing region scope.
// ---------------------------------------------------------------------------

function mapRowsById(table, columns) {
  const rows = db.prepare(`SELECT ${columns} FROM ${table}`).all();
  return new Map(rows.map((r) => [r.id, r]));
}

function assetsAtScope(assetById, substationIds, lineIds, towerIds) {
  const ids = new Set();
  for (const a of assetById.values()) {
    if (
      (a.substation_id && substationIds.has(a.substation_id)) ||
      (a.line_id && lineIds.has(a.line_id)) ||
      (a.tower_id && towerIds.has(a.tower_id))
    ) ids.add(a.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Geographic clipping
//
// Region ids are an administrative label, not a guarantee that a row's geometry
// actually sits inside the region's boundary; seed/import data can leave a
// substation or line assigned to a region while plotting far outside it. The
// map and the infrastructure lists therefore clip physical features to the
// region polygon so a region-bound viewer only ever sees their own ground.
// ---------------------------------------------------------------------------

function parseBoundary(value) {
  if (Array.isArray(value)) return value.length >= 3 ? value : null;
  if (typeof value === 'string' && value) {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) && p.length >= 3 ? p : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function regionBoundaryFor(regionId) {
  const r = db.prepare('SELECT center_lat, center_lng, boundary, boundary_json FROM region WHERE id = ?').get(regionId);
  if (!r) return null;
  return {
    polygon: parseBoundary(r.boundary_json),
    centerLat: r.center_lat,
    centerLng: r.center_lng,
    radiusM: (r.boundary != null ? r.boundary : 1.5) * 111320,
  };
}

function pointInRegionBoundary(boundary, lat, lng) {
  if (!boundary) return true;
  if (lat == null || lng == null) return false;
  return boundaryContains(boundary.polygon, boundary.centerLat, boundary.centerLng, lat, lng, boundary.radiusM);
}

// A line counts as inside when any vertex of its route (or either endpoint
// substation) falls inside the boundary, so lines that cross the border are
// kept rather than chopped.
function lineInRegionBoundary(boundary, routeJson, endpointCoordinates) {
  if (!boundary) return true;
  let route = routeJson;
  if (typeof route === 'string') {
    try { route = JSON.parse(route); } catch (_) { route = null; }
  }
  if (Array.isArray(route)) {
    for (const p of route) {
      if (Array.isArray(p) && p.length >= 2 && pointInRegionBoundary(boundary, p[0], p[1])) return true;
    }
  }
  for (const c of endpointCoordinates || []) {
    if (Array.isArray(c) && c.length >= 2 && pointInRegionBoundary(boundary, c[0], c[1])) return true;
  }
  return false;
}

function infrastructureForRegion(regionId) {
  const boundary = regionId != null ? regionBoundaryFor(regionId) : null;
  const subRows = db.prepare('SELECT id, latitude, longitude FROM substation WHERE region_id = ?').all(regionId);
  const subCoord = new Map(subRows.map((s) => [s.id, [s.latitude, s.longitude]]));
  const substationIds = new Set(subRows.filter((s) => pointInRegionBoundary(boundary, s.latitude, s.longitude)).map((s) => s.id));
  const lineRows = db.prepare('SELECT id, route_json, from_substation_id, to_substation_id FROM transmission_line WHERE region_id = ?').all(regionId);
  const lineIds = new Set(
    lineRows
      .filter((l) => lineInRegionBoundary(boundary, l.route_json, [subCoord.get(l.from_substation_id), subCoord.get(l.to_substation_id)]))
      .map((l) => l.id)
  );
  const towerIds = new Set(db.prepare('SELECT id, line_id FROM tower').all().filter((t) => lineIds.has(t.line_id)).map((t) => t.id));
  const assetById = mapRowsById('asset', 'id, substation_id, line_id, tower_id');
  const assetIds = assetsAtScope(assetById, substationIds, lineIds, towerIds);
  return { substationIds, lineIds, towerIds, assetIds };
}

function memberIdsForCrews(crewIds, includeRegionPersonnel, regionId) {
  const memberIds = new Set();
  if (crewIds && crewIds.size) {
    const ids = [...crewIds];
    const ph = ids.map(() => '?').join(',');
    for (const m of db.prepare(`SELECT person_id FROM crew_member WHERE active = 1 AND crew_id IN (${ph})`).all(...ids)) {
      memberIds.add(m.person_id);
    }
    for (const c of db.prepare(`SELECT leader_person_id FROM crew WHERE id IN (${ph})`).all(...ids)) {
      if (c.leader_person_id) memberIds.add(c.leader_person_id);
    }
  }
  if (includeRegionPersonnel && regionId) {
    for (const p of db.prepare('SELECT person_id FROM region_personnel WHERE region_id = ?').all(regionId)) {
      memberIds.add(p.person_id);
    }
  }
  return memberIds;
}

function validationIdsFor(linkedTaskIds, memberIds, substationIds, lineIds, towerIds, assetIds) {
  const ids = new Set();
  const rows = db.prepare('SELECT id, linked_task_id, validated_by, target_type, target_id FROM gps_validation').all();
  for (const v of rows) {
    if (v.linked_task_id && linkedTaskIds.has(v.linked_task_id)) { ids.add(v.id); continue; }
    if (v.validated_by && memberIds.has(v.validated_by)) { ids.add(v.id); continue; }
    if (v.target_type === 'ASSET' && assetIds.has(v.target_id)) { ids.add(v.id); continue; }
    if (v.target_type === 'SUBSTATION' && substationIds.has(v.target_id)) { ids.add(v.id); continue; }
    if (v.target_type === 'LINE' && lineIds.has(v.target_id)) { ids.add(v.id); continue; }
    if (v.target_type === 'TOWER' && towerIds.has(v.target_id)) ids.add(v.id);
  }
  return ids;
}

function emptyScope() {
  return {
    global: false,
    crewIds: new Set(), taskIds: new Set(), scheduleIds: new Set(), regionIds: new Set(),
    substationIds: new Set(), lineIds: new Set(), towerIds: new Set(), assetIds: new Set(),
    memberIds: new Set(), validationIds: new Set(),
  };
}

function regionScope(user) {
  const regionId = user.region_id;
  const crewIds = readCrewIds(user);
  const infra = infrastructureForRegion(regionId);
  const taskIds = new Set(db.prepare('SELECT id FROM task WHERE region_id = ?').all(regionId).map((t) => t.id));
  const scheduleIds = new Set(db.prepare('SELECT id FROM maintenance_schedule WHERE region_id = ?').all(regionId).map((s) => s.id));
  const memberIds = memberIdsForCrews(crewIds, true, regionId);
  if (user.person_id) memberIds.add(user.person_id);
  const validationIds = new Set(db.prepare('SELECT id FROM gps_validation WHERE region_id = ?').all(regionId).map((v) => v.id));
  const regionIds = new Set(regionId != null ? [regionId] : []);
  return { global: false, crewIds, taskIds, scheduleIds, regionIds, ...infra, memberIds, validationIds };
}

// Keep only the assets whose domain belongs to the department. An empty domain
// set means the department could not be resolved, so nothing is filtered out
// (legacy data keeps its previous reach).
function filterAssetsByDomain(assetIds, domains, assetById) {
  if (!domains || domains.size === 0) return assetIds;
  const map = assetById || mapRowsById('asset', 'id, asset_type, substation_id, line_id, tower_id, parent_asset_id');
  const out = new Set();
  for (const id of assetIds) {
    const a = map.get(id);
    if (!a) continue;
    const d = assetDomainOf(a, map);
    if (d && domains.has(d)) out.add(id);
  }
  return out;
}

// A department manager's operating scope: read the whole home region's
// directories and infrastructure (crews, members, map, validations) exactly as
// before, while the *work* lists — tasks and schedules — follow the department
// (`taskVisible` + authorized crews) and the *asset register* follows the
// department's domains, so a Substation manager no longer browses OT assets and
// vice versa. The region director is served by regionScope; functional (OT)
// managers keep their cross-region expansion.
function managerDepartmentScope(user) {
  const readCrews = readCrewIds(user);
  const domains = managerDomains(user);
  const infra = infrastructureForRegion(user.region_id);
  const assetIds = filterAssetsByDomain(infra.assetIds, domains);
  const scopedInfra = { ...infra, assetIds };
  const memberIds = memberIdsForCrews(readCrews, true, user.region_id);
  if (user.person_id) memberIds.add(user.person_id);

  const taskIds = new Set();
  const scheduleIds = new Set();
  for (const t of db.prepare(
    'SELECT id, crew_id, created_by, region_id, substation_id, line_id, tower_id, asset_id, schedule_id FROM task'
  ).all()) {
    if (!taskVisible(user, t)) continue;
    taskIds.add(t.id);
    if (t.schedule_id) scheduleIds.add(t.schedule_id);
  }
  const crewIds = authorizedCrewIds(user);
  for (const s of db.prepare('SELECT id, responsible_crew_id FROM maintenance_schedule').all()) {
    if (s.responsible_crew_id && crewIds.has(s.responsible_crew_id)) scheduleIds.add(s.id);
  }

  const regionIds = new Set(user.region_id != null ? [user.region_id] : []);
  const validationIds = validationIdsFor(taskIds, memberIds, scopedInfra.substationIds, scopedInfra.lineIds, scopedInfra.towerIds, scopedInfra.assetIds);
  return { global: false, crewIds: readCrews, taskIds, scheduleIds, regionIds, ...scopedInfra, memberIds, validationIds };
}

// A field crew browses the assets of its home region that belong to its own
// department (an OT crew sees OT assets, a line crew sees line assets), while
// its *work* stays its own: only tasks, schedules and members of its crew are in
// scope. A cross-region task assignment still shows the work but never widens
// the region boundary (see the region clamp below).
function crewScope(user) {
  const regionId = user.region_id;
  const crewIds = new Set(userCrewIds(user));
  const taskIds = new Set();
  const scheduleIds = new Set();
  const domains = new Set();
  const crewTypeStmt = db.prepare('SELECT crew_type FROM crew WHERE id = ?');
  for (const crewId of crewIds) {
    for (const t of db.prepare('SELECT id, schedule_id FROM task WHERE crew_id = ?').all(crewId)) {
      taskIds.add(t.id);
      if (t.schedule_id) scheduleIds.add(t.schedule_id);
    }
    for (const s of db.prepare('SELECT id FROM maintenance_schedule WHERE responsible_crew_id = ?').all(crewId)) scheduleIds.add(s.id);
    const c = crewTypeStmt.get(crewId);
    const d = c && DOMAIN_CREW_TYPES[c.crew_type];
    if (d) domains.add(d);
  }
  const infra = infrastructureForRegion(regionId);
  const scopedInfra = { ...infra, assetIds: filterAssetsByDomain(infra.assetIds, domains) };
  const memberIds = memberIdsForCrews(crewIds, false, null);
  if (user.person_id) memberIds.add(user.person_id);
  const regionIds = new Set(regionId != null ? [regionId] : []);
  const validationIds = validationIdsFor(taskIds, memberIds, scopedInfra.substationIds, scopedInfra.lineIds, scopedInfra.towerIds, scopedInfra.assetIds);
  return { global: false, crewIds, taskIds, scheduleIds, regionIds, ...scopedInfra, memberIds, validationIds };
}

function commandScopeOf(user) {
  if (!user) return emptyScope();
  if (isGlobal(user)) {
    return { global: true, crewIds: null, taskIds: null, scheduleIds: null, regionIds: null, substationIds: null, lineIds: null, towerIds: null, assetIds: null, memberIds: null, validationIds: null };
  }
  if (isCrewUser(user)) return crewScope(user);
  if (!isManager(user)) return regionScope(user);
  // A region-member department manager: region-wide directory/map read with
  // department-scoped work. Functional (OT) managers keep cross-region command.
  if (regionWideRead(user)) return managerDepartmentScope(user);
  // Department managers command only their own department (crews + the
  // infrastructure their crews maintain); the region director is served by
  // regionScope above. Functional (OT) managers keep cross-region authority.

  const crewIds = authorizedCrewIds(user);
  const domains = managerDomains(user);
  const inDomains = (d) => domains.size === 0 || (!!d && domains.has(d));
  // Functional (OT) managers carry cross-region authority; everybody else only
  // ever picks up infrastructure that lives in their own region.
  const regionBound = userHasFunctionalScope(user) ? null : user.region_id;
  const inRegion = (region) => regionBound == null || region == null || region === regionBound;

  const substationById = mapRowsById('substation', 'id, region_id');
  const lineById = mapRowsById('transmission_line', 'id, region_id, from_substation_id, to_substation_id');
  const towerById = mapRowsById('tower', 'id, line_id');
  const assetById = mapRowsById('asset', 'id, asset_type, substation_id, line_id, tower_id, default_crew_id, parent_asset_id');
  const lineRegion = (id) => { const l = lineById.get(id); return l ? l.region_id : null; };
  const towerRegion = (id) => { const t = towerById.get(id); return t ? lineRegion(t.line_id) : null; };
  const assetRegion = (a) => {
    if (!a) return null;
    if (a.substation_id && substationById.has(a.substation_id)) return substationById.get(a.substation_id).region_id;
    if (a.line_id) return lineRegion(a.line_id);
    if (a.tower_id) return towerRegion(a.tower_id);
    if (a.parent_asset_id && assetById.has(a.parent_asset_id)) return assetRegion(assetById.get(a.parent_asset_id));
    return null;
  };

  const taskRows = db.prepare(
    'SELECT id, crew_id, created_by, region_id, substation_id, line_id, tower_id, asset_id, schedule_id FROM task'
  ).all();
  const taskIds = new Set();
  const scheduleIds = new Set();
  const regionIds = new Set();
  const substationIds = new Set();
  const lineIds = new Set();
  const towerIds = new Set();
  const assetIds = new Set();
  for (const t of taskRows) {
    if (!taskVisible(user, t)) continue;
    taskIds.add(t.id);
    // A cross-region task assignment (or a stray region_id) must not widen a
    // region-bound user's region visibility: region roles and crews only ever
    // see their own region boundary, even when dispatched onto someone else's
    // work. Cross-region functional managers keep the open view.
    if (t.region_id != null && inRegion(t.region_id)) regionIds.add(t.region_id);
    if (t.substation_id && inRegion(substationById.get(t.substation_id) && substationById.get(t.substation_id).region_id)) substationIds.add(t.substation_id);
    if (t.line_id && inRegion(lineRegion(t.line_id))) lineIds.add(t.line_id);
    if (t.tower_id && inRegion(towerRegion(t.tower_id))) towerIds.add(t.tower_id);
    if (t.asset_id && inRegion(assetRegion(assetById.get(t.asset_id)))) assetIds.add(t.asset_id);
    if (t.schedule_id) scheduleIds.add(t.schedule_id);
  }
  for (const s of db.prepare('SELECT id, responsible_crew_id FROM maintenance_schedule').all()) {
    if (s.responsible_crew_id && crewIds.has(s.responsible_crew_id)) scheduleIds.add(s.id);
  }

  // Give the department its full asset register within its home region, so the
  // OT register and map are not limited to the assets touched by open work.
  for (const a of assetById.values()) {
    if (domains.size === 0) break;
    if (!inDomains(assetDomainOf(a, assetById))) continue;
    if (assetRegion(a) !== user.region_id) continue;
    assetIds.add(a.id);
  }

  // Expand infrastructure responsibility to a fixed point: work on an entity
  // pulls in its parents (asset -> tower/line/substation, tower -> line) and a
  // commanded line/substation pulls in the towers and assets on it. Expansion
  // is clamped to the manager's region (except cross-region function managers)
  // and to the department's domains, so an OT manager working a line does not
  // inherit the line crew's conductor spans.
  for (const a of assetById.values()) {
    if (a.default_crew_id && crewIds.has(a.default_crew_id) && inRegion(assetRegion(a)) && inDomains(assetDomainOf(a, assetById))) assetIds.add(a.id);
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const addSub = (id) => { if (id != null && inRegion(substationById.get(id) && substationById.get(id).region_id) && !substationIds.has(id)) { substationIds.add(id); changed = true; } };
    const addLine = (id) => { if (id != null && inRegion(lineRegion(id)) && !lineIds.has(id)) { lineIds.add(id); changed = true; } };
    const addTower = (id) => { if (id != null && inRegion(towerRegion(id)) && !towerIds.has(id)) { towerIds.add(id); changed = true; } };
    const addAsset = (id) => {
      const a = assetById.get(id);
      if (id != null && a && inRegion(assetRegion(a)) && inDomains(assetDomainOf(a, assetById)) && !assetIds.has(id)) { assetIds.add(id); changed = true; }
    };
    for (const a of assetById.values()) {
      if (assetIds.has(a.id)) { addTower(a.tower_id); addLine(a.line_id); addSub(a.substation_id); }
      else if (a.tower_id && towerIds.has(a.tower_id)) addAsset(a.id);
      else if (a.line_id && lineIds.has(a.line_id)) addAsset(a.id);
      else if (a.substation_id && substationIds.has(a.substation_id)) addAsset(a.id);
    }
    for (const t of towerById.values()) {
      if (towerIds.has(t.id)) addLine(t.line_id);
      if (t.line_id && lineIds.has(t.line_id)) addTower(t.id);
    }
    for (const l of lineById.values()) {
      if (lineIds.has(l.id)) { addSub(l.from_substation_id); addSub(l.to_substation_id); }
    }
    if (!changed) break;
  }


  const memberIds = memberIdsForCrews(crewIds, false, null);
  if (user.person_id) memberIds.add(user.person_id);
  for (const id of substationIds) { const s = substationById.get(id); if (s && s.region_id != null) regionIds.add(s.region_id); }
  for (const id of lineIds) { const r = lineRegion(id); if (r != null) regionIds.add(r); }
  const validationIds = validationIdsFor(taskIds, memberIds, substationIds, lineIds, towerIds, assetIds);
  return { global: false, crewIds, taskIds, scheduleIds, regionIds, substationIds, lineIds, towerIds, assetIds, memberIds, validationIds };
}

const _scopeCache = new WeakMap();

function commandScope(user) {
  if (!user) return emptyScope();
  const cached = _scopeCache.get(user);
  if (cached) return cached;
  const scope = commandScopeOf(user);
  _scopeCache.set(user, scope);
  return scope;
}

module.exports = {
  FUNCTIONAL_CREW_TYPES,
  OT_UNIT_TYPES,
  LEGACY_MANAGER_ROLES,
  MANAGER_ROLES,
  isManager,
  unitSubtree,
  managedUnitIds,
  headedUnitId,
  userUnitId,
  reconcileOrgAuthority,
  reconcileCrewOrgUnits,
  crewsForPerson,
  isFunctionalCrew,
  userHasFunctionalScope,
  regionWideRead,
  authorizedCrewIds,
  readCrewIds,
  canAssignCrew,
  canViewCrew,
  canManageUnit,
  taskVisible,
  taskDomain,
  managerDomains,
  assetDomainOf,
  domainLabel,
  regionBoundaryFor,
  pointInRegionBoundary,
  lineInRegionBoundary,
  commandScope,
};
