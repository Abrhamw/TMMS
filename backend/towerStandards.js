const { db } = require('./db');
const { COMPONENT_CATALOG } = require('./towerComponents');

const TOWER_TYPES = ['SUSPENSION', 'TENSION', 'ANGLE', 'TERMINAL', 'TRANSITION', 'DEAD_END'];

// Per-type quantity overrides on top of the master COMPONENT_CATALOG defaults.
// A value of 0 removes that component from the type's standard set.
const TYPE_OVERRIDES = {
  SUSPENSION: { INSULATOR_STRING: 6, CONDUCTOR_CLAMP: 6, DAMPER: 18, SPACER: 0, JOINT_BOX: 0, CROSS_ARM: 3 },
  TENSION: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 12, SPACER: 9, JOINT_BOX: 6, CROSS_ARM: 3 },
  ANGLE: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 12, SPACER: 9, JOINT_BOX: 6, CROSS_ARM: 6, LATTICE_MEMBER: 30 },
  TERMINAL: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 6, SPACER: 6, JOINT_BOX: 9, CROSS_ARM: 6, PEAK_MAST: 1, FOUNDATION: 6 },
  TRANSITION: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 12, SPACER: 9, JOINT_BOX: 6, CROSS_ARM: 4 },
  DEAD_END: { INSULATOR_STRING: 12, CONDUCTOR_CLAMP: 12, DAMPER: 9, SPACER: 6, JOINT_BOX: 9, CROSS_ARM: 6, PEAK_MAST: 1, FOUNDATION: 6, ANTI_CLIMBING: 4 },
};

const STANDARD_SETS = {};
for (const type of TOWER_TYPES) {
  const overrides = TYPE_OVERRIDES[type] || {};
  STANDARD_SETS[type] = COMPONENT_CATALOG
    .map((c) => {
      const qty = Object.prototype.hasOwnProperty.call(overrides, c.type) ? overrides[c.type] : c.defaultQty;
      return { component_type: c.type, name: c.name, material: c.material, default_quantity: qty, unit: c.unit };
    })
    .filter((c) => c.default_quantity > 0);
}

// Standards are static reference data, but seeding/importing a whole line calls
// this once per tower. Cache the parsed set per tower type and invalidate it
// whenever the standards table is (re)seeded.
const standardCache = new Map();

function seedTowerComponentStandards() {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO tower_component_standard (tower_type, component_type, name, material, default_quantity, unit) VALUES (?,?,?,?,?,?)'
  );
  for (const [type, rows] of Object.entries(STANDARD_SETS)) {
    for (const r of rows) {
      stmt.run(type, r.component_type, r.name, r.material, r.default_quantity, r.unit);
    }
  }
  standardCache.clear();
}

function getStandardForType(towerType) {
  const type = TOWER_TYPES.includes(String(towerType || '').toUpperCase())
    ? String(towerType).toUpperCase()
    : 'SUSPENSION';
  if (standardCache.has(type)) return standardCache.get(type);
  const select = db.prepare(
    'SELECT component_type, name, material, default_quantity, unit FROM tower_component_standard WHERE tower_type = ? ORDER BY id'
  );
  let rows = select.all(type);
  if (rows.length === 0 && type !== 'SUSPENSION') {
    rows = select.all('SUSPENSION');
  }
  if (rows.length === 0) {
    seedTowerComponentStandards();
    rows = select.all(type);
    if (rows.length === 0 && type !== 'SUSPENSION') {
      rows = select.all('SUSPENSION');
    }
  }
  standardCache.set(type, rows);
  return rows;
}

function seedStandardComponents(towerId, towerType) {
  const rows = getStandardForType(towerType);
  const stmt = db.prepare(
    'INSERT INTO tower_component (tower_id, component_type, name, material, quantity, unit, condition_rating, status, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  const now = new Date().toISOString();
  for (const r of rows) {
    stmt.run(towerId, r.component_type, r.name, r.material, r.default_quantity, r.unit, 8, 'INSTALLED', null, now);
  }
}

module.exports = { TOWER_TYPES, STANDARD_SETS, seedTowerComponentStandards, getStandardForType, seedStandardComponents };
