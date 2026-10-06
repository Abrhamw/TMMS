const crypto = require('node:crypto');
const { db } = require('./db');

// ---------------------------------------------------------------------------
// Password hashing (scrypt, salted)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const actual = Buffer.from(hash, 'hex');
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}

// ---------------------------------------------------------------------------
// Sessions (opaque bearer tokens stored in DB)
// ---------------------------------------------------------------------------
const MAX_SESSIONS_PER_USER = 10;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 3600 * 1000).toISOString();
  // Bound the session table: drop expired sessions as we go.
  db.prepare('DELETE FROM session WHERE expires_at <= ?').run(now.toISOString());
  // Cap concurrent active sessions per account, keeping the most recent ones.
  const active = db.prepare('SELECT id FROM session WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(userId);
  if (active.length >= MAX_SESSIONS_PER_USER) {
    const stale = active.slice(MAX_SESSIONS_PER_USER - 1).map((s) => s.id);
    if (stale.length) db.prepare(`DELETE FROM session WHERE id IN (${stale.map(() => '?').join(',')})`).run(...stale);
  }
  db.prepare('INSERT INTO session (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now.toISOString(), expires);
  return token;
}

function revokeUserSessions(userId) {
  if (!userId) return 0;
  return db.prepare('DELETE FROM session WHERE user_id = ?').run(userId).changes || 0;
}

function destroySession(token) {
  db.prepare('DELETE FROM session WHERE token = ?').run(token);
}

function getUserFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM session WHERE token = ? AND expires_at > ?').get(token, new Date().toISOString());
  if (!s) return null;
  const u = db.prepare(
    `SELECT u.id, u.username, u.role, u.region_id, u.person_id, u.active, u.created_at,
            p.first_name, p.last_name, p.title, p.email
     FROM user u LEFT JOIN person p ON p.id = u.person_id WHERE u.id = ?`
  ).get(s.user_id);
  if (!u || !u.active) return null;
  const crews = getUserCrews(u);
  if (crews.length) u.crew_id = crews[0].id;
  u.crew_ids = crews.map((c) => c.id);
  return u;
}

// Every crew a person belongs to, whether they lead it or serve on its active
// roster. A person can stand on more than one crew, so callers must not assume a
// single home crew; `getUserCrew` keeps the previous "primary" pick for labels.
function getUserCrews(user) {
  if (!user || !user.person_id) return [];
  return db.prepare(
    `SELECT * FROM crew
     WHERE leader_person_id = ? OR id IN (SELECT crew_id FROM crew_member WHERE person_id = ? AND active = 1)
     ORDER BY CASE WHEN leader_person_id = ? THEN 0 ELSE 1 END, id`
  ).all(user.person_id, user.person_id, user.person_id);
}

function getUserCrew(user) {
  return getUserCrews(user)[0] || null;
}

// The crews a user may act on. Reads `crew_ids` when the session resolver set it
// and falls back to the single primary crew, so hand-built user objects (tests,
// legacy callers) keep working.
function userCrewIds(user) {
  if (!user) return new Set();
  if (Array.isArray(user.crew_ids)) return new Set(user.crew_ids);
  return new Set(user.crew_id ? [user.crew_id] : []);
}

// True when the user stands on the given crew (as leader or active member).
function isOnCrew(user, crewId) {
  return crewId !== null && crewId !== undefined && userCrewIds(user).has(Number(crewId));
}

// ---------------------------------------------------------------------------
// RBAC permission matrix
// ---------------------------------------------------------------------------
const GLOBAL_ROLES = new Set(['ADMIN', 'EXECUTIVE', 'VIEWER', 'AUDITOR']);

// Crew (field) roles that are scoped to their own crew/region rather than a
// full region read. CREW_LEAD = run work + submit + amend findings;
// CREW_MEMBER = capture checklist readings/GPS/photos only.
const CREW_ROLES = new Set(['FIELD_CREW', 'CREW_LEAD', 'CREW_MEMBER']);

