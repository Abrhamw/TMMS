const test = require('node:test');
const assert = require('node:assert');

const {
  assetTag,
  tagSlug,
  createIndex,
  addKeyword,
  addRelated,
  finalizeGroups,
  countsFromGroups,
  expand,
  PER_KIND,
  GROUP_KEEP,
  GROUP_SHOW,
} = require('../searchExpand');

const TAGS = {
  region: 'Region',
  substation: 'Substation',
  line: 'Line',
  tower: 'Tower',
  task: 'Task',
  schedule: 'Schedule',
  crew: 'Crew',
  person: 'Person',
};

function tagForRow(type, row) {
  return type === 'asset' ? assetTag(row.asset_type) : TAGS[type];
}

function keyword(type, row, rank = 0) {
  const tag = tagForRow(type, row);
  return {
    item: {
      id: row.id,
      type,
      title: row.name || row.title || row.schedule_name || row.tower_id || String(row.id),
      tag,
      rank,
    },
    group: { slug: tagSlug(tag), label: tag, entity: type },
  };
}

function indexFor(type, row, rank = 0) {
  const index = createIndex();
  addKeywordWith(index, type, row, rank);
  return index;
}

function addKeywordWith(index, type, row, rank = 0) {
  const { item, group } = keyword(type, row, rank);
  addKeyword(index, item, group);
}

function findItem(groups, type, id) {
  for (const g of groups) {
    for (const it of g.items) {
      if (it.type === type && it.id === id) return it;
    }
  }
  return null;
}

const region = { id: 1, name: 'Sululta', code: 'SA', region_id: 1 };
const otherRegion = { id: 2, name: 'Other', code: 'OT' };
const sub = { id: 10, name: 'Sululta 400kV', substation_id: 'SS-SUL', region_id: 1 };
const sub2 = { id: 11, name: 'Gefersa 230kV', substation_id: 'SS-GEF', region_id: 1 };
const otherSub = { id: 12, name: 'Other substation', substation_id: 'SS-OTH', region_id: 2 };
const line = {
  id: 20, name: 'Sululta-Gefersa 230kV', line_id: 'LN-1', region_id: 1,
  from_substation_id: 10, to_substation_id: 11, voltage_kv: 230,
};
const line2 = {
  id: 21, name: 'Other line', line_id: 'LN-2', region_id: 2,
  from_substation_id: 12, to_substation_id: 12, voltage_kv: 66,
};
const tower = { id: 30, tower_id: 'TW-1', line_id: 20, tower_number: 1, tower_type: 'SUSPENSION' };
const tower2 = { id: 31, tower_id: 'TW-2', line_id: 20, tower_number: 2, tower_type: 'TENSION' };
const otherTower = { id: 32, tower_id: 'TW-9', line_id: 21, tower_number: 1, tower_type: 'SUSPENSION' };

const yardAsset = { id: 40, name: 'Auto Transformer', asset_id: 'XFR-1', asset_type: 'TRANSFORMER', substation_id: 10 };
const lineAsset = { id: 41, name: 'Line Relay', asset_id: 'RLY-1', asset_type: 'RELAY', line_id: 20 };
const towerAsset = { id: 42, name: 'Tower Breaker', asset_id: 'CB-1', asset_type: 'CIRCUIT_BREAKER', tower_id: 30 };
const otherAsset = { id: 43, name: 'Other Transformer', asset_id: 'XFR-9', asset_type: 'TRANSFORMER', substation_id: 12 };
const bothAsset = { id: 44, name: 'Yard Line Transformer', asset_id: 'XFR-2', asset_type: 'TRANSFORMER', substation_id: 10, line_id: 20 };
const assetOnly = { id: 45, name: 'Yard Reactor', asset_id: 'RCT-1', asset_type: 'REACTOR', substation_id: 10 };

const taskSub = { id: 50, task_number: 'TK-1', title: 'Sub task', status: 'OPEN', substation_id: 10, region_id: 1 };
const taskLine = { id: 51, task_number: 'TK-2', title: 'Line task', status: 'OPEN', line_id: 20, region_id: 1 };
const taskTower = { id: 52, task_number: 'TK-3', title: 'Tower task', status: 'OPEN', tower_id: 30, region_id: 1 };
const taskAsset = { id: 53, task_number: 'TK-4', title: 'Asset task', status: 'OPEN', asset_id: 40, region_id: 1 };
const taskOther = { id: 54, task_number: 'TK-5', title: 'Other task', status: 'OPEN', substation_id: 12, region_id: 2 };

