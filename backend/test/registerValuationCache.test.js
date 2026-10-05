const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.TMMS_DB = path.join(os.tmpdir(), `tmms-valcache-${process.pid}-${Date.now()}.db`);

const { initSchema } = require('../db');
const { insertRow } = require('../util');
initSchema();

const {
  computeRegionValuation,
  mergeValuations,
  buildPopulationCache,
} = require('../routes/register');

function seedRegion(code, name, price) {
  const regionId = insertRow('region', { code, name, center_lat: 35, center_lng: -97 });
  const subId = insertRow('substation', { substation_id: `SUB-${code}`, name: `Sub ${code}`, region_id: regionId, latitude: 35, longitude: -97 });
  const other = insertRow('substation', { substation_id: `SUB-${code}-2`, name: `Sub ${code} 2`, region_id: regionId, latitude: 35.1, longitude: -97.1 });
  const lineId = insertRow('transmission_line', {
    line_id: `TL-${code}`, name: `Line ${code}`, region_id: regionId,
    from_substation_id: subId, to_substation_id: other, voltage_kv: 220, length_km: 10,
  });
  const towerId = insertRow('tower', { tower_id: `TWR-${code}`, line_id: lineId, tower_number: '1', km_marker: 5, latitude: 35, longitude: -97 });
  insertRow('asset', { asset_id: `XFR-${code}`, asset_type: 'TRANSFORMER', substation_id: subId, name: 'XFR', condition_rating: 8 });
  insertRow('asset', { asset_id: `CON-${code}`, asset_type: 'CONDUCTOR_SPAN', line_id: lineId, name: 'Span', km_from: 0, km_to: 10, condition_rating: 6 });
  insertRow('asset', { asset_id: `TOW-${code}`, asset_type: 'TOWER', tower_id: towerId, name: 'Tower', condition_rating: 5 });
  return regionId;
}

insertRow('asset_catalog', { family: 'TRANSFORMER', family_label: 'Transformer', label: 'Transformer', asset_type: 'TRANSFORMER', sub_type: '', unit_of_measure: 'EA', default_unit_price: 1000000 });
insertRow('asset_catalog', { family: 'CONDUCTOR_AND_OPGW', family_label: 'Conductor', label: 'Conductor', asset_type: 'CONDUCTOR_SPAN', sub_type: '', unit_of_measure: 'KM', default_unit_price: 1000 });
insertRow('asset_catalog', { family: 'TOWER', family_label: 'Tower', label: 'Tower', asset_type: 'TOWER', sub_type: '', unit_of_measure: 'EA', default_unit_price: 50000 });

const regionA = seedRegion('AA', 'Alpha', 1);
const regionB = seedRegion('BB', 'Beta', 2);

function summarize(ids, cache) {
  const merged = mergeValuations(ids.map((id) => computeRegionValuation(id, { global: true }, cache)));
  return {
    totals: merged.totals,
    by_type: merged.by_type.map((r) => ({ asset_type: r.asset_type, count: r.count, rcn: r.rcn, current: r.current })),
    by_family: merged.by_family.map((r) => ({ family: r.family, count: r.count, rcn: r.rcn, current: r.current })),
  };
}

test('population cache preserves the uncached valuation output', () => {
  const uncached = summarize([regionA, regionB]);
  const cached = summarize([regionA, regionB], buildPopulationCache());
  assert.deepStrictEqual(cached, uncached);
});

test('a shared cache yields the same result as a fresh cache per region', () => {
  const shared = summarize([regionA, regionB], buildPopulationCache());
  const perRegion = mergeValuations([
    computeRegionValuation(regionA, { global: true }, buildPopulationCache()),
    computeRegionValuation(regionB, { global: true }, buildPopulationCache()),
  ]);
  assert.deepStrictEqual(shared.by_type, summarize([regionA, regionB]).by_type);
  assert.strictEqual(perRegion.totals.count, shared.totals.count);
  assert.strictEqual(perRegion.totals.current, shared.totals.current);
});
