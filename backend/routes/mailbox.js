const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, get, insertRow, updateRow } = require('../util');
const { isGlobal, isCrewUser, isOnCrew, hasPerm } = require('../auth');
const { authorizedCrewIds, taskVisible } = require('../authority');

const router = express.Router();
const OPEN = new Set(['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION']);
const CLOSED = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// Uploaded mail attachments reuse the task-attachment storage directory.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;


// Short, at-a-glance chips for a task thread (status, type, urgency, overdue).
function taskTags(task, nowIso) {
  const tags = [task.status, task.task_type].filter(Boolean);
  if (['HIGH', 'CRITICAL'].includes(task.priority)) tags.push(task.priority);
  if (OPEN.has(task.status) && task.due_date && task.due_date < nowIso) tags.push('OVERDUE');
  return [...new Set(tags)];
}

function reportTags(report) {
  return [report.report_type, report.status].filter(Boolean);
}


function taskRows(user) {
  return db.prepare('SELECT * FROM task ORDER BY updated_at DESC, id DESC').all()
    .filter((task) => taskVisible(user, task));
}

function taskInvolvement(user, task) {
  if (isCrewUser(user) && isOnCrew(user, task.crew_id)) return true;
  if (task.crew_id && authorizedCrewIds(user).has(task.crew_id)) return true;
  if (user.person_id && [task.created_by, task.assigned_by, task.verified_by].includes(user.person_id)) return true;
  if (user.person_id && db.prepare('SELECT 1 FROM checklist_execution WHERE task_id = ? AND executed_by = ? LIMIT 1').get(task.id, user.person_id)) return true;
  if (db.prepare('SELECT 1 FROM comment c JOIN user u ON u.id = c.user_id WHERE c.entity_type = \'task\' AND c.entity_id = ? AND c.user_id = ? LIMIT 1').get(task.id, user.id)) return true;
  return false;
}