const schedLine = {
  id: 60, schedule_name: 'Line patrol', schedule_code: 'S1', scope_type: 'LINE',
  line_id: 20, region_id: 1, frequency: 'MONTHLY',
};
const schedTower = {
  id: 61, schedule_name: 'Tower check', schedule_code: 'S2', scope_type: 'TOWER',
  tower_id: 30, line_id: 20, region_id: 1, frequency: 'YEARLY',
};
const schedRegion = {
  id: 62, schedule_name: 'Region plan', schedule_code: 'S3', scope_type: 'REGION',
  region_id: 1, frequency: 'MONTHLY',
};
const schedGroupLine = {
  id: 63, schedule_name: 'Group plan', schedule_code: 'S4', scope_type: 'ASSET_GROUP',
  line_id: 20, region_id: 1, frequency: 'MONTHLY',
};
const schedMulti = {
  id: 64, schedule_name: 'Multi plan', schedule_code: 'S5', scope_type: 'ASSET_GROUP',
  line_id: 20, substation_id: 10, region_id: 1, frequency: 'WEEKLY',
};
const schedAsset = {
  id: 65, schedule_name: 'Asset plan', schedule_code: 'S6', scope_type: 'ASSET',
  asset_id: 40, region_id: 1, frequency: 'MONTHLY',
};

const regionById = new Map([region, otherRegion].map((r) => [r.id, r]));
const subById = new Map([sub, sub2, otherSub].map((s) => [s.id, s]));
const lineById = new Map([line, line2].map((l) => [l.id, l]));
const towerById = new Map([tower, tower2, otherTower].map((t) => [t.id, t]));
const assetById = new Map([yardAsset, lineAsset, towerAsset, otherAsset, bothAsset, assetOnly].map((a) => [a.id, a]));

const maps = {
  regions: [region, otherRegion],
  regionById,
  substations: [sub, sub2, otherSub],
  subById,
  lines: [line, line2],
  lineById,
  towers: [tower, tower2, otherTower],
  towerById,
  assets: [yardAsset, lineAsset, towerAsset, otherAsset, bothAsset, assetOnly],
  assetById,
  tasks: [taskSub, taskLine, taskTower, taskAsset, taskOther],
  schedules: [schedLine, schedTower, schedRegion, schedGroupLine, schedMulti, schedAsset],
};

function expandHit(type, row, canOpen = () => true) {
  const index = indexFor(type, row);
  expand({ hits: [{ type, row }], maps, canOpen, index });
  return finalizeGroups(index);
}

test('asset tags title-case the asset type and slugify for grouping', () => {
  assert.strictEqual(assetTag('TRANSFORMER'), 'Transformer');
  assert.strictEqual(assetTag('CIRCUIT_BREAKER'), 'Circuit breaker');
  assert.strictEqual(assetTag('CAPACITOR_BANK'), 'Capacitor bank');
  assert.strictEqual(assetTag(''), 'Asset');
  assert.strictEqual(assetTag(null), 'Asset');
  assert.strictEqual(tagSlug('Circuit breaker'), 'circuit_breaker');
  assert.strictEqual(tagSlug('Transformer'), 'transformer');
});

test('keyword wins over related on the same record and drops via', () => {
  const index = createIndex();
  addKeywordWith(index, 'asset', yardAsset);
  addRelated(index, { id: 40, type: 'asset', tag: 'Transformer', title: 'Auto Transformer', via: ['Sululta 400kV'] });
  const groups = finalizeGroups(index);
  const item = findItem(groups, 'asset', 40);
  assert.ok(item);
  assert.strictEqual(item.match, 'keyword');
  assert.strictEqual(item.via, undefined);
});

test('related rows dedupe and collect unique parent titles in first-seen order', () => {
  const index = createIndex();
  addRelated(index, { id: 20, type: 'line', tag: 'Line', title: 'Sululta-Gefersa 230kV', via: ['Sululta 400kV'] });
  addRelated(index, { id: 20, type: 'line', tag: 'Line', title: 'Sululta-Gefersa 230kV', via: ['Gefersa 230kV', 'Sululta 400kV'] });
  const groups = finalizeGroups(index);
  const item = findItem(groups, 'line', 20);
  assert.deepStrictEqual(item.via, ['Sululta 400kV', 'Gefersa 230kV']);
});

test('related rows with the same parent title collapse to one via entry', () => {
  const index = createIndex();
  addRelated(index, { id: 20, type: 'line', tag: 'Line', title: 'Line', via: ['Same'] });
  addRelated(index, { id: 20, type: 'line', tag: 'Line', title: 'Line', via: ['Same'] });
  assert.deepStrictEqual(findItem(finalizeGroups(index), 'line', 20).via, ['Same']);
});

