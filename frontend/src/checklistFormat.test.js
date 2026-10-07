import { describe, expect, it } from 'vitest';
import {
  formatChecklistResponse,
  formatChecklistResult,
  describeTarget,
  targetInfraLabel,
  targetAssetLabel,
  substationDescription,
  assetDescription,
  workflowRows,
} from './checklistFormat.js';

describe('formatChecklistResponse', () => {
  it('words pass/fail and yes/no answers', () => {
    expect(formatChecklistResponse({ response_type: 'PASS_FAIL', response_value: 'true' })).toBe('Pass');
    expect(formatChecklistResponse({ response_type: 'PASS_FAIL', response_value: 'false' })).toBe('Fail');
    expect(formatChecklistResponse({ response_type: 'YES_NO', response_value: 'yes' })).toBe('Yes');
    expect(formatChecklistResponse({ response_type: 'YES_NO', response_value: 'no' })).toBe('No');
  });

  it('appends the unit from pass criteria to numeric readings', () => {
    expect(formatChecklistResponse({
      response_type: 'NUMERIC', response_value: '118', pass_criteria: JSON.stringify({ unit: 'kV' }),
    })).toBe('118 kV');
    expect(formatChecklistResponse({ response_type: 'NUMERIC', response_value: 42 })).toBe('42');
  });

  it('describes photos and GPS points', () => {
    expect(formatChecklistResponse({ response_type: 'PHOTO', response_value: 'x' })).toBe('Photo attached');
    expect(formatChecklistResponse({
      response_type: 'GPS_POINT', response_value: { lat: 9.1234567, lng: 38.7654321, accuracy_m: 5.4 },
    })).toBe('9.123457, 38.765432 · ±5 m');
  });

  it('falls back to the recorded result when nothing was entered', () => {
    expect(formatChecklistResponse({ response_value: null, result: 'NOT_RUN' })).toBe('Not run');
    expect(formatChecklistResponse({ response_value: '', result: 'NA' })).toBe('Not applicable');
    expect(formatChecklistResponse({ response_value: null })).toBe('Not recorded');
    expect(formatChecklistResponse(null)).toBe('—');
  });
});

describe('labels derived from targets', () => {
  it('spells out results', () => {
    expect(formatChecklistResult('PASS')).toBe('Passed');
    expect(formatChecklistResult('UNGRADED')).toBe('Not graded');
    expect(formatChecklistResult('WEIRD')).toBe('WEIRD');
    expect(formatChecklistResult(null)).toBe('—');
  });

  it('prefers substation, then line, then tower for the infra label', () => {
    expect(targetInfraLabel({ substation: { name: 'Bole' } })).toBe('Bole');
    expect(targetInfraLabel({ line: { name: 'L1', voltage_kv: 132 } })).toBe('L1 132 kV');
    expect(targetInfraLabel({ tower: { tower_id: 'T-12' } })).toBe('Tower T-12');
    expect(targetInfraLabel(null)).toBeNull();
  });

  it('describes the asset with its installation location', () => {
    expect(targetAssetLabel({ asset: { name: 'Transformer', location_type: 'INDOOR', bay: 'B3' } }))
      .toBe('Transformer (INDOOR, bay B3)');
  });

  it('builds one-line descriptions and a target breakdown', () => {
    expect(substationDescription({ substation_type: 'GIS', voltage_levels: '[132,230]', bay_count: 8, operational_status: 'ACTIVE' }))
      .toBe('GIS · 230 kV · 8 bays · ACTIVE');
    expect(assetDescription({ manufacturer: 'ABB', model: 'X1', serial_number: 'SN9', condition_rating: 7 }))
      .toBe('ABB · X1 · S/N SN9 · condition 7/10');
    const described = describeTarget({ line: { name: 'L1', line_id: 'LN-1' }, region: { name: 'C1' } });
    expect(described.infrastructure).toBe('Line L1 (LN-1)');
    expect(described.region).toBe('C1');
  });

  it('lists workflow people in lifecycle order and drops blanks', () => {
    const rows = workflowRows({
      created_by: { first_name: 'A', last_name: 'B' },
      executed_by: 'field crew',
    });
    expect(rows).toEqual([
      { label: 'Created by', value: 'A B' },
      { label: 'Executed by', value: 'field crew' },
    ]);
  });
});