function latestActivity(task) {
  const taskId = task.id;
  const comment = db.prepare(
    `SELECT c.created_at, c.body, u.username, p.first_name, p.last_name
       FROM comment c JOIN user u ON u.id = c.user_id
       LEFT JOIN person p ON p.id = u.person_id
      WHERE c.entity_type = 'task' AND c.entity_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1`
  ).get(taskId);
  const audit = db.prepare(
    `SELECT created_at, action, actor, detail FROM audit_log
      WHERE entity = 'task' AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(taskId);
  const rows = [];
  if (comment) rows.push({
    at: comment.created_at,
    kind: 'COMMENT',
    actor: [comment.first_name, comment.last_name].filter(Boolean).join(' ') || comment.username,
    actor_key: comment.username,
    summary: comment.body,
  });
  if (audit) {
    let detail = {};
    try { detail = JSON.parse(audit.detail || '{}'); } catch (_) { /* retain generic event */ }
    rows.push({
      at: audit.created_at,
      kind: audit.action,
      actor: audit.actor,
      actor_key: audit.actor,
      summary: detail.action ? `Task ${String(detail.action).replace(/_/g, ' ').toLowerCase()}` : `Task record ${String(audit.action).toLowerCase()}`,
    });
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  if (rows.length) return rows[0];
  return { at: task.updated_at || task.created_at, kind: 'TASK', actor: null, actor_key: null, summary: `Task status: ${task.status}` };
}

function threadSummary(task, user) {
  const line = task.line_id ? get('transmission_line', task.line_id) : null;
  const crew = task.crew_id ? get('crew', task.crew_id) : null;
  const last = latestActivity(task);
  const comments = db.prepare("SELECT COUNT(*) AS count FROM comment WHERE entity_type = 'task' AND entity_id = ?").get(task.id).count;
  const history = db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity = 'task' AND entity_id = ?").get(task.id).count;
  const unreadCount = taskMessageRows(task, user).filter((message) => message.unread).length;
  return {
    id: task.id,
    kind: 'TASK',
    task_number: task.task_number,
    title: task.title,
    status: task.status,
    priority: task.priority,
    task_type: task.task_type,
    due_date: task.due_date,
    updated_at: task.updated_at,
    line_name: line ? line.name : null,
    crew_name: crew ? crew.name : null,
    tags: taskTags(task, new Date().toISOString()),
    link: `/tasks/${task.id}`,
    message_count: comments + history,
    latest: last,
    unread: unreadCount > 0,
    unread_count: unreadCount,
  };
}

function messageWasRead(userId, key) {
  return !!db.prepare('SELECT 1 FROM mailbox_message_read WHERE user_id = ? AND message_key = ?').get(userId, key);
}

function messageRow(user, message) {
  const incoming = !!message.actor_key && message.actor_key !== user.username;
  return {
    ...message,
    unread: incoming && !messageWasRead(user.id, message.key),
  };
}

function taskMessageRows(task, user) {
  const comments = db.prepare(
    `SELECT c.id, c.body, c.created_at, u.username, p.first_name, p.last_name
       FROM comment c JOIN user u ON u.id = c.user_id
       LEFT JOIN person p ON p.id = u.person_id
      WHERE c.entity_type = 'task' AND c.entity_id = ? ORDER BY c.created_at, c.id`
  ).all(task.id).map((row) => ({
    key: `comment-${row.id}`,
    kind: 'COMMENT',
    entity_type: 'task',
    entity_id: task.id,
    task_id: task.id,
    task_number: task.task_number,
    subject: task.title,
    at: row.created_at,
    actor: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.username,
    actor_key: row.username,
    body: row.body,
    tags: taskTags(task, new Date().toISOString()),
    link: `/tasks/${task.id}`,
  }));
  const events = db.prepare(
    `SELECT id, actor, action, detail, created_at
       FROM audit_log WHERE entity = 'task' AND entity_id = ? ORDER BY created_at, id`
  ).all(task.id).map((row) => {
    let detail = {};
    try { detail = JSON.parse(row.detail || '{}'); } catch (_) { /* use generic event wording */ }
    const action = detail.action || row.action;
    return {
      key: `event-${row.id}`,
      kind: 'WORKFLOW',
      entity_type: 'task',
      entity_id: task.id,
      task_id: task.id,
      task_number: task.task_number,
      subject: task.title,
      at: row.created_at,
      actor: row.actor,
      actor_key: row.actor,
      body: `Task workflow: ${String(action).replace(/_/g, ' ').toLowerCase()}`,
      tags: taskTags(task, new Date().toISOString()),
      link: `/tasks/${task.id}`,
    };
  });
  return [...comments, ...events].map((message) => messageRow(user, message));
}

function messagesFor(user, tasks) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const messages = [];
  for (const task of tasks) messages.push(...taskMessageRows(task, user));

  // Reports are a management/oversight surface: only roles holding
  // `report:read` see them in the mailbox. Field crews (which lack the
  // permission) must not receive report messages or unread report badges.
  const reports = hasPerm(user, 'report:read')
    ? db.prepare('SELECT * FROM report ORDER BY generated_at DESC, id DESC').all()
      .filter((report) => isGlobal(user) || !report.scope_region_id || report.scope_region_id === user.region_id)
    : [];
  const reportAudit = db.prepare("SELECT entity_id, actor, created_at FROM audit_log WHERE entity = 'report' AND action = 'GENERATE' ORDER BY id DESC").all();
  const authorByReportId = new Map();
  for (const row of reportAudit) if (!authorByReportId.has(row.entity_id)) authorByReportId.set(row.entity_id, row);
  const reportMessages = reports.map((report) => {
    const authored = authorByReportId.get(report.id);
    const actor = authored?.actor || 'System';
    return messageRow(user, {
      key: `report-${report.id}`,
      kind: 'REPORT',
      entity_type: 'report',
      entity_id: report.id,
      report_id: report.id,
      report_code: report.report_code,
      report_type: report.report_type,
      subject: report.title,
      at: report.generated_at,
      actor,
      actor_key: actor,
      body: `${report.report_type.replace(/_/g, ' ')} report · ${report.period_start.slice(0, 10)} to ${report.period_end.slice(0, 10)}`,
      status: report.status,
      tags: reportTags(report),
      link: `/reports?report=${report.id}`,
    });
  });
  return [...messages, ...reportMessages].sort((a, b) => b.at.localeCompare(a.at));
}

function messageKeyVisible(user, key) {
  let m = /^report-(\d+)$/.exec(key);
  if (m) {
    if (!hasPerm(user, 'report:read')) return false;
    const report = get('report', Number(m[1]));
    if (!report) return false;
    return isGlobal(user) || !report.scope_region_id || report.scope_region_id === user.region_id;
  }
  m = /^comment-(\d+)$/.exec(key);
  if (m) {
    const c = db.prepare('SELECT entity_type, entity_id FROM comment WHERE id = ?').get(Number(m[1]));
    if (!c || c.entity_type !== 'task') return false;
    const task = get('task', c.entity_id);
    return !!task && taskVisible(user, task);
  }
  m = /^event-(\d+)$/.exec(key);
  if (m) {
    const a = db.prepare('SELECT entity, entity_id FROM audit_log WHERE id = ?').get(Number(m[1]));
    if (!a || a.entity !== 'task') return false;
    const task = get('task', a.entity_id);
    return !!task && taskVisible(user, task);
  }
  m = /^mail-(\d+)$/.exec(key);
  if (m) return mailVisible(user, Number(m[1]));
  return false;
}

// ---------------------------------------------------------------------------
// Directed mail. Unlike the task/report stream (read-time aggregation), these
// are real authored rows with a lifecycle: Draft -> (Outbox) -> Sent, filed per
// account into Inbox / Sent / Drafts / Outbox / Archive.
// ---------------------------------------------------------------------------
const MAIL_CATEGORIES = new Set(['GENERAL', 'REPORT', 'EXECUTION', 'REQUEST', 'ALERT']);
const MAIL_PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const MAIL_STATUSES = new Set(['DRAFT', 'QUEUED', 'SENT']);

function personLabel(personId) {
  const p = get('person', Number(personId));
  if (!p) return 'Unknown';
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || `Person ${personId}`;
}

function primaryUserForPerson(personId) {
  return db.prepare('SELECT id, username FROM user WHERE person_id = ? AND active = 1 ORDER BY id LIMIT 1').get(Number(personId)) || null;
}

function personRegionIds(personId) {
  const ids = new Set();
  const add = (rows) => rows.forEach((r) => { if (r.region_id != null) ids.add(r.region_id); });
  add(db.prepare('SELECT DISTINCT region_id FROM user WHERE person_id = ?').all(Number(personId)));
  add(db.prepare('SELECT DISTINCT region_id FROM region_personnel WHERE person_id = ?').all(Number(personId)));
  add(db.prepare('SELECT DISTINCT c.region_id FROM crew c JOIN crew_member m ON m.crew_id = c.id WHERE m.person_id = ?').all(Number(personId)));
  add(db.prepare('SELECT DISTINCT region_id FROM crew WHERE leader_person_id = ?').all(Number(personId)));
  return ids;
}

// A recipient must share the sender's command scope: global users may address
// anyone; a region-scoped user only people rooted in their own region.
function recipientVisible(user, personId) {
  const pid = Number(personId);
  if (!pid) return false;
  if (isGlobal(user)) return true;
  if (pid === user.person_id) return true;
  const regions = personRegionIds(pid);
  return regions.size > 0 && regions.has(user.region_id);
}

// Everyone this account has already exchanged mail with, in either direction.
// Replying must always be able to reach the original sender even when they sit
// outside the account's downward command scope (e.g. a global executive).
function correspondencePersonIds(user) {
  const ids = new Set();
  if (!user.person_id) return ids;
  const rows = db.prepare(
    'SELECT sender_person_id, recipient_person_id FROM message WHERE sender_person_id = ? OR recipient_person_id = ?'
  ).all(user.person_id, user.person_id);
  for (const r of rows) {
    for (const p of [r.sender_person_id, r.recipient_person_id]) {
      if (p && Number(p) !== user.person_id) ids.add(Number(p));
    }
  }
  return ids;
}

// Addressable = inside the command scope, or already a correspondent so a reply
// to the sender is never blocked by the one-way scope rule.
function canAddress(user, personId) {
  return recipientVisible(user, personId) || correspondencePersonIds(user).has(Number(personId));
}

function mailStateFor(userId, messageId) {
  return db.prepare('SELECT read_at, archived_at FROM message_state WHERE user_id = ? AND message_id = ?').get(userId, messageId) || null;
}

// A thread reference is only valid while the parent message still exists.
function validThreadId(value) {
  const id = Number(value);
  if (!id || !Number.isFinite(id)) return null;
  return db.prepare('SELECT id FROM message WHERE id = ?').get(id) ? id : null;
}

function attachmentRowsFor(messageId) {
  return db.prepare(
    `SELECT id, kind, entity_type, entity_id, label, link, file_name, mime, size_bytes, stored_name
       FROM message_attachment WHERE message_id = ? ORDER BY id`
  ).all(Number(messageId)).map((a) => ({
    id: a.id,
    kind: a.kind,
    entity_type: a.entity_type,
    entity_id: a.entity_id,
    label: a.label,
    link: a.link,
    file_name: a.file_name,
    mime: a.mime,
    size_bytes: a.size_bytes,
    has_file: !!a.stored_name,
  }));
}

function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const kinds = new Set(['DOC', 'REPORT', 'EXECUTION', 'TASK', 'ASSET', 'LINE', 'CREW', 'PERSON', 'FILE', 'LINK']);
  return list.slice(0, MAX_ATTACHMENTS).map((a) => {
    if (!a || typeof a !== 'object') return null;
    return {
      id: a.id != null && Number.isFinite(Number(a.id)) ? Number(a.id) : null,
      kind: kinds.has(a.kind) ? a.kind : 'DOC',
      entity_type: a.entity_type ? String(a.entity_type).slice(0, 40) : null,
      entity_id: a.entity_id != null && Number.isFinite(Number(a.entity_id)) ? Number(a.entity_id) : null,
      label: a.label ? String(a.label).slice(0, 200) : null,
      link: a.link ? String(a.link).slice(0, 400) : null,
      file_name: a.file_name ? String(a.file_name).slice(0, 200) : null,
      mime: a.mime ? String(a.mime).slice(0, 120) : null,
      data: typeof a.data === 'string' ? a.data : null,
    };
  }).filter(Boolean);
}

// Replace a message's attachments. Existing rows kept by id; new files are
// written to disk; removed files are unlinked so storage does not leak.
function saveAttachments(messageId, list) {
  const mid = Number(messageId);
  const existing = db.prepare('SELECT * FROM message_attachment WHERE message_id = ?').all(mid);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const keep = new Set();
  const now = new Date().toISOString();
  for (const a of list) {
    if (!a) continue;
    if (a.id != null && byId.has(a.id)) { keep.add(a.id); continue; }
    let stored = null;
    let size = null;
    if (a.data) {
      let buf;
      try { buf = Buffer.from(a.data, 'base64'); } catch (_) { continue; }
      if (!buf.length || buf.length > MAX_ATTACH_BYTES) continue;
      const ext = path.extname(a.file_name || '').slice(0, 10).toLowerCase();
      stored = `${crypto.randomUUID()}${ext || '.bin'}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
      size = buf.length;
    } else if (!a.link && a.entity_id == null) {
      continue;
    }
    const id = insertRow('message_attachment', {
      message_id: mid,
      kind: a.kind || 'DOC',
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      label: a.label,
      link: a.link,
      file_name: a.file_name,
      stored_name: stored,
      mime: a.mime || (stored ? 'application/octet-stream' : null),
      size_bytes: size,
      created_at: now,
    });
    keep.add(Number(id));
  }
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    if (e.stored_name) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(e.stored_name))); } catch (_) { /* row still removed */ }
    }
    db.prepare('DELETE FROM message_attachment WHERE id = ?').run(e.id);
  }
}

