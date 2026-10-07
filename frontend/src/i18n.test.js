import { describe, it, expect } from 'vitest';
import en from './i18n/en';
import es from './i18n/es';
import zh from './i18n/zh';
import am from './i18n/am';

const locales = { en, es, zh, am };

describe('i18n dictionaries', () => {
  it('uses English keys as the superset so other locales cannot drift', () => {
    const enKeys = new Set(Object.keys(en));
    for (const [name, dict] of Object.entries(locales)) {
      for (const key of Object.keys(dict)) {
        expect(enKeys.has(key), `${name} has unknown key "${key}"`).toBe(true);
      }
    }
  });

  it('translates every non-English key to a non-empty string', () => {
    for (const [name, dict] of Object.entries(locales)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${name}.${key} must be a string`).toBe('string');
        if (name !== 'en') expect(value.length, `${name}.${key} must not be empty`).toBeGreaterThan(0);
      }
    }
  });
});
