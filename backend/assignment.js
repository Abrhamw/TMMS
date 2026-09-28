// Crew-to-task fit.
//
// One scoring model shared by the assign-options ranking and the schedule
// generator's automatic pre-assignment, so "the best crew for this task" means
// the same thing everywhere. Decision support only: it ranks crews, it never
// blocks a manual choice.
//
// Relationship with authority: a crew belongs to one org unit (`crew.org_unit_id`)
// and a manager commands the crews in the subtree of the unit they head (see
// `userUnitId`/`authorizedCrewIds`). Auto-assignment therefore only ever
// substitutes a *sibling* crew from the same department subtree, never an
// unrelated crew.

const { db } = require('./util');
const { crewSnapshot } = require('./readiness');
const { evaluateCrew } = require('./dispatch');
const { deriveCrewStatus } = require('./crewStatus');
const { unitSubtree } = require('./authority');

const LOAD_DIVISOR = 8;
const OPEN_TASK_STATES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

function notSelectable(status) {
  return status === 'OFF_DUTY' || status === 'UNAVAILABLE';
}

function openTaskCount(crewId) {
  return db.prepare(
    `SELECT COUNT(*) c FROM task WHERE crew_id = ? AND status IN (${OPEN_TASK_STATES.map(() => '?').join(',')})`
  ).get(Number(crewId), ...OPEN_TASK_STATES).c;
}

// A crew ready for scoring: roster/certs (snapshot) plus the derived status and
// current open load the score needs.
function readyCrew(crewId) {
  const snapshot = crewSnapshot(crewId);
  if (!snapshot) return null;
  const row = db.prepare('SELECT org_unit_id FROM crew WHERE id = ?').get(snapshot.id);
  const status = deriveCrewStatus(snapshot.id);
  return {
    ...snapshot,
    org_unit_id: row ? row.org_unit_id : null,
    status,
    open_task_count: openTaskCount(snapshot.id),
    selectable: !notSelectable(status),
  };
}

// Score a ready crew against a task's checklist requirements. `neededCerts` is
// the legacy per-task-type fallback used when the task names no checklist; the
// score blends certification coverage with current load and skill coverage.
function scoreCrewFit(detail, reqs, neededCerts) {
  const valid = new Set(detail.valid_cert_types || []);
  const needed = neededCerts || [];
  const missing = needed.filter((c) => !valid.has(c));
  const certFactor = needed.length === 0 ? 1 : missing.length === 0 ? 1 : missing.length === needed.length ? 0 : 0.5;
  const loadFactor = Math.max(0, 1 - (detail.open_task_count || 0) / LOAD_DIVISOR);
  const evaluation = reqs ? evaluateCrew(detail, reqs) : null;
  const skillFactor = evaluation
    ? (evaluation.eligible ? 1 : Math.max(0, 1 - (evaluation.missing_skills.length + evaluation.unmapped_skills.length + (evaluation.team_shortfall ? 1 : 0)) / Math.max(1, reqs.skills.length + 1)))
    : 1;
  const score = reqs
    ? Math.round((certFactor * 0.4 + loadFactor * 0.3 + skillFactor * 0.3) * 100) / 100
    : Math.round((certFactor * 0.5 + loadFactor * 0.5) * 100) / 100;
  return {
    evaluation,
    missing,
    certFactor,
    loadFactor,
    skillFactor,
    score,
    eligible: (evaluation ? evaluation.eligible : true) && missing.length === 0,
  };
}

// The sibling crews of the intended crew: the same department subtree and the
// same region. Empty when the crew has no org unit (no department to borrow
// from).
function departmentCrewsFor(crew) {
  if (!crew || !crew.org_unit_id) return [];
  const subtree = new Set(unitSubtree(crew.org_unit_id));
  return db.prepare('SELECT id, org_unit_id, region_id FROM crew').all()
    .filter((c) => c.org_unit_id && subtree.has(c.org_unit_id) && (crew.region_id == null || c.region_id === crew.region_id));
}

// Pick the crew a generated task should be pre-assigned to, given the crew the
// schedule/asset already intends (asset default or schedule responsible). That
// intended crew is an explicit human choice, so it is kept whenever it is
// eligible. Only when it cannot do the job — or is off duty/unavailable — do we
// look for the best eligible sibling in the same department and region. If no
// capable replacement exists we keep the intended crew, so generation never
// silently drops responsibility. Returns null when there is nothing to assign.
function autoAssignCrewId(intendedCrewId, { reqs = null, neededCerts = [] } = {}) {
  const intended = intendedCrewId ? readyCrew(intendedCrewId) : null;
  if (!intended) return null;
  if (intended.selectable && scoreCrewFit(intended, reqs, neededCerts).eligible) return intended.id;
  const ranked = departmentCrewsFor(intended)
    .map((c) => readyCrew(c.id))
    .filter((c) => c && c.selectable && c.id !== intended.id)
    .map((c) => ({ crew: c, fit: scoreCrewFit(c, reqs, neededCerts) }))
    .filter((x) => x.fit.eligible)
    .sort((a, b) => b.fit.score - a.fit.score);
  return ranked.length ? ranked[0].crew.id : intended.id;
}

module.exports = {
  OPEN_TASK_STATES,
  notSelectable,
  openTaskCount,
  readyCrew,
  scoreCrewFit,
  departmentCrewsFor,
  autoAssignCrewId,
};