function mailRow(user, m, state) {
  const resolved = state || mailStateFor(user.id, m.id);
  const incoming = Number(m.recipient_person_id) === user.person_id;
  return {
    key: `mail-${m.id}`,
    id: m.id,
    kind: 'MAIL',
    entity_type: 'message',
    entity_id: m.id,
    subject: m.subject || '(no subject)',
    body: m.body,
    at: m.sent_at || m.updated_at || m.created_at,
    created_at: m.created_at,
    updated_at: m.updated_at,
    sent_at: m.sent_at || null,
    actor: personLabel(m.sender_person_id),
    actor_key: `person-${m.sender_person_id}`,
    sender_person_id: m.sender_person_id,
    recipient: personLabel(m.recipient_person_id),
    recipient_person_id: m.recipient_person_id,
    category: m.category,
    priority: m.priority,
    status: m.status,
    outgoing: !incoming,
    link: m.link || null,
    thread_id: m.thread_id || null,
    attachments: attachmentRowsFor(m.id),
    tags: [m.category, m.priority !== 'NORMAL' ? m.priority : null].filter(Boolean),
    unread: incoming && m.status === 'SENT' && !resolved?.read_at,
    archived: !!resolved?.archived_at,
  };
}

function mailFolders(user) {
  const outgoing = db.prepare(
    'SELECT * FROM message WHERE sender_user_id = ? ORDER BY COALESCE(sent_at, updated_at, created_at) DESC, id DESC'
  ).all(user.id);
  const incoming = user.person_id
    ? db.prepare('SELECT * FROM message WHERE recipient_person_id = ? ORDER BY COALESCE(sent_at, created_at) DESC, id DESC').all(user.person_id)
    : [];
  const states = new Map(db.prepare('SELECT message_id, read_at, archived_at FROM message_state WHERE user_id = ?').all(user.id).map((s) => [s.message_id, s]));
  const row = (m) => mailRow(user, m, states.get(m.id));
  const archived = new Map();
  for (const m of [...incoming, ...outgoing]) if (states.get(m.id)?.archived_at) archived.set(m.id, m);
  return {
    inbox: incoming.filter((m) => m.status === 'SENT' && !states.get(m.id)?.archived_at).map(row),
    outbox: outgoing.filter((m) => m.status === 'QUEUED' && !states.get(m.id)?.archived_at).map(row),
    sent: outgoing.filter((m) => m.status === 'SENT' && !states.get(m.id)?.archived_at).map(row),
    drafts: outgoing.filter((m) => m.status === 'DRAFT' && !states.get(m.id)?.archived_at).map(row),
    archive: [...archived.values()].sort((a, b) => String(b.sent_at || b.updated_at).localeCompare(String(a.sent_at || a.updated_at))).map(row),
  };
}