test('caps keep 40 per group, show 12, and sort related by id desc', () => {
  const index = createIndex();
  for (let id = 1; id <= 50; id += 1) {
    addRelated(index, { id, type: 'asset', tag: 'Transformer', title: `T${id}` });
  }
  const groups = finalizeGroups(index);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].total, GROUP_KEEP);
  assert.strictEqual(groups[0].items.length, GROUP_SHOW);
  assert.deepStrictEqual(groups[0].items.map((it) => it.id), [50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39]);
});

test('keyword sort is rank desc then id desc, ahead of related rows', () => {
  const index = createIndex();
  addKeywordWith(index, 'asset', { ...yardAsset, id: 2 }, 1);
  addKeywordWith(index, 'asset', { ...yardAsset, id: 1 }, 2);
  addKeywordWith(index, 'asset', { ...yardAsset, id: 3 }, 3);
  addRelated(index, { id: 4, type: 'asset', tag: 'Transformer', title: 'Related' });
  const items = finalizeGroups(index)[0].items;
  assert.deepStrictEqual(items.map((it) => it.id), [3, 1, 2, 4]);
  assert.deepStrictEqual(items.map((it) => it.match), ['keyword', 'keyword', 'keyword', 'related']);
});

test('a substation hit one hop expands its yard, lines, line towers and assets, tasks, schedules', () => {
  const groups = expandHit('substation', sub);

  assert.deepStrictEqual(findItem(groups, 'asset', 40).via, ['Sululta 400kV']);
  assert.deepStrictEqual(findItem(groups, 'line', 20).via, ['Sululta 400kV']);
  assert.deepStrictEqual(findItem(groups, 'tower', 30).via, ['Sululta-Gefersa 230kV']);
  assert.deepStrictEqual(findItem(groups, 'asset', 42).via, ['Sululta-Gefersa 230kV']);
  assert.deepStrictEqual(findItem(groups, 'asset', 41).via, ['Sululta-Gefersa 230kV']);

  assert.deepStrictEqual(findItem(groups, 'task', 50).via, ['Sululta 400kV']);
  assert.deepStrictEqual(findItem(groups, 'task', 51).via, ['Sululta-Gefersa 230kV']);
  assert.deepStrictEqual(findItem(groups, 'task', 52).via, ['Sululta-Gefersa 230kV']);

  assert.deepStrictEqual(findItem(groups, 'schedule', 60).via, ['Sululta-Gefersa 230kV']);
  assert.deepStrictEqual(findItem(groups, 'schedule', 61).via, ['Sululta-Gefersa 230kV']);
  assert.deepStrictEqual(findItem(groups, 'schedule', 63).via, ['Sululta-Gefersa 230kV']);
  assert.strictEqual(findItem(groups, 'task', 54), null);
  assert.strictEqual(findItem(groups, 'asset', 43), null);
});

test('an asset that is both a yard asset and a line asset is one row with both parents', () => {
  const groups = expandHit('substation', sub);
  const item = findItem(groups, 'asset', 44);
  assert.ok(item);
  assert.deepStrictEqual(item.via, ['Sululta 400kV', 'Sululta-Gefersa 230kV']);
});

test('a substation hit relates a multi-target schedule once with every parent', () => {
  const groups = expandHit('substation', sub);
  const item = findItem(groups, 'schedule', 64);
  assert.ok(item);
  assert.ok(item.via.includes('Sululta 400kV'));
  assert.ok(item.via.includes('Sululta-Gefersa 230kV'));
});

test('a line hit includes tower-mounted assets and tower tasks but not endpoint yard assets', () => {
  const groups = expandHit('line', line);
  assert.ok(findItem(groups, 'asset', 42));
  assert.ok(findItem(groups, 'task', 52));
  assert.strictEqual(findItem(groups, 'asset', 40), null);
  assert.ok(findItem(groups, 'substation', 10));
  assert.ok(findItem(groups, 'substation', 11));
  assert.deepStrictEqual(findItem(groups, 'schedule', 63).via, ['Sululta-Gefersa 230kV']);
});

test('a line hit caps each named neighbor kind at 25 per parent', () => {
  const manyTowers = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i, tower_id: `T${100 + i}`, line_id: 20, tower_number: i + 1, tower_type: 'SUSPENSION',
  }));
  const localMaps = {
    ...maps,
    towers: manyTowers,
    towerById: new Map(manyTowers.map((t) => [t.id, t])),
    assets: [],
    assetById: new Map(),
    tasks: [],
    schedules: [],
  };
  const index = indexFor('line', line);
  expand({ hits: [{ type: 'line', row: line }], maps: localMaps, canOpen: () => true, index });
  const groups = finalizeGroups(index);
  const towersGroup = groups.find((g) => g.type === 'tower');
  assert.strictEqual(towersGroup.total, PER_KIND);
  assert.deepStrictEqual(towersGroup.items.map((it) => it.id), [129, 128, 127, 126, 125, 124, 123, 122, 121, 120, 119, 118]);
});

