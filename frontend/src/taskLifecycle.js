export const EDITABLE_STATUSES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];
export const LOCKED_STATUSES = ['PENDING_VERIFICATION', 'COMPLETED', 'CANCELLED', 'FAILED'];

export function isTaskLocked(status) {
  return LOCKED_STATUSES.includes(status);
}

export function isEditable(status) {
  return EDITABLE_STATUSES.includes(status);
}