function mailVisible(user, id) {
  const m = db.prepare('SELECT sender_user_id, recipient_person_id FROM message WHERE id = ?').get(Number(id));
  if (!m) return false;
  return m.sender_user_id === user.id || (user.person_id && m.recipient_person_id === user.person_id);
}

function mailParticipant(user, id) {
  const m = get('message', Number(id));
  if (!m) return null;
  if (m.sender_user_id !== user.id && !(user.person_id && m.recipient_person_id === user.person_id)) return null;
  return m;
}

function loadMailVisible(req, res) {
  const m = mailParticipant(req.user, req.params.id);
  if (!m) { res.status(404).json({ error: 'Message not found' }); return null; }
  return m;
}

router.get('/mailbox/recipients', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const rows = db.prepare(
    `SELECT u.username, u.role, p.id AS person_id, p.first_name, p.last_name, p.title
       FROM user u JOIN person p ON p.id = u.person_id
      WHERE u.active = 1 AND p.active = 1
      ORDER BY p.first_name, p.last_name`
  ).all();
  const seen = new Map();
  const correspondents = correspondencePersonIds(req.user);
  for (const r of rows) {
    if (!recipientVisible(req.user, r.person_id) && !correspondents.has(Number(r.person_id))) continue;
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
    if (q && !`${name} ${r.username} ${r.role} ${r.title || ''}`.toLowerCase().includes(q)) continue;
    if (!seen.has(r.person_id)) seen.set(r.person_id, { person_id: r.person_id, name, role: r.role, title: r.title, username: r.username });
  }
  res.json([...seen.values()]);
});

