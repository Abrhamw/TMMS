import { describe, it, expect } from 'vitest';
import { EDITABLE_STATUSES, LOCKED_STATUSES, isTaskLocked, isEditable } from './taskLifecycle';

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

  it('treats unknown or missing statuses as not editable and not locked', () => {
    expect(isEditable(undefined)).toBe(false);
    expect(isEditable(null)).toBe(false);
    expect(isTaskLocked(undefined)).toBe(false);
  });

  it('covers every known status exactly once', () => {
    const all = [...EDITABLE_STATUSES, ...LOCKED_STATUSES];
    expect(new Set(all).size).toBe(all.length);
  });
});
