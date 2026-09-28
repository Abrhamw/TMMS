// Controlled asset catalog (families -> types -> subtypes). Single source of
// truth for asset typing; seeded idempotently at every boot.
const { db } = require('./db');
const { insertRow } = require('./util');
const { COMPONENT_CATALOG } = require('./towerComponents');

const FAMILY_LABEL = {
  CONTROL_AND_PROTECTION: 'Control & Protection',
  SAS_RTU_AND_TELECOM: 'SAS / RTU & Telecom',
  DC_AND_AUXILIARY: 'DC System & Auxiliary Supplies',
  MV_SWITCHGEAR: 'MV/LV Switchgear',
  HV_YARD_AND_TRANSFORMATION: 'HV Yard & Transformation',
  CONDUCTOR_AND_OPGW: 'Conductors & OPGW',
  JOINT_BOX: 'Joint Boxes (line splices)',
  TOWER_PARTS: 'Tower Parts (register vocabulary)',
  TOWER_STRUCTURE: 'Tower Structure',
  UNCLASSIFIED: 'Unclassified / legacy',
};

const ROWS = [
  // Substation indoor / yard families
  ['CONTROL_AND_PROTECTION', 'PROTECTION_RELAY', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['CONTROL_AND_PROTECTION', 'RELAY_PANEL', '', 'PANEL', 'SUBSTATION', 'INDOOR'],
  ['CONTROL_AND_PROTECTION', 'METER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['CONTROL_AND_PROTECTION', 'SUBSTATION_CONTROLLER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'SCADA_RTU', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'IED', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'NETWORK_SWITCH', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'COMMUNICATION_RADIO', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['SAS_RTU_AND_TELECOM', 'OPTICAL_FIBER', '', 'EA', 'SUBSTATION', 'ANY'],
  ['DC_AND_AUXILIARY', 'BATTERY_BANK', '', 'BANK', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'BATTERY_CHARGER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'DC_DISTRIBUTION_PANEL', '', 'PANEL', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'AUXILIARY_TRANSFORMER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['DC_AND_AUXILIARY', 'UPS', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'SWITCHGEAR', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'GIS', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'MV_CIRCUIT_BREAKER', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['MV_SWITCHGEAR', 'MV_DISCONNECTOR', '', 'EA', 'SUBSTATION', 'INDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'TRANSFORMER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'AUTO_TRANSFORMER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'HV_CIRCUIT_BREAKER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'DISCONNECTOR', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'GROUND_SWITCH', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'CT', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'VT', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'LIGHTNING_ARRESTER', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'BUSBAR', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'REACTOR', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'CAPACITOR_BANK', '', 'BANK', 'SUBSTATION', 'OUTDOOR'],
  ['HV_YARD_AND_TRANSFORMATION', 'EARTHING_MAT', '', 'EA', 'SUBSTATION', 'OUTDOOR'],
  // Line families
  ['CONDUCTOR_AND_OPGW', 'CONDUCTOR_SPAN', '', 'KM', 'LINE', null],
  ['CONDUCTOR_AND_OPGW', 'OPGW_SPAN', '', 'KM', 'LINE', null],
  ['JOINT_BOX', 'JOINT_BOX', '', 'EA', 'LINE', null],
  ['TOWER_STRUCTURE', 'TOWER', '', 'EA', 'LINE', null],
  ['TOWER_STRUCTURE', 'POLE', '', 'EA', 'LINE', null],
];

const CATALOG = ROWS.map(([family, asset_type, sub_type, unit_of_measure, location_kind, default_location_type]) => ({
  family,
  family_label: FAMILY_LABEL[family],
  label: asset_type.replace(/_/g, ' '),
  asset_type,
  sub_type,
  unit_of_measure,
  location_kind,
  default_location_type,
  active: 1,
}));

// Benchmark replacement-cost-new (RCN) prices per catalog class, keyed by
// asset_type. KM-priced rows are per-kilometre; everything else per unit.
// TOWER_PARTS and UNCLASSIFIED catch-alls stay unpriced on purpose (gap).
const PRICES = {
  // Control & protection
  PROTECTION_RELAY: 8500, RELAY_PANEL: 24000, METER: 3200, SUBSTATION_CONTROLLER: 45000,
  // SAS / RTU & telecom
  SCADA_RTU: 42000, IED: 6500, NETWORK_SWITCH: 2800, COMMUNICATION_RADIO: 15000, OPTICAL_FIBER: 9000,
  // DC & auxiliary
  BATTERY_BANK: 18000, BATTERY_CHARGER: 6500, DC_DISTRIBUTION_PANEL: 9000, AUXILIARY_TRANSFORMER: 26000, UPS: 16000,
  // MV switchgear
  SWITCHGEAR: 38000, GIS: 120000, MV_CIRCUIT_BREAKER: 30000, MV_DISCONNECTOR: 9500,
  // HV yard & transformation
  TRANSFORMER: 1200000, AUTO_TRANSFORMER: 1800000, HV_CIRCUIT_BREAKER: 210000,
  DISCONNECTOR: 48000, GROUND_SWITCH: 26000, CT: 9000, VT: 8000, LIGHTNING_ARRESTER: 6000,
  BUSBAR: 150000, REACTOR: 550000, CAPACITOR_BANK: 240000, EARTHING_MAT: 38000,
  // Line families
  CONDUCTOR_SPAN: 52000, OPGW_SPAN: 45000, JOINT_BOX: 2500,
  // Tower structure
  TOWER: 95000, POLE: 32000,
};

// Tower part vocabulary derived from the existing component catalog.
for (const c of COMPONENT_CATALOG) {
  CATALOG.push({
    family: 'TOWER_PARTS',
    family_label: FAMILY_LABEL.TOWER_PARTS,
    label: c.name,
    asset_type: c.type,
    sub_type: '',
    unit_of_measure: String(c.unit || 'EA').toUpperCase(),
    location_kind: 'TOWER',
    default_location_type: null,
    active: 1,
  });
}

function findCatalog(asset_type, sub_type = '') {
  const s = sub_type == null ? '' : String(sub_type);
  const row = CATALOG.find((c) => c.asset_type === asset_type && (c.sub_type === s || (c.sub_type === '' && s === '')));
  if (row) return row;
  const any = CATALOG.find((c) => c.asset_type === asset_type);
  return any || undefined;
}

// Insert any asset_type still used by the database that is missing from the
// seed, so existing rows stay typable (legacy catch-all family).
function ensureLegacyTypes() {
  const used = db.prepare('SELECT DISTINCT asset_type AS t FROM asset').all();
  let added = 0;
  for (const { t } of used) {
    if (!t) continue;
    if (CATALOG.some((c) => c.asset_type === t)) continue;
    CATALOG.push({
      family: 'UNCLASSIFIED',
      family_label: FAMILY_LABEL.UNCLASSIFIED,
      label: t.replace(/_/g, ' '),
      asset_type: t,
      sub_type: '',
      unit_of_measure: 'EA',
      location_kind: 'ANY',
      default_location_type: null,
      active: 1,
    });
    added++;
  }
  return added;
}

// Every tower row keeps exactly one asset row of type TOWER so the register
// tree and register summary never double-count towers.
function backfillTowerAssets() {
  const missing = db.prepare(
    `SELECT t.id, t.tower_id, t.line_id, t.latitude, t.longitude, t.tower_type, t.tower_material, t.height_m,
            t.corrosion_rating, t.gps_validated
     FROM tower t
     WHERE NOT EXISTS (SELECT 1 FROM asset a WHERE a.tower_id = t.id AND a.asset_type = 'TOWER')`
  ).all();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const t of missing) {
    const assetId = `TWR-${t.tower_id}`;
    const existing = db.prepare('SELECT id FROM asset WHERE asset_id = ?').get(assetId);
    const metadata = JSON.stringify({ source: 'tower', tower_type: t.tower_type, height_m: t.height_m, material: t.tower_material });
    if (existing) {
      db.prepare(
        'UPDATE asset SET asset_type = ?, line_id = ?, tower_id = ?, name = ?, latitude = ?, longitude = ?, condition_rating = ?, gps_validated = ?, metadata = ? WHERE id = ?'
      ).run('TOWER', t.line_id, t.id, t.tower_id, t.latitude, t.longitude, t.corrosion_rating ?? 8, t.gps_validated, metadata, existing.id);
      continue;
    }
    stmt.run(assetId, 'TOWER', t.line_id, t.id, t.tower_id, t.latitude, t.longitude,
      t.corrosion_rating ?? 8, now, 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM', t.gps_validated, metadata);
  }
  return missing.length;
}

function ensureAssetCatalog() {
  const legacyAdded = ensureLegacyTypes();
  const stmt = db.prepare(
    `INSERT INTO asset_catalog (family, family_label, label, asset_type, sub_type, unit_of_measure, location_kind, default_location_type, active)
     VALUES (?,?,?,?,?,?,?,?,1)
     ON CONFLICT(family, asset_type, sub_type) DO NOTHING`
  );
  let seeded = 0;
  for (const c of CATALOG) {
    const r = stmt.run(c.family, c.family_label, c.label, c.asset_type, c.sub_type, c.unit_of_measure, c.location_kind, c.default_location_type);
    seeded += Number(r.changes);
  }
  const towers = backfillTowerAssets();
  console.log(`[assetCatalog] seeded ${seeded} catalog row(s) (${legacyAdded} legacy type(s) added), backfilled ${towers} tower asset row(s)`);
}

function ensureRegisterDemo() {
  const c1 = db.prepare('SELECT id, center_lat, center_lng FROM region WHERE code = ?').get('C1');
  if (!c1) return;
  const now = new Date().toISOString();
  const mkAsset = (asset_id, name, asset_type, substation_id, line_id, bay, location_type, km_from, km_to) => {
    const has = db.prepare('SELECT id FROM asset WHERE asset_id = ?').get(asset_id);
    if (has) return 0;
    insertRow('asset', {
      asset_id, name, asset_type, substation_id, line_id, bay: bay || null,
      location_type, km_from: km_from ?? null, km_to: km_to ?? null,
      latitude: null, longitude: null, condition_rating: 8, condition_assessed_at: now,
      lifecycle_status: 'IN_SERVICE', operational_status: 'OPERATIONAL', criticality: 'MEDIUM',
      gps_validated: 0, metadata: JSON.stringify({ source: 'demo_register' }), revision: 1,
    });
    return 1;
  };

  let subId = db.prepare('SELECT id FROM substation WHERE substation_id = ?').get('C1-DEMO-SUB')?.id;
  if (!subId) {
    subId = insertRow('substation', {
      substation_id: 'C1-DEMO-SUB', name: 'C1 Demo Substation (Indoor Systems)', region_id: c1.id,
      latitude: c1.center_lat, longitude: c1.center_lng, voltage_levels: '["400"]', substation_type: 'TRANSMISSION',
      operational_status: 'OPERATIONAL', revision: 1,
    });
  }
  const indoor = [
    ['DEMO-C1-CP-01', 'Line protection relay P1', 'PROTECTION_RELAY', 'CONTROL_AND_PROTECTION', 'Bay 2'],
    ['DEMO-C1-CP-02', 'Feeder metering panel', 'METER', 'CONTROL_AND_PROTECTION', 'Bay 2'],
    ['DEMO-C1-RTU-01', 'Substation RTU', 'SCADA_RTU', 'SAS_RTU_AND_TELECOM', 'Control room'],
    ['DEMO-C1-RTU-02', 'Bay IED', 'IED', 'SAS_RTU_AND_TELECOM', 'Bay 2'],
    ['DEMO-C1-DC-01', 'Station battery bank', 'BATTERY_BANK', 'DC_AND_AUXILIARY', 'DC room'],
    ['DEMO-C1-DC-02', 'Battery charger', 'BATTERY_CHARGER', 'DC_AND_AUXILIARY', 'DC room'],
    ['DEMO-C1-AUX-01', 'Auxiliary supply transformer', 'AUXILIARY_TRANSFORMER', 'DC_AND_AUXILIARY', 'Annex'],
    ['DEMO-C1-MV-01', 'MV switchgear panel', 'SWITCHGEAR', 'MV_SWITCHGEAR', 'MV room'],
    ['DEMO-C1-MV-02', 'MV circuit breaker', 'MV_CIRCUIT_BREAKER', 'MV_SWITCHGEAR', 'MV room'],
    ['DEMO-C1-HV-01', 'Main power transformer T1', 'TRANSFORMER', 'HV_YARD_AND_TRANSFORMATION', 'Yard'],
  ];
  const bayByFamily = { CONTROL_AND_PROTECTION: 'Bay 2', SAS_RTU_AND_TELECOM: 'Control room', DC_AND_AUXILIARY: 'DC room', MV_SWITCHGEAR: 'MV room', HV_YARD_AND_TRANSFORMATION: 'Yard' };
  const FAMILY = new Map(CATALOG.map((c) => [c.asset_type, c.family]));
  let created = 0;
  for (const [aid, name, type] of indoor) created += mkAsset(aid, name, type, subId, null, bayByFamily[FAMILY.get(type)], 'INDOOR');

  // Line demo: spans + JBs on the first C1 line with towers.
  const line = db.prepare(
    `SELECT l.id FROM transmission_line l JOIN tower t ON t.line_id = l.id WHERE l.region_id = ? GROUP BY l.id ORDER BY COUNT(t.id) DESC LIMIT 1`
  ).get(c1.id);
  if (line) {
    const towers = db.prepare('SELECT km_marker FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(line.id);
    const km = towers.map((t) => Number(t.km_marker) || 0);
    const start = Math.min(...km);
    const end = Math.max(...km);
    created += mkAsset('DEMO-C1-COND-01', 'C1 demo conductor span', 'CONDUCTOR_SPAN', null, line.id, null, null, start, end);
    created += mkAsset('DEMO-C1-OPGW-01', 'C1 demo OPGW span', 'OPGW_SPAN', null, line.id, null, null, start, end);
    const interval = Number(db.prepare('SELECT joint_box_interval_km FROM transmission_line WHERE id = ?').get(line.id).joint_box_interval_km) || 5;
    const seqBase = db.prepare("SELECT COUNT(*) c FROM asset WHERE line_id = ? AND asset_type = 'JOINT_BOX' AND asset_id LIKE 'DEMO-C1-JB-%'").get(line.id).c;
    const existingJbKm = db.prepare("SELECT km_from FROM asset WHERE line_id = ? AND asset_type = 'JOINT_BOX'").all(line.id)
      .map((r) => Number(r.km_from) || 0).filter((v) => v > 0);
    let seq = seqBase + 1;
    for (let kmPos = interval; kmPos <= end + 1e-9; kmPos += interval) {
      const k = Math.round(kmPos * 100) / 100;
      if (existingJbKm.some((e) => Math.abs(e - k) < 0.25)) continue;
      created += mkAsset(`DEMO-C1-JB-${String(seq).padStart(2, '0')}`, `Joint box @ ${k} km`, 'JOINT_BOX', null, line.id, null, null, k, k);
      existingJbKm.push(k);
      seq += 1;
    }
  }
  if (created > 0) console.log(`[assetCatalog] demo register: ${created} asset row(s) added`);
}

// Backfill benchmark prices on every catalog row we have a price for. Only
// fills NULL/0 so an admin's manual edit is never overwritten on reboot.
function ensureCatalogPrices() {
  let changed = 0;
  const rows = db.prepare("SELECT id, family, asset_type FROM asset_catalog").all();
  for (const r of rows) {
    if (r.family === 'TOWER_PARTS' || r.family === 'UNCLASSIFIED') continue;
    const price = PRICES[r.asset_type];
    if (price === undefined) continue;
    const cur = db.prepare('SELECT default_unit_price FROM asset_catalog WHERE id = ?').get(r.id);
    const curPrice = Number(cur && cur.default_unit_price) || 0;
    if (curPrice === 0) {
      db.prepare('UPDATE asset_catalog SET default_unit_price = ? WHERE id = ?').run(price, r.id);
      changed += 1;
    }
  }
  console.log(`[assetCatalog] priced ${changed} catalog row(s)`);
  return changed;
}

module.exports = { CATALOG, FAMILY_LABEL, findCatalog, ensureAssetCatalog, ensureRegisterDemo, PRICES, ensureCatalogPrices };
