import { describe, it, expect } from 'vitest';
import { readinessSummary } from './readinessNotice';

describe('readinessSummary', () => {
  it('is empty and ready when the gate is ready', () => {
    const s = readinessSummary({ ready: true, blockers: [], warnings: [] });
    expect(s.ready).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.recommendations).toEqual([]);
    expect(s.blockers).toEqual([]);
  });

  it('maps each blocker to its message and recommendation', () => {
    const gate = {
      ready: false,
      blockers: [
        { code: 'NO_CREW', message: 'No crew is assigned or resolvable for this task', recommendation: 'Assign a crew before starting.' },
        { code: 'MISSING_CERT', message: 'No crew member holds required certification: HV-A', recommendation: 'Assign a member holding the required certification: HV-A.' },
      ],
      warnings: [],
    };
    const s = readinessSummary(gate);
    expect(s.ready).toBe(false);
    expect(s.missing).toEqual([
      'No crew is assigned or resolvable for this task',
      'No crew member holds required certification: HV-A',
    ]);
    expect(s.recommendations).toEqual([
      'Assign a crew before starting.',
      'Assign a member holding the required certification: HV-A.',
    ]);
    expect(s.blockers).toHaveLength(2);
  });

  it('falls back to "Resolve: <message>" when a blocker has no recommendation', () => {
    const gate = {
      ready: false,
      blockers: [{ code: 'SOMETHING_NEW', message: 'A new condition failed' }],
      warnings: [],
    };
    const s = readinessSummary(gate);
    expect(s.recommendations).toEqual(['Resolve: A new condition failed.']);
  });

  it('tolerates a missing or malformed gate', () => {
    expect(readinessSummary(null).ready).toBe(true);
    expect(readinessSummary(undefined).missing).toEqual([]);
    expect(readinessSummary({}).ready).toBe(true);
    expect(readinessSummary({ ready: false }).missing).toEqual([]);
  });
});