router.post('/mailbox/messages', (req, res) => {
  const body = req.body || {};
  const rid = Number(body.recipient_person_id || body.recipient_id);
  if (!rid) return res.status(400).json({ error: 'Recipient is required' });
  if (!get('person', rid)) return res.status(404).json({ error: 'Recipient not found' });
  if (!canAddress(req.user, rid)) return res.status(403).json({ error: 'Recipient is outside your command scope' });
  const status = MAIL_STATUSES.has(String(body.status)) ? String(body.status) : 'SENT';
  const subject = String(body.subject || '').trim().slice(0, 200);
  const text = String(body.body || '').trim().slice(0, 20000);
  if (!subject && !text) return res.status(400).json({ error: 'A subject or message body is required' });
  if (status === 'SENT' && !subject) return res.status(400).json({ error: 'A subject is required to send a message' });
  const now = new Date().toISOString();
  const recipientUser = primaryUserForPerson(rid);
  const id = insertRow('message', {
    sender_user_id: req.user.id,
    sender_person_id: req.user.person_id || null,
    recipient_person_id: rid,
    recipient_user_id: recipientUser ? recipientUser.id : null,
    subject,
    body: text,
    category: MAIL_CATEGORIES.has(body.category) ? body.category : 'GENERAL',
    priority: MAIL_PRIORITIES.has(body.priority) ? body.priority : 'NORMAL',
    status,
    entity_type: body.entity_type || null,
    entity_id: body.entity_id ? Number(body.entity_id) : null,
    link: body.link || null,
    thread_id: validThreadId(body.thread_id),
    created_at: now,
    updated_at: now,
    sent_at: status === 'SENT' ? now : null,
  });
  if (body.attachments !== undefined) saveAttachments(id, sanitizeAttachments(body.attachments));
  res.status(201).json(mailRow(req.user, get('message', id)));
});

router.put('/mailbox/messages/:id', (req, res) => {
  const m = loadMailVisible(req, res);
  if (!m) return;
  if (m.sender_user_id !== req.user.id) return res.status(403).json({ error: 'Only the sender can edit this message' });
  if (m.status === 'SENT') return res.status(409).json({ error: 'A sent message cannot be edited' });
  const body = req.body || {};
  const patch = {};
  if (body.subject !== undefined) patch.subject = String(body.subject || '').trim().slice(0, 200);
  if (body.body !== undefined) patch.body = String(body.body || '').trim().slice(0, 20000);
  if (body.recipient_person_id !== undefined || body.recipient_id !== undefined) {
    const rid = Number(body.recipient_person_id || body.recipient_id);
    if (!rid || !get('person', rid)) return res.status(404).json({ error: 'Recipient not found' });
    if (!canAddress(req.user, rid)) return res.status(403).json({ error: 'Recipient is outside your command scope' });
    patch.recipient_person_id = rid;
    const ru = primaryUserForPerson(rid);
    patch.recipient_user_id = ru ? ru.id : null;
  }
  if (body.thread_id !== undefined) patch.thread_id = validThreadId(body.thread_id);
  if (body.category !== undefined && MAIL_CATEGORIES.has(body.category)) patch.category = body.category;
  if (body.priority !== undefined && MAIL_PRIORITIES.has(body.priority)) patch.priority = body.priority;
  if (body.link !== undefined) patch.link = body.link || null;
  if (body.status !== undefined && MAIL_STATUSES.has(body.status) && body.status !== 'SENT') patch.status = body.status;
  patch.updated_at = new Date().toISOString();
  updateRow('message', m.id, patch);
  if (body.attachments !== undefined) saveAttachments(m.id, sanitizeAttachments(body.attachments));
  res.json(mailRow(req.user, get('message', m.id)));
});

