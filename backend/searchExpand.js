const PER_KIND = 25;
const GROUP_KEEP = 40;
const GROUP_SHOW = 12;

const ENTITY_TAGS = {
  region: 'Region',
  substation: 'Substation',
  line: 'Line',
  tower: 'Tower',
  task: 'Task',
  schedule: 'Schedule',
  crew: 'Crew',
  person: 'Person',
  asset: 'Asset',
};

const ENTITY_ORDER = {
  region: 0,
  substation: 1,
  line: 2,
  tower: 3,
  asset: 4,
  task: 5,
  schedule: 6,
  crew: 7,
  person: 8,
};

const GROUP_SCOPES = new Set(['ASSET_CLASS', 'LINE_GROUP', 'SUBSTATION_GROUP', 'ASSET_GROUP']);

function assetTag(assetType) {
  const words = String(assetType == null ? '' : assetType)
    .trim()
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);
  if (!words.length) return 'Asset';
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

function tagSlug(label) {
  return String(label == null ? '' : label).trim().toLowerCase().replace(/\s+/g, '_');
}

function entityTag(type, row) {
  if (type === 'asset') return assetTag(row && row.asset_type);
  return ENTITY_TAGS[type] || type;
}

function unique(values) {
  const out = [];
  for (const v of values || []) {
    if (v == null || v === '') continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function uniqueById(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function createIndex() {
  return { byKey: new Map(), groups: new Map() };
}

function ensureGroup(index, slug, label, entity) {
  let group = index.groups.get(slug);
  if (!group) {
    group = { slug, label, entity, keys: [] };
    index.groups.set(slug, group);
  }
  return group;
}

function addKeyword(index, item, group) {
  const key = `${item.type}:${item.id}`;
  const previous = index.byKey.get(key);
  const tag = item.tag || (group && group.label) || ENTITY_TAGS[item.type] || item.type;
  const slug = (group && group.slug) || tagSlug(tag) || item.type;
  const label = (group && group.label) || tag;
  const entity = (group && group.entity) || item.type;

  const next = { ...item, tag, match: 'keyword' };
  delete next.via;
  index.byKey.set(key, { item: next, slug, label, entity });

  const target = ensureGroup(index, slug, label, entity);
  if (!target.keys.includes(key)) target.keys.push(key);

  if (previous && previous.slug !== slug) {
    const old = index.groups.get(previous.slug);
    if (old) old.keys = old.keys.filter((k) => k !== key);
  }
}

function addRelated(index, item) {
  const key = `${item.type}:${item.id}`;
  const existing = index.byKey.get(key);
  if (existing) {
    if (existing.item.match === 'related') {
      for (const title of item.via || []) {
        if (title && !existing.item.via.includes(title)) existing.item.via.push(title);
      }
    }
    return;
  }

  const tag = item.tag || ENTITY_TAGS[item.type] || item.type;
  const slug = tagSlug(tag) || item.type;
  const group = ensureGroup(index, slug, tag, item.type);
  index.byKey.set(key, {
    item: { ...item, tag, match: 'related', via: unique(item.via) },
    slug,
    label: tag,
    entity: item.type,
  });
  group.keys.push(key);
}

function compareEntries(a, b) {
  const aKeyword = a.item.match === 'keyword';
  const bKeyword = b.item.match === 'keyword';
  if (aKeyword !== bKeyword) return aKeyword ? -1 : 1;
  if (aKeyword) {
    const rank = (Number(b.item.rank) || 0) - (Number(a.item.rank) || 0);
    if (rank) return rank;
  }
  return (Number(b.item.id) || 0) - (Number(a.item.id) || 0);
}

function compareGroups(a, b) {
  const ra = ENTITY_ORDER[a.entity] == null ? 9 : ENTITY_ORDER[a.entity];
  const rb = ENTITY_ORDER[b.entity] == null ? 9 : ENTITY_ORDER[b.entity];
  if (ra !== rb) return ra - rb;
  return String(a.type).localeCompare(String(b.type));
}

function cloneItem(item) {
  const out = { ...item };
  if (out.via) out.via = [...out.via];
  return out;
}

function finalizeGroups(index) {
  const groups = [];
  for (const group of index.groups.values()) {
    const keys = [...group.keys].sort((a, b) => compareEntries(index.byKey.get(a), index.byKey.get(b)));
    if (!keys.length) continue;
    const kept = keys.slice(0, GROUP_KEEP);
    groups.push({
      type: group.slug,
      entity: group.entity,
      label: group.label,
      total: kept.length,
      items: kept.slice(0, GROUP_SHOW).map((k) => cloneItem(index.byKey.get(k).item)),
    });
  }
  groups.sort(compareGroups);
  return groups;
}

function countsFromGroups(groups) {
  const counts = {};
  for (const group of groups) counts[group.type] = group.total;
  return counts;
}

function voltageText(v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.filter((n) => n != null && n !== '').join(' ');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.filter((n) => n != null && n !== '').join(' ');
    } catch (_) {}
    return v;
  }
  return String(v);
}

function regionName(maps, id) {
  const region = id != null && maps.regionById ? maps.regionById.get(id) : null;
  return region ? region.name : '';
}

function lineForAsset(maps, asset) {
  if (!asset) return null;
  if (asset.line_id != null && maps.lineById) return maps.lineById.get(asset.line_id) || null;
  if (asset.tower_id != null && maps.towerById && maps.lineById) {
    const tower = maps.towerById.get(asset.tower_id);
    if (tower && tower.line_id != null) return maps.lineById.get(tower.line_id) || null;
  }
  return null;
}

function towerTitle(tower) {
  if (!tower) return '';
  if (tower.tower_id) return tower.tower_id;
  if (tower.tower_number != null) return `Tower ${tower.tower_number}`;
  return `Tower ${tower.id}`;
}

function describe(type, row, maps) {
  const safe = row || {};
  switch (type) {
    case 'region':
      return {
        tag: 'Region',
        title: safe.name,
        subtitle: safe.code || '',
        description: [safe.code, 'Network region'].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=region&region=${safe.id}`,
      };
    case 'substation':
      return {
        tag: 'Substation',
        title: safe.name,
        subtitle: [safe.substation_id, regionName(maps, safe.region_id)].filter(Boolean).join(' · '),
        description: ['Substation', safe.substation_id, regionName(maps, safe.region_id)].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=substation&substation=${safe.id}`,
      };
    case 'line':
      return {
        tag: 'Line',
        title: safe.name,
        subtitle: [safe.line_id, safe.voltage_kv != null ? `${safe.voltage_kv} kV` : null, regionName(maps, safe.region_id)].filter(Boolean).join(' · '),
        description: ['Transmission line', safe.voltage_kv != null ? `${safe.voltage_kv} kV` : null, regionName(maps, safe.region_id)].filter(Boolean).join(' · '),
        href: `/infrastructure?tab=line&line=${safe.id}`,
      };
    case 'tower':
      return {
        tag: 'Tower',
        title: towerTitle(safe),
        subtitle: safe.tower_type || '',
        description: ['Tower', safe.tower_type, safe.tower_number != null ? `No. ${safe.tower_number}` : null].filter(Boolean).join(' · '),
        href: safe.line_id != null
          ? `/infrastructure?tab=line&line=${safe.line_id}&manage=towers`
          : '/infrastructure?manage=towers',
      };
    case 'asset': {
      let place = '';
      let region = '';
      let voltage = '';
      if (safe.substation_id != null && maps.subById) {
        const sub = maps.subById.get(safe.substation_id);
        place = sub ? sub.name : '';
        region = sub ? regionName(maps, sub.region_id) : '';
        voltage = sub ? voltageText(sub.voltage_levels) : '';
      } else {
        const line = lineForAsset(maps, safe);
        place = line ? line.name : '';
        region = line ? regionName(maps, line.region_id) : '';
        voltage = line ? voltageText(line.voltage_kv) : '';
      }
      return {
        tag: assetTag(safe.asset_type),
        title: safe.name || safe.asset_id,
        subtitle: [safe.asset_id, safe.asset_type].filter(Boolean).join(' · '),
        description: ['Asset', safe.asset_type, place, region].filter(Boolean).join(' · '),
        href: `/assets?asset=${safe.id}`,
      };
    }
    case 'schedule':
      return {
        tag: 'Schedule',
        title: safe.schedule_name,
        subtitle: [safe.schedule_code, safe.frequency].filter(Boolean).join(' · '),
        description: ['Maintenance schedule', safe.frequency, safe.schedule_code].filter(Boolean).join(' · '),
        href: '/schedules',
      };
    case 'task':
      return {
        tag: 'Task',
        title: safe.title || safe.task_number,
        subtitle: [safe.task_number, safe.status].filter(Boolean).join(' · '),
        description: [safe.task_number, safe.status].filter(Boolean).join(' · '),
        href: `/tasks/${safe.id}`,
      };
    default:
      return {
        tag: ENTITY_TAGS[type] || type,
        title: safe.name || safe.title || '',
        subtitle: '',
        description: ENTITY_TAGS[type] || type,
        href: null,
      };
  }
}

function expand({ hits, maps, canOpen = () => true, index = createIndex() }) {
  const source = maps || {};
  const regionById = source.regionById || new Map();
  const subById = source.subById || new Map();
  const lineById = source.lineById || new Map();
  const towerById = source.towerById || new Map();
  const assetById = source.assetById || new Map();
  const regions = source.regions || [];
  const substations = source.substations || [];
  const lines = source.lines || [];
  const towers = source.towers || [];
  const assets = source.assets || [];
  const tasks = source.tasks || [];
  const schedules = source.schedules || [];
  const ctx = { ...source, regionById, subById, lineById, towerById, assetById };

  const towersByLine = new Map();
  for (const tower of towers) {
    if (tower.line_id == null) continue;
    if (!towersByLine.has(tower.line_id)) towersByLine.set(tower.line_id, []);
    towersByLine.get(tower.line_id).push(tower);
  }

  const linesBySubstation = new Map();
  for (const line of lines) {
    for (const subId of [line.from_substation_id, line.to_substation_id]) {
      if (subId == null) continue;
      if (!linesBySubstation.has(subId)) linesBySubstation.set(subId, []);
      linesBySubstation.get(subId).push(line);
    }
  }

  const assetsByTower = new Map();
  for (const asset of assets) {
    if (asset.tower_id == null) continue;
    if (!assetsByTower.has(asset.tower_id)) assetsByTower.set(asset.tower_id, []);
    assetsByTower.get(asset.tower_id).push(asset);
  }

  function addKind(type, rows, viasFor) {
    const sorted = uniqueById(rows).sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    let count = 0;
    for (const row of sorted) {
      if (count >= PER_KIND) break;
      count += 1;
      const raw = typeof viasFor === 'function' ? viasFor(row) : viasFor;
      const vias = unique(Array.isArray(raw) ? raw : [raw]);
      const data = describe(type, row, ctx);
      const open = !!canOpen(type, row);
      const item = {
        id: row.id,
        type,
        title: data.title,
        subtitle: data.subtitle || '',
        description: data.description,
        tag: data.tag,
        can_open: open,
        match: 'related',
        via: vias,
      };
      if (open && data.href) item.href = data.href;
      addRelated(index, item);
    }
  }

  function lineNameOf(lineId) {
    const line = lineId == null ? null : lineById.get(lineId);
    return line ? line.name : '';
  }

  function lineNameOfTower(towerId) {
    const tower = towerId == null ? null : towerById.get(towerId);
    return tower && tower.line_id != null ? lineNameOf(tower.line_id) : '';
  }

  function substationLines(substation) {
    return uniqueById(linesBySubstation.get(substation.id) || []);
  }

  function expandRegion(region) {
    addKind('substation', substations.filter((s) => s.region_id === region.id), region.name);
    addKind('line', lines.filter((l) => l.region_id === region.id), region.name);
    const regionSchedules = schedules.filter((s) => {
      if (s.region_id !== region.id) return false;
      return s.scope_type === 'REGION' || GROUP_SCOPES.has(s.scope_type);
    });
    addKind('schedule', regionSchedules, region.name);
  }

  function expandSubstation(substation) {
    addKind('asset', assets.filter((a) => a.substation_id === substation.id), substation.name);

    const subLines = substationLines(substation);
    addKind('line', subLines, substation.name);

    const lineIds = new Set(subLines.map((l) => l.id));
    const lineTowers = uniqueById(subLines.flatMap((l) => towersByLine.get(l.id) || []));
    addKind('tower', lineTowers, (t) => lineNameOf(t.line_id));
    const towerIds = new Set(lineTowers.map((t) => t.id));

    const lineAssets = uniqueById([
      ...assets.filter((a) => a.line_id != null && lineIds.has(a.line_id)),
      ...assets.filter((a) => a.tower_id != null && towerIds.has(a.tower_id)),
    ]);
    addKind('asset', lineAssets, (a) => {
      const line = lineForAsset(ctx, a);
      return line ? line.name : substation.name;
    });

    const subTasks = tasks.filter((t) => (
      t.substation_id === substation.id ||
      (t.line_id != null && lineIds.has(t.line_id)) ||
      (t.tower_id != null && towerIds.has(t.tower_id))
    ));
    addKind('task', subTasks, (t) => {
      const vias = [];
      if (t.substation_id === substation.id) vias.push(substation.name);
      if (t.line_id != null && lineIds.has(t.line_id)) vias.push(lineNameOf(t.line_id));
      if (t.tower_id != null && towerIds.has(t.tower_id)) vias.push(lineNameOfTower(t.tower_id));
      return vias;
    });

    const subSchedules = schedules.filter((s) => (
      s.substation_id === substation.id ||
      (s.line_id != null && lineIds.has(s.line_id)) ||
      (s.tower_id != null && towerIds.has(s.tower_id))
    ));
    addKind('schedule', subSchedules, (s) => {
      const vias = [];
      if (s.substation_id === substation.id) vias.push(substation.name);
      if (s.line_id != null && lineIds.has(s.line_id)) vias.push(lineNameOf(s.line_id));
      if (s.tower_id != null && towerIds.has(s.tower_id)) vias.push(lineNameOfTower(s.tower_id));
      return vias;
    });
  }

  function expandLine(line) {
    const lineTowerRows = uniqueById(towersByLine.get(line.id) || []);
    addKind('tower', lineTowerRows, line.name);

    const lineAssets = uniqueById([
      ...assets.filter((a) => a.line_id === line.id),
      ...lineTowerRows.flatMap((t) => assetsByTower.get(t.id) || []),
    ]);
    addKind('asset', lineAssets, line.name);

    const endpointSubs = uniqueById(
      [line.from_substation_id, line.to_substation_id]
        .map((id) => (id == null ? null : subById.get(id)))
        .filter(Boolean)
    );
    addKind('substation', endpointSubs, line.name);

    const towerIds = new Set(lineTowerRows.map((t) => t.id));
    const lineTasks = tasks.filter((t) => (
      t.line_id === line.id || (t.tower_id != null && towerIds.has(t.tower_id))
    ));
    addKind('task', lineTasks, line.name);

    const lineSchedules = schedules.filter((s) => (
      s.line_id === line.id || (s.tower_id != null && towerIds.has(s.tower_id))
    ));
    addKind('schedule', lineSchedules, line.name);
  }

  function expandTower(tower) {
    const parentLine = tower.line_id == null ? null : lineById.get(tower.line_id);
    const title = towerTitle(tower);
    if (parentLine) addKind('line', [parentLine], title);
    addKind('asset', assetsByTower.get(tower.id) || [], title);

    const towerTasks = tasks.filter((t) => (
      t.tower_id === tower.id || (parentLine && t.line_id === parentLine.id)
    ));
    addKind('task', towerTasks, (t) => (
      t.tower_id === tower.id ? title : (parentLine ? parentLine.name : title)
    ));

    const towerSchedules = schedules.filter((s) => (
      s.tower_id === tower.id || (parentLine && s.line_id === parentLine.id)
    ));
    addKind('schedule', towerSchedules, (s) => (
      s.tower_id === tower.id ? title : (parentLine ? parentLine.name : title)
    ));
  }

  function expandAsset(asset) {
    const title = asset.name || asset.asset_id;
    let parent = null;
    if (asset.substation_id != null && subById.get(asset.substation_id)) {
      parent = { type: 'substation', row: subById.get(asset.substation_id) };
    } else {
      const line = lineForAsset(ctx, asset);
      if (line) parent = { type: 'line', row: line };
    }
    if (parent) addKind(parent.type, [parent.row], title);

    addKind('task', tasks.filter((t) => t.asset_id === asset.id), title);
    addKind('schedule', schedules.filter((s) => s.asset_id === asset.id), title);
  }

  function expandSchedule(schedule) {
    const title = schedule.schedule_name;
    if (schedule.scope_type === 'TOWER' && schedule.tower_id != null) {
      const tower = towerById.get(schedule.tower_id);
      if (tower) addKind('tower', [tower], title);
      const lineId = schedule.line_id != null ? schedule.line_id : (tower ? tower.line_id : null);
      const line = lineId == null ? null : lineById.get(lineId);
      if (line) addKind('line', [line], title);
      return;
    }

    if (schedule.tower_id != null) {
      const tower = towerById.get(schedule.tower_id);
      if (tower) addKind('tower', [tower], title);
    }
    if (schedule.asset_id != null) {
      const asset = assetById.get(schedule.asset_id);
      if (asset) addKind('asset', [asset], title);
    }
    if (schedule.line_id != null) {
      const line = lineById.get(schedule.line_id);
      if (line) addKind('line', [line], title);
    }
    if (schedule.substation_id != null) {
      const substation = subById.get(schedule.substation_id);
      if (substation) addKind('substation', [substation], title);
    }
    if (schedule.region_id != null) {
      const region = regionById.get(schedule.region_id);
      if (region) addKind('region', [region], title);
    }
  }

  const hitsByType = new Map();
  for (const hit of hits || []) {
    if (!hit || !hit.type || !hit.row) continue;
    if (!hitsByType.has(hit.type)) hitsByType.set(hit.type, []);
    hitsByType.get(hit.type).push(hit.row);
  }

  for (const type of ['region', 'substation', 'line', 'tower', 'asset', 'schedule']) {
    const rows = hitsByType.get(type);
    if (!rows) continue;
    rows.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    for (const row of rows) {
      if (type === 'region') expandRegion(row);
      else if (type === 'substation') expandSubstation(row);
      else if (type === 'line') expandLine(row);
      else if (type === 'tower') expandTower(row);
      else if (type === 'asset') expandAsset(row);
      else if (type === 'schedule') expandSchedule(row);
    }
  }

  return index;
}

module.exports = {
  PER_KIND,
  GROUP_KEEP,
  GROUP_SHOW,
  assetTag,
  tagSlug,
  entityTag,
  describe,
  createIndex,
  addKeyword,
  addRelated,
  finalizeGroups,
  countsFromGroups,
  expand,
};
