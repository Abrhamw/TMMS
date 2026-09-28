const express = require('express');
const { db, insertRow, safeDelete } = require('../util');
const { can, audit } = require('../auth');
const { taskVisible, commandScope } = require('../authority');

const router = express.Router();

const ENTITY_TABLES = {
  task: 'task',
  asset: 'asset',
  gps_validation: 'gps_validation',
};

// A commenter must be able to at least read the entity they are commenting on.
function canReadEntity(user, entityType, entityId) {
  const scope = commandScope(user);
  if (entityType === 'task') {
    const t = db.prepare('SELECT * FROM task WHERE id = ?').get(entityId);
    if (!t) return false;
    return taskVisible(user, t);
  }
  if (entityType === 'asset') {
    if (scope.global) return !!db.prepare('SELECT id FROM asset WHERE id = ?').get(entityId);
    return scope.assetIds.has(entityId);
  }
  if (entityType === 'gps_validation') {
    if (scope.global) return !!db.prepare('SELECT id FROM gps_validation WHERE id = ?').get(entityId);
    return scope.validationIds.has(entityId);
  }
  return false;
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
  const { entity_type, entity_id } = req.query;
  if (!entity_type || !ENTITY_TABLES[entity_type]) return res.status(400).json({ error: 'entity_type must be one of: task, asset, gps_validation' });
  if (!canReadEntity(req.user, entity_type, Number(entity_id))) return res.status(403).json({ error: 'Forbidden: no read access to this entity' });
  const rows = db.prepare('SELECT * FROM comment WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC').all(entity_type, Number(entity_id));
  res.json(rows.map(rowToComment));
});

router.post('/comments', (req, res) => {
  const { entity_type, entity_id, body } = req.body;
  if (!entity_type || !ENTITY_TABLES[entity_type]) return res.status(400).json({ error: 'entity_type must be one of: task, asset, gps_validation' });
  if (!entity_id || !body || !String(body).trim()) return res.status(400).json({ error: 'entity_id and body are required' });
  if (req.user.role === 'VIEWER') return res.status(403).json({ error: 'Forbidden: viewers cannot post comments' });
  if (!db.prepare(`SELECT id FROM ${ENTITY_TABLES[entity_type]} WHERE id = ?`).get(Number(entity_id))) {
    return res.status(404).json({ error: 'Entity not found' });
  }
  if (!canReadEntity(req.user, entity_type, Number(entity_id))) return res.status(403).json({ error: 'Forbidden: no read access to this entity' });
  const now = new Date().toISOString();
  const id = insertRow('comment', {
    entity_type, entity_id: Number(entity_id), user_id: req.user.id, body: String(body).trim(),
    created_at: now, updated_at: now,
  });
  audit(req.user, 'CREATE', 'comment', id, { entity_type, entity_id: Number(entity_id) });
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
