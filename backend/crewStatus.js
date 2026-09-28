const { db } = require('./util');

const CREW_STATUS_OVERRIDES = ['AVAILABLE', 'OFF_DUTY', 'UNAVAILABLE'];
const ON_TASK_STATES = ['IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];
const ASSIGNED_STATES = ['ASSIGNED', 'SCHEDULED', 'DRAFT'];

function deriveCrewStatus(crewId, useOverride = true) {
  const crew = db.prepare('SELECT id, status_override FROM crew WHERE id = ?').get(crewId);
  if (!crew) return 'AVAILABLE';
  if (useOverride && crew.status_override) return crew.status_override;
  const rows = db.prepare(
    "SELECT status FROM task WHERE crew_id = ? AND status NOT IN ('COMPLETED','CANCELLED','FAILED')"
  ).all(crewId);
  const statuses = new Set(rows.map((r) => r.status));
  if (ON_TASK_STATES.some((s) => statuses.has(s))) return 'ON_TASK';
  if (ASSIGNED_STATES.some((s) => statuses.has(s))) return 'ASSIGNED';
  return 'AVAILABLE';
}

function syncCrewStatus(crewId) {
  if (!crewId) return null;
  const crew = db.prepare('SELECT id FROM crew WHERE id = ?').get(crewId);
  if (!crew) return null;
  const status = deriveCrewStatus(crewId);
  db.prepare('UPDATE crew SET status = ? WHERE id = ?').run(status, crewId);
  return status;
}

module.exports = { deriveCrewStatus, syncCrewStatus, CREW_STATUS_OVERRIDES };
