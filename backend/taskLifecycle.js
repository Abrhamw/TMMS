// Task editability policy shared by the task and attachment routers.
//
// A task is editable for its whole operational life (planning, dispatch and
// execution) and locks the moment it is submitted for verification. `reopen`
// moves PENDING_VERIFICATION back to IN_PROGRESS, which unlocks it again;
// `verify` (COMPLETED) and `cancel` (CANCELLED) stay locked.
const EDITABLE_STATUSES = Object.freeze(['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD']);
const LOCKED_STATUSES = Object.freeze(['PENDING_VERIFICATION', 'COMPLETED', 'CANCELLED', 'FAILED']);

const EDITABLE = new Set(EDITABLE_STATUSES);

function isTaskEditable(task) {
  return !!task && EDITABLE.has(task.status);
}

function isTaskLocked(task) {
  return !!task && LOCKED_STATUSES.includes(task.status);
}

module.exports = { EDITABLE_STATUSES, LOCKED_STATUSES, isTaskEditable, isTaskLocked };