router.post('/mailbox/messages/:id/send', (req, res) => {
  const m = loadMailVisible(req, res);
  if (!m) return;
  if (m.sender_user_id !== req.user.id) return res.status(403).json({ error: 'Only the sender can send this message' });
  if (m.status === 'SENT') return res.json(mailRow(req.user, m));
  const now = new Date().toISOString();
  if (req.body && req.body.subject !== undefined) {
    const subject = String(req.body.subject || '').trim().slice(0, 200);
    if (!subject) return res.status(400).json({ error: 'A subject is required to send a message' });
    updateRow('message', m.id, { subject, updated_at: now });
  }
  if (!get('message', m.id).subject) return res.status(400).json({ error: 'A subject is required to send a message' });
  updateRow('message', m.id, { status: 'SENT', sent_at: now, updated_at: now });
  res.json(mailRow(req.user, get('message', m.id)));
});

router.put('/mailbox/messages/:id/read', (req, res) => {
  const m = loadMailVisible(req, res);
  if (!m) return;
  const readAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO message_state (user_id, message_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET read_at = excluded.read_at`
  ).run(req.user.id, m.id, readAt);
  res.json({ message_id: m.id, read_at: readAt });
});

router.put('/mailbox/messages/:id/archive', (req, res) => {
  const m = loadMailVisible(req, res);
  if (!m) return;
  const archivedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO message_state (user_id, message_id, archived_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, message_id) DO UPDATE SET archived_at = excluded.archived_at`
  ).run(req.user.id, m.id, archivedAt);
  res.json({ message_id: m.id, archived_at: archivedAt });
});

router.put('/mailbox/messages/:id/unarchive', (req, res) => {
  const m = loadMailVisible(req, res);
  if (!m) return;
  db.prepare('UPDATE message_state SET archived_at = NULL WHERE user_id = ? AND message_id = ?').run(req.user.id, m.id);
  res.json({ message_id: m.id, archived_at: null });
});