const READ_PERMS = [
  'dashboard:read', 'map:read', 'region:read', 'substation:read', 'line:read', 'tower:read',
  'asset:read', 'task:read', 'crew:read', 'people:read', 'cert:read', 'schedule:read',
  'checklist:read', 'gps:read', 'geofence:read', 'report:read', 'settings:read',
];

// Task workflow permissions granted to the management roles of the Transmission
// business-unit hierarchy (executive -> region directors -> maintenance
// managers -> supervisors). Field crews keep the operational execute/lead
// capture permissions; record creation of master data (regions, substations,
// lines, towers, assets, checklists, users) remains ADMIN-only.
const TASK_WORKFLOW = ['task:create', 'task:assign', 'task:verify', 'task:manage'];

// Management roles plan + run the operational lifecycle: task creation,
// scheduling (incl. generation), crew assignment, verification, comment back
// (reopen) and reporting. Master-data writes stay ADMIN-only.
const OPERATIONS_WORKFLOW = [...TASK_WORKFLOW, 'schedule:write', 'schedule:run', 'report:write', 'asset:evaluate', 'task:bulk', 'geofence:write', 'gps:review'];

// Base reads a field person needs to view their assignments and targets.
const FIELD_READS = [
  'dashboard:read', 'map:read', 'region:read', 'substation:read', 'line:read', 'tower:read',
  'asset:read', 'task:read', 'gps:read', 'geofence:read', 'cert:read',
];

// Department heads run the operational lifecycle AND capture field evidence
// for checklists they own (execution, GPS, attachments), but the full
// lead/submit flow stays with crew leads.
const REGION_MANAGER_PERMS = new Set([
  ...READ_PERMS, ...OPERATIONS_WORKFLOW, 'task:execute', 'gps:write', 'attachment:write',
]);

const ROLE_PERMS = {
  ADMIN: new Set(['*']),
  EXECUTIVE: new Set([...READ_PERMS, ...OPERATIONS_WORKFLOW, 'audit:read']),
  VIEWER: new Set(READ_PERMS),
  AUDITOR: new Set([...READ_PERMS, 'report:write', 'audit:read']),
  REGION_DIRECTOR: new Set([...READ_PERMS, ...OPERATIONS_WORKFLOW]),
  REGION_MANAGER: REGION_MANAGER_PERMS,
  // Operational Technology department head (and its child departments).
  OT_MANAGER: REGION_MANAGER_PERMS,
  // Legacy department-head role names remain valid aliases.
  SUBSTATION_MANAGER: REGION_MANAGER_PERMS,
  TRANSMISSION_MANAGER: REGION_MANAGER_PERMS,
  RELAY_SCADA_MANAGER: REGION_MANAGER_PERMS,
  SUPERVISOR: new Set([...READ_PERMS, ...OPERATIONS_WORKFLOW]),
  // Planner: plans recurring work (schedule write/run) and drives the task
  // lifecycle, including the crew handoff (`task:assign`). Verification stays
  // with management so the plan is independently checked.
  PLANNER: new Set([...READ_PERMS, 'task:create', 'task:assign', 'task:manage', 'schedule:write', 'schedule:run', 'task:bulk']),
  // Dispatcher: raises and assigns ad-hoc/allotted work and may expand due
  // schedules (`schedule:run`), but does not author plans or verify them.
  DISPATCHER: new Set([...READ_PERMS, 'task:create', 'task:assign', 'schedule:run']),
  // Crew lead: run the assigned work, start/submit it, hold/reopen, and record
  // ad-hoc on-site findings and pictures.
  CREW_LEAD: new Set([...FIELD_READS, 'task:execute', 'task:start', 'task:lead', 'task:amend', 'gps:write', 'attachment:write']),
  // Crew member: perform the field capture on the assigned task — start work,
  // checklist readings, GPS confirmation, photos — but the lead submits the
  // run for verification and amends findings.
  CREW_MEMBER: new Set([...FIELD_READS, 'task:execute', 'task:start', 'gps:write', 'attachment:write']),
  // Legacy field role kept working; maps to crew-lead duties.
  FIELD_CREW: new Set([...FIELD_READS, 'task:execute', 'task:start', 'task:lead', 'task:amend', 'gps:write', 'attachment:write']),
};

