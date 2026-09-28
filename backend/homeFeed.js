const { db, list, get } = require('./util');
const { isGlobal, isCrewUser, isCrewRole, getUserCrew, userCrewIds, isOnCrew, hasPerm } = require('./auth');
const { taskVisible, readCrewIds, commandScope, authorizedCrewIds } = require('./authority');
const { roleFunction, ownedBuckets, BUCKETS } = require('./operatingModel');

const OPEN = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
const CLOSED = ['COMPLETED', 'FAILED', 'CANCELLED'];
const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const CAP = 25;
// The "assigned" lens is a portfolio view of active crew work, so it shows more
// rows than the action buckets before folding.
const ASSIGNED_CAP = 50;
// A per-bucket detail request returns the whole bucket so the client can group
// it; the cap is only a guard against an unbounded response.
const DETAIL_CAP = 500;
const HISTORY_DAYS = 30;
const CERT_DAYS = 90;

// A crew that is already named on a planned task must still see it as upcoming
// work, so SCHEDULED counts alongside the assigned/started states.
const CREW_MEMBER_STATUSES = ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'];
const CREW_LEAD_STATUSES = ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];
const MANAGER_ROLES = [
  'REGION_DIRECTOR', 'REGION_MANAGER', 'OT_MANAGER', 'SUBSTATION_MANAGER',
  'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER', 'SUPERVISOR',
];

function personaFor(role) {
  if (isCrewRole(role)) return 'crew';
  if (['PLANNER', 'DISPATCHER'].includes(role)) return 'planner';
  if (role === 'AUDITOR') return 'auditor';
  if (MANAGER_ROLES.includes(role)) return 'manager';
  if (role === 'VIEWER') return 'viewer';
  return 'executive';
}

function has(user, perm) {
  return hasPerm(user, perm);
}

function canManage(user) { return has(user, 'task:manage'); }
function canAssign(user) { return has(user, 'task:assign'); }
function canStart(user) { return has(user, 'task:start'); }
function canLead(user) { return has(user, 'task:lead'); }

// The next legal step for this user. The API remains authoritative; this is a
// label + suggested action only. VIEWER is always read-only.
function primaryAction(user, t) {
  if (user.role === 'VIEWER') return 'open';
  switch (t.status) {
    case 'DRAFT':
      return canAssign(user) || canManage(user) ? 'schedule' : 'open';
    case 'SCHEDULED':
      return !t.crew_id && canAssign(user) ? 'assign' : 'open';
    case 'ASSIGNED':
      return canStart(user) || canManage(user) ? 'start' : 'open';
    case 'IN_PROGRESS':
      if (canLead(user) || canManage(user)) return 'submit';
      return has(user, 'task:execute') ? 'capture' : 'open';
    case 'ON_HOLD':
      return canLead(user) || canManage(user) ? 'resume' : 'open';
    case 'PENDING_VERIFICATION':
      return has(user, 'task:verify') ? 'verify' : 'open';
    default:
      return 'open';
  }
}

function whereLabel(t) {
  if (t.tower_id) { const tw = get('tower', t.tower_id); if (tw) return tw.tower_id; }
  if (t.asset_id) { const a = get('asset', t.asset_id); if (a) return a.name; }
  if (t.substation_id) { const s = get('substation', t.substation_id); if (s) return s.name; }
  if (t.line_id) { const l = get('transmission_line', t.line_id); if (l) return l.name; }
  return '—';
}

function crewOf(t) {
  if (!t.crew_id) return null;
  const c = get('crew', t.crew_id);
  return { id: t.crew_id, name: c ? c.name : null };
}

function isOverdue(t, now) {
  return !!t.due_date && t.due_date < now && OPEN.includes(t.status);
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const ad = a.due_date || '9999-12-31';
    const bd = b.due_date || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (pr !== 0) return pr;
    return a.id - b.id;
  });
}

function reasonFor(user, t, now) {
  if (t.status === 'PENDING_VERIFICATION') return 'Needs verification';
  if (isOverdue(t, now)) return 'Overdue';
  if (t.status === 'SCHEDULED' && !t.crew_id) return 'No crew assigned';
  if (t.status === 'DRAFT') return 'Draft to finish';
  if (isCrewUser(user)) return 'Assigned to your crew';
  return 'Waiting on you';
}