// Serve a stored attachment to anyone who can see its parent message.
router.get('/mailbox/attachments/:attId/file', (req, res) => {
  const att = db.prepare('SELECT * FROM message_attachment WHERE id = ?').get(Number(req.params.attId));
  if (!att || !att.stored_name || !mailVisible(req.user, att.message_id)) {
    return res.status(404).json({ error: 'Attachment not found' });
  }
  const file = path.join(UPLOAD_DIR, path.basename(att.stored_name));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Attachment file missing' });
  res.setHeader('Content-Type', att.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(att.file_name || 'attachment')}`);
  fs.createReadStream(file).pipe(res);
});

// Remove one attachment from a draft/queued message the caller authored.
router.delete('/mailbox/messages/:id/attachments/:attId', (req, res) => {
  const m = loadMailVisible(req, res);
  if (!m) return;
  if (m.sender_user_id !== req.user.id) return res.status(403).json({ error: 'Only the sender can edit this message' });
  const att = db.prepare('SELECT * FROM message_attachment WHERE id = ? AND message_id = ?').get(Number(req.params.attId), m.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  if (att.stored_name) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(att.stored_name))); } catch (_) { /* row still removed */ }
  }
  db.prepare('DELETE FROM message_attachment WHERE id = ?').run(att.id);
  res.json({ ok: true, id: att.id });
});

// Type-to-filter picker feed for the compose attachment chooser. Returns light
// references (not file bytes) that narrow by `q`, scoped to the caller's command
// chain for tasks/executions.
router.get('/mailbox/attachments/catalog', (req, res) => {
  const type = String(req.query.type || '').toUpperCase();
  const q = String(req.query.q || '').trim().toLowerCase();
  const match = (label, sub) => !q || `${label} ${sub || ''}`.toLowerCase().includes(q);
  const out = [];
  const add = (item) => { if (match(item.label, item.sub)) out.push(item); };
  const limit = 50;

  if (type === 'REPORT') {
    const rows = db.prepare('SELECT id, report_code, title, report_type, scope_region_id FROM report ORDER BY id DESC LIMIT 500').all();
    for (const r of rows) {
      if (!isGlobal(req.user) && r.scope_region_id && r.scope_region_id !== req.user.region_id) continue;
      add({ type: 'REPORT', entity_type: 'REPORT', entity_id: r.id, label: `${r.report_code || 'REPORT'} - ${r.title || ''}`.trim(), sub: r.report_type, link: `/reports?report=${r.id}` });
      if (out.length >= limit) break;
    }
  } else if (type === 'EXECUTION') {
    const rows = db.prepare(
      `SELECT e.id, e.task_id, e.result, e.submitted_at, t.task_number, t.title
         FROM checklist_execution e LEFT JOIN task t ON t.id = e.task_id
        ORDER BY e.id DESC LIMIT 500`
    ).all();
    for (const e of rows) {
      const t = e.task_id ? get('task', e.task_id) : null;
      if (t && !taskVisible(req.user, t)) continue;
      add({ type: 'EXECUTION', entity_type: 'CHECKLIST_EXECUTION', entity_id: e.id, label: `EX-${String(e.id).padStart(5, '0')} - ${e.task_number ? `${e.task_number} ${e.title || ''}` : (e.result || 'Execution')}`.trim(), sub: e.submitted_at, link: e.task_id ? `/tasks/${e.task_id}` : null });
      if (out.length >= limit) break;
    }
  } else if (type === 'TASK') {
    const rows = taskRows(req.user);
    for (const t of rows) {
      add({ type: 'TASK', entity_type: 'TASK', entity_id: t.id, label: `${t.task_number} - ${t.title}`, sub: t.status, link: `/tasks/${t.id}` });
      if (out.length >= limit) break;
    }
  } else if (type === 'ASSET') {
    const rows = db.prepare('SELECT id, asset_id, name FROM asset ORDER BY asset_id LIMIT 500').all();
    for (const a of rows) {
      add({ type: 'ASSET', entity_type: 'ASSET_DETAIL', entity_id: a.id, label: `${a.asset_id}${a.name ? ` - ${a.name}` : ''}`, sub: 'Asset', link: `/reports?document=ASSET_DETAIL&id=${a.id}` });
      if (out.length >= limit) break;
    }
  } else if (type === 'LINE') {
    const rows = db.prepare('SELECT id, line_id, name FROM transmission_line ORDER BY line_id LIMIT 500').all();
    for (const l of rows) {
      add({ type: 'LINE', entity_type: 'LINE_DETAIL', entity_id: l.id, label: `${l.line_id}${l.name ? ` - ${l.name}` : ''}`, sub: 'Line', link: `/reports?document=LINE_DETAIL&id=${l.id}` });
      if (out.length >= limit) break;
    }
  } else if (type === 'CREW') {
    const rows = db.prepare('SELECT id, crew_code, name FROM crew ORDER BY crew_code LIMIT 500').all();
    for (const c of rows) {
      add({ type: 'CREW', entity_type: 'CREW_DETAIL', entity_id: c.id, label: `${c.crew_code || 'CREW'}${c.name ? ` - ${c.name}` : ''}`, sub: 'Crew', link: `/reports?document=CREW_DETAIL&id=${c.id}` });
      if (out.length >= limit) break;
    }
  } else if (type === 'PERSON') {
    const rows = db.prepare('SELECT id, first_name, last_name, role FROM person ORDER BY first_name LIMIT 500').all();
    for (const p of rows) {
      add({ type: 'PERSON', entity_type: 'PERSON_DETAIL', entity_id: p.id, label: `${p.first_name || ''} ${p.last_name || ''}`.trim(), sub: p.role, link: `/reports?document=PERSON_DETAIL&id=${p.id}` });
      if (out.length >= limit) break;
    }
  } else {
    return res.status(400).json({ error: 'Unknown catalog type' });
  }
  res.json({ type, items: out });
});

router.get('/mailbox', (req, res) => {
  const user = req.user;
  const tasks = taskRows(user);
  // The inbox is everything open that reaches this account: `taskRows` already
  // applies the chain-of-command visibility (a crew sees its crew's work, a
  // department manager sees their department's work, a director the region), so
  // re-filtering by personal involvement wrongly hid work assigned to a
  // manager's crews. The extra involvement filter stays on History, which is
  // the record of work this account personally took part in.
  const inbox = tasks.filter((task) => OPEN.has(task.status));
  const sent = tasks.filter((task) => user.person_id && task.created_by === user.person_id);
  const history = tasks.filter((task) => CLOSED.has(task.status) && taskInvolvement(user, task));
  const messages = messagesFor(user, tasks);
  const unreadMessages = messages.filter((message) => message.unread);
  const mail = mailFolders(user);
  const mailUnread = mail.inbox.filter((message) => message.unread).length;
  res.json({
    inbox: inbox.map((task) => threadSummary(task, user)),
    sent: sent.map((task) => threadSummary(task, user)),
    history: history.map((task) => threadSummary(task, user)),
    message_count: messages.length,
    messages,
    unread_messages: unreadMessages,
    unread_count: unreadMessages.length,
    mail_inbox: mail.inbox,
    mail_outbox: mail.outbox,
    mail_sent: mail.sent,
    mail_drafts: mail.drafts,
    mail_archive: mail.archive,
    mail_unread_count: mailUnread,
    mail_counts: {
      inbox: mail.inbox.length,
      outbox: mail.outbox.length,
      sent: mail.sent.length,
      drafts: mail.drafts.length,
      archive: mail.archive.length,
      unread: mailUnread,
    },
  });
});

router.get('/mailbox/summary', (req, res) => {
  const user = req.user;
  const tasks = taskRows(user);
  const messages = messagesFor(user, tasks);
  const unread = messages.filter((message) => message.unread);
  const mail = mailFolders(user);
  const mailUnread = mail.inbox.filter((message) => message.unread).length;
  const byKind = {};
  for (const message of messages) byKind[message.kind] = (byKind[message.kind] || 0) + 1;
  const unreadByKind = {};
  for (const message of unread) unreadByKind[message.kind] = (unreadByKind[message.kind] || 0) + 1;
  res.json({
    unread_count: unread.length + mailUnread,
    inbox_count: tasks.filter((task) => OPEN.has(task.status)).length,
    message_count: messages.length,
    report_count: messages.filter((message) => message.kind === 'REPORT').length,
    by_kind: byKind,
    unread_by_kind: unreadByKind,
    mail_inbox_count: mail.inbox.length,
    mail_outbox_count: mail.outbox.length,
    mail_sent_count: mail.sent.length,
    mail_drafts_count: mail.drafts.length,
    mail_archive_count: mail.archive.length,
    mail_unread_count: mailUnread,
  });
});

router.get('/mailbox/:taskId', (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  if (!task || !taskVisible(req.user, task)) return res.status(404).json({ error: 'Task not found' });
  const comments = db.prepare(
    `SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.role,
            p.first_name, p.last_name
       FROM comment c JOIN user u ON u.id = c.user_id
       LEFT JOIN person p ON p.id = u.person_id
      WHERE c.entity_type = 'task' AND c.entity_id = ? ORDER BY c.created_at, c.id`
  ).all(taskId).map((row) => ({
    id: `comment-${row.id}`,
    kind: 'COMMENT',
    at: row.created_at,
    actor: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.username,
    role: row.role,
    body: row.body,
    task_id: task.id,
    task_number: task.task_number,
    link: `/tasks/${task.id}`,
  }));
  const events = db.prepare(
    `SELECT id, actor, action, detail, created_at
       FROM audit_log WHERE entity = 'task' AND entity_id = ? ORDER BY created_at, id`
  ).all(taskId).map((row) => {
    let detail = {};
    try { detail = JSON.parse(row.detail || '{}'); } catch (_) { /* keep an empty detail */ }
    const action = detail.action || row.action;
    return {
      id: `event-${row.id}`,
      kind: 'WORKFLOW',
      at: row.created_at,
      actor: row.actor,
      action,
      body: `Task workflow: ${String(action).replace(/_/g, ' ').toLowerCase()}`,
      task_id: task.id,
      task_number: task.task_number,
      link: `/tasks/${task.id}`,
    };
  });
  const timeline = [...comments, ...events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  res.json({ task: threadSummary(task, req.user), timeline });
});

router.put('/mailbox/:taskId/read', (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM task WHERE id = ?').get(taskId);
  if (!task || !taskVisible(req.user, task)) return res.status(404).json({ error: 'Task not found' });
  const readAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO mailbox_read (user_id, task_id, read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, task_id) DO UPDATE SET read_at = excluded.read_at`
  ).run(req.user.id, taskId, readAt);
  const messages = taskMessageRows(task, req.user);
  const mark = db.prepare('INSERT INTO mailbox_message_read (user_id, message_key, read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, message_key) DO UPDATE SET read_at = excluded.read_at');
  for (const message of messages) mark.run(req.user.id, message.key, readAt);
  res.json({ task_id: taskId, read_at: readAt });
});

router.put('/mailbox/message/:messageKey/read', (req, res) => {
  const key = String(req.params.messageKey || '');
  if (!messageKeyVisible(req.user, key)) return res.status(404).json({ error: 'Mailbox message not found' });
  const readAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO mailbox_message_read (user_id, message_key, read_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, message_key) DO UPDATE SET read_at = excluded.read_at`
  ).run(req.user.id, key, readAt);
  res.json({ message_key: key, read_at: readAt });
});

module.exports = router;