function hasPerm(user, perm) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  const set = ROLE_PERMS[user.role];
  return !!set && (set.has('*') || set.has(perm));
}

function inRegion(user, regionId) {
  if (!user) return false;
  if (GLOBAL_ROLES.has(user.role)) return true;
  // A row with no region (e.g. an unassigned or malformed record) is not
  // visible to a region-scoped user. Lists already hide it via scopeRows, so
  // deny it here too rather than letting a direct id lookup slip through.
  if (regionId === undefined || regionId === null) return false;
  return user.region_id === regionId;
}

function isGlobal(user) {
  return GLOBAL_ROLES.has(user.role);
}

// Field / crew users are scoped to their own crew (and region) rather than the
// whole region read granted to management roles.
function isCrewUser(user) {
  return !!user && CREW_ROLES.has(user.role);
}

// Role-string check for the same crew set, for callers that only have a role.
function isCrewRole(role) {
  return CREW_ROLES.has(role);
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  req.token = token;
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!hasPerm(req.user, perm)) {
      return res.status(403).json({ error: `Forbidden: requires '${perm}'` });
    }
    next();
  };
}

function can(req, perm) {
  return hasPerm(req.user, perm);
}

function checkRegion(req, res, regionId) {
  if (!inRegion(req.user, regionId)) {
    res.status(403).json({ error: 'Forbidden: resource is outside your region scope' });
    return false;
  }
  return true;
}

// Filter a list of rows by the user's region scope. `getRegion` extracts region id from a row.
function scopeRows(user, rows, getRegion) {
  if (isGlobal(user)) return rows;
  return rows.filter((r) => getRegion(r) === user.region_id);
}

// Keys whose values must never be written to the audit log, plus large string
// fields (attachment base64, GPS blobs) that only bloat the log.
const AUDIT_REDACT = new Set(['password', 'password_hash', 'token', 'secret', 'data', 'content', 'file']);
const AUDIT_MAX_STRING = 200;
const AUDIT_MAX_JSON = 4000;

function sanitizeAuditValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > AUDIT_MAX_STRING ? `<string len=${value.length}>` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeAuditValue(v, depth + 1));
  if (depth >= 3) return '<object>';
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = AUDIT_REDACT.has(k.toLowerCase()) ? '<redacted>' : sanitizeAuditValue(v, depth + 1);
  }
  return out;
}

// Audit helper — logs every mutating action with the acting user.
function audit(user, action, entity, entityId, detail) {
  try {
    const actor = user ? (user.username || `${user.first_name} ${user.last_name}`.trim() || 'system') : 'anonymous';
    let safeDetail = null;
    if (detail) {
      const clean = sanitizeAuditValue(detail);
      const json = JSON.stringify(clean);
      safeDetail = json.length > AUDIT_MAX_JSON
        ? JSON.stringify({ truncated: true, keys: Object.keys(detail) })
        : json;
    }
    db.prepare('INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?)')
      .run(actor, action, entity, entityId, safeDetail, new Date().toISOString());
  } catch (_) {
    /* non-fatal */
  }
}

function auditMiddleware(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400 && req.user) {
        audit(req.user, `${req.method} ${req.originalUrl}`, req.baseUrl || req.path, null, req.body || {});
      }
    });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  revokeUserSessions,
  destroySession,
  getUserFromToken,
  getUserCrew,
  getUserCrews,
  userCrewIds,
  isOnCrew,
  hasPerm,
  inRegion,
  isGlobal,
  isCrewUser,
  isCrewRole,
  requireAuth,
  requirePerm,
  can,
  checkRegion,
  scopeRows,
  audit,
  auditMiddleware,
  GLOBAL_ROLES,
  CREW_ROLES,
  ROLE_PERMS,
  REGION_MANAGER_PERMS,
  READ_PERMS,
};
