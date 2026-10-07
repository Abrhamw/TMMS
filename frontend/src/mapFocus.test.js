import { describe, expect, it, vi } from 'vitest';

// Leaflet reaches for `window` at import time; the helpers under test never
// touch it, so a stub keeps these unit tests in a plain node environment.
vi.mock('leaflet', () => ({ default: {}, divIcon: () => ({}), latLngBounds: () => ({}) }));

import { parseKv, parseVoltageLevels, maxVoltageKv, voltageBand, voltageColor, voltageLabel, isEnergized, entityColor, esc } from './mapFocus.js';

describe('voltage parsing', () => {
  it('extracts a positive number from assorted shapes', () => {
    expect(parseKv(132)).toBe(132);
    expect(parseKv('132 kV')).toBe(132);
    expect(parseKv('nominal 230kV')).toBe(230);
    expect(parseKv('0')).toBeNull();
    expect(parseKv('n/a')).toBeNull();
    expect(parseKv(null)).toBeNull();
  });

  it('normalizes voltage level inputs', () => {
    expect(parseVoltageLevels(['132', '230'])).toEqual(['132', '230']);
    expect(parseVoltageLevels('[132,230]')).toEqual(['132', '230']);
    expect(parseVoltageLevels('66;132 / 230')).toEqual(['66', '132', '230']);
    expect(parseVoltageLevels(400)).toEqual(['400']);
    expect(parseVoltageLevels(null)).toEqual([]);
  });

  it('picks the highest nominal voltage', () => {
    expect(maxVoltageKv('[15, 132, 230]')).toBe(230);
    expect(maxVoltageKv([])).toBeNull();
  });
});

describe('voltage bands', () => {
  it('maps a voltage to its band', () => {
    expect(voltageBand(500)?.label).toBe('500 kV');
    expect(voltageBand(132)?.label).toBe('132 kV');
    expect(voltageBand(50)?.label).toBe('45 kV');
    expect(voltageBand(null)).toBeNull();
  });

  it('derives color and label, with a fallback', () => {
    expect(voltageColor(500)).toBe('#f97316');
    expect(voltageColor(null)).toBe('#6b7280');
    expect(voltageLabel(230)).toBe('230 kV');
    expect(voltageLabel(null)).toBe('—');
  });

  it('uses the status color when equipment is not energized', () => {
    expect(isEnergized('ENERGIZED')).toBe(true);
    expect(isEnergized('OUT_OF_SERVICE')).toBe(false);
    expect(entityColor(500, 'ENERGIZED')).toBe('#f97316');
    expect(entityColor(500, 'OUT_OF_SERVICE')).toBe('#ef4444');
  });
});

describe('esc', () => {
  it('escapes HTML-significant characters', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(esc(null)).toBe('');
  });
});
