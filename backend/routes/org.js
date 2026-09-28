const express = require('express');
const { db, list, get, insertRow, updateRow, safeDelete } = require('../util');
const { can, audit } = require('../auth');
const { isManager, userUnitId, unitSubtree, authorizedCrewIds, readCrewIds, regionWideRead } = require('../authority');

const router = express.Router();

const UNIT_TYPES = [
  'CORPORATE', 'BUSINESS_UNIT', 'DIVISION', 'REGION_DIRECTORATE',
  'DEPARTMENT', 'SUBSTATION_UNIT',
  'SUBSTATION_MAINTENANCE', 'TRANSMISSION_MAINTENANCE', 'RELAY_SCADA_TELECOM',
  'OPERATIONAL_TECHNOLOGY', 'OT_PROTECTION_CONTROL', 'OT_SCADA_AUTOMATION', 'OT_TELECOM_FIBER',
];

function unitDetail(u, crewScope = null) {
  const out = { ...u };
  out.region = u.region_id ? get('region', u.region_id) : null;
  out.parent = u.parent_id ? get('org_unit', u.parent_id) : null;
  out.manager = u.manager_person_id ? get('person', u.manager_person_id) : null;
  let crews = db.prepare('SELECT * FROM crew WHERE org_unit_id = ? ORDER BY name').all(u.id);
  if (crewScope) crews = crews.filter((c) => crewScope.has(c.id));
  out.crews = crews;
  return out;
}

// A manager sees their chain of command: the org subtree they head, with the
// crews they are authorized to command. A region manager reads their whole
// region's units and crews. Global roles and non-manager roles keep the full tree.
function managerScope(user) {
  if (!isManager(user)) return null;
  if (regionWideRead(user)) {
    const units = new Set(list('org_unit').filter((u) => u.region_id === user.region_id).map((u) => u.id));
    return { units, crews: readCrewIds(user) };
  }
  const unitId = userUnitId(user);
  return {
    units: unitId ? new Set(unitSubtree(unitId)) : new Set(),
    crews: authorizedCrewIds(user),
  };
}

// Nested org tree for the Organization page.
function buildTree(user) {
  const scope = managerScope(user);
  const crewScope = scope ? scope.crews : null;
  let units = list('org_unit');
  if (scope) units = units.filter((u) => scope.units.has(u.id));
  units = units.map((u) => unitDetail(u, crewScope));
  const byId = new Map(units.map((u) => [u.id, u]));
  const roots = [];
  for (const u of units) {
    const parent = u.parent_id ? byId.get(u.parent_id) : null;
    if (parent) {
      (parent.children = parent.children || []).push(u);
    } else {
      roots.push(u);
    }
  }
  const sort = (nodes) => {
    nodes.sort((a, b) => a.sort_order - b.sort_order || (a.name || '').localeCompare(b.name || ''));
    for (const n of nodes) if (n.children) sort(n.children);
    return nodes;
  };
  return sort(roots);
}

router.get('/org-units', (req, res) => {
  const scope = managerScope(req.user);
  const crewScope = scope ? scope.crews : null;
  let units = list('org_unit');
  if (scope) units = units.filter((u) => scope.units.has(u.id));
  res.json(units.map((u) => unitDetail(u, crewScope)));
});

router.get('/org-tree', (req, res) => {
  res.json(buildTree(req.user));
});

router.get('/org-units/:id', (req, res) => {
  const u = get('org_unit', Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Org unit not found' });
  const scope = managerScope(req.user);
  if (scope && !scope.units.has(u.id)) {
    return res.status(403).json({ error: 'Forbidden: unit is outside your authority' });
  }
  const crewScope = scope ? scope.crews : null;
  const d = unitDetail(u, crewScope);
  d.children = list('org_unit')
    .filter((c) => c.parent_id === d.id && (!scope || scope.units.has(c.id)))
    .map((c) => unitDetail(c, crewScope));
  d.personnel = db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.title, p.email, rp.role
     FROM person p LEFT JOIN region_personnel rp ON rp.person_id = p.id AND rp.region_id = ?
     WHERE p.org_unit_id = ? OR p.id = ?
     ORDER BY p.last_name`
  ).all(d.region_id, d.id, d.manager_person_id);
  res.json(d);
});

router.post('/org-units', (req, res) => {
  if (!can(req, 'settings:write')) return res.status(403).json({ error: 'Forbidden: requires settings:write' });
  const { unit_code, name, unit_type, parent_id, region_id, manager_person_id, sort_order, notes } = req.body;
  if (!unit_code || !name || !unit_type) return res.status(400).json({ error: 'unit_code, name and unit_type are required' });
  if (!UNIT_TYPES.includes(unit_type)) return res.status(400).json({ error: `unit_type must be one of ${UNIT_TYPES.join(', ')}` });
  const id = insertRow('org_unit', {
    unit_code, name, unit_type, parent_id: parent_id || null, region_id: region_id || null,
    manager_person_id: manager_person_id || null, sort_order: sort_order || 0, notes: notes || null,
  });
  audit(req.user, 'CREATE', 'org_unit', id, { unit_code, name, unit_type });
  res.status(201).json(unitDetail(get('org_unit', id)));
});

router.put('/org-units/:id', (req, res) => {
  if (!can(req, 'settings:write')) return res.status(403).json({ error: 'Forbidden: requires settings:write' });
  const u = get('org_unit', Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Org unit not found' });
  const patch = {};
  for (const k of ['unit_code', 'name', 'unit_type', 'parent_id', 'region_id', 'manager_person_id', 'sort_order', 'notes']) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  updateRow('org_unit', u.id, patch);
  audit(req.user, 'UPDATE', 'org_unit', u.id, patch);
  res.json(unitDetail(get('org_unit', u.id)));
});

router.delete('/org-units/:id', (req, res) => {
  if (!can(req, 'settings:write')) return res.status(403).json({ error: 'Forbidden: requires settings:write' });
  const u = get('org_unit', Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Org unit not found' });
  const children = db.prepare('SELECT COUNT(*) c FROM org_unit WHERE parent_id = ?').get(u.id).c;
  if (children > 0) return res.status(409).json({ error: 'Org unit has child units; reassign them first' });
  safeDelete('org_unit', u.id);
  audit(req.user, 'DELETE', 'org_unit', u.id, { name: u.name });
  res.json({ ok: true });
});

module.exports = router;
module.exports.UNIT_TYPES = UNIT_TYPES;
