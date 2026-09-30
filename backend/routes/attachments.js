const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../db');
const { get } = require('../util');
const { can, isCrewUser, isGlobal, isOnCrew, audit } = require('../auth');
const { taskVisible } = require('../authority');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 8 * 1024 * 1024;

function loadTaskOr403(req, res) {
  const t = get('task', Number(req.params.id));
  if (!t) { res.status(404).json({ error: 'Task not found' }); return null; }
  if (!taskVisible(req.user, t)) { res.status(404).json({ error: 'Task not found' }); return null; }
  return t;
}

function personName(id) {
  if (!id) return null;
  const p = db.prepare('SELECT first_name, last_name FROM person WHERE id = ?').get(id);
  return p ? [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null : null;
}

// ---------------- Findings (ad-hoc on-site observations, append-only) --------
// A crew lead records findings against their own task; management users review
// them on the task / execution. Findings never mutate master checklist items.
router.post('/tasks/:id/findings', (req, res) => {
  if (!can(req, 'task:amend')) return res.status(403).json({ error: 'Forbidden: requires task:amend' });
  const t = loadTaskOr403(req, res);
  if (!t) return;
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Finding title is required' });
  const now = new Date().toISOString();
  // Cross-link the finding to the infrastructure/equipment/item it concerns.
  // The task's own target is the default so a finding is never orphaned.
  const assetId = req.body.asset_id != null && req.body.asset_id !== '' ? Number(req.body.asset_id) : (t.asset_id || null);
  const towerId = req.body.tower_id != null && req.body.tower_id !== '' ? Number(req.body.tower_id) : (t.tower_id || null);
  const equipmentName = req.body.equipment_name ? String(req.body.equipment_name).trim().slice(0, 120) : null;
  const checklistItemId = req.body.checklist_item_id != null && req.body.checklist_item_id !== '' ? Number(req.body.checklist_item_id) : null;
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO task_finding (task_id, execution_id, crew_id, created_by, title, detail, severity, lat, lng, captured_at, revision, asset_id, tower_id, equipment_name, checklist_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(
    t.id,
    req.body.execution_id || null,
    req.body.crew_id || t.crew_id || null,
    req.user.person_id || null,
    title,
    req.body.detail || null,
    ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(req.body.severity) ? req.body.severity : 'INFO',
    req.body.lat ?? null,
    req.body.lng ?? null,
    req.body.captured_at || now,
    assetId,
    towerId,
    equipmentName,
    checklistItemId
  );
  const f = db.prepare('SELECT * FROM task_finding WHERE id = ?').get(id);
  res.status(201).json({ ...f, created_by_name: personName(f.created_by) });
});

// ---------------- Attachments (photo / file upload, real bytes) -------------
router.post('/tasks/:id/attachments', (req, res) => {
  if (!can(req, 'attachment:write')) return res.status(403).json({ error: 'Forbidden: requires attachment:write' });
  const t = loadTaskOr403(req, res);
  if (!t) return;
  if (isCrewUser(req.user) && !isOnCrew(req.user, t.crew_id)) {
    return res.status(403).json({ error: 'Forbidden: not your assigned task' });
  }
  const data = req.body.data || req.body.base64;
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'No base64 data supplied' });
  let buf;
  try {
    buf = Buffer.from(data, 'base64');
  } catch (_) {
    return res.status(400).json({ error: 'Invalid base64 payload' });
  }
  if (buf.length === 0) return res.status(400).json({ error: 'Empty file payload' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'File exceeds 8 MB limit' });

  const orig = String(req.body.file_name || req.body.name || 'upload').trim();
  const ext = path.extname(orig).slice(0, 10).toLowerCase();
  const stored = `${crypto.randomUUID()}${ext || '.bin'}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);

  const now = new Date().toISOString();
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO attachment (task_id, execution_id, checklist_item_id, created_by, kind, file_name, stored_name, mime, size_bytes, lat, lng, accuracy_m, captured_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.id,
    req.body.execution_id || null,
    req.body.checklist_item_id || null,
    req.user.person_id || null,
    ['PHOTO', 'DOC', 'OTHER'].includes(req.body.kind) ? req.body.kind : 'PHOTO',
    orig,
    stored,
    req.body.mime || 'application/octet-stream',
    buf.length,
    req.body.lat ?? null,
    req.body.lng ?? null,
    req.body.accuracy_m ?? null,
    req.body.captured_at || now,
    req.body.note || null
  );
  const a = db.prepare('SELECT id, task_id, execution_id, checklist_item_id, created_by, kind, file_name, mime, size_bytes, lat, lng, accuracy_m, captured_at, note FROM attachment WHERE id = ?').get(id);
  res.status(201).json({ ...a, created_by_name: personName(a.created_by) });
});

function listForTask(taskId) {
  return db.prepare(
    `SELECT id, task_id, execution_id, checklist_item_id, created_by, kind, file_name, mime, size_bytes,
            lat, lng, accuracy_m, captured_at, note FROM attachment WHERE task_id = ? ORDER BY id`
  ).all(taskId).map((a) => ({ ...a, created_by_name: personName(a.created_by) }));
}

router.get('/tasks/:id/attachments', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: 'Forbidden: requires task:read' });
  const t = loadTaskOr403(req, res);
  if (!t) return;
  res.json(listForTask(t.id));
});

router.get('/tasks/:id/attachments/:attId/file', (req, res) => {
  if (!can(req, 'task:read')) return res.status(403).json({ error: 'Forbidden: requires task:read' });
  const t = loadTaskOr403(req, res);
  if (!t) return;
  const a = db.prepare('SELECT * FROM attachment WHERE id = ? AND task_id = ?').get(Number(req.params.attId), t.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  const file = path.join(UPLOAD_DIR, path.basename(a.stored_name));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Attachment file missing' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.file_name)}"`);
  fs.createReadStream(file).pipe(res);
});

// DELETE rule (never blanket): the uploader, the crew lead of the owning task,
// or a global (admin/executive) role may remove a specific attachment.
router.delete('/tasks/:id/attachments/:attId', (req, res) => {
  const t = loadTaskOr403(req, res);
  if (!t) return;
  const a = db.prepare('SELECT * FROM attachment WHERE id = ? AND task_id = ?').get(Number(req.params.attId), t.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });
  const isLead = req.user.role === 'CREW_LEAD' && isCrewUser(req.user) && isOnCrew(req.user, t.crew_id);
  const isAuthor = a.created_by && a.created_by === req.user.person_id;
  if (!(isGlobal(req.user) || isLead || isAuthor)) {
    return res.status(403).json({ error: 'Forbidden: only the uploader, the task crew lead, or an admin may remove this attachment' });
  }
  const file = path.join(UPLOAD_DIR, path.basename(a.stored_name));
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { /* keep DB row consistent even if file already gone */ }
  db.prepare('DELETE FROM attachment WHERE id = ?').run(a.id);
  audit(req.user, 'DELETE', 'attachment', a.id, { task_id: t.id, file_name: a.file_name, kind: a.kind });
  res.json({ ok: true, id: a.id });
});

module.exports = { router, listForTask };
