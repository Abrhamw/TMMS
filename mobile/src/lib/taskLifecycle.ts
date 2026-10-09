export const EDITABLE_STATUSES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'] as const;
export const LOCKED_STATUSES = ['PENDING_VERIFICATION', 'COMPLETED', 'CANCELLED', 'FAILED'] as const;

export function isTaskLocked(status?: string | null): boolean {
  return status != null && (LOCKED_STATUSES as readonly string[]).includes(status);
}

export function isEditable(status?: string | null): boolean {
  return status != null && (EDITABLE_STATUSES as readonly string[]).includes(status);
}
