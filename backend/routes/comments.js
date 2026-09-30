const express = require('express');
const { db, insertRow, safeDelete } = require('../util');
const { can, audit, isGlobal } = require('../auth');
const { taskVisible, commandScope } = require('../authority');

const router = express.Router();

// Every entity a comment can be tagged to. Numeric entities carry a row id;
// name-keyed entities (equipment) carry their name in `entity_ref` instead.
const ENTITY_TABLES = {
  task: 'task',
  crew: 'crew',
  asset: 'asset',
  tower: 'tower',
  substation: 'substation',
  transmission_line: 'transmission_line',
  report: 'report',
  gps_validation: 'gps_validation',
  finding: 'task_finding',
};
const NAME_ENTITIES = new Set(['equipment']);
const ENTITY_TYPES = [...Object.keys(ENTITY_TABLES), ...NAME_ENTITIES];

function entityExists(entityType, entityId, entityRef) {
  if (entityType === 'equipment') return knownEquipment(entityRef);
  const table = ENTITY_TABLES[entityType];
  if (!table) return false;
  return !!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(entityId);
}

// Equipment has no master table; it is a free-form name used by equipment
// checks and checklist test equipment. A target is "known" when it appears in
// either place, so comments cannot be scattered onto typos.
function knownEquipment(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const direct = db.prepare('SELECT 1 FROM task_equipment_check WHERE equipment_name = ? LIMIT 1').get(n);
  if (direct) return true;
  const items = db.prepare("SELECT test_equipment FROM checklist_item WHERE test_equipment IS NOT NULL AND test_equipment <> ''").all();
  for (const it of items) {
    if (String(it.test_equipment).split(',').map((s) => s.trim()).includes(n)) return true;
  }
  return false;
}

function canReadReport(req, entityId) {
  if (!can(req, 'report:read')) return false;
  const r = db.prepare('SELECT scope_region_id FROM report WHERE id = ?').get(entityId);
  if (!r) return false;
  if (isGlobal(req.user)) return true;
  if (r.scope_region_id == null) return true;
  return commandScope(req.user).regionIds.has(r.scope_region_id);
}

// A commenter must be able to at least read the entity they are commenting on.
function canReadEntity(req, entityType, entityId, entityRef) {
  const scope = commandScope(req.user);
  if (scope.global) return entityExists(entityType, entityId, entityRef);
  switch (entityType) {
    case 'task': {
      const t = db.prepare('SELECT * FROM task WHERE id = ?').get(entityId);
      return !!t && taskVisible(req.user, t);
    }
    case 'finding': {
      const f = db.prepare('SELECT task_id FROM task_finding WHERE id = ?').get(entityId);
      if (!f) return false;
      const t = db.prepare('SELECT * FROM task WHERE id = ?').get(f.task_id);
      return !!t && taskVisible(req.user, t);
    }
    case 'asset': return scope.assetIds.has(entityId);
    case 'crew': return scope.crewIds.has(entityId);
    case 'tower': return scope.towerIds.has(entityId);
    case 'substation': return scope.substationIds.has(entityId);
    case 'transmission_line': return scope.lineIds.has(entityId);
    case 'gps_validation': return scope.validationIds.has(entityId);
    case 'report': return canReadReport(req, entityId);
    case 'equipment': return knownEquipment(entityRef);
    default: return false;
  }
}

function normalizeRef(entityType, entityRef) {
  return NAME_ENTITIES.has(entityType) ? String(entityRef || '').trim() : null;
}

function rowToComment(c) {
  const u = db.prepare('SELECT username, role, person_id FROM user WHERE id = ?').get(c.user_id);
  const person = u && u.person_id ? db.prepare('SELECT first_name, last_name FROM person WHERE id = ?').get(u.person_id) : null;
  return {
    ...c,
    author: u ? { username: u.username, role: u.role, name: person ? `${person.first_name} ${person.last_name}` : u.username } : null,
  };
}

router.get('/comments', (req, res) => {
  const { entity_type, entity_ref } = req.query;
  if (!entity_type || !ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `entity_type must be one of: ${ENTITY_TYPES.join(', ')}` });
  }
  const entityId = Number(req.query.entity_id);
  const ref = normalizeRef(entity_type, entity_ref);
  if (NAME_ENTITIES.has(entity_type)) {
    if (!ref) return res.status(400).json({ error: 'entity_ref is required for this entity type' });
  } else if (!Number.isFinite(entityId) || entityId <= 0) {
    return res.status(400).json({ error: 'entity_id is required' });
  }
  if (!canReadEntity(req, entity_type, entityId, ref)) return res.status(403).json({ error: 'Forbidden: no read access to this entity' });
  const rows = NAME_ENTITIES.has(entity_type)
    ? db.prepare('SELECT * FROM comment WHERE entity_type = ? AND entity_ref = ? ORDER BY created_at ASC').all(entity_type, ref)
    : db.prepare('SELECT * FROM comment WHERE entity_type = ? AND entity_id = ? AND entity_ref IS NULL ORDER BY created_at ASC').all(entity_type, entityId);
  res.json(rows.map(rowToComment));
});

router.post('/comments', (req, res) => {
  const { entity_type, body } = req.body;
  if (!entity_type || !ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `entity_type must be one of: ${ENTITY_TYPES.join(', ')}` });
  }
  const entityId = Number(req.body.entity_id);
  const ref = normalizeRef(entity_type, req.body.entity_ref);
  if (NAME_ENTITIES.has(entity_type)) {
    if (!ref) return res.status(400).json({ error: 'entity_ref is required for this entity type' });
  } else if (!Number.isFinite(entityId) || entityId <= 0) {
    return res.status(400).json({ error: 'entity_id is required' });
  }
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'body is required' });
  if (req.user.role === 'VIEWER') return res.status(403).json({ error: 'Forbidden: viewers cannot post comments' });
  if (!entityExists(entity_type, entityId, ref)) return res.status(404).json({ error: 'Entity not found' });
  if (!canReadEntity(req, entity_type, entityId, ref)) return res.status(403).json({ error: 'Forbidden: no read access to this entity' });
  const now = new Date().toISOString();
  const id = insertRow('comment', {
    entity_type,
    entity_id: NAME_ENTITIES.has(entity_type) ? 0 : entityId,
    entity_ref: ref,
    user_id: req.user.id,
    body: String(body).trim(),
    created_at: now,
    updated_at: now,
  });
  audit(req.user, 'CREATE', 'comment', id, { entity_type, entity_id: NAME_ENTITIES.has(entity_type) ? null : entityId, entity_ref: ref });
  res.status(201).json(rowToComment(db.prepare('SELECT * FROM comment WHERE id = ?').get(id)));
});

router.delete('/comments/:id', (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT * FROM comment WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  if (c.user_id !== req.user.id && !can(req, 'settings:write')) {
    return res.status(403).json({ error: 'Forbidden: only the author or an admin may delete this comment' });
  }
  safeDelete('comment', id);
  audit(req.user, 'DELETE', 'comment', id, {});
  res.json({ ok: true });
});

module.exports = router;
