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

const GROUP_KEEP = 40;
const GROUP_SHOW = 12;

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

export function tagSlugFromItem(item) {
  if (!item) return '';
  if (item.tag) return tagSlug(item.tag);
  const tag = item.type === 'asset' ? assetTag(item.asset_type) : (ENTITY_TAGS[item.type] || item.type);
  return tagSlug(tag);
}

function compareItems(a, b) {
  const aKeyword = a.match === 'keyword';
  const bKeyword = b.match === 'keyword';
  if (aKeyword !== bKeyword) return aKeyword ? -1 : 1;
  if (aKeyword) {
    const rank = (Number(b.rank) || 0) - (Number(a.rank) || 0);
    if (rank) return rank;
  }
  return (Number(b.id) || 0) - (Number(a.id) || 0);
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

export function mergeSearchResults(catalog, scoped) {
  const entries = new Map();
  const groups = new Map();

  function ensureGroup(slug, label, entity) {
    let group = groups.get(slug);
    if (!group) {
      group = { type: slug, label, entity, keys: [] };
      groups.set(slug, group);
    }
    return group;
  }

  function register(item, slug, label, entity) {
    const key = `${item.type}:${item.id}`;
    entries.set(key, { item, slug, label, entity });
    const group = ensureGroup(slug, label, entity);
    if (!group.keys.includes(key)) group.keys.push(key);
  }

  for (const group of catalog?.groups || []) {
    for (const raw of group.items || []) {
      const item = { ...raw };
      const slug = item.tag ? tagSlug(item.tag) : (group.type || tagSlugFromItem(item));
      const label = item.tag || group.label || ENTITY_TAGS[item.type] || item.type;
      const entity = item.type || group.entity || group.type;
      register(item, slug, label, entity);
    }
  }

  for (const group of scoped?.groups || []) {
    for (const raw of group.items || []) {
      const item = { ...raw };
      const key = `${item.type}:${item.id}`;
      const existing = entries.get(key);
      if (existing) {
        if (existing.item.match === 'related') {
          const merged = {
            ...existing.item,
            title: item.title ?? existing.item.title,
            subtitle: item.subtitle ?? existing.item.subtitle,
            can_open: item.can_open ?? existing.item.can_open,
            match: 'keyword',
          };
          delete merged.via;
          if (item.href !== undefined) merged.href = item.href;
          if (item.document_type !== undefined) merged.document_type = item.document_type;
          entries.set(key, { ...existing, item: merged });
        }
        continue;
      }
      const tag = item.tag || (item.type === 'asset' ? assetTag(item.asset_type) : (ENTITY_TAGS[item.type] || item.type));
      const slug = tagSlug(tag);
      register({ ...item, tag, match: 'keyword' }, slug, tag, item.type);
    }
  }

  const out = [];
  for (const group of groups.values()) {
    const keys = [...group.keys].sort((a, b) => compareItems(entries.get(a).item, entries.get(b).item));
    if (!keys.length) continue;
    const kept = keys.slice(0, GROUP_KEEP);
    out.push({
      type: group.type,
      entity: group.entity,
      label: group.label,
      total: kept.length,
      items: kept.slice(0, GROUP_SHOW).map((k) => cloneItem(entries.get(k).item)),
    });
  }
  out.sort(compareGroups);

  const counts = {};
  for (const group of out) counts[group.type] = group.total;
  const total = out.reduce((n, group) => n + group.total, 0);

  return {
    query: catalog?.query || scoped?.query || '',
    counts,
    total,
    groups: out,
  };
}

const PLURAL_OVERRIDES = { person: 'people' };

function pascal(slug) {
  return String(slug).split('_').filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function tagLabel(slug, count, t) {
  const singular = Number(count) === 1;
  const resolved = !singular && PLURAL_OVERRIDES[slug] ? PLURAL_OVERRIDES[slug] : (singular ? slug : `${slug}s`);
  const key = `searchTag${pascal(resolved)}`;
  if (t) {
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  const words = String(slug).replace(/_/g, ' ');
  return singular ? words : `${words}s`;
}

export function buildSearchSummary(query, counts, t) {
  const parts = Object.entries(counts || {})
    .filter(([, n]) => Number(n) > 0)
    .map(([slug, n]) => `${n} ${tagLabel(slug, n, t)}`);
  if (!parts.length) return '';
  const pick = t ? t('searchPickOne') : 'pick one';
  return `${query || ''}: ${parts.join(', ')} — ${pick}`;
}