test('an asset hit relates its parent, its tasks, and its schedules', () => {
  const groups = expandHit('asset', yardAsset);
  assert.ok(findItem(groups, 'substation', 10));
  assert.ok(findItem(groups, 'task', 53));
  assert.ok(findItem(groups, 'schedule', 65));
  assert.deepStrictEqual(findItem(groups, 'task', 53).via, ['Auto Transformer']);
});

test('a tower hit relates its line, mounted assets, and line tasks with the line as via', () => {
  const groups = expandHit('tower', tower);
  assert.deepStrictEqual(findItem(groups, 'line', 20).via, ['TW-1']);
  assert.deepStrictEqual(findItem(groups, 'asset', 42).via, ['TW-1']);
  assert.deepStrictEqual(findItem(groups, 'task', 52).via, ['TW-1']);
  assert.deepStrictEqual(findItem(groups, 'task', 51).via, ['Sululta-Gefersa 230kV']);
  assert.deepStrictEqual(findItem(groups, 'schedule', 61).via, ['TW-1']);
  assert.deepStrictEqual(findItem(groups, 'schedule', 60).via, ['Sululta-Gefersa 230kV']);
});

test('a region hit expands substations, lines, and region-scope schedules without yard fan-out', () => {
  const groups = expandHit('region', region);
  assert.ok(findItem(groups, 'substation', 10));
  assert.ok(findItem(groups, 'substation', 11));
  assert.ok(findItem(groups, 'line', 20));
  assert.deepStrictEqual(findItem(groups, 'schedule', 62).via, ['Sululta']);
  assert.strictEqual(findItem(groups, 'asset', 40), null);
  assert.strictEqual(findItem(groups, 'schedule', 60), null);
});

test('a schedule keyword hit relates one row per stored FK in tower, asset, line, substation, region order', () => {
  const groups = expandHit('schedule', schedMulti);
  assert.deepStrictEqual(findItem(groups, 'line', 20).via, ['Multi plan']);
  assert.deepStrictEqual(findItem(groups, 'substation', 10).via, ['Multi plan']);
  assert.deepStrictEqual(findItem(groups, 'region', 1).via, ['Multi plan']);
  assert.strictEqual(findItem(groups, 'tower', 30), null);
  assert.strictEqual(findItem(groups, 'asset', 41), null);
});

test('a TOWER-scope schedule keyword hit relates the tower and its derived line', () => {
  const groups = expandHit('schedule', schedTower);
  assert.deepStrictEqual(findItem(groups, 'tower', 30).via, ['Tower check']);
  assert.deepStrictEqual(findItem(groups, 'line', 20).via, ['Tower check']);
});

test('a related task outside the caller scope is description-only and leaks no people fields', () => {
  const canOpen = (type) => type !== 'task';
  const groups = expandHit('substation', sub, canOpen);
  const task = findItem(groups, 'task', 50);
  assert.ok(task);
  assert.strictEqual(task.can_open, false);
  assert.strictEqual(task.href, undefined);
  assert.ok(task.description.includes('TK-1'));
  const raw = JSON.stringify(groups);
  assert.ok(!raw.includes('assignee'));
  assert.ok(!raw.includes('comment'));
  assert.ok(!raw.includes('person_id'));
});

test('counts use tag slugs and follow region, substation, line, tower, assets, task, schedule order', () => {
  const index = createIndex();
  addRelated(index, { id: 1, type: 'task', tag: 'Task', title: 'T' });
  addRelated(index, { id: 2, type: 'schedule', tag: 'Schedule', title: 'S' });
  addRelated(index, { id: 3, type: 'asset', tag: 'Transformer', title: 'X' });
  addRelated(index, { id: 4, type: 'asset', tag: 'Reactor', title: 'R' });
  addRelated(index, { id: 5, type: 'tower', tag: 'Tower', title: 'W' });
  addRelated(index, { id: 6, type: 'line', tag: 'Line', title: 'L' });
  addRelated(index, { id: 7, type: 'substation', tag: 'Substation', title: 'S' });
  addRelated(index, { id: 8, type: 'region', tag: 'Region', title: 'R' });
  const groups = finalizeGroups(index);
  assert.deepStrictEqual(groups.map((g) => g.type), [
    'region', 'substation', 'line', 'tower', 'reactor', 'transformer', 'task', 'schedule',
  ]);
  assert.deepStrictEqual(Object.keys(countsFromGroups(groups)), [
    'region', 'substation', 'line', 'tower', 'reactor', 'transformer', 'task', 'schedule',
  ]);
  assert.strictEqual(groups.every((g) => g.entity), true);
});
