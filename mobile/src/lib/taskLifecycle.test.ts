import { describe, expect, it } from 'vitest';
import { EDITABLE_STATUSES, LOCKED_STATUSES, isEditable, isTaskLocked } from './taskLifecycle';

describe('task lifecycle status policy', () => {
  it('locks only after submission or closure', () => {
    for (const status of ['PENDING_VERIFICATION', 'COMPLETED', 'CANCELLED', 'FAILED']) {
      expect(isTaskLocked(status), status).toBe(true);
      expect(isEditable(status), status).toBe(false);
    }
  });

  it('keeps the operational lifecycle editable', () => {
    for (const status of ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD']) {
      expect(isEditable(status), status).toBe(true);
      expect(isTaskLocked(status), status).toBe(false);
    }
  });

  it('treats unknown or missing statuses as not locked', () => {
    expect(isTaskLocked(undefined)).toBe(false);
    expect(isTaskLocked(null)).toBe(false);
    expect(isEditable(undefined)).toBe(false);
  });

  it('covers every known status exactly once', () => {
    const all = [...EDITABLE_STATUSES, ...LOCKED_STATUSES];
    expect(new Set(all).size).toBe(all.length);
  });
});
