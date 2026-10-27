import { describe, it, expect } from 'vitest';
import { mergeSearchResults, buildSearchSummary, tagSlugFromItem } from './mergeSearchResults';

function catalogResult(groups, query = 'sululta') {
  return { query, groups };
}

describe('mergeSearchResults', () => {
  it('upgrades a related catalog task with the scoped keyword row and keeps catalog tag/description', () => {
    const catalog = catalogResult([
      {
        type: 'task', entity: 'task', label: 'Task', total: 1,
        items: [{
          id: 7, type: 'task', title: 'Old title', subtitle: 'TK-7 · OPEN',
          description: 'TK-7 · OPEN', tag: 'Task', match: 'related', via: ['Sululta 400kV'],
        }],
      },
    ]);
    const scoped = {
      groups: [{
        type: 'task', label: 'Tasks', total: 1,
        items: [{
          id: 7, type: 'task', title: 'Scoped title',
          subtitle: 'TK-7 · OPEN · Sululta', href: '/tasks/7',
          document_type: 'TASK_DETAIL',
        }],
      }],
    };

    const merged = mergeSearchResults(catalog, scoped);
    const items = merged.groups.flatMap((g) => g.items);
    const row = items.find((it) => it.type === 'task' && it.id === 7);
    expect(row.match).toBe('keyword');
    expect(row.via).toBeUndefined();
    expect(row.tag).toBe('Task');
    expect(row.description).toBe('TK-7 · OPEN');
    expect(row.title).toBe('Scoped title');
    expect(row.href).toBe('/tasks/7');
    expect(row.document_type).toBe('TASK_DETAIL');
  });

  it('produces counts for a person-only scoped query with an empty catalog', () => {
    const scoped = {
      groups: [{
        type: 'person', label: 'People', total: 1,
        items: [{ id: 3, type: 'person', title: 'Ayu Bekele', subtitle: 'Engineer' }],
      }],
    };

    const merged = mergeSearchResults(catalogResult([], 'ayu'), scoped);
    expect(merged.total).toBe(1);
    expect(merged.counts.person).toBe(1);
    const summary = buildSearchSummary('ayu', merged.counts, (k) => ({
      searchPickOne: 'pick one', searchTagPerson: 'person',
    }[k] || k));
    expect(summary).toBe('ayu: 1 person — pick one');
  });

  it('appends a scoped keyword asset that is missing from the catalog slice', () => {
    const catalog = catalogResult([
      {
        type: 'transformer', entity: 'asset', label: 'Transformer', total: 1,
        items: [{ id: 1, type: 'asset', tag: 'Transformer', title: 'T1', description: 'Asset', match: 'keyword', rank: 3 }],
      },
    ]);
    const scoped = {
      groups: [{
        type: 'asset', label: 'Assets', total: 1,
        items: [{ id: 99, type: 'asset', title: 'Ninth transformer', document_type: 'ASSET_DETAIL' }],
      }],
    };

    const merged = mergeSearchResults(catalog, scoped);
    const items = merged.groups.flatMap((g) => g.items);
    const row = items.find((it) => it.id === 99);
    expect(row.match).toBe('keyword');
    expect(row.tag).toBe('Asset');
    expect(items.some((it) => it.id === 1)).toBe(true);
  });

  it('keeps catalog keyword rank order and appends scoped-only rows after it', () => {
    const catalog = catalogResult([
      {
        type: 'transformer', entity: 'asset', label: 'Transformer', total: 2,
        items: [
          { id: 1, type: 'asset', tag: 'Transformer', title: 'T1', match: 'keyword', rank: 3 },
          { id: 2, type: 'asset', tag: 'Transformer', title: 'T2', match: 'keyword', rank: 9 },
        ],
      },
    ]);
    const scoped = {
      groups: [{
        type: 'person', label: 'People', total: 1,
        items: [{ id: 5, type: 'person', title: 'Ayu' }],
      }],
    };

    const merged = mergeSearchResults(catalog, scoped);
    expect(merged.groups.map((g) => g.type)).toEqual(['transformer', 'person']);
    expect(merged.groups[0].items.map((it) => it.id)).toEqual([2, 1]);
    expect(merged.groups[1].items[0].id).toBe(5);
  });

  it('exposes asset tag slugs for scoped items', () => {
    expect(tagSlugFromItem({ type: 'asset', tag: 'Circuit breaker' })).toBe('circuit_breaker');
    expect(tagSlugFromItem({ type: 'asset', asset_type: 'CAPACITOR_BANK' })).toBe('capacitor_bank');
    expect(tagSlugFromItem({ type: 'line' })).toBe('line');
  });
});

describe('buildSearchSummary', () => {
  it('pluralizes an unknown slug from its display words', () => {
    const summary = buildSearchSummary('cap', { capacitor_bank: 2 }, (k) => ({
      searchPickOne: 'pick one',
    }[k] || k));
    expect(summary).toBe('cap: 2 capacitor banks — pick one');
  });

  it('uses translated tag keys when the locale provides them', () => {
    const summary = buildSearchSummary('x', { circuit_breaker: 1 }, (k) => ({
      searchPickOne: 'pick one', searchTagCircuitBreaker: 'interruptor',
    }[k] || k));
    expect(summary).toBe('x: 1 interruptor — pick one');
  });

  it('returns an empty string when there is nothing to summarize', () => {
    expect(buildSearchSummary('x', {}, (k) => k)).toBe('');
    expect(buildSearchSummary('x', { line: 0 }, (k) => k)).toBe('');
  });
});
