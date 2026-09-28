const { db, get } = require('./util');

function currencyCode() {
  const r = db.prepare("SELECT value FROM system_config WHERE key = 'currency'").get();
  return (r && r.value) || 'USD';
}

function assetRegion(a) {
  if (!a) return null;
  if (a.substation_id) return get('substation', a.substation_id)?.region_id ?? null;
  if (a.line_id) return get('transmission_line', a.line_id)?.region_id ?? null;
  if (a.tower_id) {
    const t = get('tower', a.tower_id);
    return t ? get('transmission_line', t.line_id)?.region_id ?? null : null;
  }
  return null;
}

function maintenanceCostForRegions(regionIds, { from, to, limit = 25 } = {}) {
  const code = currencyCode();
  const regionSet = new Set(regionIds);
  const startMs = from ? new Date(`${from}T00:00:00.000Z`).getTime() : Date.now() - 365 * 864e5;
  const endMs = to ? new Date(`${to}T23:59:59.999Z`).getTime() : Date.now();
  const events = db.prepare('SELECT * FROM asset_maintenance_event ORDER BY performed_at DESC').all().map((e) => {
    const at = new Date(e.performed_at).getTime();
    const asset = e.asset_id ? get('asset', e.asset_id) : null;
    return { ...e, asset, at, cost: Number(e.cost) || 0, rid: assetRegion(asset) };
  }).filter((e) => Number.isFinite(e.at) && e.at >= startMs && e.at <= endMs && regionSet.has(e.rid));
  const byRegion = new Map();
  const byAssetType = new Map();
  const byEventType = new Map();
  const byMonth = new Map();
  let spend = 0;
  for (const e of events) {
    spend += e.cost;
    const rid = e.rid;
    const r = get('region', rid);
    if (!byRegion.has(rid)) byRegion.set(rid, { region: r ? r.name : `#${rid}`, count: 0, spend: 0 });
    byRegion.get(rid).count += 1;
    byRegion.get(rid).spend += e.cost;
    const type = e.asset ? (e.asset.asset_type || 'UNSPECIFIED') : 'UNSPECIFIED';
    if (!byAssetType.has(type)) byAssetType.set(type, { asset_type: type, count: 0, spend: 0 });
    byAssetType.get(type).count += 1;
    byAssetType.get(type).spend += e.cost;
    if (!byEventType.has(e.event_type)) byEventType.set(e.event_type, { event_type: e.event_type, count: 0, spend: 0 });
    byEventType.get(e.event_type).count += 1;
    byEventType.get(e.event_type).spend += e.cost;
    const month = String(e.performed_at || '').slice(0, 7);
    if (month) {
      if (!byMonth.has(month)) byMonth.set(month, { month, count: 0, spend: 0 });
      byMonth.get(month).count += 1;
      byMonth.get(month).spend += e.cost;
    }
  }
  const sortBySpend = (arr) => [...arr].sort((a, b) => b.spend - a.spend);
  return {
    currency: { code },
    from: from || null,
    to: to || null,
    totals: { spend, count: events.length, avg: events.length ? spend / events.length : 0 },
    by_region: sortBySpend([...byRegion.values()]),
    by_asset_type: sortBySpend([...byAssetType.values()]),
    by_event_type: sortBySpend([...byEventType.values()]),
    monthly: [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    recent: events.slice(0, limit).map((e) => ({
      id: e.id,
      asset_pk: e.asset ? e.asset.id : null,
      asset_id: e.asset ? e.asset.asset_id : null,
      asset_name: e.asset ? e.asset.name : null,
      event_type: e.event_type,
      performed_at: e.performed_at,
      cost: e.cost,
      crew_name: e.crew_id ? get('crew', e.crew_id)?.name || null : null,
    })),
  };
}

module.exports = { maintenanceCostForRegions, currencyCode, assetRegion };
