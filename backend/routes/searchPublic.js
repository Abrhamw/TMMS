const express = require('express');
const { list } = require('../util');
const { can, requireAuth } = require('../auth');
const { taskVisible } = require('../authority');
const { parseSearchQuery, searchGroup } = require('../searchEngine');
const {
  describe,
  createIndex,
  addKeyword,
  expand,
  finalizeGroups,
  countsFromGroups,
  tagSlug,
} = require('../searchExpand');

const router = express.Router();

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

const OPEN_PERM = {
  region: 'region:read',
  substation: 'substation:read',
  line: 'line:read',
  tower: 'tower:read',
  asset: 'asset:read',
  schedule: 'schedule:read',
};

function canOpenFor(req) {
  return (type, row) => {
    if (type === 'task') return can(req, 'task:read') && taskVisible(req.user, row);
    return can(req, OPEN_PERM[type]);
  };
}

router.get('/search/public', requireAuth, (req, res) => {
  const { raw, tokens } = parseSearchQuery(req.query.q);
  if (!tokens.length) return res.json({ query: '', counts: {}, total: 0, groups: [] });
  const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const regions = list('region');
  const substations = list('substation');
  const lines = list('transmission_line');
  const towers = list('tower');
  const assets = list('asset');
  const schedules = list('maintenance_schedule');
  const tasks = list('task');

  const regionById = new Map(regions.map((r) => [r.id, r]));
  const subById = new Map(substations.map((s) => [s.id, s]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const towerById = new Map(towers.map((t) => [t.id, t]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));
  const regionName = (id) => regionById.get(id)?.name || '';

  const maps = {
    regions,
    regionById,
    substations,
    subById,
    lines,
    lineById,
    towers,
    towerById,
    assets,
    assetById,
    schedules,
    tasks,
  };
  const rowsById = {
    region: regionById,
    substation: subById,
    line: lineById,
    tower: towerById,
    asset: assetById,
    schedule: scheduleById,
  };

  const canOpen = canOpenFor(req);

  function catalogGroup(entity, label, rows, titleFields, extraFields) {
    return searchGroup({
      type: entity,
      label,
      rows,
      tokens,
      limit,
      titleFields,
      extraFields,
      toItem: (row) => {
        const data = describe(entity, row, maps);
        const open = canOpen(entity, row);
        const item = {
          id: row.id,
          type: entity,
          title: data.title,
          subtitle: data.subtitle || '',
          description: data.description,
          tag: data.tag,
          can_open: open,
          match: 'keyword',
        };
        if (open && data.href) item.href = data.href;
        return item;
      },
    });
  }

  const keywordGroups = [
    catalogGroup('region', 'Regions', regions, (r) => [r.name, r.code], () => []),
    catalogGroup(
      'substation', 'Substations', substations,
      (s) => [s.name, s.substation_id],
      (s) => [regionName(s.region_id)]
    ),
    catalogGroup(
      'line', 'Transmission lines', lines,
      (l) => [l.name, l.line_id],
      (l) => [l.voltage_kv, regionName(l.region_id)]
    ),
    catalogGroup(
      'tower', 'Towers', towers,
      (t) => [t.tower_id, t.tower_number],
      (t) => [t.tower_type]
    ),
    catalogGroup(
      'schedule', 'Schedules', schedules,
      (s) => [s.schedule_name, s.schedule_code],
      (s) => [s.frequency]
    ),
  ].filter((g) => g.total > 0);

  const assetGroup = searchGroup({
    type: 'asset',
    label: 'Assets',
    rows: assets,
    tokens,
    limit,
    titleFields: (a) => [a.name, a.asset_id],
    extraFields: (a) => [a.asset_type, a.sub_type, describe('asset', a, maps).description],
    toItem: (row) => {
      const data = describe('asset', row, maps);
      const open = canOpen('asset', row);
      const item = {
        id: row.id,
        type: 'asset',
        title: data.title,
        subtitle: data.subtitle || '',
        description: data.description,
        tag: data.tag,
        can_open: open,
        match: 'keyword',
      };
      if (open && data.href) item.href = data.href;
      return item;
    },
  });

  const assetGroups = [];
  const assetBySlug = new Map();
  for (const item of assetGroup.items) {
    const slug = tagSlug(item.tag);
    if (!assetBySlug.has(slug)) {
      const group = { type: slug, entity: 'asset', label: item.tag, total: 0, items: [] };
      assetBySlug.set(slug, group);
      assetGroups.push(group);
    }
    const group = assetBySlug.get(slug);
    group.total += 1;
    group.items.push(item);
  }

  const index = createIndex();
  const hits = [];
  for (const group of [...keywordGroups, ...assetGroups]) {
    const entity = group.entity || group.type;
    const rowsForType = rowsById[entity];
    for (const item of group.items) {
      addKeyword(index, item, { slug: group.type, label: group.label, entity });
      const row = rowsForType.get(item.id);
      if (row) hits.push({ type: entity, row });
    }
  }

  expand({ hits, maps, canOpen, index });

  const groups = finalizeGroups(index);
  const counts = countsFromGroups(groups);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  res.json({ query: raw, counts, total, groups });
});

module.exports = router;
