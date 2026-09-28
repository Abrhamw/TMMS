const express = require('express');
const { db, get } = require('../util');
const { hashPassword, hasPerm, audit } = require('../auth');

const router = express.Router();

const CONFIG_KEYS = ['language', 'unit_system', 'grid_frequency_hz', 'currency', 'date_locale', 'timezone'];

// ---------------------------------------------------------------------------
// System settings (system_config)
// ---------------------------------------------------------------------------
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM system_config').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

router.put('/settings', (req, res) => {
  if (!hasPerm(req.user, 'settings:write') && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden: requires settings:write' });
  }
  const body = req.body || {};
  const changes = {};
  for (const k of CONFIG_KEYS) {
    if (body[k] !== undefined && body[k] !== null) {
      db.prepare('INSERT INTO system_config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(k, String(body[k]));
      changes[k] = String(body[k]);
    }
  }
  audit(req.user, 'UPDATE', 'system_config', null, changes);
  const rows = db.prepare('SELECT key, value FROM system_config').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

// ---------------------------------------------------------------------------
// Audit log (AUDITOR/ADMIN)
// ---------------------------------------------------------------------------
router.get('/audit', (req, res) => {
  if (!hasPerm(req.user, 'audit:read') && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden: requires audit:read' });
  }
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// User management (ADMIN only)
// ---------------------------------------------------------------------------
router.get('/users', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(
    `SELECT u.id, u.username, u.role, u.region_id, u.active, u.created_at, u.person_id,
            p.first_name, p.last_name, p.title
     FROM user u LEFT JOIN person p ON p.id = u.person_id ORDER BY u.id`
  ).all();
  res.json(rows);
});

router.post('/users', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  const { username, password, role, region_id, person_id, active } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  const pwd = String(password || '').trim();
  if (!uname || !pwd || !role) return res.status(400).json({ error: 'username, password, role required' });
  const exists = db.prepare('SELECT id FROM user WHERE lower(username) = lower(?)').get(uname);
  if (exists) return res.status(409).json({ error: 'username already exists' });
  const id = db.prepare(
    'INSERT INTO user (username, password_hash, person_id, role, region_id, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(uname, hashPassword(pwd), person_id || null, role, region_id || null, active === undefined ? 1 : active, new Date().toISOString()).lastInsertRowid;
  audit(req.user, 'CREATE', 'user', id, { username: uname, role, region_id });
  res.status(201).json({ id });
});

router.patch('/users/:id', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  const { password, role, region_id, active, person_id } = req.body || {};
  const existing = get('user', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updates = {};
  if (role !== undefined) updates.role = role;
  if (region_id !== undefined) updates.region_id = region_id || null;
  if (active !== undefined) updates.active = active ? 1 : 0;
  if (person_id !== undefined) updates.person_id = person_id || null;
  if (password) updates.password_hash = hashPassword(String(password).trim());
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE user SET ${sets} WHERE id = ?`).run(...Object.values(updates), Number(req.params.id));
  }
  const { password_hash, ...auditUpdates } = updates;
  audit(req.user, 'UPDATE', 'user', Number(req.params.id), auditUpdates);
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const existing = get('user', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM session WHERE user_id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM user WHERE id = ?').run(Number(req.params.id));
  audit(req.user, 'DELETE', 'user', Number(req.params.id), { username: existing.username });
  res.json({ ok: true });
});

module.exports = router;
