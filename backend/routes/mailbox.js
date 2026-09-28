const express = require('express');
const { db, get } = require('../util');
const { isGlobal, isCrewUser, isOnCrew, hasPerm } = require('../auth');
const { authorizedCrewIds, taskVisible } = require('../authority');

const router = express.Router();
const OPEN = new Set(['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION']);
const CLOSED = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

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
  return false;
}

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
  res.json({
    inbox: inbox.map((task) => threadSummary(task, user)),
    sent: sent.map((task) => threadSummary(task, user)),
    history: history.map((task) => threadSummary(task, user)),
    message_count: messages.length,
    messages,
    unread_messages: unreadMessages,
    unread_count: unreadMessages.length,
  });
});

router.get('/mailbox/summary', (req, res) => {
  const user = req.user;
  const tasks = taskRows(user);
  const messages = messagesFor(user, tasks);
  const unread = messages.filter((message) => message.unread);
  const byKind = {};
  for (const message of messages) byKind[message.kind] = (byKind[message.kind] || 0) + 1;
  const unreadByKind = {};
  for (const message of unread) unreadByKind[message.kind] = (unreadByKind[message.kind] || 0) + 1;
  res.json({
    unread_count: unread.length,
    inbox_count: tasks.filter((task) => OPEN.has(task.status)).length,
    message_count: messages.length,
    report_count: messages.filter((message) => message.kind === 'REPORT').length,
    by_kind: byKind,
    unread_by_kind: unreadByKind,
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