function taskItem(user, t, now, { withReason = true, action = null } = {}) {
  return {
    kind: 'task',
    id: t.id,
    task_number: t.task_number,
    title: t.title,
    task_type: t.task_type,
    priority: t.priority,
    status: t.status,
    due_date: t.due_date,
    overdue: isOverdue(t, now),
    where: whereLabel(t),
    crew: crewOf(t),
    reason: withReason ? reasonFor(user, t, now) : null,
    primary_action: action || primaryAction(user, t),
  };
}

function visibleTasks(user, rows) {
  const scope = commandScope(user);
  if (scope.global) return rows;
  return rows.filter((t) => scope.taskIds.has(t.id));
}

// Human label for a raw code that comes from the database (an asset type).
function humanize(code) {
  return String(code || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function nameOf(table, id) {
  const row = id ? get(table, id) : null;
  return row ? row.name : null;
}

// A task can name a tower, an asset, a substation or a line directly, or only
// through its asset. Resolve the four grouping facets once per task so the
// Home cards can be broken into sub-categories (status, type, substation,
// transmission line, asset category) without a query per group.
function taskFacets(t) {
  const asset = t.asset_id ? get('asset', t.asset_id) : null;
  let subId = t.substation_id || null;
  let lineId = t.line_id || null;
  if (!subId && asset && asset.substation_id) subId = asset.substation_id;
  if (!lineId && asset && asset.line_id) lineId = asset.line_id;
  if (!lineId && t.tower_id) {
    const tw = get('tower', t.tower_id);
    if (tw && tw.line_id) lineId = tw.line_id;
  }
  return {
    status: t.status,
    task_type: t.task_type,
    substation: subId ? { key: String(subId), label: nameOf('substation', subId) || `#${subId}` } : null,
    line: lineId ? { key: String(lineId), label: nameOf('transmission_line', lineId) || `#${lineId}` } : null,
    asset: asset ? { key: asset.asset_type, label: humanize(asset.asset_type) } : null,
  };
}

// Shared read context for a bucket query: the visible task set and the crew a
// crew user belongs to. Built once per request so several buckets do not each
// re-read the task table.
function taskContext(user, now) {
  const all = list('task');
  return {
    user,
    now,
    all,
    vis: visibleTasks(user, all),
    crewIds: userCrewIds(user),
  };
}

// Raw (uncapped) task rows that belong to one role bucket. This is the single
// definition of bucket membership, shared by the Home feed and the per-bucket
// detail endpoint so a card's count and its sub-categories can never diverge.
function bucketRows(ctx, key) {
  const { user, all, vis, crewIds, now } = ctx;
  if (key === 'execute') {
    if (!crewIds.size) return [];
    const statuses = user.role === 'CREW_MEMBER' ? CREW_MEMBER_STATUSES : CREW_LEAD_STATUSES;
    return all.filter((t) => crewIds.has(t.crew_id) && statuses.includes(t.status));
  }
  if (key === 'schedule') return vis.filter((t) => t.status === 'DRAFT');
  if (key === 'assign') return vis.filter((t) => (t.status === 'SCHEDULED' || t.status === 'ASSIGNED') && !t.crew_id);
  // Work already handed to a crew the user commands: the manager/director
  // lens on active assignments. Emergency stays in its own bucket.
  if (key === 'assigned') {
    const crews = authorizedCrewIds(user);
    return all.filter((t) => taskVisible(user, t) && t.crew_id && crews.has(t.crew_id) && t.task_type !== 'EMERGENCY'
      && ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status));
  }
  if (key === 'verify') return vis.filter((t) => t.status === 'PENDING_VERIFICATION');
  if (key === 'emergency') return vis.filter((t) => t.task_type === 'EMERGENCY' && OPEN.includes(t.status));
  if (key === 'audit') return vis.filter((t) => t.status === 'PENDING_VERIFICATION');
  if (key === 'oversight') return vis.filter((t) => t.priority === 'CRITICAL' && OPEN.includes(t.status) && isOverdue(t, now));
  return [];
}

function failedGpsItems(user, now, limit) {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  let rows = db.prepare(
    "SELECT * FROM gps_validation WHERE (result = 'FAIL' OR inside_geofence = 0 OR violation IS NOT NULL) AND (review_status IS NULL OR review_status NOT IN ('RESOLVED','REJECTED')) AND validated_at >= ? ORDER BY validated_at DESC"
  ).all(cutoff);
  const scope = commandScope(user);
  if (!scope.global) rows = rows.filter((v) => scope.validationIds.has(v.id));
  return rows.slice(0, limit).map((v) => ({
    kind: 'gps',
    id: v.id,
    title: `GPS ${v.result || 'REVIEW'} on ${v.target_type} #${v.target_id}`,
    status: v.result,
    due_date: v.validated_at,
    overdue: true,
    where: v.target_type,
    crew: null,
    reason: 'GPS failed',
    primary_action: 'open',
    href: '/gps',
  }));
}

function expiringCertItems(user, limit) {
  let certs = list('certification');
  if (!isGlobal(user)) {
    const people = new Set();
    const crewIds = readCrewIds(user);
    for (const c of list('crew').filter((c) => crewIds.has(c.id))) {
      if (c.leader_person_id) people.add(c.leader_person_id);
      for (const m of db.prepare('SELECT person_id FROM crew_member WHERE crew_id = ?').all(c.id)) people.add(m.person_id);
    }
    if (user.person_id) people.add(user.person_id);
    certs = certs.filter((c) => people.has(c.person_id));
  }
  const horizon = new Date(Date.now() + CERT_DAYS * 864e5).toISOString();
  return certs.filter((c) => c.expires_at <= horizon)
    .sort((a, b) => a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : 0)
    .slice(0, limit).map((c) => {
    const expired = c.expires_at < new Date().toISOString();
    return {
      kind: 'cert',
      id: c.id,
      title: `${c.cert_type} — ${c.person_id ? `person #${c.person_id}` : 'crew'}`,
      status: expired ? 'EXPIRED' : 'EXPIRING',
      due_date: c.expires_at,
      overdue: expired,
      where: 'Certification',
      crew: null,
      reason: expired ? 'Cert expired' : 'Cert expiring',
      primary_action: 'open',
      href: '/certifications',
    };
  });
}

function inboxFor(user, now) {
  const items = [];
  const all = list('task');

  if (isCrewUser(user)) {
    const crewIds = userCrewIds(user);
    if (!crewIds.size) return [];
    const statuses = user.role === 'CREW_MEMBER' ? CREW_MEMBER_STATUSES : CREW_LEAD_STATUSES;
    all.filter((t) => crewIds.has(t.crew_id) && statuses.includes(t.status))
      .forEach((t) => items.push(taskItem(user, t, now)));
    return sortItems(items).slice(0, CAP);
  }

  if (['PLANNER', 'DISPATCHER'].includes(user.role)) {
    visibleTasks(user, all).filter((t) => t.status === 'DRAFT' || (t.status === 'SCHEDULED' && !t.crew_id))
      .forEach((t) => items.push(taskItem(user, t, now)));
  } else if (MANAGER_ROLES.includes(user.role)) {
    all.filter((t) => taskVisible(user, t)).filter((t) =>
      (OPEN.includes(t.status) && isOverdue(t, now)) ||
      t.status === 'PENDING_VERIFICATION' ||
      (t.status === 'SCHEDULED' && !t.crew_id)
    ).forEach((t) => items.push(taskItem(user, t, now)));
  } else if (user.role === 'AUDITOR') {
    visibleTasks(user, all).filter((t) => t.status === 'PENDING_VERIFICATION').forEach((t) => items.push(taskItem(user, t, now)));
    items.push(...failedGpsItems(user, now, CAP));
  } else {
    // EXECUTIVE, ADMIN, VIEWER — exceptions only.
    visibleTasks(user, all).filter((t) => t.priority === 'CRITICAL' && OPEN.includes(t.status) && isOverdue(t, now))
      .forEach((t) => items.push(taskItem(user, t, now)));
    items.push(...failedGpsItems(user, now, CAP));
    items.push(...expiringCertItems(user, CAP));
  }

  return sortItems(items).slice(0, CAP);
}

function isMineCrew(user, t) {
  return isOnCrew(user, t.crew_id);
}

function isMine(user, t, execIds) {
  if (isCrewUser(user) && isMineCrew(user, t)) return true;
  if (user.person_id && [t.created_by, t.assigned_by, t.verified_by].includes(user.person_id)) return true;
  if (user.person_id && execIds.has(t.id)) return true;
  return false;
}

function executedTaskIds(user) {
  if (!user.person_id) return new Set();
  return new Set(
    db.prepare('SELECT DISTINCT task_id FROM checklist_execution WHERE executed_by = ?')
      .all(user.person_id).map((r) => r.task_id)
  );
}

function areaRows(user, rows) {
  if (isGlobal(user)) return rows;
  if (isCrewUser(user)) {
    const c = getUserCrew(user);
    const rid = (c && c.region_id) || user.region_id;
    return rows.filter((t) => t.region_id === rid);
  }
  return visibleTasks(user, rows);
}

function historyFor(user, now, execIds) {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  const closed = list('task')
    .filter((t) => CLOSED.includes(t.status))
    .filter((t) => (t.actual_end || t.updated_at || t.created_at || '') >= cutoff);
  const newestFirst = (a, b) => {
    const ad = a.actual_end || a.updated_at || a.created_at || '';
    const bd = b.actual_end || b.updated_at || b.created_at || '';
    if (ad !== bd) return ad < bd ? 1 : -1;
    return b.id - a.id;
  };
  const mine = closed.filter((t) => isMine(user, t, execIds)).sort(newestFirst).slice(0, CAP)
    .map((t) => taskItem(user, t, now, { withReason: false, action: 'open' }));
  const area = areaRows(user, closed).sort(newestFirst).slice(0, CAP)
    .map((t) => taskItem(user, t, now, { withReason: false, action: 'open' }));
  return { mine, area };
}

function personName(user) {
  if (!user) return '';
  const p = user.person_id ? get('person', user.person_id) : null;
  if (p) return `${p.first_name} ${p.last_name}`.trim();
  return user.username || '';
}

function personTitle(user) {
  const person = user && user.person_id ? get('person', user.person_id) : null;
  return person ? person.title || person.role || null : null;
}

function scopeFor(user) {
  const crew = isCrewUser(user) ? getUserCrew(user) : null;
  const region = user.region_id ? get('region', user.region_id) : null;
  return {
    crew: crew ? { id: crew.id, name: crew.name } : null,
    region: region ? { id: region.id, name: region.name } : null,
    global: isGlobal(user),
  };
}

// Role-separated task buckets. Each owned bucket holds only the tasks that
// belong to that function, so the Home view never merges "to schedule" with
// "to assign", "to verify", execution and emergency work.
function bucketsFor(user, now) {
  const ctx = taskContext(user, now);
  const owned = ownedBuckets(user);
  const primary = roleFunction(user).bucket;
  const ordered = primary && owned.includes(primary) ? [primary, ...owned.filter((k) => k !== primary)] : owned;
  return ordered.map((key) => {
    const rows = bucketRows(ctx, key);
    return {
      ...BUCKETS[key],
      primary: key === primary,
      readOnly: key === 'audit',
      canCreate: key === 'emergency' && hasPerm(user, 'task:create'),
      count: rows.length,
      items: rows.map((t) => taskItem(user, t, now)).slice(0, key === 'assigned' ? ASSIGNED_CAP : CAP),
    };
  });
}

// Everything an expanded Home card needs: the full task set for a bucket plus
// the facets that let the UI break it into sub-categories. Access is limited to
// the buckets the user's role owns, so this never widens what /home exposes.
function bucketDetail(user, key, now = new Date().toISOString()) {
  if (!BUCKETS[key] || !ownedBuckets(user).includes(key)) return null;
  const ctx = taskContext(user, now);
  const rows = bucketRows(ctx, key);
  const items = sortItems(rows.map((t) => {
    const it = taskItem(user, t, now);
    it.facets = taskFacets(t);
    return it;
  }));
  return {
    ...BUCKETS[key],
    primary: key === roleFunction(user).bucket,
    readOnly: key === 'audit',
    canCreate: key === 'emergency' && hasPerm(user, 'task:create'),
    count: rows.length,
    items: items.slice(0, DETAIL_CAP),
  };
}

function buildHome(user) {
  const now = new Date().toISOString();
  const execIds = executedTaskIds(user);
  return {
    name: personName(user),
    title: personTitle(user),
    role: user.role,
    persona: personaFor(user.role),
    function: roleFunction(user),
    scope: scopeFor(user),
    inbox: inboxFor(user, now),
    buckets: bucketsFor(user, now),
    history: historyFor(user, now, execIds),
  };
}

module.exports = { personaFor, primaryAction, sortItems, buildHome, bucketDetail };
